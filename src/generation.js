import { callGemini, GeminiError } from './gemini.js';
import { normalizeMission, validateMissionResponse, findDuplicatePoiIndexes } from './validation.js';

export async function generateMission({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount, onProgress }) {
  onProgress?.({ stage: 'RESEARCHING PORTFOLIO', detail: 'Building Portfolio Intelligence Profile prompt...', done: 0, total: poiCount });
  const prompt = buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount });
  onProgress?.({ stage: 'ANALYZING TARGETS', detail: 'Researching agenda-relevant targets and pressure points...', done: 0, total: poiCount });
  let text = await callGemini(form.apiKey, prompt);
  let mission = normalizeMission(text, { sliders, includeFollowUp, poiCount });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const problems = validateMissionResponse(mission, { selectedTargets, targetingMode, includeFollowUp, sliders, poiCount });
    if (!problems.length) break;
    onProgress?.({ stage: 'VALIDATING EVIDENCE', detail: `Revision ${attempt + 1}/2: ${problems.slice(0, 3).join('; ')}`, done: mission.chits.length, total: poiCount });
    const malformedRequest = problems.some((problem) => /request payload|model unavailable|api key/i.test(problem));
    if (malformedRequest) break;
    text = await callGemini(form.apiKey, buildRevisionPrompt({ form, sliders, includeFollowUp, previous: mission, problems, poiCount }));
    mission = normalizeMission(text, { sliders, includeFollowUp, poiCount });
  }
  const duplicates = findDuplicatePoiIndexes(mission.chits);
  if (duplicates.length) {
    onProgress?.({ stage: 'GENERATING POIs', detail: `Replacing ${duplicates.length} duplicate POI(s)...`, done: mission.chits.length - duplicates.length, total: poiCount });
    mission = await replaceDuplicatePois({ form, sliders, includeFollowUp, mission, duplicates, poiCount });
  }
  const missing = Math.max(0, poiCount - mission.chits.length);
  if (missing) {
    onProgress?.({ stage: 'GENERATING POIs', detail: `Gemini returned ${mission.chits.length}/${poiCount}. Attempting ${missing} missing POI(s)...`, done: mission.chits.length, total: poiCount });
    mission = await generateMissingPois({ form, sliders, selectedTargets, targetingMode, includeFollowUp, mission, missing, poiCount });
  }
  onProgress?.({ stage: 'FINALIZING TACTICAL BRIEF', detail: `${mission.chits.length}/${poiCount} POIs generated. Calculating local metrics...`, done: mission.chits.length, total: poiCount });
  return mission;
}

export async function regenerateChit({ form, sliders, chit, existingChits, apiKey, includeFollowUp, onProgress }) {
  onProgress?.({ stage: 'GENERATING POIs', detail: `Regenerating POI for ${chit.target}...`, done: 0, total: 1 });
  const prompt = `Return STRICT JSON only, no markdown fences. Regenerate exactly 1 distinct ChitForge POI to replace the weak POI below. Use the same agenda, portfolio, target, slider profile, evidence standards, simple English, no ceremonial opening, and Markdown bold emphasis. Do not duplicate these existing POIs: ${JSON.stringify(existingChits.map((item) => item.poi))}.\nAGENDA: ${form.agenda}\nPORTFOLIO: ${form.portfolio}\nTARGET: ${chit.target}\nSLIDERS: ${JSON.stringify(sliders)}\nFOLLOW-UP: ${includeFollowUp ? 'GENERATE' : 'DO NOT GENERATE'}\nOLD CHIT: ${JSON.stringify(chit)}\nReturn schema {"research_summary":"...","portfolio_alignment":"...","targets":[{"country":"${chit.target}","pressure_points":[{"poi":"...","legal_foundation":"...","evidence":[{"claim":"...","source_name":"...","source_url":"..."}],"documented_contradiction":"...","tactical_impact":"...","classification":"...","follow_up":${includeFollowUp ? '"..."' : 'null'}}]}]}`;
  const text = await callGemini(apiKey, prompt);
  const mission = normalizeMission(text, { sliders, includeFollowUp, poiCount: 1 });
  return mission.chits[0] || chit;
}

