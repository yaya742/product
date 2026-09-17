import { isolatedEnvironment } from "../scripts/test-environment.mjs";
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(),
  out = path.join(root, 'artifacts/map-v2');
await fs.mkdir(out, { recursive: true });
const env = isolatedEnvironment("desktop", path.join(root, '.test-data', 'map-faults-' + Date.now()));
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [root], env });
const report = {
  status: 'running',
  checks: [],
  errors: [],
  simulated: 'Renderer fetch faults, 700 ms data delay and forced graphics-context loss are test injections.',
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
      reason: '异常测试未采集位置',
    }));
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  // Inject a failed fetch at the renderer boundary; no real files are modified.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__mapOriginalFetch = original;
    window.fetch = (input, init) =>
      String(input).includes('geography.geojson')
        ? Promise.reject(new TypeError('测试：地图文件不可用'))
        : original(input, init);
  });
  await page.reload();
  await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
  await expect(page.locator('.campus-v2-empty')).toContainText('地图暂未载入');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '和在场说说' })).toBeVisible();
  report.checks.push('Failed geography fetch presents retry/return and does not prevent chat use.');
  // Remove the injection in this page and use a controlled delayed resource.
  await page.evaluate(() => {
    window.fetch = async (input, init) => {
      if (String(input).includes('geography.geojson')) await new Promise((r) => setTimeout(r, 700));
      return window.__mapOriginalFetch(input, init);
    };
  });
  const start = performance.now();
  await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
  await expect(page.locator('.campus-v2-dialog')).toBeVisible();
  report.shellMs = performance.now() - start;
  assert.ok(report.shellMs < 500);
  const ready = page.locator('.campus-v2-stage[data-ready="true"]');
  await ready.waitFor();
  report.delayedContentReadyMs = performance.now() - start;
  assert.ok(report.delayedContentReadyMs >= 700);
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(out, 'slow-data-ready.png') });
  report.checks.push(
    'A 700 ms data delay leaves an immediately available shell and controls; content readiness is timed separately.',
  );
  const stage = page.locator('.campus-v2-stage');
  report.initialRenderer = await stage.getAttribute('data-renderer');
  if (report.initialRenderer === 'webgl-2d') {
    await page.evaluate(() => {
      const canvas = [...document.querySelectorAll('.campus-v2-stage canvas')].find((c) =>
        c.getContext('webgl'),
      );
      const gl = canvas.getContext('webgl');
      gl.getExtension('WEBGL_lose_context').loseContext();
    });
    await expect(stage).toHaveAttribute('data-renderer', 'canvas-2d-fallback');
    await page.getByRole('combobox', { name: '搜索建筑或地点' }).fill('东3教学楼');
    await page.keyboard.press('Enter');
    await expect(page.locator('.campus-v2-endpoints')).toContainText('东3教学楼');
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(out, 'graphics-fallback.png') });
    report.checks.push(
      'A lost WebGL context switches to live Canvas 2D geography; building selection remains usable.',
    );
  }
  // Restore the real fetch for subsequent use in this isolated page.
  await page.evaluate(() => {
    window.fetch = window.__mapOriginalFetch;
    delete window.__mapOriginalFetch;
  });
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(String(e));
  process.exitCode = 1;
} finally {
  await app.close();
  await fs.writeFile(path.join(out, 'faults.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
