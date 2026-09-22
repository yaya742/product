import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedEnvironment } from '../scripts/test-environment.mjs';

const base = process.cwd();
const out = path.join(base, 'artifacts', 'review', 'material');
await mkdir(out, { recursive: true });
const env = isolatedEnvironment('material-desktop');
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [base], env, timeout: 30000 });
const page = await app.firstWindow();
const report = { checks: [], screenshots: [], errors: [] };
page.on('pageerror', (error) => report.errors.push(String(error)));

try {
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  report.checks.push('真实 Electron 启动时设置稳定的 Windows 通知应用标识');
  const initial = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    const composer = document.querySelector('.composer');
    return {
      ambient: getComputedStyle(shell, '::before').backgroundImage,
      backdrop: getComputedStyle(composer).backdropFilter,
      shellOverflow: getComputedStyle(shell).overflow,
    };
  });
  assert.match(initial.ambient, /gradient/);
  assert.match(initial.backdrop, /blur/);
  assert.equal(initial.shellOverflow, 'hidden');
  report.checks.push('真实 Electron 首页存在环境背景，输入区启用玻璃模糊');

  const pointer = await page.evaluate(() =>
    new Promise((resolve) => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 110 }));
      requestAnimationFrame(() => {
        const shell = document.querySelector('.app-shell');
        resolve({
          x: shell.style.getPropertyValue('--pointer-x'),
          y: shell.style.getPropertyValue('--pointer-y'),
        });
      });
    }),
  );
  assert.deepEqual(pointer, { x: '90px', y: '110px' });
  report.checks.push('指针柔光变量通过 requestAnimationFrame 更新');

  await page.screenshot({ path: path.join(out, 'dark-home.png'), animations: 'disabled' });
  report.screenshots.push('dark-home.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'light-home.png'), animations: 'disabled' });
  report.screenshots.push('light-home.png');

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.app-shell').evaluate((el) => getComputedStyle(el, '::after').opacity), '0');
  report.checks.push('减少动态效果关闭指针柔光');

  await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' });
  await page.waitForTimeout(50);
  const forced = await page.locator('.composer').evaluate((el) => ({
    backdrop: getComputedStyle(el).backdropFilter,
    shadow: getComputedStyle(el).boxShadow,
  }));
  assert.equal(forced.backdrop, 'none');
  assert.equal(forced.shadow, 'none');
  report.checks.push('高对比度模式回退为实底与无阴影');
  assert.deepEqual(report.errors, []);
  await writeFile(path.join(out, 'material-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
