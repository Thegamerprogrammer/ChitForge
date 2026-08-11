import test from 'node:test';
import assert from 'node:assert/strict';
import { addOrToggleCountry, findCountryByQuery, removeCountry } from '../src/countryUtils.js';

test('country search accepts ISO alpha-2, alpha-3, aliases and names', () => {
  assert.equal(findCountryByQuery('IND').iso, 'IND');
  assert.equal(findCountryByQuery('US').iso, 'USA');
  assert.equal(findCountryByQuery('United Kingdom').iso, 'GBR');
  assert.equal(findCountryByQuery('South Korea').iso, 'KOR');
});

test('multi-selection, opposition toggle, and undo-compatible arrays work', () => {
  const india = findCountryByQuery('India');
  const china = findCountryByQuery('CHN');
  const usa = findCountryByQuery('USA');
  let selected = [];
  selected = addOrToggleCountry(selected, india);
  selected = addOrToggleCountry(selected, china);
  selected = addOrToggleCountry(selected, usa, true);
  assert.equal(selected.length, 3);
  assert.equal(selected.find((country) => country.iso === 'USA').opposition, true);
  selected = removeCountry(selected, 'USA');
  assert.equal(selected.length, 2);
});
