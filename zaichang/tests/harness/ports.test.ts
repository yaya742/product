import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './support';
import { personalLabel, always } from '../../src/shared/harness';

test('X01 media versions retain audio locator while corrected transcript invalidates the old candidate', () => {
  const f = new Fixture();
  try {
    const runtime = f.store.runtime;
    f.policy.registerSource('media:test');
    const s = f.scope();
    runtime.observations.ingest(s, {
      id: 'audio-1',
      sourceId: 'media:test',
      kind: 'media',
      version: 1,
      locator: {
        kind: 'audio',
        artifactId: 'audio-1',
        version: 1,
        startMs: 1000,
        endMs: 4000,
        transcriptVersion: 1,
      },
      text: '去东教',
      label: personalLabel,
      quality: 'unverified',
      data: {},
    });
    runtime.observations.correctTranscript(s, 'audio-1', 2, '去西教');
    const current = runtime.observations.read(s, 'audio-1');
    assert.equal(current.text, '去西教');
    assert.equal(current.locator.startMs, 1000);
    assert.equal(current.locator.endMs, 4000);
    assert.equal(
      f.repo.evidenceList(s).some((e) => e.text === '去东教'),
      false,
    );
  } finally {
    f.close();
  }
});
test('X02 synchronized proposals use trusted actors, explicit revisions and privacy precedence instead of last writer wins', () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime,
      s = f.scope(),
      goal = r.work.create(s, 'goal', '练习', {}, { status: 'active' }),
      a = r.sync.registerTrustedDevice('desktop'),
      b = r.sync.registerTrustedDevice('phone', false);
    const op = {
      deviceId: 'desktop',
      operationId: 'one',
      objectId: goal.id,
      baseRevision: 1,
      policyEpoch: f.repo.epoch,
      causalReferences: [],
      createdAt: f.clock.now(),
      delta: { operation: 'edit_work', title: '新标题' },
    };
    assert.equal(r.sync.submit(s, a, op).accepted, true);
    assert.equal(r.sync.submit(s, a, op).revision, 2);
    assert.equal(
      r.sync.submit(s, b, { ...op, deviceId: 'phone', operationId: 'two' }).code,
      'revision_conflict',
    );
    assert.equal(
      r.sync.submit(s, b, {
        ...op,
        deviceId: 'phone',
        operationId: 'offline',
        baseRevision: 2,
        delta: { operation: 'propose_external_action' },
      }).code,
      'offline_unsafe',
    );
    f.policy.revoke('campus:read');
    assert.equal(
      r.sync.submit(f.scope(), b, { ...op, deviceId: 'phone', operationId: 'stale', baseRevision: 2 }).code,
      'stale_epoch',
    );
  } finally {
    f.close();
  }
});
test('X07/13 answer exposure and accepted suggestion never imply independent mastery or causal success', () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime;
    f.policy.registerSource('learning:test');
    const s = f.scope();
    r.observations.ingest(s, {
      id: 'learning-1',
      sourceId: 'learning:test',
      kind: 'learning',
      version: 1,
      locator: {
        kind: 'structured',
        snapshotId: 'lesson-1',
        jsonPointer: '/steps',
        sourceRecordId: 'step-1',
      },
      text: '已看答案',
      label: personalLabel,
      quality: 'unverified',
      data: {
        taskRef: 'task-1',
        skillRefs: ['skill'],
        assistance: 'answer_seen',
        exposedRefs: ['answer'],
        independentSteps: [],
        comparability: 'unknown',
        occurredAt: f.clock.now(),
      },
    });
    assert.equal(r.observations.learningProjection(s, 'task-1').mastery, 'not_established');
    assert.equal(r.observations.learningProjection(s, 'task-1').independentPerformance, 'unknown');
    r.observations.ingest(s, {
      id: 'feedback-1',
      sourceId: 'learning:test',
      kind: 'feedback',
      version: 1,
      locator: {
        kind: 'structured',
        snapshotId: 'recommendation-1',
        jsonPointer: '/response',
        sourceRecordId: 'r1',
      },
      text: '接受过，未观察结果',
      label: personalLabel,
      quality: 'unverified',
      data: {
        recommendationId: 'r1',
        exposure: 'shown',
        response: 'accepted',
        missingness: 'not_observed',
        contextRevision: 1,
      },
    });
    assert.equal(r.observations.feedbackProjection(s, 'feedback-1').outcome, 'not_observed');
    assert.equal(r.observations.feedbackProjection(s, 'feedback-1').causalSuccess, 'not_established');
  } finally {
    f.close();
  }
});
test('X09 versioned rule packs keep institution, term and cohort applicability separate', () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime;
    f.policy.registerSource('rules:test');
    const s = f.scope();
    for (const [institution, term, required] of [
      ['A', 'fall', 12],
      ['B', 'fall', 20],
      ['A', 'spring', 16],
    ] as const)
      r.rulePacks.register(
        s,
        {
          id: institution + '-' + term,
          institutionId: institution,
          termId: term,
          cohortScope: ['2026'],
          validFrom: '2026-01-01T00:00:00Z',
          validTo: '2027-01-01T00:00:00Z',
          sourceId: 'rules:test',
          sourceRevision: '1',
          rules: [{ id: 'sports', predicate: 'sports.required', value: { required, unit: 'count' } }],
        },
        { approved: true },
      );
    assert.equal(r.rulePacks.applicable(s, 'A', 'fall', '2026').records[0].value.required, 12);
    assert.equal(r.rulePacks.applicable(s, 'A', 'fall').status, 'applicability_unknown');
    assert.equal(r.rulePacks.applicable(s, 'A', 'fall', '2025').records.length, 0);
  } finally {
    f.close();
  }
});
test('X04/15 active watches respect novelty and cancelled goals; plaintext storage refuses lasting health observations', () => {
  const f = new Fixture();
  try {
    const r = f.store.runtime,
      s = f.scope(),
      goal = r.work.create(s, 'goal', '出门', {}, { status: 'active' }),
      e = f.ingest('合成天气变化', 'weather-change');
    r.watches.create(s, {
      id: 'watch1',
      goalId: goal.id,
      eventCategory: 'weather',
      actionableUntil: '2026-09-15T00:00:00Z',
      condition: always,
      channel: 'local_notification',
      title: '仍有时间调整',
    });
    assert.equal(
      r.watches.signal(s, { category: 'weather', noveltyKey: 'rain', facts: {}, evidenceId: e.id }).length,
      1,
    );
    assert.equal(
      r.watches.signal(s, { category: 'weather', noveltyKey: 'rain', facts: {}, evidenceId: e.id }).length,
      0,
    );
    r.work.cancelGoal(s, goal.id);
    assert.equal(
      r.watches.signal(s, { category: 'weather', noveltyKey: 'storm', facts: {}, evidenceId: e.id }).length,
      0,
    );
    assert.equal(r.storageProtection.capabilities.atRest, false);
    assert.throws(() => r.storageProtection.requireAtRest(), /尚未接入/);
    f.policy.registerSource('health:test');
    f.policy.grant('health:use');
    const hs = f.scope();
    const result = r.observations.ingest(hs, {
      id: 'wellness1',
      sourceId: 'health:test',
      kind: 'wellness',
      version: 1,
      locator: {
        kind: 'structured',
        snapshotId: 'device1',
        jsonPointer: '/measurement',
        sourceRecordId: 'wellness1',
      },
      text: 'CANARY_HEALTH_ONLY_MEMORY',
      label: { ...personalLabel, sensitivity: 'restricted' },
      quality: 'unverified',
      data: {
        measureType: 'fatigue',
        sourceDevice: 'device1',
        observationWindow: [f.clock.now(), '2026-09-14T07:00:00Z'],
        quality: 'missing',
      },
    });
    assert.equal(result.status, 'ephemeral_only');
    assert.equal(
      f.repo.evidenceList(hs).some((e) => e.text.includes('CANARY_HEALTH')),
      false,
    );
    f.policy.revoke('health:use');
    assert.equal(r.observations.read(f.scope(), 'wellness1'), undefined);
  } finally {
    f.close();
  }
});
