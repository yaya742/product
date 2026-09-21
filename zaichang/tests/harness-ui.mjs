import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../scripts/test-environment.mjs';
const env = isolatedEnvironment('harness-ui'),
  out = path.resolve('artifacts/harness/frontend-review');
await fs.mkdir(out, { recursive: true });
const compiled = path.join(env.ZAICHANG_DATA_DIR, 'seed-ui.cjs');
await build({
  entryPoints: ['tests/harness/seed-ui.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: compiled,
  target: 'node24',
  loader: { '.md': 'text' },
});
const seeded = spawnSync(process.execPath, [compiled], { env, encoding: 'utf8', windowsHide: true });
if (seeded.status !== 0) throw new Error(seeded.stderr);
const ids = JSON.parse(await fs.readFile(path.join(env.ZAICHANG_DATA_DIR, 'ui-ids.json'), 'utf8'));
let app = await electron.launch({ args: [process.cwd()], env, timeout: 30000 });
const checks = [],
  errors = [];
let status = 'failed';
async function run() {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const shot = async (name) => page.screenshot({ path: path.join(out, name), animations: 'disabled' });
  const close = async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('01-home-light.png');
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByText('只保留会帮到你的几件事。需要时可以改，也可以删掉。').waitFor();
  await page.locator('.memory-row').first().waitFor();
  assert.equal(await page.locator('.memory-row').count(), 3);
  assert.equal(await page.locator('.memory-group-simple .memory-row-current').count(), 1);
  const memorySurfaceText = await page.locator('.memory-panel-simple').innerText();
  assert.equal(memorySurfaceText.includes('有原文依据'), false);
  assert.equal(memorySurfaceText.includes('尚未核验'), false);
  assert.equal(memorySurfaceText.includes('正在使用'), false);
  assert.equal(await page.locator('.memory-row-current .memory-detail-actions').count(), 0);
  await page.getByText('其他内容', { exact: true }).click();
  assert.equal(await page.locator('.memory-more-simple').getAttribute('open'), '');
  assert.equal(await page.locator('.memory-review-simple .memory-row-decision').count(), 1);
  assert.equal(await page.locator('.memory-archive-simple .memory-row-archived').count(), 1);
  await shot('02-understanding-expanded.png');
  await page.locator('.memory-row-decision .memory-row-summary').first().click();
  const detailLayout = await page
    .locator('.memory-row-decision .memory-detail-actions')
    .evaluate((el) => getComputedStyle(el).display);
  assert.equal(detailLayout, 'grid');
  await page.locator('.memory-row-decision .memory-row-summary').first().click();
  await page.getByText('其他内容', { exact: true }).click();
  await shot('02-understanding-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('03-understanding-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  const active = page.locator('.memory-row-current').filter({ hasText: '安静的地方' });
  await active.getByRole('button', { name: /我更喜欢安静的地方/ }).click();
  await active.getByRole('button', { name: '改正这条内容', exact: true }).click();
  await page.getByRole('textbox', { name: '偏好内容' }).fill('我现在更喜欢有一点背景声的空间。');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存；下一轮' }).waitFor();
  let overview = await page.evaluate(() => window.zaichang.runtimeOverview());
  assert.equal(overview.memories.find((m) => m.id === ids.memoryId).revision, 2);
  const corrected = page.locator('.memory-row-current').filter({ hasText: '背景声' });
  await corrected.getByRole('button', { name: /背景声/ }).click();
  await page
    .locator('.memory-row-current')
    .filter({ hasText: '背景声' })
    .getByRole('button', { name: '查看来源' })
    .click();
  await page
    .locator('.evidence-preview')
    .getByText('我现在更喜欢有一点背景声的空间。', { exact: true })
    .waitFor();
  await shot('04-correction-source.png');
  checks.push(
    'single-focus memory rows, on-demand review details, version-bound correction, updated source through native IPC',
  );
  await page
    .locator('.memory-row-current')
    .filter({ hasText: '背景声' })
    .getByRole('button', { name: '暂时停用', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: '已停用' }).waitFor();
  overview = await page.evaluate(() => window.zaichang.runtimeOverview());
  assert.equal(overview.memories.find((m) => m.id === ids.memoryId).status, 'inactive');
  await close();
  await page.getByRole('button', { name: /^我的安排/ }).click();
  await page.locator('.work-row').getByText('准备社团分享', { exact: true }).waitFor();
  await page.getByRole('button', { name: '采用这个目标' }).click();
  await page.getByText('进行中', { exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByText('已暂停', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消目标' }).click();
  await page.getByText('已取消', { exact: true }).waitFor();
  await page.getByRole('button', { name: '核查结果', exact: true }).click();
  overview = await page.evaluate(() => window.zaichang.runtimeOverview());
  assert.equal(overview.actions.find((a) => a.action.id === ids.unknownId).action.status, 'unresolved');
  await shot('05-goal-unknown.png');
  checks.push('goal adopt/pause/cancel and unsupported unknown receipt remain honest');
  await close();
  await page.getByRole('button', { name: '历史对话', exact: true }).click();
  await page.locator('.history-item > button').first().click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '保存为待核对安排' }).waitFor();
  await page.getByRole('button', { name: /按需参考资料/ }).click();
  await page.getByText('本轮理解', { exact: true }).waitFor();
  await page.getByText('有一处指代待确认：刚才那个', { exact: true }).waitFor();
  await shot('06a-interpretation.png');
  checks.push('user-facing interpretation summary exposes participation and unresolved reference without hidden reasoning');
  await page.getByRole('button', { name: /按需参考资料/ }).click();
  await page.getByRole('button', { name: '反馈这条建议' }).click();
  await page.getByRole('textbox', { name: '建议反馈原因' }).fill('想先休息，不想把空闲全部安排好。');
  await page.getByRole('button', { name: '保存反馈' }).click();
  await page.getByRole('status').filter({ hasText: '已记下反馈' }).waitFor();
  checks.push('conditional action label and reasoned feedback do not claim execution or outcome');
  await shot('06-conversation-feedback.png');
  await page.getByRole('button', { name: '保存为待核对安排' }).click();
  const savedAction = page.locator('.saved-action').filter({ hasText: '整理分享提纲' });
  await savedAction.getByText('条件待核对', { exact: false }).waitFor();
  await savedAction.getByText('本机已登记', { exact: false }).waitFor();
  assert.equal(await savedAction.getByRole('button', { name: '加入我的安排' }).count(), 0);
  const agendaAfterSave = (await page.evaluate(() => window.zaichang.state())).agenda;
  assert.equal(agendaAfterSave[0].coverage, 'conditional');
  const savedActionState = await page.evaluate((id) => window.zaichang.actionState(id), agendaAfterSave[0].id);
  assert.equal(savedActionState.receipts.at(-1).localStatus, 'local_saved');
  await shot('06b-local-receipt.png');
  await savedAction.getByRole('button', { name: '查看安排' }).click();
  await page.getByRole('dialog').getByText('本机回执', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '撤销本机登记' }).waitFor();
  await shot('06c-agenda-receipt.png');
  await close();
  await savedAction.getByRole('button', { name: /撤销本机登记/ }).click();
  await page.getByText('本机登记已撤销。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.zaichang.state())).agenda.length, 0);
  checks.push(
    'conditional local record shows its host receipt, preserves unresolved conditions, and can be revoked from the original chat',
  );
  await page.getByRole('button', { name: '设置本轮资料范围' }).click();
  await page.getByRole('combobox', { name: '本轮参考范围' }).selectOption('current_sources_only');
  await shot('07-scope.png');
  await page.getByRole('button', { name: '用于下一条消息' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const input = page.getByRole('textbox', { name: '和在场说说' });
  await input.fill('只整理本条文字：讨论课改到周四。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'detached' });
  const last = await page.evaluate(
    async (id) => (await window.zaichang.messages(id)).filter((m) => m.role === 'assistant').at(-1),
    ids.sessionId,
  );
  assert.equal(last.scopeSummary.memoryMode, 'current_sources_only');
  assert.equal(
    last.contextReceipt.providedObjectVersions.some((o) => o.id === ids.memoryId),
    false,
  );
  checks.push('scope control reaches policy and receipt through original input');
  await page.getByRole('button', { name: '设置本轮资料范围' }).click();
  await page.getByRole('combobox', { name: '本轮保留方式' }).selectOption('session_only');
  await page.getByRole('button', { name: '用于下一条消息' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await input.fill('EPHEMERAL_UI_CANARY_552 这段只在本轮使用。');
  const savedDraft = await page.evaluate((id) => window.zaichang.draft(id), ids.sessionId);
  assert.ok(!JSON.stringify(savedDraft).includes('EPHEMERAL_UI_CANARY_552'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'detached' });
  const stored = await page.evaluate((id) => window.zaichang.messages(id), ids.sessionId);
  assert.ok(!JSON.stringify(stored).includes('EPHEMERAL_UI_CANARY_552'));
  checks.push('temporary scope suppresses draft and conversation persistence');
  await input.fill('假设下周搬到另一处住，先把要准备的事情放在设想里。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^我的安排/ }).click();
  await page.locator('.world-review summary').first().click();
  await page.getByRole('checkbox', { name: '选择这项设想作为准备事项' }).first().check();
  await shot('10-world-diff.png');
  await page.getByRole('button', { name: '建立选中的准备事项' }).click();
  await page.getByText('来自你选中的设想 · 尚未执行', { exact: true }).waitFor();
  overview = await page.evaluate(() => window.zaichang.runtimeOverview());
  assert.equal(overview.work.filter((w) => w.kind === 'task' && w.data.adoptionItemId).length, 1);
  assert.equal(overview.work.filter((w) => w.kind === 'commitment').length, 0);
  checks.push('original hypothetical input -> itemized review -> one preparation task, no commitment');
  await close();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 570));
  await page.waitForFunction(() => window.innerWidth <= 700);
  await page.getByRole('button', { name: '设置本轮资料范围' }).click();
  await shot('08-scope-small.png');
  assert.ok(await page.getByRole('button', { name: '用于下一条消息' }).isVisible());
  await close();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot('09-small-dark.png');
  assert.deepEqual(errors, []);
  status = 'passed';
}
try {
  await run();
} finally {
  await app.close();
  await fs.writeFile(
    path.join(out, 'ui-report.json'),
    JSON.stringify(
      { status, dataDirectory: env.ZAICHANG_DATA_DIR, kind: 'real_electron_synthetic_data', checks, errors },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ status, checks, errors }, null, 2));
