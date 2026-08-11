import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMission, validateMissionResponse } from '../src/validation.js';

const sliders = { aggression: 50, controversy: 50, diplomacy: 50, length: 50 };

test('source-linked POI normalizes and validates as sourced', () => {
  const raw = JSON.stringify({ research_summary: 'summary', portfolio_alignment: 'portfolio wants transparency', targets: [{ country: 'India', iso: 'IND', reason_for_targeting: 'agenda', pressure_points: [{ poi: 'The source shows **debt disclosure gaps**. How does the delegation reconcile that with its transparency position?', legal_foundation: 'Policy commitment', evidence: [{ claim: 'claim', sourceId: 'src_1', source_name: 'UN', source_url: 'https://www.un.org/' }], documented_contradiction: 'conflict', tactical_impact: 'pressure', classification: 'POLICY CONTRADICTION', sourceIds: ['src_1'] }] }] });
  const mission = normalizeMission(raw, { sliders, includeFollowUp: false, poiCount: 1 });
  assert.equal(mission.chits.length, 1);
  assert.equal(mission.chits[0].evidence[0].sourceId, 'src_1');
});

test('POI without trusted source linkage is rejected', () => {
  const mission = { portfolioProfile: { summary: 'ok' }, chits: [{ target: 'X', poi: 'How does X justify this?', evidence: [], legalTacticalTypes: ['POLICY'], pressurePoint: { portfolioPosition: 'ok' } }] };
  assert.match(validateMissionResponse(mission, { targetingMode: 'automatic', poiCount: 1 }).join(' '), /source linkage/);
});
