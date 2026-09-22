import path from 'node:path';
import { isolatedEnvironment } from '../scripts/test-environment.mjs';
process.env.ELECTRON_OVERRIDE_DIST_PATH = path.join(process.cwd(), '.test-data', 'electron44');
const { _electron: electron } = await import('@playwright/test');
const env = isolatedEnvironment('inspect-geometry');
env.ELECTRON_OVERRIDE_DIST_PATH = process.env.ELECTRON_OVERRIDE_DIST_PATH;
const app = await electron.launch({ args: [process.cwd()], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  const before = await app.evaluate(({ BrowserWindow, screen }) => ({ bounds: BrowserWindow.getAllWindows()[0].getBounds(), screen: screen.getPrimaryDisplay().workAreaSize }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await page.waitForTimeout(350);
  const after = await app.evaluate(({ BrowserWindow, screen }) => ({ bounds: BrowserWindow.getAllWindows()[0].getBounds(), screen: screen.getPrimaryDisplay().workAreaSize }));
  const geometry = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], composer: document.querySelector('.composer')?.getBoundingClientRect().width, inputFont: parseFloat(getComputedStyle(document.querySelector('.composer textarea')).fontSize), dpr: devicePixelRatio }));
  console.log(JSON.stringify({ before, after, geometry }, null, 2));
} finally { await app.close(); }
