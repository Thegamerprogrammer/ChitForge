import { callGemini, callGeminiWithSearch, GeminiError } from './gemini.js';
import { normalizeMission, validateMissionResponse, findDuplicatePoiIndexes } from './validation.js';
import { DEFAULT_MAIN_MODEL, DEFAULT_REVIEW_MODEL, DEFAULT_MAIN_THINKING, DEFAULT_REVIEW_THINKING } from './models.js';
import { buildClaimGraph, rejectModelGeneratedEvidence, reviewEvidenceLocally, sourceStatusLabel } from './sourceIntegrity.js';

const BATCH_CATEGORIES = ['Legal trap', 'Voting trap', 'Policy contradiction', 'Official statement contradiction', 'Economic contradiction', 'Implementation trap', 'Transparency trap', 'Treaty trap', 'International organization finding', 'Credibility trap'];

export async function generateMission({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount, onProgress }) {
  const settings = normalizeSettings(form, poiCount);
  onProgress?.({ stage: 'RESEARCHING PORTFOLIO', detail: 'Running Google Search grounding and extracting real citation metadata...', done: 0, total: settings.totalPoiTarget });
  const search = await searchSources({ form, selectedTargets, targetingMode, settings });
  onProgress?.({ stage: 'VALIDATING SOURCES', detail: `${search.sources.length} trusted grounded source(s) extracted. Reviewing claim ↔ source links...`, done: 0, total: settings.totalPoiTarget, stats: { sourcesFound: search.sources.length } });
  const reviewedSources = await reviewSources({ form, sources: search.sources, settings, onProgress });
  onProgress?.({ stage: 'GENERATING POIs', detail: 'Generating batched POIs from verified/reported evidence only...', done: 0, total: settings.totalPoiTarget, stats: { sourcesVerified: reviewedSources.filter((source) => ['verified', 'reported'].includes(source.reviewStatus)).length } });
  let mission = await synthesizePoiBatches({ form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, sources: reviewedSources, searchSummary: search.text, onProgress });
  mission = attachTrustedSources(mission, reviewedSources, settings);
  mission = await repairMission({ mission, form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, onProgress });
  onProgress?.({ stage: 'FINALIZING TACTICAL BRIEF', detail: `${mission.chits.length}/${settings.totalPoiTarget} defensible POIs finalized.`, done: mission.chits.length, total: settings.totalPoiTarget, stats: mission.auditTrail?.stats });
  return mission;
}

export async function regenerateChit({ form, sliders, chit, existingChits, apiKey, includeFollowUp, onProgress }) {
  const settings = normalizeSettings(form, 1);
  onProgress?.({ stage: 'GENERATING POIs', detail: `Regenerating POI for ${chit.target} using existing trusted sources...`, done: 0, total: 1 });
  const trustedEvidence = (chit.evidence || []).filter((item) => item.sourceId && item.url);
  if (!trustedEvidence.length) throw new GeminiError('Cannot regenerate this POI as verified because it has no trusted source records attached.', { category: 'unsupported-source' });
  const prompt = `Return STRICT JSON only. Regenerate exactly 1 distinct POI. Do not duplicate: ${JSON.stringify(existingChits.map((item) => item.poi))}. Use ONLY these sourceIds and claims; do not invent URLs: ${JSON.stringify(trustedEvidence)}. Agenda: ${form.agenda}. Portfolio: ${form.portfolio}. Target: ${chit.target}. Sliders: ${JSON.stringify(sliders)}. Return targets[].pressure_points[].`;
  const text = await callGemini(apiKey, prompt, { model: settings.mainModel, thinkingLevel: settings.mainThinking });
  const mission = attachTrustedSources(normalizeMission(text, { sliders, includeFollowUp, poiCount: 1 }), trustedEvidence.map((e) => evidenceToSource(e)), settings);
  return mission.chits[0] || chit;
}

