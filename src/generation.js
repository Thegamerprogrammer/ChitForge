import { normalizeMission, validateMissionResponse } from './validation.js';

const endpoint = (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${encodeURIComponent(key)}`;

async function callGemini(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(endpoint(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.24, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 403) throw new Error('Gemini rejected the request. Check that the user-provided API key is valid and enabled for Gemini.');
      if (res.status === 429) throw new Error('Gemini rate limit reached. Wait briefly and try again.');
      throw new Error('Gemini request failed. Check your network connection and try again.');
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') || '';
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Gemini request timed out. Try fewer targets or a shorter agenda.', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateMission({ form, sliders, selectedTargets, targetingMode, includeFollowUp, onProgress }) {
  onProgress?.('Building Portfolio Intelligence Profile prompt...');
  const prompt = buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp });
  onProgress?.('Researching portfolio interests, agenda relevance, targets, evidence, and pressure points...');
  let text = await callGemini(form.apiKey, prompt);
  let mission = normalizeMission(text, { sliders, includeFollowUp });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const problems = validateMissionResponse(mission, { selectedTargets, targetingMode, includeFollowUp, sliders });
    if (!problems.length) break;
    onProgress?.(`Revision ${attempt + 1}/2: fixing validation issues (${problems.slice(0, 3).join('; ')})...`);
    text = await callGemini(form.apiKey, buildRevisionPrompt({ form, sliders, includeFollowUp, previous: mission, problems }));
    mission = normalizeMission(text, { sliders, includeFollowUp });
  }
  onProgress?.('Calculating word counts, speaking time, pressure score, and validation checklist...');
  return mission;
}

export async function generateFollowUp({ form, sliders, chit, apiKey, onProgress }) {
  onProgress?.(`Generating optional follow-up for ${chit.target}...`);
  const prompt = `Return STRICT JSON only, no markdown fences. Generate an optional follow-up for this MUN POI.\nAGENDA: ${form.agenda}\nPORTFOLIO: ${form.portfolio}\nSLIDERS: ${JSON.stringify(sliders)}\nEXISTING CHIT: ${JSON.stringify(chit)}\nReturn {"expectedEvasion":"...","question":"..."}. The follow-up must be short, direct, evidence-based, and must return to the original pressure point. Do not introduce unrelated issues, ceremonial openings, or new unsupported sources.`;
  const text = await callGemini(apiKey, prompt);
  const parsed = JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, ''));
  return { ...chit, followUp: { expectedEvasion: parsed.expectedEvasion || 'VERIFICATION REQUIRED', question: parsed.question || 'What evidence addresses the original contradiction directly?' } };
}

function band(value, bands) { return bands.find(([max]) => value <= max)?.[1] || bands.at(-1)[1]; }
function lengthRange(length) { return band(length, [[20, '10–20 words'], [40, '20–35 words'], [60, '30–50 words'], [80, '45–70 words'], [100, '60–100 words']]); }
function aggressionInstruction(value) { return band(value, [[10, 'Use a calm, neutral question with minimal confrontation: “How does the delegation propose...”'], [30, 'Use a mild challenge that asks for a clear policy explanation.'], [50, 'Use a firm challenge and clearly expose the relevant disagreement: “How does the delegation reconcile...”'], [70, 'Use a strong challenge, direct wording, and clear pressure: “How can the delegation justify...”'], [85, 'Use a very aggressive but MUN-usable challenge. Lead into the contradiction and give little room for vague answers: “How can the delegation defend...”'], [100, 'Use maximum directness. Lead with the strongest verified contradiction and directly challenge the delegation to justify it. Do not soften the wording.']]); }
function controversyInstruction(value) { return band(value, [[10, 'Use a normal policy disagreement only.'], [30, 'Use a minor documented inconsistency if available.'], [50, 'Use a clear policy contradiction tied to the agenda.'], [70, 'Use a serious documented contradiction, commitment gap, vote, dispute, or implementation failure.'], [85, 'Prioritize major verified controversies, commitment failures, policy-practice gaps, legal disputes, or financial inconsistencies.'], [100, 'Search for the strongest relevant VERIFIED pressure point available. Never manufacture or exaggerate controversy.']]); }
function diplomacyInstruction(value) { return band(value, [[10, 'Use blunt, direct wording. Do not add diplomatic cushioning.'], [30, 'Use very direct MUN wording with minimal restraint.'], [50, 'Use normal MUN language with moderate diplomatic restraint.'], [70, 'Use formal language while preserving pressure.'], [85, 'Use highly diplomatic polish without weakening the challenge.'], [100, 'Use maximum diplomatic polish, but preserve the same substantive pressure and direct question.']]); }

function styleProfile(sliders) {
  return [
    `Aggression: ${sliders.aggression}/100 — ${aggressionInstruction(sliders.aggression)}`,
    `Controversy: ${sliders.controversy}/100 — ${controversyInstruction(sliders.controversy)}`,
    `Diplomacy: ${sliders.diplomacy}/100 — ${diplomacyInstruction(sliders.diplomacy)}`,
    `Length: ${sliders.length}/100 — target spoken POI range ${lengthRange(sliders.length)}.`,
  ].join('\n');
}

export function buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp }) {
  const manualTargets = selectedTargets.map((c) => `${c.name} (${c.iso})`).join(', ') || 'NONE — zero selected targets is valid; use auto-discovery for Automatic/Hybrid.';
  return `You are ChitForge's MUN tactical POI generation engine. You are assisting a serious competitive MUN delegate. Every POI must be accurate, evidence-based, agenda-relevant, portfolio-aligned, easy to speak aloud, simple in English, concise, hard-hitting, and strategically useful. Do not write generic AI questions. Do not add ceremonial filler. The POI must begin directly with the substantive issue.

COMMITTEE: ${form.committee || 'Unspecified'}
AGENDA: ${form.agenda}
PORTFOLIO: ${form.portfolio}
TARGETING MODE: ${targetingMode}
SELECTED TARGETS: ${manualTargets}
AGGRESSION: ${sliders.aggression}/100
CONTROVERSY: ${sliders.controversy}/100
DIPLOMACY: ${sliders.diplomacy}/100
LENGTH: ${sliders.length}/100 (${lengthRange(sliders.length)})
FOLLOW-UP: ${includeFollowUp ? 'GENERATE' : 'DO NOT GENERATE'}

STYLE PROFILE:
${styleProfile(sliders)}

PIPELINE: PORTFOLIO → FOREIGN POLICY + COMMITTEE INTERESTS → AGENDA RELEVANCE → IDENTIFY PRESSURE POINTS → OPTIONAL TARGET SELECTION → RESEARCH TARGET → GENERATE POI → APPLY SLIDER STYLE → VERIFY EVIDENCE → CALCULATE PRESSURE INPUTS → OPTIONAL FOLLOW-UP.

TARGETING RULES: Required inputs are agenda and portfolio only. Targets are optional. Manual means use selected targets only; if none, return no chits and recommendedTargets explaining manual selection is needed. Automatic means research portfolio and agenda, then choose agenda-relevant countries based on foreign-policy conflict, economic relevance, committee relevance, policy contradictions, international commitments, and documented pressure points; do not choose merely famous or powerful states. Hybrid means recommend targets and use selected targets too. Never target the portfolio country against itself.

PORTFOLIO INTELLIGENCE: Before writing POIs, analyze foreign policy, official positions, committee interests, agenda priorities, economic interests, regional interests, alliances, treaty commitments, UN positions/voting where relevant, official statements, proposals, frameworks, and documented priorities. Determine what the portfolio actually wants, who supports/obstructs it, and what documented pressure points advance the portfolio's legitimate interests. Do not attack a country just because it is controversial.

TARGET RESEARCH: For each target, research agenda position, policies, treaty commitments, UN positions/voting, economic role, commitments, contradictions, policy-practice gaps, controversies, legal disputes, implementation failures, and financial/policy inconsistencies. Do not manufacture relevance.

WRITE LIKE A STRONG COMPETITIVE MUN DELEGATE. Use simple, concise English. Do not use complex vocabulary to sound intelligent. The question must be understandable when heard once. Every word must serve a purpose. Avoid academic filler, excessive legalese, long introductions, repetition, empty rhetoric, and ceremonial language. Simple English does not mean a simple argument.

START THE POI DIRECTLY. Never begin with: "Would the distinguished delegate", "Could the distinguished delegate", "Would the honorable delegation", "Could the honorable delegate", "Can the esteemed delegation", "May the delegate", or "Would the delegation kindly". Begin with the fact, contradiction, or challenge. Use pressure point + contradiction + question. Possible structures include: "How can the delegation support X while doing Y?"; "How does the delegation reconcile X with Y?"; "If the delegation supports X, why does it continue to do Y?"; "Why should this committee accept X when the delegation's own policy demonstrates Y?" Do not force every POI into one template.

When Aggression and Controversy are both high, do not merely use stronger adjectives. Change the strategy: find the strongest verified contradiction and center the POI on it. The objective is a question difficult to answer cleanly, not literally impossible.

Use Markdown bold for 1–4 important short phrases only, such as the core contradiction, obligation, pressure point, important action, or final demand. Do not bold entire sentences.

EVIDENCE AND LEGAL ACCURACY: Every factual claim used to create pressure must be supported by a real source. Prefer UN, IMF, World Bank, WTO, OECD, governments, treaty databases, official reports, courts, and then Reuters/FT/Bloomberg/AP/BBC/Al Jazeera. Never cite Wikipedia. Never invent citations, URLs, statistics, resolutions, treaty provisions, quotes, votes, cases, statements, or reports. Mark disputed claims DISPUTED. If evidence cannot be verified, do not use the claim. Distinguish binding legal obligation, treaty obligation, UN resolution, political commitment, international principle, recommendation, policy contradiction, documented controversy, allegation, and disputed claim. Do not call anything a legal violation unless evidence supports it.

FOLLOW-UP: ${includeFollowUp ? 'Generate EXPECTED EVASION and FOLLOW-UP. The follow-up must return directly to the original pressure point.' : 'Do not generate a follow-up. Set expected_evasion and follow_up to null.'}

Return STRICT JSON only, no markdown fences, in this schema:
{"research_summary":"...","portfolio_alignment":"...","portfolioProfile":{"summary":"...","orientation":"...","interests":["..."],"officialPositions":["..."],"economicInterests":["..."],"alliancesOrPartnerships":["..."],"treatyCommitments":["..."],"redLines":["..."],"sources":[{"title":"...","organization":"...","date":"...","url":"...","sourceClassification":"PRIMARY"}]},"recommendedTargets":[{"name":"...","iso":"ISO3","reason":"..."}],"chits":[{"target":"...","reasonForTargeting":"...","poi":"...","legalPolicyFoundation":"...","evidence":[{"title":"...","organization":"...","date":"...","url":"...","sourceClassification":"PRIMARY | HIGH-QUALITY SECONDARY | OTHER","claim":"..."}],"pressurePoint":{"portfolioPosition":"...","targetPositionAction":"...","conflict":"...","agendaRelevance":"..."},"legalTacticalTypes":["POLICY CONTRADICTION"],"tacticalImpact":"...","contradictionStrength":0,"agendaRelevanceScore":0,"portfolioAlignmentScore":0,"legalRelevanceScore":0,"validation":[{"test":"Agenda relevance","pass":true,"notes":"..."}],"followUp":${includeFollowUp ? '{"expectedEvasion":"...","question":"..."}' : 'null'}}]}`;
}

function buildRevisionPrompt({ form, sliders, includeFollowUp, previous, problems }) {
  return `Return STRICT JSON only, no markdown fences. The generated ChitForge mission failed validation. Problems: ${problems.join('; ')}. Inputs: committee=${form.committee || 'Unspecified'}; agenda=${form.agenda}; portfolio=${form.portfolio}; sliders=${JSON.stringify(sliders)}; follow-up=${includeFollowUp ? 'ON' : 'OFF'}. Rewrite the mission JSON to fix only these problems while preserving factual accuracy and existing evidence. Do not invent sources. POIs must start directly, avoid ceremonial openings, use simple concise English, include 1–4 Markdown bold phrases, and meet the length range ${lengthRange(sliders.length)}. Previous JSON: ${JSON.stringify(previous)}`;
}
