import { extractGeminiText } from './responseParser.js';
import { CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, FACT_CHECK_RESPONSE_SCHEMA, classifyDiscoveredModel, compatibleModels, rankModels, selectBest, selectFactCheckModel, selectSmartRotation, MODEL_SELECTION_MODES } from './modelSelection.js';

const API_VERSION = 'v1beta';
const BASE_URL = 'https://generativelanguage.googleapis.com';

export class GeminiError extends Error {
  constructor(message, { category, status, reason, diagnostic, cause } = {}) {
    super(message, { cause });
    this.name = 'GeminiError';
    this.category = category;
    this.status = status;
    this.reason = reason;
    this.diagnostic = diagnostic;
  }
}

const endpoint = (_key, id) => `${BASE_URL}/${API_VERSION}/models/${id}:generateContent`;
const interactionsEndpoint = () => `${BASE_URL}/${API_VERSION}/interactions`;
const listEndpoint = () => `${BASE_URL}/${API_VERSION}/models`;
const redact = (value) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '';
const cacheKey = (apiKey) => redact(apiKey);

function userMessageForStatus(status, reason) {
  if (status === 400 && /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason || '')) return 'Invalid Gemini API key. Check your key and try again.';
  if (status === 400) return 'Gemini rejected the request payload. The prompt, model, tool, or JSON configuration was invalid.';
  if (status === 401) return 'Invalid Gemini API key. Check your key and try again.';
  if (status === 403) return 'Gemini rejected the request. Check API access, billing, Google Search grounding, and model permissions.';
  if (status === 404) return 'Gemini model unavailable or not found. Choose another model or refresh available models.';
  if (status === 429) return 'Gemini rate limit reached. Wait a moment and try again.';
  if (status === 500 || status === 503) return 'Gemini is temporarily unavailable. Try again shortly.';
  return reason ? `Gemini request failed (${status}): ${reason}` : `Gemini request failed with HTTP ${status}.`;
}
async function parseErrorResponse(res) { try { const p = await res.json(); return [p.error?.message, p.error?.status, p.error?.details?.find?.((d) => d.reason)?.reason].filter(Boolean).join(' — ') || res.statusText; } catch { return (await res.text().catch(() => '')).slice(0, 240) || res.statusText; } }
function debugDiagnostic({ status, reason, category, model }) { if (!import.meta.env.DEV) return undefined; return [`GEMINI ERROR`, `MODEL: ${model || 'n/a'}`, `HTTP STATUS: ${status || 'n/a'}`, `FAILURE STAGE: ${category}`, `REASON: ${reason || 'n/a'}`].join('\n'); }

export async function discoverGeminiModels(apiKey, { force = false } = {}) {
  if (!apiKey?.trim()) throw new GeminiError('Missing Gemini API key. Enter your key and try again.', { category: 'missing-api-key' });
  const key = cacheKey(apiKey);
  if (!force && cache.has(key)) return cache.get(key);
  const res = await fetch(listEndpoint(), { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) {
    const reason = await parseErrorResponse(res); const category = (res.status === 401 || res.status === 403 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : 'model-discovery';
    throw new GeminiError(category === 'invalid-api-key' ? 'Your Gemini API key was rejected. Check the key and API access.' : 'Could not retrieve Gemini model availability.', { category, status: res.status, reason, diagnostic: debugDiagnostic({ status: res.status, reason, category }) });
  }
}

function debugDiagnostic({ status, reason, category, apiKey, model, endpoint }) {
  if (!import.meta.env.DEV) return undefined;
  return [`GEMINI ERROR`, `Endpoint: ${endpoint}`, `Model: ${model}`, `Status: ${status || 'n/a'}`, `Category: ${category}`, `Reason: ${reason || 'n/a'}`, `API key: ${redact(apiKey)}`].join('\n');
}


function extractInteractionText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const chunks = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.text === 'string') chunks.push(value.text);
    if (Array.isArray(value.content)) value.content.forEach(visit);
    if (Array.isArray(value.parts)) value.parts.forEach(visit);
    if (Array.isArray(value.steps)) value.steps.forEach(visit);
    if (value.model_output) visit(value.model_output);
    if (value.modelOutput) visit(value.modelOutput);
  };
  visit(payload);
  return [...new Set(chunks)].join('\n').trim();
}

function safeDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function normalizeCitation(urlCitation, text = '', searchQuery = '') {
  const url = urlCitation?.url || urlCitation?.uri || urlCitation?.source_url || urlCitation?.sourceUrl;
  if (!url) return null;
  const start = urlCitation.start_index ?? urlCitation.startIndex;
  const end = urlCitation.end_index ?? urlCitation.endIndex;
  const title = urlCitation.title || urlCitation.sourceTitle || safeDomain(url) || 'Retrieved source';
  return {
    id: `src-${Math.abs([...url].reduce((n, ch) => ((n << 5) - n + ch.charCodeAt(0)) | 0, 0))}`,
    url,
    title,
    sourceName: title,
    organization: safeDomain(url) || title,
    domain: safeDomain(url),
    publishedAt: urlCitation.publication_date || urlCitation.publicationDate || '',
    publicationDate: urlCitation.publication_date || urlCitation.publicationDate || '',
    sourceType: 'OTHER_CREDIBLE',
    citationSource: 'google_search',
    retrievalStatus: 'retrieved',
    reviewStatus: 'pending',
    confidence: 0.6,
    verbatimEvidence: typeof start === 'number' && typeof end === 'number' && text ? text.slice(start, end) : null,
    snippet: text ? text.slice(0, 320) : '',
    searchQuery,
    claimsSupported: [],
    claimsContradicted: [],
  };
}

export function extractGroundedSources(payload) {
  const sources = [];
  const queries = [];
  const visit = (value, currentText = '') => {
    if (!value || typeof value !== 'object') return;
    const text = typeof value.text === 'string' ? value.text : currentText;
    if (value.type === 'google_search_call' && value.args?.query) queries.push(value.args.query);
    if (value.type === 'google_search_result' && value.output?.query) queries.push(value.output.query);
    if (Array.isArray(value.annotations)) {
      value.annotations.forEach((a) => {
        const citation = a.url_citation || a.urlCitation || (a.type === 'url_citation' ? a : null);
        const normalized = citation && normalizeCitation(citation, text, queries.at(-1) || '');
        if (normalized) sources.push(normalized);
      });
    }
    if (Array.isArray(value.groundingChunks)) value.groundingChunks.forEach((chunk) => {
      const web = chunk.web || chunk.retrievedContext || chunk;
      const normalized = normalizeCitation({ url: web.uri || web.url, title: web.title }, text, queries.at(-1) || '');
      if (normalized) sources.push(normalized);
    });
    Object.values(value).forEach((child) => { if (child && typeof child === 'object') Array.isArray(child) ? child.forEach((x) => visit(x, text)) : visit(child, text); });
  };
  visit(payload);
  const deduped = [];
  const seen = new Set();
  sources.forEach((source) => { if (!seen.has(source.url)) { seen.add(source.url); deduped.push(source); } });
  return { sources: deduped, searchQueries: [...new Set(queries)] };
}

