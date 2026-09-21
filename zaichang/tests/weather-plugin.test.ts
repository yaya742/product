import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../examples/weather-plugin/index.mjs';

const weatherPayload = {
  current: {
    temperature_2m: 22,
    apparent_temperature: 22.5,
    relative_humidity_2m: 60,
    precipitation: 0,
    weather_code: 0,
    wind_speed_10m: 2,
    is_day: 1,
  },
  daily: {
    time: ['2026-09-17'],
    weather_code: [0],
    temperature_2m_max: [28],
    temperature_2m_min: [19],
    precipitation_probability_max: [10],
  },
};

function context(payload: unknown = weatherPayload) {
  return {
    request: async () => new Response(JSON.stringify(payload), { status: 200 }),
  };
}

test('weather lookup returns current conditions and forecast data', async () => {
  const result = await plugin.invoke({
    name: 'weather.lookup',
    args: { days: 1, location: 'current', latitude: 30.27, longitude: 120.15 },
    context: context(),
  });

  assert.equal(result.status, 'fresh');
  assert.equal(result.data.current.temperature_2m, 22);
  assert.deepEqual(result.data.forecast.time, ['2026-09-17']);
});

test('current location never falls back to the Hangzhou reference coordinate', async () => {
  const result = await plugin.invoke({
    name: 'weather.lookup',
    args: { days: 1, location: 'current' },
    context: context(),
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /缺少宿主提供的有效坐标/);
});

test('provider failures become controlled plugin failures', async () => {
  const result = await plugin.invoke({
    name: 'weather.lookup',
    args: { days: 1, location: 'Hangzhou' },
    context: { request: async () => { throw new Error('network'); } },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /无法连接天气服务/);
});
