import assert from 'node:assert/strict';
import { enforceTrustedEvidence, sourceFromGrounding } from './sourceValidation.js';
import { applyMapAction, findCountry } from './mapUtils.js';

const grounded = [{ id: 'src-1', url: 'https://www.un.org/en/about-us/un-charter/full-text', title: 'UN Charter', domain: 'un.org', verbatimEvidence: 'All Members shall refrain...', citationSource: 'google_search' }];

assert.equal(enforceTrustedEvidence([{ sourceName: 'UN Charter', url: grounded[0].url, claimSupported: 'Article 2(4)' }], grounded)[0].citationSource, 'google_search');
assert.equal(enforceTrustedEvidence([{ sourceName: 'Reuters', url: 'https://www.reuters.com/world/made-up-slug', claimSupported: 'fake' }], grounded)[0].status, 'FAILED');
assert.equal(enforceTrustedEvidence([{ sourceName: 'No URL', claimSupported: 'missing' }], grounded)[0].status, 'FAILED');
assert.equal(sourceFromGrounding(grounded[0]).url, grounded[0].url);

assert.equal(findCountry('IND').iso, 'IND');
assert.equal(findCountry('United States').iso, 'USA');
let state = { selected: [], opposition: [] };
state = applyMapAction(state, { type: 'target', country: { iso: 'IND', name: 'India' } });
state = applyMapAction(state, { type: 'opposition', country: { iso: 'USA', name: 'United States' } });
assert.equal(state.selected.length, 2);
assert.equal(state.opposition[0].iso, 'USA');
console.log('sourceValidation/mapUtils tests passed');
