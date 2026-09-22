import { isolatedEnvironment } from '../scripts/test-environment.mjs';
import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const live = process.argv.includes('--live');
const lunaTest = process.env.ZAICHANG_MODEL_TRANSPORT === 'luna-app-server-test';
const base = process.cwd();
const dataDir = path.join(base, '.test-data', `multimodal-${live ? 'live' : 'contract'}-${Date.now()}`);
const out = path.resolve(process.env.ZAICHANG_MULTIMODAL_REPORT || path.join(base, 'artifacts', 'review', 'multimodal'));
await mkdir(dataDir, { recursive: true });
await mkdir(out, { recursive: true });
const env = isolatedEnvironment('multimodal', dataDir);
if (!live) env.ZAICHANG_PROJECT_DEEPSEEK_KEY = 'synthetic-multimodal-key';
if (live && !lunaTest && !env.ZAICHANG_PROJECT_DEEPSEEK_KEY)
  throw new Error('Run the live check through the project DeepSeek credential wrapper.');

const executablePath = process.env.ZAICHANG_ELECTRON_EXECUTABLE;
const app = await electron.launch({ args: executablePath ? [] : [base], env, ...(executablePath ? { executablePath } : {}), ...(process.env.ZAICHANG_ELECTRON_CWD ? { cwd: process.env.ZAICHANG_ELECTRON_CWD } : {}) });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const imagePath = path.join(base, 'build', 'icon.png');
const report = {
  kind: live ? 'real_model_electron_multimodal' : 'synthetic_model_electron_multimodal_contract',
  packaged: !!executablePath,
  launchCwd: process.env.ZAICHANG_ELECTRON_CWD || base,
  live,
  temporaryTestSubstitute: lunaTest,
  providerId: lunaTest ? 'openai-app-server' : 'deepseek',
  model: null,
  imageParts: 0,
  textParts: 0,
  answer: '',
  screenshots: [],
};

async function shot(name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file, animations: 'disabled' });
  report.screenshots.push(name);
}

try {
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await app.evaluate(
    ({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.imagePath] });
      globalThis.__multimodalRequests = [];
      const summarize = (url, init) => {
        const payload = JSON.parse(String(init?.body || '{}'));
        const visual = (payload.messages || payload.input)?.find(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => ['image_url', 'input_image'].includes(part?.type)),
        );
        if (visual)
          globalThis.__multimodalRequests.push({
            url: String(url),
            model: payload.model,
            imageParts: visual.content.filter((part) => ['image_url', 'input_image'].includes(part?.type)).length,
            textParts: visual.content.filter((part) => ['text', 'input_text'].includes(part?.type)).length,
            dataUrl: visual.content
              .filter((part) => ['image_url', 'input_image'].includes(part?.type))
              .every((part) => String(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || '').startsWith('data:image/jpeg;base64,')),
          });
      };
      if (input.live) {
        const actualFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          summarize(url, init);
          return actualFetch(url, init);
        };
      } else {
        globalThis.fetch = async (url, init) => {
          summarize(url, init);
          const payload = JSON.parse(String(init?.body || '{}'));
          const isControl = payload.tools?.some(tool => tool.function?.name === 'propose_turn_controls');
          const control = { retention: 'unchanged', sourceAllowlist: null, sourceExclusions: [], sourceBasis: null, subject: 'none', world: 'real', audience: 'self', actions: 'unchanged', actionsApplyToWholeTurn: false, specificActionLimits: [], release: null, basis: [], uncertain: false, uncertainControls: [] };
          const bytes = new TextEncoder().encode(
            'data: ' +
              JSON.stringify({
                choices: [
                  {
                    delta: isControl ? { tool_calls: [{ index: 0, id: 'synthetic-control', type: 'function', function: { name: 'propose_turn_controls', arguments: JSON.stringify(control) } }] } : { content: '门把手在右边，晚归记得带钥匙。' },
                    finish_reason: isControl ? 'tool_calls' : 'stop',
                  },
                ],
              }) +
              '\n\ndata: [DONE]\n\n',
          );
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          );
        };
      }
    },
    { imagePath, live },
  );

  await page.getByRole('button', { name: '添加资料' }).click();
  assert.equal(await page.getByRole('menuitem', { name: /添加图片/ }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: /添加文件/ }).count(), 1);
  await shot(`${live ? 'live' : 'contract'}-01-existing-upload-menu.png`);
  await page.getByRole('menuitem', { name: /添加图片/ }).click();
  await page.locator('.attachment-preview').waitFor();
  assert.equal(
    await page.locator('.attachment-preview').evaluate((element) => element.closest('button') === null),
    true,
  );
  assert.equal(await page.locator('.image-preview-panel').count(), 0);
  await page.getByRole('textbox', { name: '和在场说说' }).fill(
    '把图形当作一扇宿舍门。根据小圆点所在的左右位置，只写一句20字以内的晚归拿钥匙提醒；不要描述颜色或图形。',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(`${live ? 'live' : 'contract'}-02-image-ready-dark.png`);
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(`${live ? 'live' : 'contract'}-03-image-ready-light.png`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 700));
  await page.waitForFunction(() => window.innerWidth <= 720);
  await shot(`${live ? 'live' : 'contract'}-04-image-ready-narrow.png`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 850));
  await page.waitForFunction(() => window.innerWidth >= 1200);
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复' }).waitFor({ state: 'detached', timeout: 180_000 });
  await page.locator('.sent-image-preview').waitFor();
  assert.equal(await page.locator('.sent-image-preview img').count(), 1);
  const assistant = page.locator('.assistant-message .markdown').last();
  await assistant.waitFor();
  report.answer = (await assistant.textContent())?.trim() || '';
  assert.match(report.answer, /右/);
  assert.match(report.answer, /钥匙/);
  const requests = await app.evaluate(() => globalThis.__multimodalRequests);
  const request = requests.find((item) => item.imageParts > 0);
  assert.ok(request);
  assert.equal(request.url, lunaTest ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://api.deepseek.com/chat/completions');
  assert.equal(request.model, lunaTest ? 'gpt-5.6-luna' : 'deepseek-flash');
  assert.equal(request.imageParts, 1);
  assert.equal(request.textParts, 1);
  assert.equal(request.dataUrl, true);
  report.model = request.model;
  report.imageParts = request.imageParts;
  report.textParts = request.textParts;
  const state = await page.evaluate(() => window.zaichang.state());
  assert.equal(state.settings.model, 'deepseek-flash');
  await page.locator('.user-message').evaluate((element) =>
    element.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  await shot(`${live ? 'live' : 'contract'}-05-image-answer.png`);
  await page.locator('.sent-image-preview').click();
  await page.locator('.image-preview-panel').waitFor();
  assert.equal(await page.locator('.image-preview-content').count(), 1);
  await shot(`${live ? 'live' : 'contract'}-06-opened-image-preview.png`);
  await page.locator('.image-preview-panel').getByRole('button', { name: '关闭面板' }).click();
  await page.locator('.image-preview-panel').waitFor({ state: 'detached' });
  assert.equal(
    await page.locator('.sent-image-preview').evaluate((element) => element === document.activeElement),
    true,
  );
  assert.deepEqual(pageErrors, []);
} finally {
  await app.close();
}

const reportPath = path.join(out, live ? 'live-report.json' : 'contract-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
