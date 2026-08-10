import { countWords, speakingSeconds, stripMarkdown } from './format.js';
import { calculatePressureScore, classifyPressure, findDuplicatePoiIndexes, normalizeMission } from './validation.js';

export function extractJson(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const start = Math.min(...['{', '['].map((c) => { const i = trimmed.indexOf(c); return i < 0 ? Infinity : i; }));
  if (!Number.isFinite(start)) throw new Error('No JSON object found in Gemini response.');
  const open = trimmed[start]; const close = open === '{' ? '}' : ']';
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) { escaped = ch === '\\' && !escaped; if (ch === '"' && !escaped) inString = false; if (ch !== '\\') escaped = false; continue; }
    if (ch === '"') inString = true;
    if (ch === open) depth += 1;
    if (ch === close) depth -= 1;
    if (depth === 0) {
      const candidate = trimmed.slice(start, i + 1).replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(candidate);
    }
  }
  throw new Error('Could not locate a complete JSON object in Gemini response.');
}

function value(...items) { return items.find((item) => item !== undefined && item !== null && item !== '') ?? ''; }
function array(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function evidenceStrength(evidence) { return evidence.some((e) => /^https?:\/\//i.test(e.sourceUrl || e.url || '')) ? 75 : 25; }

export function toInternalMission(raw, ctx, modelInfo = {}) {
  const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
  const legacy = normalizeMission(parsed, ctx);
  const targetsByName = new Map();
  legacy.chits.forEach((chit, index) => {
    const country = value(chit.target, chit.country, 'AUTO-DISCOVERED TARGET');
    if (!targetsByName.has(country)) targetsByName.set(country, { country, reasonForTargeting: value(chit.reasonForTargeting, 'Agenda-relevant pressure point identified by Gemini.'), pois: [] });
    const evidence = array(chit.evidence).map((e) => ({ claim: value(e.claim, 'Verification required'), sourceName: value(e.sourceName, e.source_name, e.title, e.source, 'Verification required'), sourceUrl: value(e.sourceUrl, e.source_url, e.url, '') }));
    const wordCount = countWords(chit.poi);
    const pressureScore = calculatePressureScore(ctx.sliders, evidenceStrength(evidence), Number(chit.contradictionStrength || 60), Number(chit.agendaRelevanceScore || 70), Number(chit.portfolioAlignmentScore || 70), Number(chit.legalRelevanceScore || 60));
    targetsByName.get(country).pois.push({
      id: `poi-${index + 1}`,
      target: country,
      poi: value(chit.poi, 'Verification required'),
      legalFoundation: value(chit.legalPolicyFoundation, chit.legal_foundation, 'Verification required'),
      evidence,
      documentedIssue: value(chit.pressurePoint?.conflict, chit.documentedIssue, chit.documented_contradiction, 'Verification required'),
      classification: value(chit.legalTacticalTypes?.[0], chit.classification, classifyPressure(pressureScore)),
      tacticalImpact: value(chit.tacticalImpact, 'Verification required'),
      pressureScore,
      aggression: ctx.sliders.aggression,
      controversy: ctx.sliders.controversy,
      diplomacy: ctx.sliders.diplomacy,
      length: ctx.sliders.length,
      wordCount,
      estimatedSeconds: speakingSeconds(wordCount),
      followUp: ctx.includeFollowUp ? (chit.followUp || null) : null,
      factCheck: { status: 'pending', confidence: 0, claims: [], legalAssessment: { status: 'pending', reason: '' } },
      pressureProfile: { ...ctx.sliders, score: pressureScore, classification: value(chit.pressureProfile?.classification, chit.legalTacticalTypes?.[0], classifyPressure(pressureScore)) },
      legalPolicyFoundation: value(chit.legalPolicyFoundation, chit.legal_foundation, 'Verification required'),
      pressurePoint: chit.pressurePoint,
      legalTacticalTypes: array(chit.legalTacticalTypes),
    });
  });
  const mission = { metadata: { committee: ctx.form?.committee || 'Unspecified', agenda: ctx.form?.agenda || '', portfolio: ctx.form?.portfolio || '', targetMode: ctx.targetingMode, primaryModel: modelInfo.primaryModel || '', factCheckModel: modelInfo.factCheckModel || '' }, researchSummary: legacy.researchSummary, portfolioProfile: legacy.portfolioProfile, portfolioAlignment: legacy.portfolioAlignment, recommendedTargets: legacy.recommendedTargets, targets: [...targetsByName.values()] };
  mission.chits = mission.targets.flatMap((target) => target.pois.map((poi) => ({ ...poi, target: target.country, reasonForTargeting: target.reasonForTargeting })));
  return mission;
}

export function validateInternalMission(mission, { poiCount, includeFollowUp }) {
  const problems = [];
  const pois = mission?.chits || [];
  if (!mission?.metadata) problems.push('Missing metadata');
  if (!Array.isArray(mission?.targets)) problems.push('Missing targets');
  if (pois.length !== poiCount) problems.push(`Expected ${poiCount} POIs, received ${pois.length}`);
  pois.forEach((poi, index) => {
    if (!stripMarkdown(poi.poi).trim()) problems.push(`POI ${index + 1} missing question`);
    if (!poi.legalFoundation) problems.push(`POI ${index + 1} missing legal foundation`);
    if (!poi.documentedIssue) problems.push(`POI ${index + 1} missing documented issue`);
    if (!Array.isArray(poi.evidence) || !poi.evidence.length) problems.push(`POI ${index + 1} missing evidence`);
    poi.evidence?.forEach((e, evIndex) => { if (!e.claim || !e.sourceName) problems.push(`POI ${index + 1} evidence ${evIndex + 1} incomplete`); });
    if (!includeFollowUp && poi.followUp) problems.push(`POI ${index + 1} included follow-up while disabled`);
  });
  findDuplicatePoiIndexes(pois).forEach((idx) => problems.push(`Duplicate POI argument detected at ${idx + 1}`));
  return problems.slice(0, 12);
}
