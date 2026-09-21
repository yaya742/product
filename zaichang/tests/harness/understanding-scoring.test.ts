import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreObservedEvidence, type ObservedEvidence } from './understanding-scoring';

test('independent evidence scoring rejects false success, duplicates, hidden reads, stale chains, fake delegation and semantic violations', () => {
  const valid: ObservedEvidence = { expectedEffects: [{ title: '讨论', startsAt: '2026-09-15T01:00:00Z' }], effects: [{ id: 'actual-row', title: '讨论', startsAt: '2026-09-15T01:00:00Z' }], confirmedRecordIds: ['actual-row'], forbiddenReads: [], withdrawnSourcesSent: [], requiredChildren: 1, children: [{ id: 'independent-child', state: 'consumed', independentCalls: 2, observations: 1, consumed: true }], semantic: { truthful: true, needsMet: true, autonomyRespected: true, correctionRespected: true }, requiredVisibleTools: ['look_up'], variants: [{ visibleTools: ['look_up'] }, { visibleTools: ['look_up'] }] };
  assert.equal(scoreObservedEvidence(valid).passed, true);
  const faults: [string, Partial<ObservedEvidence>][] = [
    ['provider success but database unchanged', { effects: [] }],
    ['reply success without action or receipt', { effects: [], confirmedRecordIds: [], semantic: { ...valid.semantic!, truthful: false } }],
    ['duplicate side effects', { effects: [...valid.effects, { ...valid.effects[0], id: 'duplicate' }] }],
    ['private prefetch omitted from reply', { forbiddenReads: ['profile:self'] }],
    ['child completed event without independent request', { children: [{ ...valid.children![0], independentCalls: 0 }] }],
    ['forgotten summary still sent to model', { withdrawnSourcesSent: ['removed-summary'] }],
    ['paraphrase loses a tool', { variants: [{ visibleTools: ['look_up'] }, { visibleTools: [] }] }],
    ['successful action accompanied by shaming', { semantic: { ...valid.semantic!, autonomyRespected: false } }],
  ];
  for (const [name, patch] of faults) assert.equal(scoreObservedEvidence({ ...valid, ...patch }).passed, false, name);
  assert.equal(scoreObservedEvidence({ ...valid, children: [{ ...valid.children![0], consumed: false }] }).passed, false, 'produced but unconsumed result');
});