export async function generateFollowUp({ form, sliders, chit, apiKey, onProgress }) {
  onProgress?.({ stage: 'GENERATING FOLLOW-UP', detail: `Generating optional follow-up for ${chit.target}...`, done: 0, total: 1 });
  const prompt = `Return STRICT JSON only, no markdown fences. Generate an optional follow-up for this MUN POI.\nAGENDA: ${form.agenda}\nPORTFOLIO: ${form.portfolio}\nSLIDERS: ${JSON.stringify(sliders)}\nEXISTING CHIT: ${JSON.stringify(chit)}\nReturn {"expectedEvasion":"...","question":"..."}. The follow-up must be short, direct, evidence-based, and must return to the original pressure point. Do not introduce unrelated issues, ceremonial openings, or new unsupported sources.`;
  const text = await callGemini(apiKey, prompt);
  try {
    const parsed = JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, ''));
    return { ...chit, followUp: { expectedEvasion: parsed.expectedEvasion || 'VERIFICATION REQUIRED', question: parsed.question || 'What evidence addresses the original contradiction directly?' } };
  } catch (cause) {
    throw new GeminiError('Invalid JSON returned by Gemini while generating the follow-up. Try again.', { category: 'invalid-json', cause });
  }
}

function band(value, bands) { return bands.find(([max]) => value <= max)?.[1] || bands.at(-1)[1]; }
function lengthRange(length) { return band(length, [[20, '10–20 words'], [40, '20–35 words'], [60, '30–50 words'], [80, '45–70 words'], [100, '60–100 words']]); }
function aggressionInstruction(value) { return band(value, [[10, 'Use a calm, neutral question with minimal confrontation.'], [30, 'Use a mild challenge that asks for a clear policy explanation.'], [50, 'Use a firm challenge and clearly expose the relevant disagreement.'], [70, 'Use strong direct wording and pressure; ask how the delegation can justify the contradiction.'], [85, 'Use very aggressive but MUN-usable wording. Lead into the contradiction and give little room for vague answers.'], [100, 'Use maximum directness. Lead with the strongest verified contradiction, remove unnecessary diplomatic cushioning, end with a direct challenge, and do not soften the wording. Do not use insults or unsupported accusations.']]); }
function controversyInstruction(value) { return band(value, [[10, 'Use a normal policy disagreement only.'], [30, 'Use a minor documented inconsistency if available.'], [50, 'Use a clear policy contradiction tied to the agenda.'], [70, 'Use a serious documented contradiction, commitment gap, vote, dispute, or implementation failure.'], [85, 'Prioritize major verified controversies, commitment failures, policy-practice gaps, legal disputes, or financial inconsistencies.'], [100, 'Search for the strongest relevant VERIFIED pressure point available: broken commitments, conflicting statements, voting contradictions, legal disputes, implementation failures, or financial inconsistencies. Never manufacture or exaggerate controversy.']]); }
function diplomacyInstruction(value) { return band(value, [[10, 'Use blunt, direct wording. Do not add diplomatic cushioning.'], [30, 'Use very direct MUN wording with minimal restraint.'], [50, 'Use normal MUN language with moderate diplomatic restraint.'], [70, 'Use formal language while preserving pressure.'], [85, 'Use highly diplomatic polish without weakening the challenge.'], [100, 'Use maximum diplomatic polish, but preserve the same substantive pressure and direct question. High diplomacy does not reduce pressure.']]); }
function styleProfile(sliders) { return [`AGGRESSION: ${sliders.aggression}/100 — ${aggressionInstruction(sliders.aggression)}`, `CONTROVERSY: ${sliders.controversy}/100 — ${controversyInstruction(sliders.controversy)}`, `DIPLOMACY: ${sliders.diplomacy}/100 — ${diplomacyInstruction(sliders.diplomacy)}`, `LENGTH: ${sliders.length}/100 — generate each spoken POI in the target range ${lengthRange(sliders.length)}. Do not pad the question.`].join('\n'); }