export async function generateFollowUp({ form, sliders, chit, apiKey, onProgress }) {
  onProgress?.({ stage: 'GENERATING FOLLOW-UP', detail: `Generating optional follow-up for ${chit.target}...`, done: 0, total: 1 });
  const prompt = `Return STRICT JSON only. Generate an optional evidence-grounded follow-up for this MUN POI. Do not introduce unsupported facts or new URLs. Sliders: ${JSON.stringify(sliders)}. Existing source-linked chit: ${JSON.stringify(chit)}. Return {"expectedEvasion":"...","question":"...","counter":"..."}.`;
  const text = await callGemini(apiKey, prompt, { model: form.mainModel || DEFAULT_MAIN_MODEL, thinkingLevel: form.mainThinking || DEFAULT_MAIN_THINKING });
  try {
    const parsed = JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, ''));
    return { ...chit, followUp: { expectedEvasion: parsed.expectedEvasion || 'VERIFICATION REQUIRED', question: parsed.question || 'What evidence addresses the original contradiction directly?', counter: parsed.counter || null } };
  } catch (cause) {
    throw new GeminiError('Invalid JSON returned by Gemini while generating the follow-up. Try again.', { category: 'invalid-json', cause });
  }
}

function normalizeSettings(form, poiCount) {
  const countryCount = Math.max(1, Number(form.selectedCountryCount || 0));
  const poisPerCountry = Number(form.poisPerCountry || poiCount || 10);
  return {
    mainModel: form.mainModel || DEFAULT_MAIN_MODEL,
    reviewModel: form.reviewModel || DEFAULT_REVIEW_MODEL,
    mainThinking: form.mainThinking || DEFAULT_MAIN_THINKING,
    reviewThinking: form.reviewThinking || DEFAULT_REVIEW_THINKING,
    researchDepth: form.researchDepth || 'standard',
    extensiveLegalities: !!form.extensiveLegalities,
    poisPerCountry,
    totalPoiTarget: Math.max(1, Math.min(250, Number(form.totalPoiTarget || poiCount || poisPerCountry * countryCount))),
  };
}

async function searchSources({ form, selectedTargets, targetingMode, settings }) {
  const targetText = selectedTargets.length ? selectedTargets.map((c) => `${c.name} (${c.iso})${c.opposition ? ' [OPPOSITION]' : ''}`).join(', ') : 'none selected; discover agenda-relevant targets';
  const prompt = `SEARCH STAGE ONLY. Do not generate POIs. Use Google Search grounding to find real sources with actual citation metadata for this MUN research request. Agenda: ${form.agenda}. Committee: ${form.committee || 'Unspecified'}. Portfolio: ${form.portfolio}. Targeting mode: ${targetingMode}. Targets/opposition: ${targetText}. Research depth: ${settings.researchDepth}. Extensive legalities: ${settings.extensiveLegalities ? 'ON' : 'OFF'}. Search for official positions, UN/IO reports, legal texts, votes, disputes, policy contradictions, implementation failures, official statements, and high-quality reporting. Return a concise JSON object with candidate_claims only; source URLs must come from grounding metadata, not your text.`;
  return callGeminiWithSearch(form.apiKey, prompt, { model: settings.mainModel, thinkingLevel: settings.mainThinking, query: `${form.portfolio} ${form.agenda}` });
}

async function reviewSources({ form, sources, settings, onProgress }) {
  const reviewable = sources.slice(0, depthLimit(settings.researchDepth));
  const reviewed = [];
  for (let index = 0; index < reviewable.length; index += 1) {
    const source = reviewable[index];
    onProgress?.({ stage: 'VALIDATING SOURCES', detail: `Reviewing source ${index + 1}/${reviewable.length}: ${source.domain}`, done: index, total: reviewable.length, stats: { sourcesFound: sources.length, sourcesReviewed: index } });
    const local = reviewEvidenceLocally(`${form.agenda} ${form.portfolio}`, source);
    if (!source.verbatimEvidence) {
      reviewed.push({ ...source, ...local, reviewStatus: 'unavailable', confidence: local.confidence });
      continue;
    }
    try {
      const prompt = `Return STRICT JSON only. Review whether the source excerpt supports agenda-relevant MUN claims. Never invent quotes. CLAIM CONTEXT: ${form.agenda} / ${form.portfolio}. SOURCE Title: ${source.title}. URL: ${source.url}. Domain: ${source.domain}. VERBATIM EVIDENCE: ${source.verbatimEvidence}. Return {"supportsClaim":true,"status":"verified|reported|disputed|unsupported|unavailable","confidence":0.0,"relevance":0.0,"evidenceQuote":"...","reason":"...","claimWordingAdjustment":null}.`;
      const text = await callGemini(form.apiKey, prompt, { model: settings.reviewModel, thinkingLevel: settings.reviewThinking });
      const parsed = JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, ''));
      reviewed.push({ ...source, reviewStatus: parsed.status || local.status, confidence: Number(parsed.confidence || local.confidence), verbatimEvidence: parsed.evidenceQuote || source.verbatimEvidence, reviewReason: parsed.reason || local.reason });
    } catch {
      reviewed.push({ ...source, reviewStatus: local.status, confidence: local.confidence, reviewReason: local.reason });
    }
  }
  return reviewed;
}

