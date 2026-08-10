import { CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, classifyDiscoveredModel, compatibleModels, modelId, rankModels, selectBest, selectSmartRotation, MODEL_SELECTION_MODES } from './modelSelection.js';

const API_VERSION = 'v1beta';
const BASE_URL = 'https://generativelanguage.googleapis.com';
const cache = new Map();
const verificationCache = new Map();

export class GeminiError extends Error {
  constructor(message, { category, status, reason, diagnostic, cause, fallbackLog, model } = {}) {
    super(message, { cause }); this.name = 'GeminiError'; this.category = category; this.status = status; this.reason = reason; this.diagnostic = diagnostic; this.fallbackLog = fallbackLog || []; this.model = model;
  }
}

const endpoint = (key, id) => `${BASE_URL}/${API_VERSION}/models/${id}:generateContent?key=${encodeURIComponent(key)}`;
const listEndpoint = (key) => `${BASE_URL}/${API_VERSION}/models?key=${encodeURIComponent(key)}`;
const redact = (value) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '';

function userMessageForStatus(status, reason) {
  if (status === 400 && /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason || '')) return 'Your Gemini API key was rejected. Check the key and API access.';
  if (status === 401 || status === 403) return 'Your Gemini API key was rejected. Check the key and API access.';
  if (status === 404) return 'Gemini model unavailable or not found. ChitForge will refresh models and try another compatible model.';
  if (status === 429) return 'Gemini rate limit reached. ChitForge will try another compatible model when available.';
  if (status === 500 || status === 503) return 'Gemini is temporarily unavailable. ChitForge will try another compatible model when available.';
  return reason ? `Gemini request failed (${status}): ${reason}` : `Gemini request failed with HTTP ${status}.`;
}
async function parseErrorResponse(res) { try { const p = await res.json(); return [p.error?.message, p.error?.status, p.error?.details?.find?.((d) => d.reason)?.reason].filter(Boolean).join(' — ') || res.statusText; } catch { return (await res.text().catch(() => '')).slice(0, 240) || res.statusText; } }
function debugDiagnostic({ status, reason, category, apiKey, model }) { if (!import.meta.env.DEV) return undefined; return [`GEMINI ERROR`, `Model: ${model || 'n/a'}`, `Status: ${status || 'n/a'}`, `Category: ${category}`, `Reason: ${reason || 'n/a'}`, `API key: ${redact(apiKey)}`].join('\n'); }
function cacheKey(apiKey) { return redact(apiKey); }

