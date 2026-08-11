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
  mission.chits = updated;
  mission.targets = mission.targets.map((target) => ({ ...target, pois: updated.filter((poi) => poi.target === target.country) }));
  onProgress?.({ stage: 'FINALIZING CHITS', detail: 'Final verification states calculated and chits finalized.', done: mission.chits.length, total: mission.chits.length });
  mission.metadata.factCheckModel = factCheckModel || 'Unavailable';
  return mission;
}

function band(value, bands) { return bands.find(([max]) => value <= max)?.[1] || bands.at(-1)[1]; }
export function lengthInfo(length) { return band(length, [[10, { lines: '≈ 1 line', words: 'approximately 8–15 words', min: 8, max: 15 }], [25, { lines: '≈ 1–2 lines', words: 'approximately 15–25 words', min: 15, max: 25 }], [40, { lines: '≈ 2 lines', words: 'approximately 20–35 words', min: 20, max: 35 }], [55, { lines: '≈ 2–3 lines', words: 'approximately 30–45 words', min: 30, max: 45 }], [70, { lines: '≈ 3 lines', words: 'approximately 40–55 words', min: 40, max: 55 }], [85, { lines: '≈ 3–4 lines', words: 'approximately 50–70 words', min: 50, max: 70 }], [100, { lines: '≈ 4–5 lines', words: 'approximately 65–90 words', min: 65, max: 90 }]]); }
function aggressionInstruction(value) { return band(value, [[10, 'Use a calm, neutral question with minimal confrontation.'], [30, 'Use a mild challenge that asks for a clear policy explanation.'], [50, 'Use a firm challenge and clearly expose the relevant disagreement.'], [70, 'Use strong direct wording and pressure; ask how the delegation can justify the contradiction.'], [85, 'Use very aggressive but MUN-usable wording. Lead into the contradiction and give little room for vague answers.'], [100, 'Use maximum directness. Lead with the strongest verified contradiction, remove unnecessary diplomatic cushioning, end with a direct challenge, and do not soften the wording. Do not use insults or unsupported accusations.']]); }
function controversyInstruction(value) { return band(value, [[10, 'Use a normal policy disagreement only.'], [30, 'Use a minor documented inconsistency if available.'], [50, 'Use a clear policy contradiction tied to the agenda.'], [70, 'Use a serious documented contradiction, commitment gap, vote, dispute, or implementation failure.'], [85, 'Prioritize major verified controversies, commitment failures, policy-practice gaps, legal disputes, or financial inconsistencies.'], [100, 'Search for the strongest relevant VERIFIED pressure point available: broken commitments, conflicting statements, voting contradictions, legal disputes, implementation failures, or financial inconsistencies. Never manufacture or exaggerate controversy.']]); }
function diplomacyInstruction(value) { return band(value, [[10, 'Use blunt, direct wording. Do not add diplomatic cushioning.'], [30, 'Use very direct MUN wording with minimal restraint.'], [50, 'Use normal MUN language with moderate diplomatic restraint.'], [70, 'Use formal language while preserving pressure.'], [85, 'Use highly diplomatic polish without weakening the challenge.'], [100, 'Use maximum diplomatic polish, but preserve the same substantive pressure and direct question. High diplomacy does not reduce pressure.']]); }
export function buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount, poiTypes = ['AUTO'] }) {
  const manualTargets = selectedTargets.map((c) => `${c.name} (${c.iso})`).join(', ') || 'NONE — target countries are optional; identify useful targets globally if target mode allows.';
  const info = lengthInfo(sliders.length);
  return `COMMITTEE:
${form.committee || 'Unspecified'}

AGENDA:
${form.agenda}

PORTFOLIO:
${form.portfolio}

TARGETS:
${manualTargets}

TARGET MODE:
${targetingMode === 'selected_only' ? 'SELECTED TARGETS ONLY' : 'SELECTED + GLOBAL RESEARCH'}

NUMBER OF POIs:
${poiCount}

AGGRESSION:
${sliders.aggression}/100

CONTROVERSY:
${sliders.controversy}/100

DIPLOMACY:
${sliders.diplomacy}/100

LENGTH:
${sliders.length}/100

TARGET WORD RANGE:
${info.words}

TARGET DISPLAY LENGTH:
${info.lines}

FOLLOW-UPS:
${includeFollowUp ? 'ON' : 'OFF'}

POI TYPE:
${poiTypes.join(', ')}

You are an expert competitive Model United Nations strategist.

Analyze the represented country's actual foreign-policy interests in relation to the committee and agenda.

Research credible evidence and relevant international legal frameworks.

Generate concise, simple, hard-hitting POIs.

Do not begin with 'Distinguished delegate'.

Begin directly with the substantive question.

Aggression controls confrontation. ${aggressionInstruction(sliders.aggression)}

Controversy controls research depth and political discomfort. ${controversyInstruction(sliders.controversy)}

Diplomacy controls wording. ${diplomacyInstruction(sliders.diplomacy)}

Length controls actual word count. Stay approximately within ${info.words} and ${info.lines}. Do not add filler.

The ideal POI should expose a documented contradiction, obligation, commitment, policy failure or controversy that makes a clean evasive answer difficult.

Do not claim a question is literally impossible to answer.

Do not fabricate:
- allegations
- violations
- statistics
- resolutions
- treaties
- quotations
- sources
- scandals
- government positions

Distinguish allegations from established facts.

Distinguish legally binding obligations from non-binding political commitments.

Use simple but precise English.

Do not write an academic essay.

Do not use ceremonial openings.

Do not add filler.

Every factual statement must be supported by a real source. Do not output 'VERIFICATION REQUIRED' as a source. If a claim cannot be verified, mark it MANUAL VERIFICATION. Never fabricate citations. Never fabricate URLs. Never invent foreign-policy positions. Prefer official government, UN, treaty, IMF, World Bank and other primary sources. Use reputable external reporting where primary sources do not cover the issue.

For every factual claim used in a POI, provide a real, traceable source. Use the strongest available source. Prefer primary sources: UN documents, official government documents, treaties, court judgments, IMF, World Bank, WTO, OECD, official statistics, and official reports. For controversies and events that primary sources do not adequately cover, use reputable journalism such as Reuters, AP, Financial Times, Bloomberg, BBC, etc. Never fabricate a source. Never fabricate a URL. Never fabricate a publication date. Do not use 'VERIFICATION REQUIRED' as a source. If you cannot establish a claim with a credible source, mark the claim as requiring manual verification instead of inventing evidence.

Source objects must include sourceName, organization, publicationDate, url, claimSupported, sourceType, and confidence. sourceType must be one of PRIMARY, GOVERNMENT, UN, INTERNATIONAL_ORGANIZATION, COURT, NEWS, ACADEMIC, THINK_TANK, OTHER_CREDIBLE.

Distinguish BINDING LEGAL OBLIGATION, NON-BINDING RESOLUTION, POLITICAL COMMITMENT, POLICY GUIDANCE, CUSTOMARY INTERNATIONAL LAW, ALLEGED VIOLATION, POLICY CONTRADICTION, LEGAL CONCERN, and POTENTIAL LEGAL ISSUE. Never call something a LEGAL VIOLATION unless the cited legal framework actually supports that characterization.

POI TYPE instructions: AUTO lets ChitForge/Gemini choose the strongest legitimate category. If one or more types are selected, prioritize and distribute across those types only where evidence supports them. Classification must be evidence-driven, not chosen merely because it sounds aggressive. Include classificationReason explaining why the classification fits.

Type definitions: POLICY CONTRADICTION = stated policy conflicts with conduct/position/vote/commitment; LEGAL ERROR = legally incorrect claim or misinterpretation; LEGAL TRAP = actual legal obligation/framework; COMMITMENT CONTRADICTION = commitment conflicts with actions; EVIDENCE TRAP = documented fact/statistic/report/record; ACCOUNTABILITY = asks to explain documented action; FINANCIAL PRESSURE = debt/lending/financial flows/sanctions/tax/development finance; IMPLEMENTATION FAILURE = commitment implementation falls short; VOTING CONTRADICTION = vote conflicts with stated position; TREATY / OBLIGATION = treaty or formal obligation; HISTORICAL CONTRADICTION = previous position/action conflicts with current position; CONTROVERSY = documented controversy central to POI.

Target countries are optional. If targets are selected, prioritize them. If no countries are selected, perform global research and identify countries relevant to the agenda, portfolio interests, legal obligations, international commitments, policy contradictions, documented controversies, financial conduct, voting behavior, implementation failures, diplomatic disputes, economic relevance, and committee relevance. If target mode is SELECTED + GLOBAL RESEARCH, selected countries must not prevent broader portfolio-interest analysis.

Use authoritative legal sources where relevant: UN Charter, UNSC resolutions, UNGA resolutions, ICJ judgments, treaties, WTO agreements, IMF/World Bank documents, G20 Common Framework, Paris Club principles, Addis Ababa Action Agenda, official government sources, and official court records. Do NOT call every UNGA resolution legally binding. Use LEGAL VIOLATION only where justified; otherwise use LEGAL CONCERN or POLICY CONTRADICTION.

Use reputable external sources for documented controversies: Reuters, AP, Financial Times, Bloomberg, BBC, Al Jazeera, major established newspapers, credible investigative organizations, academic publications, and established research institutions. Avoid random blogs, unsourced sites, anonymous claims, social media as primary evidence, AI-generated sources, and Wikipedia as primary evidence.

Generate exactly ${poiCount} distinct POIs. No duplicates. Each POI should preferably attack a different contradiction, commitment, legal issue, evidence point, implementation failure, policy issue, or financial issue.

Important concepts may be emphasized with Markdown-style bold markers around short phrases only.

If FOLLOW-UPS is OFF, set followUp to null for every POI. If ON, generate one concise follow-up that anticipates an evasive answer and presses the same issue from another angle.

Return ONLY the requested structured response.
Do not include introductory prose.
Do not use Markdown code fences.
Use valid JSON.
Use double quotes.
Do not use comments.
Do not use trailing commas.
Use null for optional values.
Follow the provided schema.

Required JSON shape:
{"pois":[{"target":"","question":"","legalFoundation":"","evidence":[{"sourceName":"","organization":"","publicationDate":"","url":"","claimSupported":"","sourceType":"PRIMARY","confidence":0}],"documentedIssue":"","classification":"","classificationReason":"","tacticalImpact":"","followUp":null}]}`;
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