async function synthesizePoiBatches({ form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, sources, searchSummary, onProgress }) {
  const trustedSources = sources.filter((source) => ['verified', 'reported'].includes(source.reviewStatus));
  if (!trustedSources.length) throw new GeminiError('No verified or reported sources were available after review. The application refused to generate unsupported POIs.', { category: 'no-verified-sources' });
  const batches = allocateBatches(settings.totalPoiTarget);
  const allChits = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    onProgress?.({ stage: 'GENERATING POIs', detail: `Batch ${index + 1}/${batches.length}: ${batch.category} (${batch.count} POIs)`, done: allChits.length, total: settings.totalPoiTarget, stats: { sourcesVerified: trustedSources.length, candidatesGenerated: allChits.length } });
    const prompt = buildSynthesisPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, sources: trustedSources, searchSummary, batch });
    const text = await callGemini(form.apiKey, prompt, { model: settings.mainModel, thinkingLevel: settings.mainThinking, timeoutMs: 120000 });
    const mission = normalizeMission(text, { sliders, includeFollowUp, poiCount: batch.count });
    allChits.push(...mission.chits);
  }
  return { researchSummary: searchSummary, portfolioProfile: { summary: searchSummary, interests: [] }, portfolioAlignment: 'Built from search-grounded source review.', recommendedTargets: selectedTargets, requestedPoiCount: settings.totalPoiTarget, chits: allChits.slice(0, settings.totalPoiTarget), sources, auditTrail: { searchSummary, stats: { sourcesFound: sources.length, sourcesVerified: trustedSources.length, candidatesGenerated: allChits.length } } };
}

function buildSynthesisPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, sources, batch }) {
  const targets = selectedTargets.length ? selectedTargets.map((country) => `${country.name} (${country.iso})${country.opposition ? ' [OPPOSITION]' : ''}`).join(', ') : 'AUTO-DISCOVER FROM SOURCES';
  const sourceBrief = sources.map((source) => ({ id: source.id, title: source.title, url: source.url, domain: source.domain, status: source.reviewStatus, confidence: source.confidence, excerpt: source.verbatimEvidence, sourceType: source.sourceType })).slice(0, 40);
  return `Return STRICT JSON only. Generate exactly ${batch.count} distinct, source-linked POIs for category ${batch.category}. Do not invent URLs. Use ONLY source IDs from TRUSTED_SOURCES. Every pressure point must include sourceIds and claimIds. If evidence is insufficient, return fewer; do not fabricate. Agenda: ${form.agenda}. Committee: ${form.committee || 'Unspecified'}. Portfolio: ${form.portfolio}. Targets/opposition: ${targets}. Targeting mode: ${targetingMode}. Research depth: ${settings.researchDepth}. Extensive legalities: ${settings.extensiveLegalities ? 'ON - only use real legal provisions present in sources' : 'OFF'}. Sliders: ${JSON.stringify(sliders)}. Follow-up: ${includeFollowUp ? 'include likelyDefense, follow_up, counter for S/A tier' : 'follow_up null'}.
STYLE: simple hard-hitting English; fact → contradiction → pressure → direct question; no distinguished delegate filler; 25–60 words unless legal trap needs more.
RANKING: assign tier S, A, or B based on evidence strength, source quality, specificity, legal relevance, agenda relevance, defensibility, difficulty to evade, originality, conciseness, and diplomatic appropriateness.
TRUSTED_SOURCES: ${JSON.stringify(sourceBrief)}
Return schema {"research_summary":"...","portfolio_alignment":"...","targets":[{"country":"...","iso":"ISO3","pressure_points":[{"poi":"...","category":"${batch.category}","tier":"S|A|B","confidence":0.0,"sourceIds":["src_1"],"claimIds":["claim_1"],"legal_basis":"... or null","likelyDefense":"... or null","counter":"... or null","legal_foundation":"...","evidence":[{"claim":"...","sourceId":"src_1","verbatimEvidence":"exact excerpt copied from TRUSTED_SOURCES"}],"documented_contradiction":"...","tactical_impact":"...","classification":"...","follow_up":${includeFollowUp ? '"..."' : 'null'}}]}]}`;
}

