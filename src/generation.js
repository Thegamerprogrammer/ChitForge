import { formatContextBlock } from './context.js';
import { normalizeMission } from './validation.js';

const endpoint = (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${encodeURIComponent(key)}`;

async function callGemini(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(endpoint(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.28, responseMimeType: 'application/json' } }),
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

export async function generateMission({ form, sliders, selectedTargets, targetingMode, includeFollowUp, researchContext, onProgress }) {
  onProgress?.('1/18 Reading agenda and portfolio...');
  const prompt = buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, researchContext });
  onProgress?.('2/18 Researching portfolio intelligence profile and interests...');
  const text = await callGemini(form.apiKey, prompt);
  onProgress?.('16/18 Validating evidence, source integrity, and legal classifications...');
  return normalizeMission(text, { sliders, includeFollowUp, researchContext });
}

export async function generateFollowUp({ form, sliders, chit, apiKey, onProgress }) {
  onProgress?.(`Generating optional follow-up for ${chit.target}...`);
  const prompt = `Return JSON only. Generate a follow-up for this MUN POI. Agenda: ${form.agenda}. Portfolio: ${form.portfolio}. Sliders: ${JSON.stringify(sliders)}. Existing chit: ${JSON.stringify(chit)}. Return {expectedEvasion, question}. The follow-up must be concise, procedurally appropriate, evidence-based, and must bring the target back to the original pressure point. Do not invent new sources or claims.`;
  const text = await callGemini(apiKey, prompt);
  try {
    return { ...chit, followUp: JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '')) };
  } catch {
    return { ...chit, followUp: { expectedEvasion: 'VERIFICATION REQUIRED', question: 'Could the distinguished delegate address the original documented pressure point directly?' } };
  }
}

function sliderGuidance(sliders) {
  const aggression = sliders.aggression >= 85 ? 'very high: use a contradiction/commitment/legal consistency trap structure' : sliders.aggression >= 60 ? 'high: direct confrontation of a documented inconsistency' : sliders.aggression >= 30 ? 'medium: firm challenge' : 'low: diplomatic inquiry';
  const controversy = sliders.controversy >= 85 ? 'very high: strongest relevant defensible pressure point; no fabricated scandal' : sliders.controversy >= 60 ? 'high: documented controversies, commitments, disputes, voting or financial contradictions' : sliders.controversy >= 30 ? 'medium: policy contradictions and implementation failures' : 'low: conventional policy disagreement';
  const diplomacy = sliders.diplomacy >= 70 ? 'formal, respectful, legally precise language without reducing pressure' : sliders.diplomacy >= 35 ? 'professional MUN wording' : 'blunt, concise wording without insults';
  const length = sliders.length >= 80 ? 'long supporting intelligence, but spoken POI remains concise' : sliders.length >= 45 ? 'moderate supporting detail' : 'short compact chit';
  return { aggression, controversy, diplomacy, length };
}

function buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, researchContext }) {
  const manualTargets = selectedTargets.map((c) => `${c.name} (${c.iso})`).join(', ') || 'NONE';
  return `You are ChitForge, an open-source frontend-only MUN tactical POI/chit generator. Return exactly one JSON object, no markdown.

Generation pipeline MUST happen in this order: read agenda; read portfolio; build Portfolio Intelligence Profile; determine what the portfolio actually wants on this agenda; determine legal/policy frameworks; determine targets using mode ${targetingMode}; research target positions; identify pressure points; apply sliders; validate evidence; calculate pressure; optionally include follow-up.

${formatContextBlock(researchContext)}

Committee: ${form.committee || 'Unspecified'}
Agenda: ${form.agenda}
Portfolio country: ${form.portfolio}
Targeting mode: ${targetingMode}
Manual targets selected: ${manualTargets}
Generate follow-up now: ${includeFollowUp ? 'YES' : 'NO'}
Sliders: ${JSON.stringify(sliders)}
Slider guidance: ${JSON.stringify(sliderGuidance(sliders))}

Context hierarchy:
1. MUN rules / freeze date; 2. Committee + agenda; 3. Background guide; 4. User research notes; 5. Target countries; 6. Opposition countries; 7. Retrieved evidence; 8. Model instructions. Retrieved authoritative evidence remains the factual source of truth.

Targeting rules:
- Target countries are OPTIONAL. If mode is automatic, or hybrid with no manual targets, discover agenda-relevant targets.
- If mode is hybrid and manual targets exist, generate for manual targets and add up to 3 recommended targets only if strongly justified.
- If mode is manual, use selected manual targets only; if none selected, return no chits and a recommendedTargets note explaining manual mode needs map selection.
- Never choose targets merely because they are powerful. Choose because their documented policy/action conflicts with portfolio interests on the agenda.
- Do not target the portfolio country against itself.

Background guide understanding requirements:
If a background guide is attached, first extract and use its committee, agenda, scope, historical context, key actors, dates, legal frameworks, terminology, stated questions, likely debate areas, proposed solutions, incidents, treaties/resolutions, and committee-specific framing. Use guide terms to improve official-source search strategy (for example, search named resolutions with official repositories). The guide is context only, not evidence.

Freeze-date requirements:
Every source should include publishedAt where available and every finding should include eventDate where applicable. If freeze enforcement is enabled, do not use events after the freeze date as primary MUN evidence. If post-freeze sources for pre-freeze events are allowed, label them as secondary confirmation. If disabled, reject post-freeze publications.

Portfolio intelligence requirements:
Create portfolioProfile with summary, orientation, interests[], officialPositions[], economicInterests[], alliancesOrPartnerships[], treatyCommitments[], redLines[], and sources[]. Distinguish official government position, treaty obligation, UN position, political commitment, economic interest, historical/current/reported position. Mark uncertainty VERIFICATION REQUIRED.

Source integrity and legal accuracy:
Never fabricate sources, URLs, stats, UN resolutions, treaty articles, quotes, votes, court cases, government statements, or news. Wikipedia must not be cited. Prefer UN, IMF, World Bank, WTO, OECD, governments, courts, treaty databases, official reports; then Reuters/FT/Bloomberg/AP/BBC/Al Jazeera. Do not call something a legal violation unless evidence supports it. Distinguish binding legal obligation, treaty obligation, UN resolution, political commitment, international principle, policy recommendation, policy contradiction, documented controversy, allegation, disputed claim.

Return schema:
{
  "portfolioProfile": {"summary":"...","orientation":"...","interests":["..."],"officialPositions":["..."],"economicInterests":["..."],"alliancesOrPartnerships":["..."],"treatyCommitments":["..."],"redLines":["..."],"sources":[{"title":"...","organization":"...","date":"...","url":"...","sourceClassification":"PRIMARY"}]},
  "recommendedTargets": [{"name":"...","iso":"...","reason":"agenda-relevant conflict with portfolio interests"}],
  "chits": [{
    "target":"Country / institution / actor",
    "poi":"Actual concise MUN Point of Information",
    "legalPolicyFoundation":"Framework and how it relates; state if non-binding or disputed",
    "evidence":[{"title":"...","organization":"...","date":"...","publishedAt":"YYYY-MM-DD where available","eventDate":"YYYY-MM-DD where applicable","url":"...","sourceClassification":"PRIMARY | HIGH-QUALITY SECONDARY | OTHER","freezeStatus":"🟢 Before freeze | 🟡 Post-freeze source / pre-freeze event | 🔴 Post-freeze event","claim":"What source establishes"}],
    "pressurePoint":{"portfolioPosition":"...","targetPositionAction":"...","conflict":"...","agendaRelevance":"..."},
    "legalTacticalTypes":["Policy Contradiction"],
    "tacticalImpact":"Explain why difficult to answer cleanly; never say unanswerable.",
    "contradictionStrength":0-100,
    "agendaRelevanceScore":0-100,
    "legalRelevanceScore":0-100,
    "validation":[{"test":"Agenda relevance","pass":true,"notes":"..."},{"test":"Portfolio alignment","pass":true,"notes":"..."},{"test":"Target relevance","pass":true,"notes":"..."},{"test":"Evidence exists","pass":true,"notes":"..."},{"test":"No fabricated citation","pass":true,"notes":"..."},{"test":"Legal classification accurate","pass":true,"notes":"..."},{"test":"Procedurally usable POI","pass":true,"notes":"..."},{"test":"Pressure based on evidence","pass":true,"notes":"..."},{"test":"No unsupported accusation","pass":true,"notes":"..."}]${includeFollowUp ? ',"followUp":{"expectedEvasion":"...","question":"..."}' : ''}
  }]
}`;
}
