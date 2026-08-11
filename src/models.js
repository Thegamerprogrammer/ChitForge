export const FALLBACK_MODELS = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', supportsSearch: true, supportsThinking: true },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', supportsSearch: true, supportsThinking: true },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', supportsSearch: true, supportsThinking: true },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', supportsSearch: true, supportsThinking: true },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', supportsSearch: true, supportsThinking: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', supportsSearch: true, supportsThinking: true },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', supportsSearch: true, supportsThinking: true },
];

export const DEFAULT_MAIN_MODEL = 'gemini-3.6-flash';
export const DEFAULT_REVIEW_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_MAIN_THINKING = 'high';
export const DEFAULT_REVIEW_THINKING = 'medium';
export const THINKING_LEVELS = ['none', 'low', 'medium', 'high'];

export function getKnownModel(id) {
  return FALLBACK_MODELS.find((model) => model.id === id) || FALLBACK_MODELS[0];
}

export function sanitizeThinkingLevel(modelId, level) {
  const model = getKnownModel(modelId);
  if (!model.supportsThinking) return undefined;
  return THINKING_LEVELS.includes(level) ? level : 'medium';
}
