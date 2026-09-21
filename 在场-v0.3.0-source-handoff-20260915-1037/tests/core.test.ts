import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/main/store';

test('PC Agent starts with a local-only core state', () => {
  const store = new Store(':memory:');
  try {
    const state = store.state(false);
    assert.equal(state.settings.mode, 'demo');
    assert.ok(Array.isArray(state.agenda));
    assert.ok(Array.isArray(state.memories));
    assert.ok(!store.runtime.policy.grants().some((grant) => /campus|weather|map|location/i.test(grant)));
  } finally {
    store.close();
  }
});

test('PC Agent keeps the local agenda capability available', () => {
  const store = new Store(':memory:');
  try {
    const catalog = store.runtime.broker.catalog(store.runtime.policy.hostScope(), '', 0, 100).items;
    assert.ok(catalog.some((item) => item.name === 'local.agenda.read'));
    assert.ok(!catalog.some((item) => /campus|weather|map|location/i.test(item.name)));
  } finally {
    store.close();
  }
});
