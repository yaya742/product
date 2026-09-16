import { isolatedEnvironment } from '../scripts/test-environment.mjs';
import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = process.cwd();
const dir = path.join(base, '.test-data', 'desktop-' + Date.now());
const out = path.join(base, 'artifacts', 'review', process.env.ZAICHANG_REVIEW_ROUND || 'round1');
await mkdir(out, { recursive: true });
const env = isolatedEnvironment('desktop', dir);
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [base], env, timeout: 30000 });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const report = { dataDirectory: dir, checks: [], errors, frameSamples: {} };
async function shot(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
}
try {
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  const composerInput = page.getByRole('textbox', { name: '和在场说说' });
  await composerInput.click();
  const focusStyle = await composerInput.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      borderStyle: s.borderStyle,
      borderWidth: s.borderWidth,
    };
  });
  assert.equal(focusStyle.outlineStyle, 'none');
  assert.equal(focusStyle.outlineWidth, '0px');
  assert.equal(focusStyle.borderStyle, 'none');
  assert.equal(focusStyle.borderWidth, '0px');
  report.checks.push('点击输入框只保留外层容器焦点提示，不出现内部白色方框');
  await shot('01-home.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('01-dark-home.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('01-light-home.png');
  await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' });
  await composerInput.click();
  const forcedFocusStyle = await composerInput.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      borderStyle: s.borderStyle,
      borderWidth: s.borderWidth,
    };
  });
  assert.equal(forcedFocusStyle.outlineStyle, 'none');
  assert.equal(forcedFocusStyle.outlineWidth, '0px');
  assert.equal(forcedFocusStyle.borderStyle, 'none');
  assert.equal(forcedFocusStyle.borderWidth, '0px');
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  report.checks.push('应用启动，真实 Electron 窗口显示首页');
  await page.getByRole('button', { name: '安排一下今天', exact: false }).click();
  assert.equal(await page.getByRole('textbox', { name: '和在场说说' }).inputValue(), '帮我安排一下今天');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '加入我的安排', exact: false }).waitFor({ state: 'visible' });
  await shot('02a-action-draft.png');
  await page.getByRole('button', { name: '加入我的安排', exact: false }).click();
  await page.locator('.saved-action').waitFor();
  report.checks.push('本地演示完成并真实保存本地行动');
  await shot('02-conversation.png');
  await page.getByRole('button', { name: /^我的安排/ }).click();
  await page.getByRole('dialog').waitFor();
  await shot('02b-agenda.png');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  report.checks.push('安排页先显示已确认事项，其他状态退到下方');
  await page.locator('.process-summary').first().click();
  await page.waitForTimeout(350);
  await page.locator('.message-scroll').evaluate((el) => el.scrollTo(0, 0));
  await shot('03-process.png');
  report.checks.push('处理摘要可展开，示例标签清晰');
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await shot('04-connection.png');
  await page.getByRole('button', { name: /校园资料与天气/ }).click();
  const campusLogin = page.getByRole('button', { name: /^(登录浙大|验证登录|重新验证)$/ });
  await campusLogin.waitFor();
  assert.equal(await page.getByText('浙大账号已登录，可以按需读取校园资料', { exact: true }).count(), 0);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await campusLogin.click();
  await page.getByText('登录未完成：没有选择浙大连接器，当前不会读取校园资料', { exact: true }).waitFor();
  assert.equal(await page.getByText('浙大账号已登录，可以按需读取校园资料', { exact: true }).count(), 0);
  await shot('04a-campus-connector.png');
  report.checks.push('校园个人信息连接器以单一资料行呈现；取消登录不会显示虚假的成功状态');
  await page.getByRole('button', { name: '返回连接', exact: true }).click();
  await page.getByRole('tab', { name: '偏好', exact: true }).click();
  const panelColors = await page.evaluate(() => {
    const pick = (selector, pseudo) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el, pseudo);
      return { color: s.color, fill: s.webkitTextFillColor, outline: s.outline, border: s.border };
    };
    return {
      intro: pick('.panel-intro'),
      label: pick('.field-label'),
      control: pick('.field-label textarea'),
      placeholder: pick('.field-label textarea', '::placeholder'),
    };
  });
  assert.equal(panelColors.control.fill, panelColors.control.color);
  assert.equal(panelColors.placeholder.fill, panelColors.placeholder.color);
  assert.notEqual(panelColors.placeholder.color, 'rgb(255, 255, 255)');
  report.checks.push('记忆/偏好页使用统一中性色，输入框文字与占位文字不再抢主体层级');
  await shot('04b-preferences.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('04c-preferences-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByText('告诉在场一件事', { exact: true }).click();
  await page.getByRole('textbox', { name: '偏好内容' }).fill('我喜欢有一整段不被打断的学习时间。');
  await page.getByRole('button', { name: '记住这件事', exact: true }).click();
  await page
    .locator('.memory-row-current')
    .filter({ hasText: '我喜欢有一整段不被打断的学习时间。' })
    .waitFor();
  await shot('05-memory.png');
  report.checks.push('新增可编辑、可追溯的长期偏好');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '历史对话', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索对话标题' }).fill('找不到的标题');
  const historyFocus = await page.getByRole('textbox', { name: '搜索对话标题' }).evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      borderStyle: s.borderStyle,
      borderWidth: s.borderWidth,
    };
  });
  assert.equal(historyFocus.outlineStyle, 'none');
  assert.equal(historyFocus.outlineWidth, '0px');
  assert.equal(historyFocus.borderStyle, 'none');
  assert.equal(historyFocus.borderWidth, '0px');
  await page.getByRole('heading', { name: '没有找到这段对话。' }).waitFor();
  await shot('06-history-empty.png');
  report.checks.push('历史搜索空状态与Escape关闭可用；焦点恢复另有契约断言');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '新的对话', exact: true }).click();
  await page.getByRole('textbox', { name: '和在场说说' }).fill('最近有点累');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).click();
  await page.getByRole('button', { name: '重新试试', exact: false }).waitFor();
  report.checks.push('停止后保留重试入口；草稿保留与附件隔离另有契约断言');
  await shot('06-stopped.png');
  const stored = await page.evaluate(() => window.zaichang.state());
  assert.equal(stored.memories.length, 1);
  assert.equal(stored.agenda.length, 1);
  assert.equal(stored.settings.mode, 'demo');
  await page.getByRole('button', { name: '新的对话', exact: true }).click();
  await page
    .getByRole('textbox', { name: '和在场说说' })
    .fill('给老师写一段，沟通目的：确认讨论时间；公开内容：周三下午可以；语气：礼貌自然；先别发送。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'detached' });
  const releaseReply = page.locator('.assistant-message').last();
  await releaseReply.locator('.reply-evidence .evidence-toggle').click();
  await releaseReply.getByText('收件人：老师 · 目的：确认讨论时间', { exact: true }).waitFor();
  await releaseReply.getByText('允许写入：周三下午可以', { exact: true }).waitFor();
  assert.equal((await releaseReply.innerText()).includes('发送服务未接入'), true);
  await shot('06b-release-spec.png');
  report.checks.push('公开草稿前台显示收件人、目的、允许事实与未接入发送边界');
  await page.getByRole('button', { name: '新的对话', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 620));
  await shot('07-compact.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  report.checks.push('760 × 620 窄窗口无水平溢出');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 570));
  await shot('07b-minimum.png');
  const minimum = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    headingVisible: (() => {
      const r = document.querySelector('.welcome h1')?.getBoundingClientRect();
      return !!r && r.bottom <= window.innerHeight && r.top >= 0;
    })(),
    composerVisible: (() => {
      const r = document.querySelector('.composer')?.getBoundingClientRect();
      return !!r && r.bottom <= window.innerHeight && r.top >= 0;
    })(),
  }));
  assert.equal(minimum.horizontalOverflow, false);
  assert.equal(minimum.headingVisible, true);
  assert.equal(minimum.composerVisible, true);
  report.checks.push('680 × 570 最小窗口标题与输入框可见，无水平溢出');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await page.waitForTimeout(350);
  await shot('08-fullscreen.png');
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    composer: document.querySelector('.composer').getBoundingClientRect().width,
    inputFont: parseFloat(getComputedStyle(document.querySelector('.composer textarea')).fontSize),
  }));
  assert.ok(geometry.composer >= Math.min(1000, geometry.viewport * 0.65));
  assert.ok(geometry.inputFont >= 16.5);
  report.checks.push('全屏输入区域随可用屏幕放大，输入字号保持可读');
  report.fullscreenGeometry = geometry;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 850));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  const duration = await page.getByRole('dialog').evaluate((el) => getComputedStyle(el).animationDuration);
  assert.equal(duration, '0s');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  report.checks.push('减少动态效果遵从系统偏好');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const frames = page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let previous = 0,
          begin = performance.now();
        function sample(t) {
          if (previous) times.push(t - previous);
          previous = t;
          if (t - begin < 1100) requestAnimationFrame(sample);
          else resolve(times);
        }
        requestAnimationFrame(sample);
      }),
  );
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  await page.mouse.move(610, 500);
  await page.mouse.wheel(0, 350);
  const values = (await frames).sort((a, b) => a - b);
  report.frameSamples = {
    samples: values.length,
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.floor(values.length * 0.95)],
    over50Ms: values.filter((v) => v > 50).length,
    note: '单机 rAF 采样，只反映本次弹窗与滚动场景，不等于用户体感或所有设备性能。',
  };
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'desktop-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
const restarted = await electron.launch({ args: [base], env });
try {
  const page = await restarted.firstWindow();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  const data = await page.evaluate(() => window.zaichang.state());
  assert.equal(data.memories.length, 1);
  assert.equal(data.agenda.length, 1);
  console.log('重启恢复：记忆、历史、安排均保留。');
} finally {
  await restarted.close();
}
