import test from 'node:test';
import assert from 'node:assert/strict';
import { InterfaceManager, type InterfaceBroker } from '../src/main/interfaces/manager';
import type { CapabilityProviderSnapshot } from '../src/main/capabilities/broker';

const snapshot = (id: string, enabled: boolean): CapabilityProviderSnapshot => ({
  id,
  version: '1',
  displayName: id === 'weather' ? '天气' : '地图',
  description: id === 'weather' ? '读取天气预报。' : '查看校园地图。',
  trust: 'bundled_reviewed',
  sourceId: id === 'weather' ? 'plugin:weather' : 'map:local',
  egressHosts: id === 'weather' ? ['api.open-meteo.com'] : [],
  platforms: ['*'],
  simulated: false,
  offline: 'read_cache',
  license: 'test',
  enabled,
  connection: { connected: true },
  capabilities: [{
    name: id === 'weather' ? 'weather.lookup' : 'map.search',
    displayName: id === 'weather' ? '查询天气' : '搜索地点',
    description: '只读能力。',
    version: '1',
    effect: 'read',
    requiredScopes: id === 'weather' ? ['weather:read'] : ['map:read'],
    timeoutMs: 15000,
    maxBytes: 80000,
    supportsIdempotency: false,
    supportsInspect: false,
    supportsCancel: false,
  }],
});

test('interface manager restores persisted state and keeps a weather default off', () => {
  const enabled = new Map([['weather', true], ['spatial', true]]);
  const saved: Record<string, boolean>[] = [];
  const broker: InterfaceBroker = {
    providerSnapshots: () => [snapshot('weather', enabled.get('weather')!), snapshot('spatial', enabled.get('spatial')!)],
    setProviderEnabled: (id, value) => enabled.set(id, value),
  };
  const manager = new InterfaceManager(
    broker,
    () => ({ spatial: false }),
    (states) => saved.push(states),
    (id) => id !== 'weather',
  );

  manager.restore();
  assert.deepEqual(Object.fromEntries(enabled), { weather: false, spatial: false });
  assert.deepEqual(saved.at(-1), { weather: false, spatial: false });
  assert.equal(manager.list().find((item) => item.id === 'weather')?.displayName, '天气');

  manager.setEnabled('weather', true);
  assert.equal(enabled.get('weather'), true);
  assert.deepEqual(saved.at(-1), { weather: true, spatial: false });
});

test('interface manager does not expose executable schemas to the renderer view', () => {
  const broker: InterfaceBroker = {
    providerSnapshots: () => [snapshot('weather', false)],
    setProviderEnabled: () => {},
  };
  const manager = new InterfaceManager(broker, () => ({}), () => {}, () => false);
  const item = manager.list()[0];
  assert.equal(item.capabilities[0].name, 'weather.lookup');
  assert.equal('input' in item.capabilities[0], false);
  assert.equal('output' in item.capabilities[0], false);
});
