import { _electron as electron, expect } from '@playwright/test';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { isolatedEnvironment } from '../scripts/test-environment.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = process.cwd();
const executablePath = path.join(base, 'release', 'win-unpacked', '在场.exe');
const env = isolatedEnvironment('packaged');
const version = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')).version;
await mkdir(path.join(base, 'artifacts', 'review', 'round2'), { recursive: true });
const desktop = await electron.launch({ executablePath, args: [], env, timeout: 30000 });
try {
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const runtime = await desktop.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    appPath: app.getAppPath(),
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    security: {
      nodeIntegration: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().nodeIntegration,
      contextIsolation: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().contextIsolation,
      sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
    },
  }));
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.version, version);
  assert.equal(runtime.security.nodeIntegration, false);
  assert.equal(runtime.security.contextIsolation, true);
  assert.equal(runtime.security.sandbox, true);
  await page.screenshot({
    path: path.join(base, 'artifacts', 'review', 'round2', '09-packaged-home.png'),
    animations: 'disabled',
  });
  const input = page.getByRole('textbox', { name: '和在场说说' });
  await page.getByRole('button', { name: '设置本轮资料范围' }).click();
  await page.getByRole('combobox', { name: '本轮参考范围' }).selectOption('current_sources_only');
  await page.getByRole('button', { name: '用于下一条消息' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await input.fill('只整理这一条合成文字：讨论课改到周四。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'detached' });
  let state = await page.evaluate(() => window.zaichang.state());
  const messages = await page.evaluate((id) => window.zaichang.messages(id), state.conversations[0].id);
  assert.equal(messages.at(-1).scopeSummary.memoryMode, 'current_sources_only');
  assert.ok(messages.at(-1).contextReceipt);
  state = await page.evaluate(() =>
    window.zaichang.memory({ action: 'save', text: '我喜欢安静的学习环境。' }),
  );
  const memory = state.memories[0];
  assert.ok(memory);
  state = await page.evaluate((id) => window.zaichang.memory({ action: 'deactivate', id }), memory.id);
  const overview = await page.evaluate(() => window.zaichang.runtimeOverview());
  assert.equal(overview.memories.find((m) => m.id === memory.id).status, 'inactive');
  await input.fill('PACKAGED_DRAFT_552');
  await page.getByRole('button', { name: '打开校园地图', exact: true }).click();
  await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();
  for (const name of ['求是大道', '西操场', '东操场', '中心湖', '启真湖']) {
    const search = page.getByRole('combobox', { name: '搜索建筑或地点' });
    await search.fill(name);
    await search.press('Enter');
    const displayed = { '西操场': '紫金港西田径场', '东操场': '东田径场' }[name] || name;
    await expect(page.getByRole('region', { name: '路线信息' })).toContainText(displayed);
  }
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await input.inputValue(), 'PACKAGED_DRAFT_552');
  runtime.harnessChecks = [
    'original input -> policy scope -> persisted ContextReceipt',
    'controlled memory save/deactivate',
    'map return preserves draft',
  ];
  await writeFile(
    path.join(base, 'artifacts', 'review', 'package-report.json'),
    JSON.stringify(runtime, null, 2),
  );
  console.log(JSON.stringify(runtime, null, 2));
} finally {
  await desktop.close();
}
