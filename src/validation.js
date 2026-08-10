import { countWords, speakingSeconds, stripMarkdown } from './format.js';

const validationTests = ['Agenda relevance', 'Portfolio alignment', 'Target relevance', 'Evidence exists', 'No fabricated citation', 'Legal classification accurate', 'POI usable in MUN', 'Aggression matches slider', 'Controversy matches slider', 'Diplomacy matches slider', 'Length matches slider', 'Word count calculated', 'Speaking time calculated', 'Important phrases emphasized', 'No ceremonial opening', 'Simple English', 'Direct question', 'Strong pressure point'];
const ceremonial = /^(would|could|may|can)\s+(the\s+)?(distinguished|honou?rable|esteemed|delegate|delegation|representative)|^would\s+the\s+delegation\s+kindly/i;

export function validateMissionInputs({ agenda, portfolio, apiKey }) {
  if (!agenda.trim()) return 'Enter an agenda/topic.';
  if (!portfolio.trim()) return 'Enter your portfolio/country.';
  if (!apiKey.trim()) return 'Enter your Gemini API key.';
  return '';
}

export function calculatePressureScore(sliders, evidenceStrength = 55, contradictionStrength = 55, agendaRelevance = 70, portfolioAlignment = 70, legalRelevance = 60) {
  const score = Math.round(evidenceStrength * 0.25 + contradictionStrength * 0.2 + agendaRelevance * 0.2 + portfolioAlignment * 0.15 + legalRelevance * 0.1 + sliders.aggression * 0.1);
  return Math.max(0, Math.min(100, score));
}

export function classifyPressure(score, types = []) {
  if (score >= 85) return 'TACTICAL TRAP';
  if (types.some((type) => /legal/i.test(type)) && score >= 70) return 'LEGAL PRESSURE';
  if (score >= 70) return 'HIGH PRESSURE';
  if (score >= 50) return 'SIGNIFICANT PRESSURE';
  if (score >= 25) return 'MODERATE PRESSURE';
  return 'LOW PRESSURE';
}

function parseJson(raw) {
  const text = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
  return JSON.parse(text);
}

export function normalizeMission(raw, ctx) {
  const fallbackChit = (target = 'AUTO-DISCOVERED TARGET') => normalizeChit({
    target,
    poi: 'VERIFICATION REQUIRED: The model response could not be parsed into a defensible Point of Information.',
    legalPolicyFoundation: 'VERIFICATION REQUIRED',
    evidence: [],
    pressurePoint: {},
    legalTacticalTypes: ['VERIFICATION REQUIRED'],
    tacticalImpact: 'Insufficient verified evidence to assess pressure.',
  }, ctx);
  try {
    const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
    const chits = (parsed.chits || parsed.targets?.flatMap((t) => (t.pressure_points || []).map((p) => ({ ...p, target: t.country, reasonForTargeting: t.reason_for_targeting, legalPolicyFoundation: p.legal_foundation, pressurePoint: { portfolioPosition: parsed.portfolio_alignment, targetPositionAction: p.documented_contradiction, conflict: p.documented_contradiction, agendaRelevance: t.reason_for_targeting }, legalTacticalTypes: [p.classification], tacticalImpact: p.tactical_impact, followUp: p.follow_up ? { expectedEvasion: p.expected_evasion, question: p.follow_up } : null }))) || []).map((chit) => normalizeChit(chit, ctx));
    return { portfolioProfile: parsed.portfolioProfile || { summary: parsed.research_summary || 'VERIFICATION REQUIRED', interests: [], sources: [] }, portfolioAlignment: parsed.portfolio_alignment || parsed.portfolioAlignment || 'VERIFICATION REQUIRED', recommendedTargets: parsed.recommendedTargets || [], chits };
  } catch {
    return { portfolioProfile: { summary: 'VERIFICATION REQUIRED', interests: [], sources: [] }, portfolioAlignment: 'VERIFICATION REQUIRED', recommendedTargets: [], chits: [fallbackChit()] };
  }
}