export async function discoverGeminiModels(apiKey, { force = false, verify = false } = {}) {
  if (!apiKey?.trim()) throw new GeminiError('Missing Gemini API key. Enter your key and try again.', { category: 'missing-api-key' });
  const key = cacheKey(apiKey);
  if (!force && cache.has(key)) return cache.get(key);
  const res = await fetch(listEndpoint(apiKey));
  if (!res.ok) {
    const reason = await parseErrorResponse(res); const category = (res.status === 401 || res.status === 403 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : 'model-discovery';
    throw new GeminiError(category === 'invalid-api-key' ? 'Your Gemini API key was rejected. Check the key and API access.' : 'Could not retrieve Gemini model availability.', { category, status: res.status, reason, diagnostic: debugDiagnostic({ status: res.status, reason, category, apiKey }) });
  }
  const payload = await res.json();
  const models = rankModels((payload.models || []).map((m) => classifyDiscoveredModel(m, verificationCache.get(`${key}:${modelId(m)}`))));
  const result = { fetchedAt: Date.now(), all: models, compatible: compatibleModels(models) };
  cache.set(key, result);
  if (verify) await refreshModelCapabilities(apiKey, { limit: 6 });
  return cache.get(key);
}

function buildBody(prompt, schema, model) {
  const generationConfig = { temperature: 0.25, responseMimeType: 'application/json', responseSchema: schema };
  if (model?.outputTokenLimit) generationConfig.maxOutputTokens = Math.min(8192, Math.max(2048, model.outputTokenLimit));
  return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
}

async function rawGenerate(apiKey, model, prompt, schema, { timeoutMs = 70000 } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(apiKey, model.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(buildBody(prompt, schema, model)) });
    if (!res.ok) { const reason = await parseErrorResponse(res); const category = (res.status === 401 || res.status === 403 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : res.status === 404 ? 'model-unavailable' : [429, 500, 503].includes(res.status) ? 'transient-model-failure' : `http-${res.status}`; throw new GeminiError(userMessageForStatus(res.status, reason), { category, status: res.status, reason, model: model.displayName }); }
    const data = await res.json(); const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request for safety reasons: ${data.promptFeedback.blockReason}.`, { category: 'safety-filter', reason: data.promptFeedback.blockReason, model: model.displayName });
    const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n').trim();
    if (!text) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response', model: model.displayName });
    return text;
  } catch (error) { if (error instanceof GeminiError) throw error; if (error.name === 'AbortError') throw new GeminiError('Gemini request timed out. Try fewer POIs or try again shortly.', { category: 'timeout', cause: error, model: model.displayName }); throw new GeminiError('Could not reach Gemini. Check your internet connection.', { category: 'network', cause: error, model: model.displayName }); } finally { clearTimeout(timer); }
}

export async function refreshModelCapabilities(apiKey, { force = false, limit = 8 } = {}) {
  const discovered = await discoverGeminiModels(apiKey, { force }); const key = cacheKey(apiKey);
  for (const model of discovered.compatible.slice(0, limit)) {
    const vKey = `${key}:${model.id}`; if (!force && verificationCache.get(vKey)?.verified) continue;
    try { const text = await rawGenerate(apiKey, model, 'Return a tiny but complete ChitForge-compatible JSON object for a schema compatibility test only. Use one target and one pressure point with placeholder strings, one evidence object, nullable follow_up fields set to null, no Markdown, and no extra prose.', CHITFORGE_RESPONSE_SCHEMA, { timeoutMs: 25000 }); const parsed = JSON.parse(text); const ok = typeof parsed.research_summary === 'string' && Array.isArray(parsed.targets) && Array.isArray(parsed.targets?.[0]?.pressure_points); verificationCache.set(vKey, { verified: true, structuredJson: ok }); }
    catch { verificationCache.set(vKey, { verified: true, structuredJson: false }); }
  }
  cache.delete(key); return discoverGeminiModels(apiKey, { force: true });
}


async function verifyModelCompatibility(apiKey, model) {
  const vKey = `${cacheKey(apiKey)}:${model.id}`;
  const cached = verificationCache.get(vKey);
  if (cached?.verified) return cached.structuredJson;
  try {
    const text = await rawGenerate(apiKey, model, 'Return a tiny but complete ChitForge-compatible JSON object for a schema compatibility test only. Use one target and one pressure point with placeholder strings, one evidence object, nullable follow_up fields set to null, no Markdown, and no extra prose.', CHITFORGE_RESPONSE_SCHEMA, { timeoutMs: 25000 });
    const parsed = JSON.parse(text);
    const ok = typeof parsed.research_summary === 'string' && Array.isArray(parsed.targets) && Array.isArray(parsed.targets?.[0]?.pressure_points) && typeof parsed.targets?.[0]?.pressure_points?.[0]?.poi === 'string' && !/^```/i.test(text.trim());
    verificationCache.set(vKey, { verified: true, structuredJson: ok });
    cache.delete(cacheKey(apiKey));
    return ok;
  } catch {
    verificationCache.set(vKey, { verified: true, structuredJson: false });
    cache.delete(cacheKey(apiKey));
    return false;
  }
}

export async function callGemini(apiKey, prompt, { modelMode = MODEL_SELECTION_MODES.BEST, manualModelId, schema = CHITFORGE_RESPONSE_SCHEMA, timeoutMs = 70000, onModelStatus } = {}) {
  const discovered = await discoverGeminiModels(apiKey);
  let ranked = discovered.compatible;
  if (!ranked.length) throw new GeminiError('No Gemini model available to your API key supports ChitForge structured JSON generation. Use Refresh Models or check API access.', { category: 'no-compatible-models' });
  let selected = modelMode === MODEL_SELECTION_MODES.ROTATION ? selectSmartRotation(ranked) : modelMode === MODEL_SELECTION_MODES.MANUAL ? ranked.find((m) => m.id === manualModelId) : selectBest(ranked);
  if (!selected) selected = selectBest(ranked);
  const fallbackLog = [];
  for (const model of [selected, ...ranked.filter((m) => m.id !== selected.id)]) {
    const jsonOk = await verifyModelCompatibility(apiKey, model);
    if (!jsonOk) { fallbackLog.push({ from: model.displayName, reason: 'structured JSON unsupported' }); continue; }
    try { onModelStatus?.({ model: { ...model, verified: true, compatibilityStatus: 'STRUCTURED JSON — VERIFIED' }, mode: modelMode, fallbackLog }); const text = await rawGenerate(apiKey, model, prompt, schema, { timeoutMs }); return { text, model: { ...model, verified: true, compatibilityStatus: 'STRUCTURED JSON — VERIFIED' }, mode: modelMode, fallbackLog }; }
    catch (err) { if (err.category === 'invalid-api-key') throw err; if (!['model-unavailable', 'transient-model-failure', 'timeout', 'http-400'].includes(err.category)) throw err; fallbackLog.push({ from: model.displayName, reason: err.status || err.category }); }
  }
  throw new GeminiError('Gemini returned an invalid structured response.', { category: 'all-models-failed', fallbackLog });
}

export { CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, MODEL_SELECTION_MODES };
