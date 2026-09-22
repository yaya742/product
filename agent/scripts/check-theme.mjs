import { _electron as electron } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from './test-environment.mjs';

const base = process.cwd();
const out = path.join(base, 'artifacts', 'review', 'theme-check');
await mkdir(out, { recursive: true });
const env = isolatedEnvironment('theme-check');
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [base], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(out, `${scheme}-home.png`), animations: 'disabled' });
    const values = await page.evaluate(() => {
      const rgb = (value) => {
        const m = value.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').slice(0, 3).map(Number);
        return p.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
      };
      const ratio = (a, b) => {
        const x = rgb(a), y = rgb(b);
        if (!x || !y) return null;
        const l = v => .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
        const [hi, lo] = [l(x), l(y)].sort((m, n) => n - m);
        return Number(((hi + .05) / (lo + .05)).toFixed(2));
      };
      const pick = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor, fontSize: s.fontSize };
      };
      const body = pick('body'), composer = pick('.composer'), placeholder = getComputedStyle(document.querySelector('.composer textarea'), '::placeholder').color;
      const h1 = pick('.welcome h1');
      return {
        body, brand: pick('.brand'), placeholder: { color: placeholder, ratio: ratio(placeholder, composer.background) },
        footer: pick('.app-footer-status'), composer,
        contrast: { h1: ratio(h1.color, body.background), body: ratio(body.color, body.background) },
      };
    });
    console.log(scheme, JSON.stringify(values));
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const newChatButton = page.getByRole('button', { name: '新的对话', exact: true });
  await newChatButton.hover();
  await page.waitForTimeout(220);
  const hoverStyles = await newChatButton.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color };
  });
  assert.equal(hoverStyles.background, 'rgb(69, 71, 69)');
  assert.equal(hoverStyles.color, 'rgb(247, 248, 247)');
  await page.screenshot({ path: path.join(out, 'light-hover.png'), animations: 'disabled' });
  console.log('light hover', JSON.stringify(hoverStyles));
  await page.getByRole('button', { name: '安排一下今天', exact: false }).click();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '加入我的安排', exact: false }).waitFor();
  await page.getByRole('button', { name: '加入我的安排', exact: false }).click();
  await page.locator('.saved-action').waitFor();
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(out, `${scheme}-conversation.png`), animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('textarea[aria-label="和在场说说"]').focus();
  await page.screenshot({ path: path.join(out, 'light-focus.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light', contrast: 'more', forcedColors: 'active' });
  console.log('forced', await page.evaluate(() => {
    const e = document.querySelector('.composer');
    const t = document.querySelector('.composer textarea');
    const s = getComputedStyle(e);
    return { border: s.border, shadow: s.boxShadow, forced: s.forcedColorAdjust, textarea: getComputedStyle(t).border };
  }));
  await page.screenshot({ path: path.join(out, 'light-high-contrast.png'), animations: 'disabled' });
} finally {
  await app.close();
}