export function buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount }) {
  const manualTargets = selectedTargets.map((c) => `${c.name} (${c.iso})`).join(', ') || 'NONE — zero selected targets is valid; use auto-discovery for Automatic/Hybrid.';
  return `You are ChitForge's MUN tactical POI generation engine. Every POI must be accurate, evidence-based, agenda-relevant, portfolio-aligned, easy to speak aloud, simple in English, concise, hard-hitting, and strategically useful. Do not write generic AI questions. Do not add ceremonial filler. The POI must begin directly with the substantive issue.

COMMITTEE: ${form.committee || 'Unspecified'}
AGENDA: ${form.agenda}
PORTFOLIO: ${form.portfolio}
TARGETING MODE: ${targetingMode}
SELECTED TARGETS: ${manualTargets}
NUMBER OF POIs: ${poiCount}
AGGRESSION: ${sliders.aggression}/100
CONTROVERSY: ${sliders.controversy}/100
DIPLOMACY: ${sliders.diplomacy}/100
LENGTH: ${sliders.length}/100 (${lengthRange(sliders.length)})
FOLLOW-UP: ${includeFollowUp ? 'GENERATE' : 'DO NOT GENERATE'}

Generate exactly ${poiCount} distinct POI chits. Do not return fewer. Do not return more. Do not duplicate arguments. Each POI must have a distinct tactical purpose. Each POI should use a different primary pressure point whenever the available evidence allows it. Do not simply rewrite the same question with different wording. Avoid duplicate evidence unless it is necessary for a different argument. The total number of pressure_points across all targets must equal ${poiCount}. If multiple targets are selected, distribute POIs intelligently based on evidence quality and agenda relevance; do not force equal distribution when one target has stronger evidence.

SLIDER BEHAVIORAL INSTRUCTIONS:
${styleProfile(sliders)}

PIPELINE: USER INPUT → BUILD FULL GEMINI PROMPT → PORTFOLIO → FOREIGN POLICY + COMMITTEE INTERESTS → AGENDA RELEVANCE → IDENTIFY PRESSURE POINTS → OPTIONAL TARGET SELECTION → RESEARCH TARGET → GENERATE POI → APPLY SLIDER STYLE → VERIFY EVIDENCE → RETURN STRUCTURED JSON.

TARGETING RULES: Required inputs are agenda and portfolio only. Targets are optional. Manual means use selected targets only; if none, return no POIs and explain manual selection is needed. Automatic means research portfolio and agenda, then choose agenda-relevant countries based on foreign-policy conflict, economic relevance, committee relevance, policy contradictions, international commitments, and documented pressure points; do not choose merely famous or powerful states. Hybrid means recommend targets and use selected targets too. Never target the portfolio country against itself.

PORTFOLIO INTELLIGENCE: Before writing POIs, analyze foreign policy, official positions, committee interests, agenda priorities, economic interests, regional interests, alliances, treaty commitments, UN positions/voting where relevant, official statements, proposals, frameworks, and documented priorities. Determine what the portfolio actually wants, who supports/obstructs it, and what documented pressure points advance the portfolio's legitimate interests.

TARGET RESEARCH: For each target, research agenda position, policies, treaty commitments, UN positions/voting, economic role, commitments, contradictions, policy-practice gaps, controversies, legal disputes, implementation failures, and financial/policy inconsistencies. Do not manufacture relevance.

START THE POI DIRECTLY. Never begin with ceremonial phrases such as distinguished delegate, honorable delegation, esteemed delegation, may the delegate, or would the delegation kindly. Use pressure point + contradiction + question. Use simple, spoken English. Avoid academic filler, legalese, repetition, empty rhetoric, and long introductions.

When Aggression and Controversy are both high, do not merely use stronger adjectives. Change the strategy: find the strongest verified contradiction and center the POI on it. The objective is a question difficult to answer cleanly, not literally impossible.

Use Markdown bold for 1–4 important short phrases only, such as the core contradiction, obligation, pressure point, important action, or final demand. Do not bold entire sentences.

EVIDENCE AND LEGAL ACCURACY: Every factual claim used to create pressure must be supported by a real source. Prefer UN, IMF, World Bank, WTO, OECD, governments, treaty databases, official reports, courts, and then Reuters/FT/Bloomberg/AP/BBC/Al Jazeera. Never cite Wikipedia. Never invent citations, URLs, statistics, resolutions, treaty provisions, quotes, votes, cases, statements, or reports. Mark disputed claims DISPUTED. If evidence cannot be verified, do not use the claim. Distinguish binding legal obligation, treaty obligation, UN resolution, political commitment, international principle, recommendation, policy contradiction, documented controversy, allegation, and disputed claim. Do not call anything a legal violation unless evidence supports it.

FOLLOW-UP: ${includeFollowUp ? 'Generate expected_evasion and follow_up for each pressure point. The follow-up must return directly to the original pressure point.' : 'Do not generate follow-ups. Set follow_up to null.'}

Return STRICT JSON only, no markdown fences, in this schema:
{"research_summary":"...","portfolio_alignment":"...","portfolioProfile":{"summary":"...","orientation":"...","interests":["..."],"officialPositions":["..."],"economicInterests":["..."],"alliancesOrPartnerships":["..."],"treatyCommitments":["..."],"redLines":["..."],"sources":[{"title":"...","organization":"...","date":"...","url":"...","sourceClassification":"PRIMARY"}]},"recommendedTargets":[{"name":"...","iso":"ISO3","reason":"..."}],"targets":[{"country":"...","iso":"ISO3","reason_for_targeting":"...","pressure_points":[{"title":"...","poi":"...","legal_foundation":"...","evidence":[{"claim":"...","source_name":"...","source_url":"...","sourceClassification":"PRIMARY | HIGH-QUALITY SECONDARY | OTHER"}],"documented_contradiction":"...","tactical_impact":"...","classification":"LEGAL PRESSURE | POLICY CONTRADICTION | COMMITMENT TRAP | VOTING CONTRADICTION | IMPLEMENTATION FAILURE | FINANCIAL CONTRADICTION | POLICY-PRACTICE GAP | ACCOUNTABILITY TRAP","contradictionStrength":0,"agendaRelevanceScore":0,"portfolioAlignmentScore":0,"legalRelevanceScore":0,"expected_evasion":${includeFollowUp ? '"..."' : 'null'},"follow_up":${includeFollowUp ? '"..."' : 'null'}}]}]}`;
}