async function rawGenerate(apiKey, model, prompt, schema, { timeoutMs = 70000, nativeJson = true } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(apiKey, model.id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal: controller.signal, body: JSON.stringify(buildBody(prompt, schema, model, { nativeJson })) });
    if (!res.ok) { const reason = await parseErrorResponse(res); const category = (res.status === 401 || res.status === 403 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : res.status === 404 ? 'model-unavailable' : [429, 500, 503].includes(res.status) ? 'transient-model-failure' : `http-${res.status}`; throw new GeminiError(userMessageForStatus(res.status, reason), { category, status: res.status, reason, model: model.displayName }); }
    const data = await res.json();
    if (data.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request for safety reasons: ${data.promptFeedback.blockReason}.`, { category: 'safety-filter', reason: data.promptFeedback.blockReason, model: model.displayName });
    const text = extractGeminiText(data).trim();
    if (!text) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response', model: model.displayName, diagnostic: import.meta.env.DEV ? `MODEL: ${model.displayName}\nHTTP STATUS: ${res.status}\nRAW RESPONSE LENGTH: ${JSON.stringify(data).length}\nEXTRACTED TEXT LENGTH: 0` : undefined });
    return text;
  } catch (error) { if (error instanceof GeminiError) throw error; if (error.name === 'AbortError') throw new GeminiError('Request timed out.', { category: 'timeout', cause: error, model: model.displayName }); throw new GeminiError('Could not reach Gemini.', { category: 'network', cause: error, model: model.displayName }); } finally { clearTimeout(timer); }
}

function interactionText(data) {
  const text = data.output_text || data.outputText || (data.steps || []).flatMap((step) => step.content || []).filter((part) => part.type === 'text' || part.text).map((part) => part.text).join('\n');
  if (!text?.trim()) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response' });
  return text.trim();
}

export async function callGemini(apiKey, prompt, { modelMode = MODEL_SELECTION_MODES.BEST, manualModelId, schema = CHITFORGE_RESPONSE_SCHEMA, timeoutMs = 70000, onModelStatus } = {}) {
  const discovered = await discoverGeminiModels(apiKey);
  const ranked = discovered.compatible;
  if (!ranked.length) throw new GeminiError('No Gemini text-generation models were returned for this API key. Refresh models or check Gemini API access.', { category: 'no-generation-models' });
  const selected = pickModel(ranked, modelMode, manualModelId) || ranked[0];
  const fallbackLog = [];
  for (const model of [selected, ...ranked.filter((m) => m.id !== selected.id)]) {
    onModelStatus?.({ model, mode: modelMode, fallbackLog });
    try {
      try { return { text: await rawGenerate(apiKey, model, prompt, schema, { timeoutMs, nativeJson: true }), model, mode: modelMode, fallbackLog, usedNativeJson: true }; }
      catch (err) {
        if (err.category === 'http-400') { fallbackLog.push({ from: model.displayName, reason: 'structured-json-request-failed; retried plain JSON' }); return { text: await rawGenerate(apiKey, model, prompt, schema, { timeoutMs, nativeJson: false }), model, mode: modelMode, fallbackLog, usedNativeJson: false }; }
        throw err;
      }
    } catch (err) {
      if (err.category === 'invalid-api-key') throw err;
      if (!['model-unavailable', 'transient-model-failure', 'timeout', 'network'].includes(err.category)) throw err;
      fallbackLog.push({ from: model.displayName, reason: err.status || err.category });
    }
  }
  throw new GeminiError('Gemini could not produce a response with any currently available generation model.', { category: 'all-models-failed', fallbackLog });
}

export async function callGemini(apiKey, prompt, { model = DEFAULT_MAIN_MODEL, thinkingLevel = 'medium', timeoutMs, responseJson = true } = {}) {
  const body = {
    model,
    input: prompt,
    generation_config: { ...(responseJson ? { response_mime_type: 'application/json' } : {}), ...(sanitizeThinkingLevel(model, thinkingLevel) ? { thinking_level: sanitizeThinkingLevel(model, thinkingLevel) } : {}) },
  };
  const data = await postGemini(apiKey, interactionsEndpoint(), body, { timeoutMs, model });
  return interactionText(data);
}

export async function callFactCheck(apiKey, prompt, { primaryModelId, modelSelection } = {}) {
  const discovered = await discoverGeminiModels(apiKey);
  const requestedReviewer = discovered.compatible.find((m) => m.id === modelSelection?.reviewModelId);
  const model = requestedReviewer || selectFactCheckModel(discovered.compatible, primaryModelId) || pickModel(discovered.compatible, modelSelection?.modelMode, modelSelection?.manualModelId);
  const response = await callGemini(apiKey, prompt, { modelMode: MODEL_SELECTION_MODES.MANUAL, manualModelId: model?.id, schema: FACT_CHECK_RESPONSE_SCHEMA, timeoutMs: 45000 });
  return response;
}



export async function callGeminiSearch(apiKey, prompt, { modelMode = MODEL_SELECTION_MODES.BEST, manualModelId, timeoutMs = 70000, onModelStatus, thinkingSummaries = 'brief' } = {}) {
  const discovered = await discoverGeminiModels(apiKey);
  const ranked = discovered.compatible;
  if (!ranked.length) throw new GeminiError('No Gemini text-generation models were returned for this API key. Refresh models or check Gemini API access.', { category: 'no-generation-models' });
  const selected = pickModel(ranked, modelMode, manualModelId) || ranked[0];
  const fallbackLog = [];
  for (const model of [selected, ...ranked.filter((m) => m.id !== selected.id)]) {
    onModelStatus?.({ model, mode: modelMode, fallbackLog });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = { model: model.id, input: prompt, tools: [{ type: 'google_search' }], generation_config: { thinking_summaries: thinkingSummaries } };
      const res = await fetch(interactionsEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal: controller.signal, body: JSON.stringify(body) });
      if (!res.ok) { const reason = await parseErrorResponse(res); throw new GeminiError(userMessageForStatus(res.status, reason), { category: res.status === 404 ? 'model-unavailable' : [429, 500, 503].includes(res.status) ? 'transient-model-failure' : `http-${res.status}`, status: res.status, reason, model: model.displayName }); }
      const data = await res.json();
      const text = extractInteractionText(data) || extractGeminiText(data);
      const grounded = extractGroundedSources(data);
      if (!grounded.sources.length) throw new GeminiError('Google Search grounding returned no source citations. ChitForge will not trust model-generated URLs.', { category: 'missing-grounding-metadata', model: model.displayName, rawText: text });
      return { text, interaction: data, sources: grounded.sources, searchQueries: grounded.searchQueries, model, mode: modelMode, fallbackLog };
    } catch (err) {
      if (err instanceof GeminiError && err.category === 'invalid-api-key') throw err;
      if (err.name === 'AbortError') fallbackLog.push({ from: model.displayName, reason: 'timeout' });
      else if (err instanceof GeminiError && ['model-unavailable', 'transient-model-failure', 'timeout', 'network', 'missing-grounding-metadata'].includes(err.category)) fallbackLog.push({ from: model.displayName, reason: err.category });
      else if (err instanceof GeminiError) throw err;
      else fallbackLog.push({ from: model.displayName, reason: 'network' });
    } finally { clearTimeout(timer); }
  }
  throw new GeminiError('Gemini Google Search grounding could not produce trusted source metadata with any available model.', { category: 'all-search-models-failed', fallbackLog });
}


export { CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, FACT_CHECK_RESPONSE_SCHEMA, MODEL_SELECTION_MODES };
