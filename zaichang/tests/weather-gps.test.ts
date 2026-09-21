import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/main/store';
import { prepareWeatherPluginInput } from '../src/main/plugins/weather-adapter';

const connections = (location: any) => ({
  map: { overview: () => ({ bounds: [120, 30, 121, 31] }) } as any,
  location,
});

test('weather plugin receives Windows location only after explicit location opt-in', async () => {
  const store = new Store(':memory:');
  let reads = 0;
  const prepared = await prepareWeatherPluginInput(
    { days: 1, location: 'current' },
    {
      policy: store.runtime.policy,
      scope: store.runtime.policy.hostScope({
        sources: ['plugin:weather'],
        grants: ['weather:read', 'location:read'],
      }),
      connections: connections({
        read: async () => {
          reads++;
          return {
            status: 'fresh',
            reason: '测试定位已更新。',
            source: 'test',
            phoneConnected: false as const,
            fix: {
              coordinate: [120.1234, 30.2345] as [number, number],
              crs: 'EPSG:4326' as const,
              timestamp: Date.now(),
              accuracy: 25,
              source: 'test' as const,
              deviceLabel: '测试设备',
            },
          };
        },
      }),
      signal: new AbortController().signal,
    },
  );

  assert.equal(reads, 1);
  assert.ok('input' in prepared);
  assert.equal(prepared.input.latitude, 30.2345);
  assert.equal(prepared.input.longitude, 120.1234);
  assert.equal(prepared.input.accuracy_m, 25);
  assert.equal(prepared.input.locationLabel, '当前位置（Windows 定位，精度约 25 米）');
  store.close();
});

test('weather plugin adapter does not silently fall back when current location is unavailable', async () => {
  const store = new Store(':memory:');
  const prepared = await prepareWeatherPluginInput(
    { days: 1, location: 'current' },
    {
      policy: store.runtime.policy,
      scope: store.runtime.policy.hostScope({
        sources: ['plugin:weather'],
        grants: ['weather:read', 'location:read'],
      }),
      connections: connections({
        read: async () => ({
          status: 'unavailable' as const,
          reason: 'Windows 位置服务未返回结果。',
          source: 'test',
          phoneConnected: false as const,
        }),
      }),
      signal: new AbortController().signal,
    },
  );

  assert.ok('result' in prepared);
  assert.equal(prepared.result.status, 'unknown');
  assert.match(prepared.result.reason, /没有改用杭州坐标/);
  store.close();
});

test('weather location permission remains controlled by the weather plugin setting', () => {
  const store = new Store(':memory:');
  assert.equal(store.settings().weatherUseLocation, false);
  store.saveSettings({ weatherEnabled: true, weatherUseLocation: true });
  assert.equal(store.settings().weatherUseLocation, true);
  assert.equal(store.runtime.policy.grants().includes('weather:read'), true);
  assert.equal(store.runtime.policy.grants().includes('location:read'), true);
  store.saveSettings({ weatherEnabled: false });
  assert.equal(store.runtime.policy.grants().includes('weather:read'), false);
  assert.equal(store.runtime.policy.grants().includes('location:read'), false);
  store.close();
});
