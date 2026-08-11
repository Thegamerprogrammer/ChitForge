import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGroundedSources, isTrustedRetrievedUrl, rejectModelGeneratedEvidence, reviewEvidenceLocally } from '../src/sourceIntegrity.js';

test('fake and model-generated URLs are rejected unless in grounding metadata', () => {
  assert.equal(isTrustedRetrievedUrl('https://www.reuters.com/world/asia/example-made-up-slug'), false);
  assert.equal(isTrustedRetrievedUrl('https://example.com/fake'), false);
  const evidence = [{ sourceId: '', url: 'https://www.reuters.com/world/asia/example-made-up-slug' }];
  assert.deepEqual(rejectModelGeneratedEvidence(evidence, []), []);
});

test('real grounded URLs become trusted source records', () => {
  const data = { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://www.un.org/en/about-us/un-charter', title: 'UN Charter', snippet: 'Article 2 of the Charter...' } }] } }] };
  const sources = extractGroundedSources(data, { query: 'UN Charter' });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].citationSource, 'google_grounding');
  assert.equal(sources[0].sourceType, 'un');
});

test('claim review distinguishes unsupported unavailable evidence', () => {
  const reviewed = reviewEvidenceLocally('UN Charter Article 2', { verbatimEvidence: null, snippet: '', confidence: 0.6 });
  assert.equal(reviewed.status, 'unavailable');
});
