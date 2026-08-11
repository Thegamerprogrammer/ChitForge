const KEY = 'chitforgeGeminiKey';
const REMEMBER = 'chitforgeRememberKey';
const SETTINGS = 'chitforgeSettings';

export function loadStoredKey() {
  const rememberKey = localStorage.getItem(REMEMBER) === 'true';
  return { rememberKey, key: (rememberKey ? localStorage : sessionStorage).getItem(KEY) || '' };
}

export function saveApiKey(key, rememberKey) {
  if (rememberKey) {
    localStorage.setItem(KEY, key);
    localStorage.setItem(REMEMBER, 'true');
    sessionStorage.removeItem(KEY);
  } else {
    sessionStorage.setItem(KEY, key);
    localStorage.removeItem(KEY);
    localStorage.setItem(REMEMBER, 'false');
  }
}

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS) || '{}'); }
  catch { return {}; }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS, JSON.stringify(settings));
}

export function clearStoredKey() {
  sessionStorage.removeItem(KEY);
  localStorage.removeItem(KEY);
  localStorage.removeItem(REMEMBER);
}
