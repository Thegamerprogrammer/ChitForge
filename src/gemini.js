import { DEFAULT_MAIN_MODEL, sanitizeThinkingLevel } from './models.js';
import { extractGroundedSources } from './sourceIntegrity.js';

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

const interactionsEndpoint = () => `${BASE_URL}/${API_VERSION}/interactions`;
const generateContentEndpoint = (model) => `${BASE_URL}/${API_VERSION}/models/${model}:generateContent`;

function redact(value) {
  if (!value) return '';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

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

async function parseErrorResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const payload = await res.json();
      const detailReason = payload.error?.details?.find?.((detail) => detail.reason)?.reason;
      return [payload.error?.message, payload.error?.status, detailReason].filter(Boolean).join(' — ') || res.statusText || 'Unknown Gemini error';
    }
    const text = await res.text();
    return text.slice(0, 240) || res.statusText || 'Unknown Gemini error';
  } catch {
    return res.statusText || 'Unknown Gemini error';
  }
}

function debugDiagnostic({ status, reason, category, apiKey, model, endpoint }) {
  if (!import.meta.env.DEV) return undefined;
  return [`GEMINI ERROR`, `Endpoint: ${endpoint}`, `Model: ${model}`, `Status: ${status || 'n/a'}`, `Category: ${category}`, `Reason: ${reason || 'n/a'}`, `API key: ${redact(apiKey)}`].join('\n');
}

async function postGemini(apiKey, endpoint, body, { timeoutMs = 90000, model } = {}) {
  if (!apiKey?.trim()) throw new GeminiError('Missing Gemini API key. Enter your key and try again.', { category: 'missing-api-key' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal: controller.signal, body: JSON.stringify(body) });
    if (!res.ok) {
      const reason = await parseErrorResponse(res);
      const category = (res.status === 401 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : res.status === 404 ? 'model-unavailable' : `http-${res.status}`;
      throw new GeminiError(userMessageForStatus(res.status, reason), { category, status: res.status, reason, diagnostic: debugDiagnostic({ status: res.status, reason, category, apiKey, model, endpoint }) });
    }
    try { return await res.json(); }
    catch (cause) { throw new GeminiError('Gemini returned an unexpected response. Try generating again.', { category: 'malformed-response', reason: 'Response was not valid JSON', cause }); }
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    if (error.name === 'AbortError') throw new GeminiError('Gemini request timed out. Try fewer POIs or a lower research depth.', { category: 'timeout', cause: error });
    throw new GeminiError('Could not reach Gemini. Check your internet connection.', { category: 'network', cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function interactionText(data) {
  const text = data.output_text || data.outputText || (data.steps || []).flatMap((step) => step.content || []).filter((part) => part.type === 'text' || part.text).map((part) => part.text).join('\n');
  if (!text?.trim()) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response' });
  return text.trim();
}

function generateContentText(data) {
  const promptFeedback = data.promptFeedback;
  if (promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request for safety reasons: ${promptFeedback.blockReason}. Revise the agenda or wording and try again.`, { category: 'safety-filter', reason: promptFeedback.blockReason });
  const candidate = data.candidates?.[0];
  if (!candidate) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response' });
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw new GeminiError(`Gemini stopped generation early: ${candidate.finishReason}. Try revising the prompt or reducing POI count.`, { category: 'safety-filter', reason: candidate.finishReason });
  const text = candidate.content?.parts?.map((part) => part.text).filter(Boolean).join('\n').trim();
  if (!text) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response' });
  return text;
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

export async function callGeminiWithSearch(apiKey, prompt, { model = DEFAULT_MAIN_MODEL, thinkingLevel = 'high', timeoutMs, query = '' } = {}) {
  const body = {
    model,
    input: prompt,
    tools: [{ google_search: {} }],
    generation_config: { thinking_level: sanitizeThinkingLevel(model, thinkingLevel) || 'medium' },
  };
  const data = await postGemini(apiKey, interactionsEndpoint(), body, { timeoutMs, model });
  const sources = extractGroundedSources(data, { query });
  if (!sources.length) throw new GeminiError('Gemini completed the search step but returned no grounding metadata. No trusted sources were added.', { category: 'missing-grounding-metadata' });
  return { text: interactionText(data), sources, raw: data };
}

export async function callGenerateContent(apiKey, prompt, { model = DEFAULT_MAIN_MODEL, thinkingLevel = 'medium', timeoutMs, responseJson = true } = {}) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { ...(responseJson ? { responseMimeType: 'application/json' } : {}), ...(sanitizeThinkingLevel(model, thinkingLevel) ? { thinkingLevel: sanitizeThinkingLevel(model, thinkingLevel) } : {}) },
  };
  const data = await postGemini(apiKey, generateContentEndpoint(model), body, { timeoutMs, model });
  return { text: generateContentText(data), sources: extractGroundedSources(data), raw: data };
}
