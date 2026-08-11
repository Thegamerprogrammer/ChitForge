import { getFreezeStatus } from './context.js';

const validationTests = ['Agenda relevance', 'Portfolio alignment', 'Target relevance', 'Evidence exists', 'No fabricated citation', 'Legal classification accurate', 'Procedurally usable POI', 'Pressure based on evidence', 'No unsupported accusation'];

export function validateMissionInputs({ agenda, portfolio, apiKey, mode }) {
  if (!agenda.trim()) return 'Enter an agenda/topic.';
  if (!portfolio.trim()) return 'Enter your portfolio/country.';
  if (!apiKey.trim()) return 'Enter your Gemini API key.';
  if (mode === 'manual') return '';
  return '';
}

export function calculatePressureScore(sliders, evidenceStrength = 55, contradictionStrength = 55, agendaRelevance = 70, legalRelevance = 60) {
  const score = Math.round(sliders.aggression * 0.26 + sliders.controversy * 0.24 + evidenceStrength * 0.18 + contradictionStrength * 0.16 + agendaRelevance * 0.1 + legalRelevance * 0.06);
  return Math.max(0, Math.min(100, score));
}

export function classifyPressure(score, types = []) {
  if (types.some((type) => /legal/i.test(type)) && score >= 70) return 'LEGAL PRESSURE';
  if (score >= 85) return 'TACTICAL TRAP';
  if (score >= 65) return 'HIGH PRESSURE';
  if (score >= 40) return 'MODERATE PRESSURE';
  return 'LOW PRESSURE';
}

export function normalizeMission(raw, ctx) {
  const fallbackChit = (target = 'AUTO-DISCOVERED TARGET') => ({
    target,
    pressureProfile: { ...ctx.sliders, score: calculatePressureScore(ctx.sliders, 0, 0, 30, 20), classification: 'VERIFICATION REQUIRED' },
    poi: 'VERIFICATION REQUIRED: The model response could not be parsed into a defensible Point of Information.',
    legalPolicyFoundation: 'VERIFICATION REQUIRED',
    evidence: [{ title: 'Malformed or unverifiable model response', organization: 'VERIFICATION REQUIRED', date: 'VERIFICATION REQUIRED', url: '', sourceClassification: 'OTHER', claim: 'The response did not match the required schema.' }],
    pressurePoint: { portfolioPosition: 'VERIFICATION REQUIRED', targetPositionAction: 'VERIFICATION REQUIRED', conflict: 'VERIFICATION REQUIRED', agendaRelevance: 'VERIFICATION REQUIRED' },
    legalTacticalTypes: ['VERIFICATION REQUIRED'],
    tacticalImpact: 'Insufficient verified evidence to assess pressure.',
    validation: validationTests.map((test) => ({ test, pass: false, notes: 'VERIFICATION REQUIRED' })),
  });
  try {
    const text = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
    const parsed = JSON.parse(text);
    const chits = (parsed.chits || []).map((chit) => normalizeChit(chit, ctx));
    return { portfolioProfile: parsed.portfolioProfile || { summary: 'VERIFICATION REQUIRED', interests: [] }, recommendedTargets: parsed.recommendedTargets || [], chits: chits.length ? chits : [fallbackChit()] };
  } catch {
    return { portfolioProfile: { summary: 'VERIFICATION REQUIRED', interests: [] }, recommendedTargets: [], chits: [fallbackChit()] };
  }
}

export function normalizeChit(chit, ctx) {
  const rawEvidence = Array.isArray(chit.evidence) && chit.evidence.length ? chit.evidence : [{ title: 'Source verification required', organization: 'VERIFICATION REQUIRED', date: 'VERIFICATION REQUIRED', publishedAt: '', eventDate: '', url: '', sourceClassification: 'OTHER', claim: 'No source was provided for this claim.' }];
  const evidence = rawEvidence.map((item) => ({ ...item, freezeStatus: item.freezeStatus || getFreezeStatus(item, ctx.researchContext || {}) }));
  const evidenceStrength = evidence.some((e) => e.url && /PRIMARY/i.test(e.sourceClassification || '')) ? 85 : evidence.some((e) => e.url) ? 65 : 15;
  const validation = validationTests.map((test) => {
    const provided = (chit.validation || []).find((v) => v.test?.toLowerCase() === test.toLowerCase());
    return provided || { test, pass: evidenceStrength > 50, notes: evidenceStrength > 50 ? 'Model marked as passing; verify source manually before use.' : 'VERIFICATION REQUIRED' };
  });
  const legalTypes = Array.isArray(chit.legalTacticalTypes) ? chit.legalTacticalTypes : ['Policy Contradiction'];
  const score = calculatePressureScore(ctx.sliders, evidenceStrength, Number(chit.contradictionStrength || 60), Number(chit.agendaRelevanceScore || 70), Number(chit.legalRelevanceScore || 60));
  return {
    target: chit.target || 'AUTO-DISCOVERED TARGET',
    pressureProfile: { ...ctx.sliders, score, classification: chit.pressureProfile?.classification || classifyPressure(score, legalTypes) },
    poi: chit.poi || 'VERIFICATION REQUIRED: No usable POI was generated.',
    legalPolicyFoundation: chit.legalPolicyFoundation || 'VERIFICATION REQUIRED',
    evidence,
    pressurePoint: chit.pressurePoint || { portfolioPosition: 'VERIFICATION REQUIRED', targetPositionAction: 'VERIFICATION REQUIRED', conflict: 'VERIFICATION REQUIRED', agendaRelevance: 'VERIFICATION REQUIRED' },
    legalTacticalTypes: legalTypes,
    tacticalImpact: chit.tacticalImpact || 'VERIFICATION REQUIRED',
    followUp: chit.followUp || null,
    validation,
  };
}
