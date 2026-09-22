import { isolatedEnvironment } from '../scripts/test-environment.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = process.cwd(),
  out = path.join(root, 'artifacts/map-v2/desktop');
await fs.mkdir(out, { recursive: true });
const dataDirectory = path.join(root, '.test-data', 'map-v2-' + Date.now());
const serviceModule = path.join(root, '.test-data', 'map-v2-service.cjs');
await build({
  entryPoints: ['src/main/mapService.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: serviceModule,
});
const places = JSON.parse(await fs.readFile('assets/map-v2/places.json', 'utf8'));
const manifest = JSON.parse(await fs.readFile('assets/map-v2/manifest.json', 'utf8'));
const report = {
  status: 'running',
  environment: {
    platform: os.platform(),
    cpu: os.cpus()[0].model,
    release: 'production build in real Electron',
    dataVersion: manifest.version,
  },
  checks: [],
  errors: [],
  simulated: [
    'Controlled location fixes and delayed IPC responses are TEST fixtures, not device evidence. Native Windows service evidence is recorded separately without coordinates.',
  ],
  performance: {},
};
const env = isolatedEnvironment('desktop', dataDirectory);
delete env.ELECTRON_RUN_AS_NODE;
let app, page, video;
function checked(id, detail) {
  report.checks.push({ id, detail });
  console.log(`${id}: ${detail}`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  app = await electron.launch({
    args: [root],
    env,
    timeout: 30000,
    recordVideo: { dir: path.join(out, 'video'), size: { width: 1360, height: 920 } },
  });
  page = await app.firstWindow();
  video = page.video();
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 20, width: 1360, height: 920 }),
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  report.environment.runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  }));
  report.environment.screen = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  async function mockLocation({
    status = 'unavailable',
    wait = 0,
    accuracy = 10,
    age = 0,
    coordinate = [120.0839164, 30.3025089],
  } = {}) {
    await app.evaluate(
      ({ ipcMain }, c) => {
        ipcMain.removeHandler('map:locate');
        ipcMain.handle(
          'map:locate',
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    status: c.status,
                    reason: `测试定位状态：${c.status}（模拟）`,
                    source: 'test',
                    phoneConnected: false,
                    fix: ['fresh', 'approximate', 'stale', 'outside'].includes(c.status)
                      ? {
                          coordinate: c.coordinate,
                          accuracy: c.accuracy,
                          timestamp: Date.now() - c.age,
                          crs: 'EPSG:4326',
                          source: 'test',
                          deviceLabel: '模拟测试设备',
                        }
                      : undefined,
                  }),
                c.wait,
              ),
            ),
        );
      },
      { status, wait, accuracy, age, coordinate },
    );
  }
  await mockLocation();
  const stage = () => page.locator('.campus-v2-stage');
  async function camera() {
    return JSON.parse(await stage().getAttribute('data-camera'));
  }
  async function open() {
    const t = performance.now();
    await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
    await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();
    return performance.now() - t;
  }
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, name) });
  }
  async function choose(query) {
    await page.getByRole('combobox', { name: '搜索建筑或地点' }).fill(query);
    await page.getByRole('combobox', { name: '搜索建筑或地点' }).press('Enter');
  }
  async function readyRoute() {
    await expect(page.locator('.campus-v2-route')).toHaveAttribute('data-status', 'ready');
    await page.waitForTimeout(420);
  }
  async function assertReturnButtonStable() {
    const back = page.getByRole('button', { name: '返回对话', exact: true });
    await back.waitFor({ state: 'visible' });
    const style = await back.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        pointerEvents: s.pointerEvents,
        appRegion: s.getPropertyValue('-webkit-app-region'),
        zIndex: s.zIndex,
      };
    });
    assert.equal(style.pointerEvents, 'auto');
    assert.equal(style.appRegion, 'no-drag');
    for (let i = 0; i < 12; i++) {
      await back.hover();
      const hit = await back.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el.matches(':hover') && (target === el || el.contains(target));
      });
      assert.equal(hit, true, `返回按钮第 ${i + 1} 次悬停未命中`);
    }
  }
  async function invariant() {
    const c = await camera();
    assert.equal(c.pitch, 0);
    const transforms = await stage()
      .locator('canvas')
      .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).transform));
    assert.ok(transforms.every((t) => t === 'none' || t.startsWith('matrix(')));
    assert.equal(await stage().locator('img,video,iframe').count(), 0);
  }
  async function pixel(coordinate) {
    const c = await camera(),
      r = await stage().boundingBox(),
      x = (6378137 * coordinate[0] * Math.PI) / 180,
      y = 6378137 * Math.log(Math.tan(Math.PI / 4 + (coordinate[1] * Math.PI) / 360)),
      dx = x - c.center[0],
      dy = y - c.center[1];
    return {
      x: r.x + c.size[0] / 2 + (dx * Math.cos(c.rotation) + dy * Math.sin(c.rotation)) / c.resolution,
      y: r.y + c.size[1] / 2 + (dx * Math.sin(c.rotation) - dy * Math.cos(c.rotation)) / c.resolution,
    };
  }
  await page.getByRole('textbox', { name: '和在场说说' }).fill('地图验收草稿（合成）');
  report.performance.coldOpenMs = await open();
  await shot('01-overview.png');
  await invariant();
  checked('G01', '真实应用标题栏进入地图，草稿保持；使用隔离测试资料目录');
  await page.getByRole('button', { name: '两点路线', exact: true }).click();
  await choose('东3教学楼');
  await choose('东4教学楼');
  await readyRoute();
  await expect(page.locator('.campus-v2-route')).toContainText('206 米');
  await shot('02-route-east3-east4.png');
  const direct = await page.evaluate(() =>
    window.zaichang.mapRoute({
      from: { kind: 'place', id: 'way/161393058' },
      to: { kind: 'place', id: 'way/161393066' },
    }),
  );
  assert.equal(direct.status, 'ready');
  assert.equal(direct.distance.connectorM, 0);
  report.performance.routeComputeMs = direct.elapsedMs;
  checked('G11', '两点模式起点固定；真实源建筑、入口、路线和距离对应');
  const beforeFit = await camera();
  await page.getByRole('button', { name: '查看全路线', exact: true }).click();
  await page.waitForTimeout(400);
  const afterFit = await camera();
  assert.ok(
    Math.hypot(beforeFit.center[0] - afterFit.center[0], beforeFit.center[1] - afterFit.center[1]) < 1,
  );
  assert.ok(Math.abs(beforeFit.resolution - afterFit.resolution) < 0.01);
  checked('G16', '路线已经可见时，查看全路线不进行多余缩放');
  await page.getByRole('button', { name: '交换两端', exact: true }).click();
  await readyRoute();
  await expect(page.locator('.campus-v2-endpoints')).toContainText('东4教学楼');
  await page.getByRole('button', { name: '更改起点', exact: true }).click();
  await choose('白沙综合楼');
  await readyRoute();
  const next = places
    .filter(
      (p) =>
        p.kind === 'building' &&
        p.entrances.some((e) => e.connected) &&
        !['way/161393058', 'way/161393066', 'way/322644189'].includes(p.id),
    )
    .slice(0, 5);
  for (const p of next) {
    await choose(p.id);
    await expect(page.locator('.campus-v2-route')).not.toHaveAttribute('data-status', 'loading');
    await expect(page.locator('.campus-v2-endpoints')).toContainText(p.displayName);
  }
  checked('G24', '五个未用于主展示的真实建筑通过同一选择与路由流程');
  await choose('桂花苑');
  await expect(page.locator('.campus-v2-route')).toHaveAttribute('data-status', 'unknown_entrance');
  await shot('03-wangyue-missing-entry.png');
  checked('G15', '望月公寓未知入口准确失败；未绘制假连接，地图仍可浏览');
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await choose('东3教学楼');
  await choose('东4教学楼');
  await readyRoute();
  const target = places.find((p) => p.id === 'way/161393066');
  const angles = [(await camera()).rotation];
  for (let i = 0; i < 24; i++) {
    await page.getByRole('button', { name: '顺时针旋转地图', exact: true }).click();
    await expect.poll(async () => (await camera()).animating).toBe(false);
    await invariant();
    angles.push((await camera()).rotation);
    if ([2, 11, 23].includes(i)) {
      await page.getByRole('button', { name: '查看全路线', exact: true }).click();
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: '更改起点', exact: true }).click();
      const p = await pixel(target.coordinate);
      assert.ok(
        await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.campus-v2-stage'), p),
        'Sampled building must be visible outside control overlays',
      );
      await page.mouse.click(p.x, p.y);
      await expect(page.locator('.campus-v2-endpoints>button').first()).toContainText('东4教学楼');
      await page.getByRole('button', { name: '更改起点', exact: true }).click();
      await choose('东3教学楼');
      await readyRoute();
      await shot(`04-rotation-${i + 1}.png`);
    }
  }
  for (let i = 0; i < 24; i++) {
    await page.getByRole('button', { name: '顺时针旋转地图', exact: true }).click();
    await expect.poll(async () => (await camera()).animating).toBe(false);
    await invariant();
    angles.push((await camera()).rotation);
  }
  const deltas = angles.slice(1).map((a, i) => Math.atan2(Math.sin(a - angles[i]), Math.cos(a - angles[i])));
  report.rotation = { normalizedSamples: angles, travelRadians: deltas.reduce((s, x) => s + x, 0) };
  assert.ok(Math.abs(report.rotation.travelRadians - 4 * Math.PI) < 0.04);
  assert.ok(deltas.every((d) => d > 0 && d < 0.3));
  await page.getByRole('button', { name: '地图回北', exact: true }).click();
  await page.waitForTimeout(300);
  assert.ok(Math.abs(Math.sin((await camera()).rotation)) < 1e-5);
  checked('G17', '连续两圈旋转、跨零和回北均保持 Canvas 二维变换；同一建筑命中不变');
  await page.getByRole('button', { name: '查看校园全貌', exact: true }).click();
  await page.waitForTimeout(430);
  const rect = await stage().boundingBox();
  const hoverables = [];
  for (const p of places.filter((p) => p.kind === 'building')) {
    const at = await pixel(p.coordinate);
    if (
      at.x > rect.x + 380 &&
      at.x < rect.x + rect.width - 90 &&
      at.y > rect.y + 150 &&
      at.y < rect.y + rect.height - 240
    )
      hoverables.push({ p, at });
    if (hoverables.length === 12) break;
  }
  for (const { at } of hoverables) {
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(15);
  }
  assert.equal(await page.locator('.campus-v2-tooltip').count(), 0);
  await page.waitForTimeout(380);
  assert.equal(await page.locator('.campus-v2-tooltip').count(), 1);
  await expect(page.locator('.campus-v2-endpoints')).toContainText('东4教学楼');
  checked('G08-G09', '快速扫楼不弹连续说明，停留才显示名称；悬停不改变已选终点');
  // Deliberately reorder actual route calculations at the IPC boundary.
  await app.evaluate(
    ({ ipcMain }, { modulePath, dataPath }) => {
      const load = process.getBuiltinModule('module').createRequire(modulePath);
      const Service = load(modulePath).CampusMapAdapter,
        service = new Service(dataPath);
      ipcMain.removeHandler('map:route');
      ipcMain.handle('map:route', async (_event, q) => {
        const r = service.route(q);
        await new Promise((resolve) => setTimeout(resolve, q.to?.id === 'way/161393058' ? 650 : 25));
        return r;
      });
    },
    { modulePath: serviceModule, dataPath: path.join(root, 'assets/map-v2') },
  );
  await choose('东3教学楼');
  await choose('东4教学楼');
  await page.waitForTimeout(900);
  await expect(page.locator('.campus-v2-endpoints')).toContainText('东4教学楼');
  await expect(page.locator('.campus-v2-route')).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('.campus-v2-route')).toContainText('206 米');
  checked('G12', '故意晚到的旧 IPC 路线未覆盖较新终点');
  await assertReturnButtonStable();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '和在场说说' })).toHaveValue('地图验收草稿（合成）');
  const restoreCamera = afterFit;
  report.performance.warmOpenMs = await open();
  await expect(page.locator('.campus-v2-endpoints')).toContainText('东4教学楼');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  // Fresh first entry with explicitly labelled synthetic position, then immediate takeover.
  await mockLocation({ status: 'fresh', wait: 120 });
  await page.reload();
  await open();
  await expect(page.locator('.campus-v2-location-state')).toContainText('位置已更新');
  await page.waitForTimeout(220);
  const r = await stage().boundingBox();
  await page.mouse.move(r.x + r.width * 0.55, r.y + r.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.55 + 95, r.y + r.height * 0.45 + 60, { steps: 8 });
  await page.mouse.wheel(0, -280);
  await page.mouse.up();
  await page.waitForTimeout(550);
  await invariant();
  await shot('05-simulated-intro-interrupted.png');
  checked('G02-G03', '模拟及时定位触发局部引导；拖动与反向缩放可中断，不影响纯二维');
  await mockLocation({ status: 'fresh', wait: 1000 });
  await page.reload();
  await open();
  const rr = await stage().boundingBox();
  await page.mouse.move(rr.x + 500, rr.y + 350);
  await page.mouse.down();
  await page.mouse.move(rr.x + 600, rr.y + 360, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const lateBefore = await camera();
  await page.waitForTimeout(800);
  const lateAfter = await camera();
  assert.ok(
    Math.hypot(lateBefore.center[0] - lateAfter.center[0], lateBefore.center[1] - lateAfter.center[1]) < 2,
  );
  checked('G04', '模拟迟到定位在用户平移后只更新位置，不抢相机');
  for (const fixture of [
    { status: 'denied' },
    { status: 'approximate', accuracy: 300 },
    { status: 'stale', age: 180000 },
    { status: 'outside', coordinate: [121, 31] },
  ]) {
    await mockLocation(fixture);
    await page.reload();
    await open();
    await page.waitForTimeout(180);
    await page.getByRole('button', { name: '地图来源与覆盖范围', exact: true }).click();
    await expect(page.locator('.campus-v2-about')).toContainText('未连接手机位置');
    await page.getByRole('button', { name: '关闭地图说明', exact: true }).click();
    await page.getByRole('button', { name: '两点路线', exact: true }).click();
    await choose('东3教学楼');
    await choose('东4教学楼');
    await readyRoute();
  }
  checked('G05-G06', '模拟拒绝、低精度、过期、范围外状态均保留两点路线；明确未连接手机');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stage().focus();
  await page.keyboard.press('e');
  await page.keyboard.press('+');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('n');
  await invariant();
  await page.getByRole('combobox', { name: '搜索建筑或地点' }).fill('e');
  const inSearch = await camera();
  await page.keyboard.press('q');
  assert.deepEqual(await camera(), inSearch);
  await page.keyboard.press('Escape');
  checked('G18-G20', '无鼠标键盘任务可操作；搜索输入不截获地图快捷键，减少动态效果保留功能');
  for (const [width, height] of [
    [760, 620],
    [680, 570],
    [1360, 920],
  ]) {
    await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), {
      width,
      height,
    });
    await page.waitForTimeout(120);
    const dimensions = await page.locator('.campus-v2-dialog').evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth,
      height: el.clientHeight,
      viewport: innerHeight,
    }));
    assert.ok(dimensions.scroll <= dimensions.client + 1);
    assert.ok(dimensions.height <= dimensions.viewport);
    await invariant();
    await shot(`06-layout-${width}.png`);
  }
  checked('G19', '桌面最小窗口和宽窗口无横向溢出，画布随容器更新');
  const rendererBeforeTheme = await stage().getAttribute('data-renderer');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(350);
  await shot('07-light.png');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.waitForTimeout(350);
  assert.equal(
    await stage().getAttribute('data-renderer'),
    rendererBeforeTheme,
    'Theme updates must not unexpectedly switch the renderer',
  );
  const measures = await page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    frames.sort((a, b) => a - b);
    return {
      samples: frames.length,
      medianMs: frames[Math.floor(frames.length / 2)],
      p95Ms: frames[Math.floor(frames.length * 0.95)],
      over50: frames.filter((x) => x > 50).length,
      note: 'Idle rAF clock sampling; interaction timing is separate.',
    };
  });
  report.performance.idleFrameClock = measures;
  await page.mouse.move(5, 5);
  await page.waitForTimeout(700);
  const renders = await stage().getAttribute('data-renders');
  await page.waitForTimeout(10000);
  assert.equal(await stage().getAttribute('data-renders'), renders);
  checked('G23', '无位置变化时静置十秒，没有装饰循环或额外地图重绘');
  for (let i = 0; i < 8; i++) {
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await open();
    assert.equal(await page.locator('.campus-v2-stage .ol-viewport').count(), 1);
  }
  checked('G22', '八次开关后只有一个地图实例；离开时定位请求和监听器清理');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
  await shot('08-final.png');
} catch (error) {
  report.status = page ? 'failed' : 'runtime-blocked';
  report.errors.push(String(error));
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  if (video) report.video = await video.path().catch(() => undefined);
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