function buildRevisionPrompt({ form, sliders, includeFollowUp, previous, problems, poiCount }) {
  return `Return STRICT JSON only, no markdown fences. The generated ChitForge mission failed validation. Problems: ${problems.join('; ')}. Inputs: committee=${form.committee || 'Unspecified'}; agenda=${form.agenda}; portfolio=${form.portfolio}; POI count=${poiCount}; sliders=${JSON.stringify(sliders)}; follow-up=${includeFollowUp ? 'ON' : 'OFF'}. Rewrite the mission JSON to fix these problems while preserving factual accuracy. Do not invent sources. Return exactly ${poiCount} distinct POIs total across targets unless Manual mode has zero targets. Do not duplicate arguments. POIs must start directly, avoid ceremonial openings, use simple concise English, include 1–4 Markdown bold phrases, and meet ${lengthRange(sliders.length)}. Previous JSON: ${JSON.stringify(previous)}`;
}

async function generateMissingPois({ form, sliders, selectedTargets, targetingMode, includeFollowUp, mission, missing, poiCount }) {
  const prompt = buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount: missing }) + `\n\nAlready generated POIs to avoid duplicating: ${JSON.stringify(mission.chits.map((chit) => chit.poi))}. Generate exactly ${missing} additional distinct replacement POI chits only.`;
  const text = await callGemini(form.apiKey, prompt);
  const extra = normalizeMission(text, { sliders, includeFollowUp, poiCount: missing });
  return { ...mission, chits: [...mission.chits, ...extra.chits].slice(0, poiCount), recommendedTargets: [...(mission.recommendedTargets || []), ...(extra.recommendedTargets || [])] };
}

async function replaceDuplicatePois({ form, sliders, includeFollowUp, mission, duplicates, poiCount }) {
  const keep = mission.chits.filter((_, index) => !duplicates.includes(index));
  const prompt = `Return STRICT JSON only, no markdown fences. Generate exactly ${duplicates.length} distinct replacement POI chits. Do not duplicate these POIs: ${JSON.stringify(keep.map((chit) => chit.poi))}. Agenda: ${form.agenda}. Portfolio: ${form.portfolio}. Sliders: ${JSON.stringify(sliders)}. Follow-up: ${includeFollowUp ? 'GENERATE' : 'DO NOT GENERATE'}. Use the same ChitForge schema with targets[].pressure_points[].`;
  const text = await callGemini(form.apiKey, prompt);
  const replacement = normalizeMission(text, { sliders, includeFollowUp, poiCount: duplicates.length });
  return { ...mission, chits: [...keep, ...replacement.chits].slice(0, poiCount) };
}
