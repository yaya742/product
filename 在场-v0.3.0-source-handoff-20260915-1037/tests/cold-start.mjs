import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isolatedEnvironment, testRoot } from '../scripts/test-environment.mjs';

const base = process.cwd();
await mkdir(testRoot, { recursive: true });
const dataDir = await mkdtemp(path.join(testRoot, 'cold-start-'));
const env = isolatedEnvironment('cold-start', dataDir);
delete env.ELECTRON_RUN_AS_NODE;

let app;
try {
  // Save a fixture credential through the real Electron IPC path first. The
  // next launch then receives unreadable ciphertext, matching a key created
  // under another Windows profile or after a profile migration.
  app = await electron.launch({ args: [base], env, timeout: 30000 });
  let page = await app.firstWindow();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  const saved = await page.evaluate(() =>
    window.zaichang.saveSettings({ mode: 'deepseek', apiKey: 'sk-cold-start-fixture-123456' }),
  );
  assert.equal(saved.settings.mode, 'deepseek');
  assert.equal(saved.settings.keyStatus, 'available');
  await app.close();
  app = undefined;

  await writeFile(path.join(dataDir, 'deepseek-key.bin'), Buffer.from('not-a-valid-safe-storage-ciphertext'));

  app = await electron.launch({ args: [base], env, timeout: 30000 });
  page = await app.firstWindow();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  const state = await page.evaluate(() => window.zaichang.state());
  assert.deepEqual(
    { mode: state.settings.mode, hasKey: state.settings.hasKey, keyStatus: state.settings.keyStatus },
    { mode: 'deepseek', hasKey: false, keyStatus: 'invalid' },
  );
  await page
    .getByRole('alert')
    .filter({ hasText: '已保存的 DeepSeek API Key 无法读取' })
    .waitFor();

  const input = page.getByRole('textbox', { name: '和在场说说' });
  await input.fill('冷启动全新验证');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: '已保存的 DeepSeek API Key 无法读取，请打开连接设置重新输入并保存。' })
    .waitFor({ timeout: 5000 });
  assert.equal(
    await page.getByText('这次处理中断了，剩余事项未完成。已有回执的操作可在安排中核对。', { exact: true }).count(),
    0,
  );
  assert.equal(await page.locator('.assistant-message').count(), 0);
  console.log('冷启动回归通过：无效密钥会在启动页和发送前显示可操作提示，不再生成泛化无回应错误。');
} finally {
  if (app) await app.close();
}
