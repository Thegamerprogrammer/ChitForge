import mammoth from 'mammoth/mammoth.browser';

const SESSION_KEY = 'chitforgeResearchSession';
const MAX_CONTEXT_CHARS = 12000;
const RELEVANT_SECTION_LIMIT = 8;

export const defaultResearchContext = {
  freezeDate: '',
  backgroundGuide: null,
  researchNotes: [],
  useContextInResearch: true,
  useContextInPois: true,
  enforceFreezeDate: true,
  prioritizeBackgroundGuide: true,
  allowPostFreezeSourcesForPreFreezeEvents: true,
  noteUsage: { research: true, poi: true, evidenceVerification: false },
  poiNotes: {},
};

export function loadResearchSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return saved ? { ...defaultResearchContext, ...saved.context } : defaultResearchContext;
  } catch {
    return defaultResearchContext;
  }
}

export function saveResearchSession(payload) {
  const safe = { ...payload, context: { ...payload.context, backgroundGuide: trimGuide(payload.context.backgroundGuide) } };
  localStorage.setItem(SESSION_KEY, JSON.stringify(safe));
}

export async function processBackgroundGuide(file, agenda = '', notes = []) {
  const type = inferDocumentType(file);
  const extractedText = await extractText(file, type);
  const relevantSections = detectRelevantSections(extractedText, [agenda, ...notes]);
  return { documentName: file.name, documentType: type, extractedText, relevantSections };
}

export function buildMUNResearchContext({ form, context, selectedTargets }) {
  return {
    committee: form.committee,
    agenda: form.agenda,
    freezeDate: context.freezeDate,
    backgroundGuide: context.backgroundGuide ? trimGuide(context.backgroundGuide) : null,
    researchNotes: context.researchNotes,
    poiNotes: context.poiNotes,
    selectedTargets,
    enforceFreezeDate: context.enforceFreezeDate,
    allowPostFreezeSourcesForPreFreezeEvents: context.allowPostFreezeSourcesForPreFreezeEvents,
    useContextInResearch: context.useContextInResearch,
    useContextInPois: context.useContextInPois,
    prioritizeBackgroundGuide: context.prioritizeBackgroundGuide,
    noteUsage: context.noteUsage,
  };
}

export function formatContextBlock(ctx) {
  const guide = ctx.backgroundGuide;
  return `MUN CONTEXT\n1. MUN rules / freeze date:\nFreeze Date: ${ctx.freezeDate || 'None configured'}\nEnforce Freeze Date: ${ctx.enforceFreezeDate ? 'YES' : 'NO'}\nAllow post-freeze sources for pre-freeze events: ${ctx.allowPostFreezeSourcesForPreFreezeEvents ? 'YES' : 'NO'}\n\n2. Committee + agenda:\nCommittee: ${ctx.committee || 'Unspecified'}\nAgenda: ${ctx.agenda}\n\n3. Background guide context:\n${guide ? `Document: ${guide.documentName} (${guide.documentType})\nRelevant sections:\n${guide.relevantSections?.join('\n---\n') || 'No relevant sections detected.'}` : 'No background guide attached.'}\n\n4. User research notes:\n${ctx.researchNotes.length ? ctx.researchNotes.map((note, i) => `${i + 1}. USER ASSERTION/INSTRUCTION TO INVESTIGATE: ${note}`).join('\n') : 'None'}\n\n5. Target countries:\n${ctx.selectedTargets?.length ? ctx.selectedTargets.map((c) => `${c.name} (${c.iso})`).join(', ') : 'None selected; automatic discovery may be required.'}\n\nIMPORTANT: The above information provides research context and instructions. It is NOT automatically factual evidence. For factual claims, rely on verified retrieved sources. Respect the configured freeze-date policy. Do not use post-freeze events when prohibited. User notes and background-guide statements must never override authoritative evidence.`;
}

export function buildSourceReviewerPrompt({ agenda, freezeDate, claim, source, verbatimEvidence }) {
  return `Agenda: ${agenda}\nFreeze Date: ${freezeDate || 'None'}\nClaim: ${claim}\nSource: ${JSON.stringify(source)}\nVerbatim evidence: ${verbatimEvidence}\nAssess whether the source is relevant, whether eventDate and publishedAt satisfy the freeze-date policy, and whether the source actually supports the claim. Background guides and user notes are context only, never proof. Return JSON.`;
}

export function getFreezeStatus({ publishedAt, eventDate }, { freezeDate, enforceFreezeDate, allowPostFreezeSourcesForPreFreezeEvents }) {
  if (!enforceFreezeDate || !freezeDate) return 'No freeze policy';
  const freeze = Date.parse(freezeDate);
  const event = eventDate ? Date.parse(eventDate) : NaN;
  const published = publishedAt ? Date.parse(publishedAt) : NaN;
  if (!Number.isNaN(event) && event > freeze) return '🔴 Post-freeze event';
  if (!Number.isNaN(published) && published > freeze && !Number.isNaN(event) && event <= freeze) {
    return allowPostFreezeSourcesForPreFreezeEvents ? '🟡 Post-freeze source / pre-freeze event' : '🔴 Post-freeze source disallowed';
  }
  if (!Number.isNaN(published) && published > freeze && Number.isNaN(event)) return '🟡 Published after freeze; event date verification required';
  return '🟢 Before freeze';
}

function trimGuide(guide) {
  if (!guide) return null;
  return { ...guide, extractedText: (guide.extractedText || '').slice(0, MAX_CONTEXT_CHARS), relevantSections: guide.relevantSections || [] };
}

function inferDocumentType(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'docx') return 'DOCX';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'md') return 'MD';
  return 'TXT';
}

async function extractText(file, type) {
  if (type === 'TXT' || type === 'MD') return file.text();
  if (type === 'DOCX') {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value || 'VERIFICATION REQUIRED: DOCX text extraction returned no readable text.';
  }
  return 'PDF text extraction is not enabled in this browser build. Convert the PDF to TXT/MD/DOCX or paste relevant excerpts into Research Notes. VERIFICATION REQUIRED for any PDF-only claims.';
}

function detectRelevantSections(text, hints) {
  const normalizedHints = hints.join(' ').toLowerCase().match(/[a-z0-9/.-]{4,}/g) || [];
  const weighted = ['resolution', 'treaty', 'framework', 'debt', 'transparency', 'question', 'actor', 'country', 'legal', 'committee', 'proposal'];
  return text.split(/\n\s*\n+/).map((section) => section.trim()).filter(Boolean).map((section) => {
    const lower = section.toLowerCase();
    const score = normalizedHints.filter((term) => lower.includes(term)).length + weighted.filter((term) => lower.includes(term)).length;
    return { section: section.slice(0, 1600), score };
  }).sort((a, b) => b.score - a.score).slice(0, RELEVANT_SECTION_LIMIT).map((item) => item.section);
}
