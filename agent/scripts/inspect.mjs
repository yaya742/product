import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import { isolatedEnvironment } from './test-environment.mjs';
const env = isolatedEnvironment('native-inspection');
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ args: [process.cwd()], env });
const page = await desktop.firstWindow();
await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
console.log('Desktop inspection ready: ' + desktop.process().pid);
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('-webkit-app-region'),
      dragSpace: getComputedStyle(document.querySelector('.drag-space')).getPropertyValue(
        '-webkit-app-region',
      ),
    })),
  ),
);
await desktop.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.show();
  w.focus();
});
await desktop.waitForEvent('close', { timeout: 0 });