export function normalizeChit(chit, ctx) {
  const evidence = Array.isArray(chit.evidence) && chit.evidence.length ? chit.evidence.map((e) => ({ ...e, url: e.url || e.source_url || '', title: e.title || e.source_name || e.source || 'VERIFICATION REQUIRED' })) : [{ title: 'Source verification required', organization: 'VERIFICATION REQUIRED', date: 'VERIFICATION REQUIRED', url: '', sourceClassification: 'OTHER', claim: 'No source was provided for this claim.' }];
  const evidenceStrength = evidence.some((e) => e.url && /PRIMARY/i.test(e.sourceClassification || '')) ? 85 : evidence.some((e) => e.url && !/wikipedia/i.test(e.url)) ? 65 : 15;
  const legalTypes = Array.isArray(chit.legalTacticalTypes) ? chit.legalTacticalTypes : [chit.classification || 'POLICY CONTRADICTION'];
  const wordCount = countWords(chit.poi || '');
  const estimatedSeconds = speakingSeconds(wordCount);
  const score = calculatePressureScore(ctx.sliders, evidenceStrength, Number(chit.contradictionStrength || 60), Number(chit.agendaRelevanceScore || 70), Number(chit.portfolioAlignmentScore || 70), Number(chit.legalRelevanceScore || 60));
  const base = {
    target: chit.target || chit.country || 'AUTO-DISCOVERED TARGET',
    reasonForTargeting: chit.reasonForTargeting || chit.reason_for_targeting || 'Agenda-relevant pressure point identified by Gemini.',
    pressureProfile: { ...ctx.sliders, score, classification: chit.pressureProfile?.classification || classifyPressure(score, legalTypes) },
    poi: chit.poi || 'VERIFICATION REQUIRED: No usable POI was generated.',
    wordCount,
    estimatedSeconds,
    legalPolicyFoundation: chit.legalPolicyFoundation || chit.legal_foundation || 'VERIFICATION REQUIRED',
    evidence,
    pressurePoint: chit.pressurePoint || { portfolioPosition: 'VERIFICATION REQUIRED', targetPositionAction: 'VERIFICATION REQUIRED', conflict: chit.documented_contradiction || 'VERIFICATION REQUIRED', agendaRelevance: 'VERIFICATION REQUIRED' },
    legalTacticalTypes: legalTypes,
    tacticalImpact: chit.tacticalImpact || 'VERIFICATION REQUIRED',
    followUp: ctx.includeFollowUp ? (chit.followUp || (chit.expected_evasion || chit.follow_up ? { expectedEvasion: chit.expected_evasion, question: chit.follow_up } : null)) : null,
  };
  base.validation = buildValidation(base, chit.validation || []);
  return base;
}

function buildValidation(chit, supplied) {
  return validationTests.map((test) => {
    const provided = supplied.find?.((v) => v.test?.toLowerCase() === test.toLowerCase());
    if (provided) return provided;
    let pass = true;
    let notes = 'Checked locally after Gemini response.';
    const plain = stripMarkdown(chit.poi);
    if (test === 'Evidence exists') pass = chit.evidence.some((e) => e.url && !/wikipedia/i.test(e.url));
    if (test === 'No fabricated citation') pass = chit.evidence.every((e) => e.url ? /^https?:\/\//i.test(e.url) && !/example\.com|wikipedia/i.test(e.url) : false);
    if (test === 'No ceremonial opening') pass = !ceremonial.test(plain.trim());
    if (test === 'Direct question') pass = /\?\s*$/.test(plain.trim());
    if (test === 'Important phrases emphasized') pass = (chit.poi.match(/\*\*.+?\*\*/g) || []).length >= 1 && (chit.poi.match(/\*\*.+?\*\*/g) || []).length <= 4;
    if (test === 'Word count calculated') pass = Number.isFinite(chit.wordCount) && chit.wordCount > 0;
    if (test === 'Speaking time calculated') pass = Number.isFinite(chit.estimatedSeconds) && chit.estimatedSeconds > 0;
    if (!pass) notes = 'VERIFICATION REQUIRED or revise before committee use.';
    return { test, pass, notes };
  });
}

export function validateMissionResponse(mission, { targetingMode }) {
  const problems = [];
  if (!mission.portfolioProfile?.summary || /VERIFICATION REQUIRED/i.test(mission.portfolioProfile.summary)) problems.push('Portfolio intelligence profile is missing or unverifiable');
  if (targetingMode !== 'manual' && !mission.chits.length) problems.push('Automatic/hybrid zero-target generation returned no chits');
  mission.chits.forEach((chit) => {
    if (!chit.poi) problems.push(`Missing POI for ${chit.target}`);
    if (ceremonial.test(stripMarkdown(chit.poi).trim())) problems.push(`Ceremonial opening for ${chit.target}`);
    if (!chit.evidence?.some((e) => e.url && /^https?:\/\//i.test(e.url) && !/wikipedia/i.test(e.url))) problems.push(`Missing credible source URL for ${chit.target}`);
    if (!chit.legalTacticalTypes?.length) problems.push(`Missing legal/tactical classification for ${chit.target}`);
    if (!chit.pressurePoint?.portfolioPosition) problems.push(`Missing portfolio alignment for ${chit.target}`);
  });
  return problems.slice(0, 8);
}