async function repairMission({ mission, form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, onProgress }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const problems = validateMissionResponse(mission, { selectedTargets, targetingMode, includeFollowUp, sliders, poiCount: settings.totalPoiTarget });
    if (!problems.length) break;
    onProgress?.({ stage: 'VALIDATING EVIDENCE', detail: `Repair ${attempt + 1}/2: ${problems.slice(0, 4).join('; ')}`, done: mission.chits.length, total: settings.totalPoiTarget, stats: mission.auditTrail?.stats });
    const duplicates = findDuplicatePoiIndexes(mission.chits);
    if (duplicates.length) mission.chits = mission.chits.filter((_, index) => !duplicates.includes(index));
    if (mission.chits.length >= settings.totalPoiTarget) break;
    const missing = settings.totalPoiTarget - mission.chits.length;
    const batch = { category: 'Replacement verified pressure points', count: Math.min(missing, 20) };
    const prompt = buildSynthesisPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, settings, sources: mission.sources || [], batch }) + `\nAvoid duplicating existing POIs: ${JSON.stringify(mission.chits.map((chit) => chit.poi))}`;
    const text = await callGemini(form.apiKey, prompt, { model: settings.mainModel, thinkingLevel: settings.mainThinking });
    const extra = attachTrustedSources(normalizeMission(text, { sliders, includeFollowUp, poiCount: batch.count }), mission.sources || [], settings);
    mission.chits.push(...extra.chits);
  }
  if (mission.chits.length > settings.totalPoiTarget) mission.chits = mission.chits.slice(0, settings.totalPoiTarget);
  return mission;
}

function attachTrustedSources(mission, sources, settings) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const chits = buildClaimGraph(mission.chits, sources).map((chit) => {
    const evidence = rejectModelGeneratedEvidence(chit.evidence || [], sources).map((item) => {
      const source = sourceMap.get(item.sourceId);
      return { ...item, sourceId: source.id, title: source.title, url: source.url, organization: source.domain, sourceClassification: source.sourceType, status: sourceStatusLabel(source.reviewStatus), verbatimEvidence: item.verbatimEvidence || source.verbatimEvidence, confidence: source.confidence };
    });
    const sourceIds = evidence.map((item) => item.sourceId);
    const tier = chit.tier || rankTier(chit.pressureProfile?.score || 50, evidence);
    return { ...chit, evidence, sourceIds, tier, citationStatus: sourceIds.length ? 'supported' : 'unsupported' };
  }).filter((chit) => chit.evidence.length && chit.citationStatus === 'supported');
  return { ...mission, chits, sources, requestedPoiCount: settings.totalPoiTarget };
}

function allocateBatches(total) {
  const batches = [];
  let remaining = total;
  let index = 0;
  while (remaining > 0) {
    const count = Math.min(20, remaining);
    batches.push({ category: BATCH_CATEGORIES[index % BATCH_CATEGORIES.length], count });
    remaining -= count;
    index += 1;
  }
  return batches;
}

function depthLimit(depth) {
  return ({ quick: 8, standard: 16, deep: 32, extensive: 60 })[depth] || 16;
}

function rankTier(score, evidence) {
  const bestConfidence = Math.max(0, ...evidence.map((item) => Number(item.confidence || 0)));
  if (score >= 80 && bestConfidence >= 0.75) return 'S';
  if (score >= 60 && bestConfidence >= 0.55) return 'A';
  return 'B';
}

function evidenceToSource(evidence) {
  return { id: evidence.sourceId, url: evidence.url, title: evidence.title, domain: evidence.organization, sourceType: evidence.sourceClassification, citationSource: 'google_grounding', retrievalStatus: 'retrieved', reviewStatus: 'verified', confidence: evidence.confidence || 0.7, verbatimEvidence: evidence.verbatimEvidence, claimsSupported: [], claimsContradicted: [] };
}
