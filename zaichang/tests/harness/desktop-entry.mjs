import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../../scripts/test-environment.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const out = path.resolve(arg('--report-dir', 'artifacts/harness/desktop-entry'));
const draft = arg('--draft', 'DRAFT_RECOVERY_663'),
  modelFailure = process.argv.includes('--model-failure');
const env = isolatedEnvironment('harness-entry');
await fs.mkdir(out, { recursive: true });
let app = await electron.launch({ args: [process.cwd()], env, timeout: 30000 });
const errors = [];
const report = {
  status: 'running',
  dataDirectory: env.ZAICHANG_DATA_DIR,
  ui: { draft: '', map_opened: false, map_lifecycle_leaks: -1, model_unavailable: false },
  errors,
};
try {
  let page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  if (modelFailure) {
    await app.evaluate(() => {
      globalThis.fetch = async () => new Response('', { status: 401 });
    });
    await page.evaluate(() =>
      window.zaichang.saveSettings({ mode: 'deepseek', apiKey: 'synthetic-desktop-contract-key' }),
    );
    await page.getByRole('textbox', { name: '和在场说说' }).fill('分析一个测试安排');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '重新试试', exact: true }).waitFor();
    report.ui.model_unavailable = await page.getByText('DeepSeek API Key 无效', { exact: false }).isVisible();
    assert.equal(report.ui.model_unavailable, true);
  }
  await page.getByRole('textbox', { name: '和在场说说' }).fill(draft);
  await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
  await page.getByRole('button', { name: '返回对话', exact: true }).waitFor();
  await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();
  await page.locator('.campus-v2-dialog canvas').first().waitFor({ state: 'visible' });
  report.ui.map_opened = (await page.locator('.campus-v2-dialog canvas').count()) > 0;
  await page.screenshot({ path: path.join(out, 'map.png') });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '和在场说说' }).inputValue(), draft);
  report.ui.map_lifecycle_leaks = await page.locator('.campus-v2-dialog canvas').count();
  assert.equal(report.ui.map_lifecycle_leaks, 0);
  const saved = await page.evaluate(async () => {
    const state = await window.zaichang.state();
    return Promise.all(
      ['new', ...state.conversations.map((c) => c.id)].map((id) => window.zaichang.draft(id)),
    );
  });
  assert.ok(saved.some((d) => d.text === draft));
  await app.close();
  app = await electron.launch({ args: [process.cwd()], env, timeout: 30000 });
  page = await app.firstWindow();
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  const recovered = await page.evaluate(async () => {
    const state = await window.zaichang.state();
    return Promise.all(
      ['new', ...state.conversations.map((c) => c.id)].map((id) => window.zaichang.draft(id)),
    );
  });
  report.ui.draft = recovered.find((d) => d.text === draft)?.text || '';
  assert.equal(report.ui.draft, draft);
  assert.deepEqual(errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  throw error;
} finally {
  await app.close();
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        ...report,
        coverage:
          'real original Electron UI, canvas unmount and saved-draft restart; not a general heap-leak proof',
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify(report));
