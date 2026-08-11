export const SOURCE_STATUS = ['verified', 'reported', 'disputed', 'unsupported', 'unavailable', 'pending'];

export function isTrustedRetrievedUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !/(example\.com|localhost|wikipedia\.org|made-up|fake)/i.test(parsed.hostname + parsed.pathname);
  } catch {
    return false;
  }
}

export function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((param) => parsed.searchParams.delete(param));
    return parsed.toString();
  } catch {
    return '';
  }
}

export function classifySourceType(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/\.un\.org$|^un\.org$|ohchr\.org|unhcr\.org|undp\.org|who\.int|unesco\.org|unicef\.org/.test(host)) return 'un';
  if (/\.gov$|\.gov\.|government|parliament|ministry|state\.gov|europa\.eu/.test(host)) return 'government';
  if (/worldbank\.org|imf\.org|wto\.org|oecd\.org|icc-cpi\.int|icj-cij\.org|worldcourts/.test(host)) return 'international_organization';
  if (/court|tribunal|justice/.test(host)) return 'court';
  if (/reuters\.com|apnews\.com|bbc\.|ft\.com|bloomberg\.com|aljazeera\.com|nytimes\.com|washingtonpost\.com|theguardian\.com/.test(host)) return 'major_media';
  if (/\.edu$|scholar|jstor|ssrn/.test(host)) return 'academic';
  if (/amnesty|hrw\.org|transparency\.org/.test(host)) return 'ngo';
  if (/brookings|chathamhouse|csis|cfr\.org|carnegie/.test(host)) return 'think_tank';
  return 'other';
}

export function sourceTier(sourceType) {
  if (['un', 'government', 'international_organization', 'court'].includes(sourceType)) return 1;
  if (sourceType === 'major_media') return 2;
  if (sourceType === 'academic') return 3;
  return 4;
}

export function sourceStatusLabel(status) {
  return ({ verified: '🟢 Verified', reported: '🟡 Reported', disputed: '🟠 Disputed', unsupported: '🔴 Unsupported', unavailable: '⚪ Unavailable', pending: '⚪ Pending' })[status] || '⚪ Pending';
}

function groundingChunksFromGenerateContent(data) {
  return (data.candidates || []).flatMap((candidate) => candidate.groundingMetadata?.groundingChunks || []);
}

function annotationsFromInteractions(data) {
  return (data.steps || []).flatMap((step) => step.content || []).flatMap((content) => content.annotations || []).filter((annotation) => annotation.url_citation || annotation.urlCitation);
}

export function extractGroundedSources(data, { query = '' } = {}) {
  const rawSources = [];
  groundingChunksFromGenerateContent(data).forEach((chunk) => {
    const web = chunk.web || chunk.retrievedContext || chunk;
    if (web?.uri) rawSources.push({ url: web.uri, title: web.title || web.uri, snippet: web.snippet || '', citationSource: 'google_grounding' });
    if (web?.url) rawSources.push({ url: web.url, title: web.title || web.url, snippet: web.snippet || '', citationSource: 'google_search' });
  });
  annotationsFromInteractions(data).forEach((annotation) => {
    const citation = annotation.url_citation || annotation.urlCitation;
    rawSources.push({ url: citation.url, title: citation.title || citation.url, snippet: citation.snippet || '', citationSource: 'google_grounding' });
  });
  const seen = new Set();
  return rawSources.filter((source) => isTrustedRetrievedUrl(source.url)).map((source) => {
    const url = canonicalUrl(source.url);
    if (seen.has(url)) return null;
    seen.add(url);
    const parsed = new URL(url);
    const sourceType = classifySourceType(url);
    return {
      id: `src_${seen.size}`,
      url,
      title: source.title || parsed.hostname,
      domain: parsed.hostname,
      sourceType,
      searchQuery: query,
      snippet: source.snippet || '',
      retrievedText: source.snippet || '',
      citationSource: source.citationSource,
      retrievalStatus: source.snippet ? 'retrieved' : 'unavailable',
      reviewStatus: 'pending',
      confidence: sourceTier(sourceType) === 1 ? 0.75 : 0.55,
      verbatimEvidence: source.snippet || null,
      claimsSupported: [],
      claimsContradicted: [],
    };
  }).filter(Boolean);
}

export function rejectModelGeneratedEvidence(evidence, trustedSources) {
  const trusted = new Set(trustedSources.map((source) => canonicalUrl(source.url)));
  return (evidence || []).filter((item) => item.sourceId && trusted.has(canonicalUrl(item.url || trustedSources.find((source) => source.id === item.sourceId)?.url || '')));
}

export function buildClaimGraph(chits, sources) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  return chits.map((chit, index) => {
    const claimIds = chit.claimIds?.length ? chit.claimIds : [`claim_${index + 1}`];
    const sourceIds = (chit.sourceIds || chit.evidence?.map((item) => item.sourceId) || []).filter((id) => sourceMap.has(id));
    return { ...chit, claimIds, sourceIds, citationStatus: sourceIds.length ? 'supported' : 'unsupported' };
  });
}

export function reviewEvidenceLocally(claim, source) {
  const evidence = `${source.verbatimEvidence || ''} ${source.snippet || ''}`.toLowerCase();
  const claimWords = String(claim || '').toLowerCase().split(/\W+/).filter((word) => word.length > 4);
  const overlap = claimWords.filter((word) => evidence.includes(word)).length;
  const relevance = claimWords.length ? overlap / claimWords.length : 0;
  const status = !source.verbatimEvidence ? 'unavailable' : relevance > 0.35 ? 'reported' : 'unsupported';
  return { supportsClaim: status === 'reported', status, confidence: Math.min(0.9, source.confidence * (0.5 + relevance)), relevance, evidenceQuote: source.verbatimEvidence || null, reason: status === 'reported' ? 'Source excerpt overlaps the claim; reviewer should confirm wording.' : 'Source excerpt does not directly substantiate the claim.', claimWordingAdjustment: status === 'reported' ? null : 'VERIFICATION REQUIRED' };
}
