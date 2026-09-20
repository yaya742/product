import { isolatedEnvironment } from '../scripts/test-environment.mjs';
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(),
  out = path.join(root, 'artifacts/map-v2');
await fs.mkdir(out, { recursive: true });
const env = isolatedEnvironment('map-performance');
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [root], env, timeout: 30000 });
const report = {
  environment:
    'Real Electron, production renderer, synthetic input. Touch is CDP simulation, not a physical touchscreen.',
  checks: [],
  errors: [],
};
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1360, height: 920 });
    ipcMain.removeHandler('map:locate');
    ipcMain.handle('map:locate', () => ({
      status: 'unavailable',
      source: 'test',
      phoneConnected: false,
      reason: '性能测试未采集位置',
    }));
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
  const stage = page.locator('.campus-v2-stage');
  await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();
  await page.waitForTimeout(250);
  report.dataVersion = (await page.evaluate(() => window.zaichang.mapOverview())).version;
  report.renderer = await stage.getAttribute('data-renderer');
  const camera = async () => JSON.parse(await stage.getAttribute('data-camera'));
  const cdp = await page.context().newCDPSession(page);
  await expect.poll(async () => (await camera()).animating).toBe(false);
  await expect.poll(async () => (await camera()).interacting).toBe(false);
  await stage.focus();
  const before = await camera(),
    box = await stage.boundingBox();
  const center = { x: box.x + box.width * 0.52, y: box.y + box.height * 0.42 },
    radius = 90;
  await page.evaluate(() => {
    window.__v2TouchPointers = [];
    window.__v2TouchTargets = {};
    window.__v2TouchDown = (e) => {
      if (e.pointerType === 'touch') {
        window.__v2TouchPointers.push(e.pointerId);
        window.__v2TouchTargets[e.pointerId] = e.target;
      }
    };
    document.querySelector('.campus-v2-stage').addEventListener('pointerdown', window.__v2TouchDown);
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const fingers = (angle, scale = 1, dx = 0, dy = 0) => [
    {
      id: 1,
      x: center.x - Math.cos(angle) * radius * scale + dx,
      y: center.y - Math.sin(angle) * radius * scale + dy,
    },
    {
      id: 2,
      x: center.x + Math.cos(angle) * radius * scale + dx,
      y: center.y + Math.sin(angle) * radius * scale + dy,
    },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(0) });
  for (let i = 1; i <= 24; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: fingers(i * 0.018, 1 + i * 0.01, (20 * i) / 24, (12 * i) / 24),
    });
    await page.waitForTimeout(16);
  }
  // CDP does not emit a partial pointerup when a point is omitted from touchMove.
  // Dispatch the missing DOM pointerup through the actual map handler, not its state.
  const ids = await page.evaluate(() => window.__v2TouchPointers);
  const lifted = fingers(0.432, 1.24, 20, 12)[1];
  await page.evaluate(
    ({ id, point }) =>
      window.__v2TouchTargets[id].dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: id,
          pointerType: 'touch',
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: 0,
          bubbles: true,
        }),
      ),
    { id: ids[1], point: lifted },
  );
  const one = fingers(0.432, 1.24, 20, 12)[0];
  const pinchEnd = await camera();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [one] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...one, x: one.x + 35, y: one.y + 10 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...one, x: one.x + 50, y: one.y + 15 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await camera()).interacting).toBe(false);
  const after = await camera();
  assert.equal(after.pitch, 0);
  assert.ok(Math.abs(pinchEnd.resolution / before.resolution - 1 / 1.24) < 0.04);
  assert.ok(
    Math.abs(
      Math.atan2(
        Math.sin(pinchEnd.rotation - before.rotation),
        Math.cos(pinchEnd.rotation - before.rotation),
      ) - 0.432,
    ) < 0.08,
  );
  assert.ok(Math.abs(after.resolution - pinchEnd.resolution) < 0.01);
  assert.ok(Math.abs(after.rotation - pinchEnd.rotation) < 0.01);
  assert.ok(
    Math.hypot(after.center[0] - pinchEnd.center[0], after.center[1] - pinchEnd.center[1]) > 5,
    'The remaining finger must actually pan the map',
  );
  assert.equal(
    await page.locator('.campus-v2-route').count(),
    0,
    'Pinching must not accidentally select a building',
  );
  report.touch = {
    before,
    pinchEnd,
    after,
    simulated: true,
    twoToOne: true,
    partialRelease: 'DOM PointerEvent through map input handlers; other gesture events via CDP',
  };
  report.checks.push(
    'Pinch follows the supplied angle/scale; partial release leaves single-finger pan without extra rotation/zoom or an accidental click.',
  );
  await page.evaluate(() => {
    document.querySelector('.campus-v2-stage').removeEventListener('pointerdown', window.__v2TouchDown);
    delete window.__v2TouchDown;
    delete window.__v2TouchPointers;
    delete window.__v2TouchTargets;
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(0) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.getByRole('button', { name: '地图回北', exact: true }).click();
  await expect.poll(async () => (await camera()).animating).toBe(false);
  await page.getByRole('button', { name: '查看校园全貌', exact: true }).click();
  await expect.poll(async () => (await camera()).animating).toBe(false);
  await page.evaluate(() => {
    const state = { frames: [], cameraLatency: [], last: performance.now(), pending: undefined, raf: 0 };
    const el = document.querySelector('.campus-v2-stage');
    state.input = () => {
      state.pending = performance.now();
    };
    for (const type of ['pointermove', 'wheel', 'keydown'])
      el.addEventListener(type, state.input, { capture: true, passive: true });
    state.observer = new MutationObserver(() => {
      if (state.pending !== undefined) {
        state.cameraLatency.push(performance.now() - state.pending);
        state.pending = undefined;
      }
    });
    state.observer.observe(el, { attributes: true, attributeFilter: ['data-camera'] });
    const frame = (t) => {
      state.frames.push(t - state.last);
      state.last = t;
      state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
    window.__mapV2Performance = state;
  });
  const pan = await stage.boundingBox(),
    sx = pan.x + pan.width * 0.57,
    sy = pan.y + pan.height * 0.42;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 0; i < 150; i++) {
    await page.mouse.move(sx + Math.sin(i / 22) * 105, sy + Math.cos(i / 29) * 65);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, i < 4 ? -90 : 90);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
  report.interaction = await page.evaluate(() => {
    const state = window.__mapV2Performance,
      el = document.querySelector('.campus-v2-stage');
    cancelAnimationFrame(state.raf);
    state.observer.disconnect();
    for (const type of ['pointermove', 'wheel', 'keydown']) el.removeEventListener(type, state.input, true);
    delete window.__mapV2Performance;
    const summarize = (values) => {
      const sorted = values.filter((v) => v >= 0).sort((a, b) => a - b);
      return {
        samples: sorted.length,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        p99Ms: sorted[Math.floor(sorted.length * 0.99)],
        over50: sorted.filter((x) => x > 50).length,
      };
    };
    return {
      frameIntervals: summarize(state.frames.slice(1)),
      inputToCameraState: summarize(state.cameraLatency),
      rawFrameIntervals: state.frames.slice(1),
      rawCameraLatency: state.cameraLatency,
      dpr: devicePixelRatio,
      viewport: [innerWidth, innerHeight],
      timingNote:
        'Frame clock during real panning and wheel input. Camera latency is renderer event to camera DOM state, not physical device-to-photon latency.',
    };
  });
  assert.ok(report.interaction.frameIntervals.samples > 150);
  assert.ok(report.interaction.inputToCameraState.samples > 80);
  report.checks.push(
    'Interaction frame times and input-to-camera state latency sampled independently of animation duration.',
  );
  await page.screenshot({ path: path.join(out, 'touch-and-performance.png') });
  // With packaged local assets, network offline must not remove browsing or routing.
  await page.context().setOffline(true);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
  await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();
  const result = await page.evaluate(() =>
    window.zaichang.mapRoute({
      from: { kind: 'place', id: 'way/161393058' },
      to: { kind: 'place', id: 'way/161393066' },
    }),
  );
  assert.equal(result.status, 'ready');
  report.checks.push('Offline cached reopening and local route computation remain available.');
  await page.context().setOffline(false);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(String(e));
  process.exitCode = 1;
} finally {
  await app.close();
  await fs.writeFile(path.join(out, 'performance.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ...report,
        interaction: report.interaction
          ? { ...report.interaction, rawFrameIntervals: undefined, rawCameraLatency: undefined }
          : undefined,
      },
      null,
      2,
    ),
  );
}
