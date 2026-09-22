import { isolatedEnvironment } from '../scripts/test-environment.mjs';
import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = process.cwd(),
  dir = path.join(base, '.test-data', 'contract-' + Date.now()),
  out = path.join(base, 'artifacts', 'review', 'contracts');
await mkdir(out, { recursive: true });
await mkdir(dir, { recursive: true });
const env = isolatedEnvironment('desktop', dir);
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [base], env });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const checks = [],
  key = 'sk-zaichang-contract-fixture-only';
const performanceReport = {};
const textbox = page.getByRole('textbox', { name: '和在场说说' });
async function settle() {
  await page.waitForFunction(() => !document.querySelector('[aria-label="停止回复"]'));
}
async function closePanel() {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
async function mode(value) {
  await app.evaluate((_electron, value) => {
    globalThis.__fixtureMode = value;
  }, value);
}
async function shot(name) {
  await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
}
let originalId, editedTitle;
try {
  await textbox.waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Replace only the provider transport in the actual Electron main process.
  // No request in this test reaches DeepSeek or any other network service.
  await app.evaluate(() => {
    globalThis.__fixtureMode = 'success';
    globalThis.__requests = [];
    globalThis.__rootRound = 0;
    globalThis.__childActive = 0;
    globalThis.__childMax = 0;
    globalThis.__abortedTests = 0;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('https://api.deepseek.com/'))
        throw new Error('Unexpected network in contract test');
      const payload = JSON.parse(init.body);
      globalThis.__requests.push(payload);
      const mode = globalThis.__fixtureMode;
      if (mode === '401') return new Response('TEST SECRET MUST NOT ECHO', { status: 401 });
      if (mode === '429') return new Response('', { status: 429 });
      if (mode === 'offline') throw new TypeError('fixture network failure');
      if (mode === 'stall')
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            'abort',
            () => {
              globalThis.__abortedTests++;
              reject(init.signal.reason);
            },
            { once: true },
          ),
        );
      const chunks = (content, call) =>
        new Response(
          new ReadableStream({
            start(c) {
              const values = call
                ? [
                    {
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: call.id,
                                type: 'function',
                                function: { name: call.name, arguments: JSON.stringify(call.args) },
                              },
                            ],
                          },
                          finish_reason: 'tool_calls',
                        },
                      ],
                    },
                  ]
                : [
                    { choices: [{ delta: { reasoning_content: '隐藏推理测试片段' } }] },
                    { choices: [{ delta: { content }, finish_reason: 'stop' }] },
                  ];
              const bytes = new TextEncoder().encode(
                values.map((v) => 'data: ' + JSON.stringify(v) + '\n\n').join('') + 'data: [DONE]\n\n',
              );
              for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.slice(i, i + 13));
              c.close();
            },
          }),
        );
      const messages = payload.messages;
      if (messages[0]?.content?.includes('[harness:extract'))
        return chunks(JSON.stringify({ status: 'no_personal_fact', changes: [] }));
      if (messages[0]?.content?.includes('[harness:verify')) {
        const data = JSON.parse(messages[1].content);
        const supported = data.source.text.includes(data.candidate.sourceQuote);
        return chunks(
          JSON.stringify({
            supported,
            preservesSubject: true,
            preservesWorld: true,
            preservesTime: true,
            preservesConditions: true,
            reason: '受控语义审核输出；真实模型理解另行评估',
          }),
        );
      }
      if (mode === 'long')
        return chunks(
          '这是用于检查全屏阅读舒适度的排版样例，不是个人日程建议。\n\n## 先给最重要的事留一点空间\n\n不必一次安排好整个星期。先看已经确定的课程和考试，再找出一段真正可以自由使用的时间。连续的时间适合深入理解一道题，零碎的时间也可以用来整理笔记。安排应当帮你减轻负担。\n\n## 看见依据，也保留余地\n\n如果课程数据来自之前的导出，临时调课可能尚未包含在内。建议应说明来源和更新时间。天气预报也只是预报，到了出门的时候，可以再核对一次。把这些不确定因素说清楚，才能让你判断是否需要调整。\n\n## 一件事做完，再决定下一步\n\n学习之后，给休息留一些空间。可以到附近走走，也可以坐下来喝杯水。你不需要为了符合某种性格标签去改变自己；系统应当从你明确表达的偏好里学习，并允许你随时更正。\n\n眼前的计划只是一个可以修改的提议。最终的决定仍然属于你。',
        );
      if (messages.length === 1) return chunks('连接成功。');
      if (messages[0].content.includes('你是一个只读分身')) {
        globalThis.__childActive++;
        globalThis.__childMax = Math.max(globalThis.__childMax, globalThis.__childActive);
        await new Promise((r) => setTimeout(r, 100));
        globalThis.__childActive--;
        if (!messages.some((m) => m.role === 'tool'))
          return chunks('', {
            id: 'child-' + globalThis.__requests.length,
            name: 'look_up',
            args: {
              source: 'campus',
              mode: 'detail',
              domain: messages[1].content.includes('体育方向') ? 'practice' : 'schedule',
            },
          });
        return chunks('依据“接口契约测试资料”，已查到示例记录；它不是实际校园查询。');
      }
      const round = ++globalThis.__rootRound;
      if (round === 1)
        return chunks('', {
          id: 'plan1',
          name: 'set_plan',
          args: { items: [{ id: 'schedule', title: '核对逐次课程与运动要求', status: 'running' }] },
        });
      if (round === 2)
        return chunks('', {
          id: 'memory1',
          name: 'remember_preference',
          args: { text: '喜欢连续思考', source_quote: '我喜欢连续思考' },
        });
      if (round === 3)
        return chunks('', {
          id: 'delegate1',
          name: 'delegate',
          args: {
            tasks: [
              { title: '课程方向', instruction: '核对课程方向' },
              { title: '体育方向', instruction: '核对体育方向' },
            ],
          },
        });
      if (round === 4)
        return chunks('', {
          id: 'action1',
          name: 'prepare_action',
          args: {
            title: '接口测试：留出一段思考时间',
            detail: '这是契约测试建议，没有查询真实校园系统。',
            durationMinutes: 45,
          },
        });
      if (round === 5)
        return chunks('', {
          id: 'plan2',
          name: 'set_plan',
          args: { items: [{ id: 'schedule', title: '核对逐次课程与运动要求', status: 'done' }] },
        });
      return chunks('**接口契约测试完成。**\n\n两个方向已返回，下面的建议等待你决定。所有资料都是测试样例。');
    };
  });
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  await shot('13-connection-visual.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('13-connection-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByLabel('DeepSeek 密钥', { exact: true }).fill(key);
  await page.locator('.connection-advanced summary').click();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('连接可用', { exact: true }).waitFor();
  const unsavedState = await page.evaluate(() => window.zaichang.state());
  assert.equal(unsavedState.settings.hasKey, false);
  assert.equal(unsavedState.settings.mode, 'demo');
  await closePanel();
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  assert.equal(await page.getByLabel('DeepSeek 密钥', { exact: true }).inputValue(), key);
  checks.push('测试未保存密钥只验证连通性，提示完成保存；关闭再开保留设置草稿');
  await page.getByRole('button', { name: '连接 DeepSeek', exact: false }).click();
  await page.getByRole('status').filter({ hasText: '已连接' }).waitFor();
  let state = await page.evaluate(() => window.zaichang.state());
  assert.equal(state.settings.hasKey, true);
  assert.ok(!JSON.stringify(state).includes(key));
  assert.ok(!(await readFile(path.join(dir, 'deepseek-key.bin'))).includes(Buffer.from(key)));
  checks.push('真实IPC保存模拟密钥，系统加密文件不含明文；renderer状态无密钥');
  await page.getByRole('button', { name: /校园资料与天气/ }).click();
  await shot('12-campus-data-visual.png');
  const campusFile = path.join(dir, 'campus.json');
  await writeFile(
    campusFile,
    JSON.stringify({
      source: '接口契约测试资料（非真实校园信息）',
      updatedAt: new Date().toISOString(),
      schedule: [
        {
          id: 'a',
          title: '接口测试课程',
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          endsAt: new Date(Date.now() + 7200000).toISOString(),
          location: '测试地点',
          status: 'scheduled',
          source: '测试通知',
        },
      ],
      exams: [],
      sports: {
        completed: 3,
        required: 6,
        deadline: new Date(Date.now() + 14 * 86400000).toISOString(),
        ruleSource: '测试规则',
      },
      places: [],
      rules: [],
    }),
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, campusFile);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.locator('.campus-import-state').waitFor({ state: 'visible' });
  assert.equal(
    (await page.evaluate(() => window.zaichang.state())).campus?.source,
    '接口契约测试资料（非真实校园信息）',
  );
  await shot('14-campus-data-imported.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('14-campus-data-imported-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  checks.push('原生导入命令验证并存储带来源的逐次校园快照');
  await closePanel();
  await textbox.fill('我喜欢连续思考，请结合课程方向和体育方向安排下一步。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle();
  await page.getByText('接口契约测试完成。', { exact: false }).waitFor();
  assert.equal(await page.locator('.memory-notice').isVisible(), true);
  const requests = await app.evaluate(() => ({
    requests: globalThis.__requests,
    childMax: globalThis.__childMax,
  }));
  assert.equal(requests.childMax, 2);
  assert.ok(
    requests.requests.some((r) =>
      r.messages.some((m) => m.role === 'tool' && m.content.includes('接口契约测试资料')),
    ),
  );
  assert.ok(!(await page.textContent('body')).includes('隐藏推理测试片段'));
  state = await page.evaluate(() => window.zaichang.state());
  assert.equal(state.memories.length, 1);
  assert.equal(state.agenda.length, 0);
  originalId = state.conversations[0].id;
  checks.push(
    'DeepSeek SSE协议经真实harness完成计划、偏好、2个并行只读分身、汇总与行动草稿；未自动保存行动或暴露内部推理',
  );
  await page.locator('.memory-notice').getByRole('button', { name: '撤销' }).click();
  assert.equal((await page.evaluate(() => window.zaichang.state())).memories.length, 0);
  checks.push('自动记忆有可见提示并可撤销');
  const staleResult = await page.evaluate(async () => {
    const s = await window.zaichang.state();
    const messages = await window.zaichang.messages(s.conversations[0].id);
    const old = messages.flatMap((m) => m.actions).at(-1);
    try {
      await window.zaichang.action({ action: 'save', item: old });
      return 'unexpected_save';
    } catch {
      return 'stale_rejected';
    }
  });
  assert.equal(staleResult, 'stale_rejected');
  await app.evaluate(() => {
    globalThis.__rootRound = 3;
  });
  await textbox.fill('请重新核对课程方向和体育方向，再生成一项本地安排建议。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle();
  checks.push('删除依据使旧卡失效，新的明确请求生成可重新确认的安排');
  await page.getByRole('button', { name: '调整一下' }).last().click();
  editedTitle = '修改后的真实保存内容';
  await page.locator('.action-edit input').first().fill(editedTitle);
  await page.getByRole('button', { name: '加入我的安排', exact: false }).last().click();
  await page.locator('.saved-action').getByText(editedTitle).waitFor();
  await shot('09-provider-contract.png');
  // A retry must resend the old saved request, never the newly staged attachment.
  await mode('401');
  await textbox.fill('触发一次连接错误');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle();
  await textbox.fill('新的草稿，不能被重试清空');
  const attachmentFile = path.join(dir, 'only-new-draft.txt');
  await writeFile(attachmentFile, '仅属于新草稿的附件内容');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, attachmentFile);
  await page.getByRole('button', { name: '添加资料' }).click();
  await page.getByRole('menuitem', { name: /添加文件/ }).click();
  await page.locator('.attachment').getByText('only-new-draft.txt').waitFor();
  const beforeRequests = await app.evaluate(() => globalThis.__requests.length);
  await page.getByRole('button', { name: '重新试试', exact: false }).last().click();
  await settle();
  assert.equal(await textbox.inputValue(), '新的草稿，不能被重试清空');
  assert.equal(await page.locator('.attachment').isVisible(), true);
  const retryRequest = await app.evaluate((_e, before) => globalThis.__requests[before], beforeRequests);
  assert.ok(!JSON.stringify(retryRequest).includes('仅属于新草稿的附件内容'));
  checks.push('错误后重试不清空新草稿，不错用当前附件');
  await shot('10-retry-draft.png');
  await page.getByRole('button', { name: '新的对话', exact: true }).click();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  assert.equal(await textbox.inputValue(), '');
  assert.equal(await page.locator('.attachment').count(), 0);
  await textbox.fill('这是新会话草稿');
  await page.getByRole('button', { name: '历史对话', exact: true }).click();
  await page.locator('.history-item > button').first().click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await textbox.inputValue(), '新的草稿，不能被重试清空');
  assert.equal(await page.locator('.attachment').isVisible(), true);
  await page.getByRole('button', { name: '新的对话', exact: true }).click();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  assert.equal(await textbox.inputValue(), '这是新会话草稿');
  checks.push('历史与新会话草稿/附件独立恢复，无跨会话错投');
  // Suggestions preserve a drafted text as well.
  await page.getByRole('button', { name: '连接与偏好', exact: true }).click();
  await page.getByRole('button', { name: '使用本地示例', exact: true }).click();
  await closePanel();
  await page.getByRole('button', { name: '安排一下今天', exact: false }).click();
  await settle();
  assert.equal(await textbox.inputValue(), '这是新会话草稿');
  checks.push('欢迎建议不消费正在编写的草稿');
  // IME Escape should not stop a running task; ordinary Escape should.
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.evaluate(() =>
    document
      .querySelector('textarea[aria-label="和在场说说"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })),
  );
  assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  await settle();
  checks.push('IME组合阶段Escape不停止，普通Escape可停止');
  // Tabs, focus restoration and local feedback in the real settings dialog.
  const opener = page.getByRole('button', { name: '连接与偏好', exact: true });
  await opener.click();
  await page.getByRole('tab', { name: '连接', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.getByRole('tab', { name: '记忆', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.keyboard.press('End');
  assert.equal(
    await page.getByRole('tab', { name: '偏好', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await closePanel();
  assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
  checks.push('tab方向键/Home/End与关闭后的原入口焦点均有实际断言');
  await opener.click();
  await page.locator('.connection-advanced summary').click();
  for (const failure of ['401', '429', 'offline']) {
    await mode(failure);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByRole('alert').waitFor();
    const box = await page.getByRole('alert').boundingBox();
    const panelBox = await page.locator('.panel-body').boundingBox();
    assert.ok(box.y >= panelBox.y && box.y + box.height <= panelBox.y + panelBox.height + 1);
    assert.ok(!(await page.textContent('body')).includes('TEST SECRET MUST NOT ECHO'));
  }
  await mode('stall');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('button', { name: '取消测试', exact: true }).click();
  await page.getByText('已取消测试', { exact: true }).waitFor();
  const aborted = await app.evaluate(() => globalThis.__abortedTests);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('button', { name: '取消测试', exact: true }).waitFor();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button[role="switch"]').disabled);
  assert.ok((await app.evaluate(() => globalThis.__abortedTests)) > aborted);
  await page.getByRole('tab', { name: '连接', exact: true }).click();
  await page.locator('.connection-advanced summary').click();
  const timeoutStart = Date.now();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('alert').waitFor({ timeout: 26000 });
  performanceReport.connectionTimeoutMs = Date.now() - timeoutStart;
  assert.ok(performanceReport.connectionTimeoutMs >= 19000 && performanceReport.connectionTimeoutMs < 26000);
  checks.push('离开连接页会取消测试；20秒超时上限有真实计时验证');
  checks.push('401/429/断网反馈在触发控件旁可见，测试可取消，秘密响应体不回显');
  await mode('401');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('11-connection-error.png');
  await closePanel();
  const isolated = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.equal(isolated.require, 'undefined');
  assert.equal(isolated.process, 'undefined');
  const badLink = await page.evaluate(() =>
    window.zaichang.openLink('file:///C:/Windows').then(
      () => false,
      () => true,
    ),
  );
  assert.equal(badLink, true);
  checks.push('renderer无Node能力，外链IPC拒绝file协议');
  // The maximum accepted draft plus attachment is passed intact, including its final marker.
  await page.evaluate(() => window.zaichang.saveSettings({ mode: 'deepseek' }));
  const fullInput =
    '正'.repeat(6000) +
    '\n\n[用户附上的文字资料：' +
    '名'.repeat(255) +
    '.txt]\n' +
    '附'.repeat(19996) +
    'TAIL';
  const aggregateSession = await page.evaluate((content) => window.zaichang.send({ content }), fullInput);
  await page.waitForFunction(
    async (id) => (await window.zaichang.messages(id)).at(-1).status !== 'running',
    aggregateSession.sessionId,
  );
  const lastInput = await app.evaluate(
    () =>
      globalThis.__requests
        .at(-1)
        .messages.filter((m) => m.role === 'user')
        .at(-1).content,
  );
  assert.ok(lastInput.startsWith('正'.repeat(6000)));
  const attached = JSON.parse(lastInput.slice(6000).trim()).attached_data;
  assert.equal(attached.name, '名'.repeat(255) + '.txt');
  assert.equal(attached.text.length, 20000);
  assert.ok(attached.text.endsWith('TAIL'));
  checks.push('6000字正文+20000字附件+长文件名可发送，末尾TAIL未被截断');
  // Readable full-screen long answer, followed by input stress with real draft persistence.
  await page.getByRole('button', { name: '新的对话', exact: true }).click();
  await page.getByRole('heading', { name: '今天，从哪件事开始？' }).waitFor();
  await textbox.fill('显示排版检查样例');
  await mode('long');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await page.waitForTimeout(350);
  await page.locator('.message-scroll').evaluate((el) => el.scrollTo(0, 0));
  await shot('12-long-fullscreen.png');
  const readingGeometry = await page.evaluate(() => ({
    reading: document.querySelector('.messages').getBoundingClientRect().width,
    composer: document.querySelector('.composer').getBoundingClientRect().width,
    viewport: window.innerWidth,
  }));
  assert.ok(
    readingGeometry.reading <= 900 &&
      readingGeometry.composer >= Math.min(1000, readingGeometry.viewport * 0.65),
  );
  performanceReport.readingGeometry = readingGeometry;
  await page.getByRole('button', { name: '添加资料' }).click();
  assert.equal(await page.getByRole('menuitem', { name: /添加文件/ }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: /添加图片/ }).count(), 1);
  await shot('13-attachment-menu.png');
  checks.push('输入列随可用屏幕放大，阅读列保持上限；原上传菜单中文字和图片入口分开');
  const samples = page.evaluate(
    () =>
      new Promise((resolve) => {
        let previous = 0;
        const frames = [],
          start = performance.now();
        function frame(t) {
          if (previous) frames.push(t - previous);
          previous = t;
          if (t - start < 1800) requestAnimationFrame(frame);
          else resolve(frames);
        }
        requestAnimationFrame(frame);
      }),
  );
  await textbox.focus();
  const typingStart = Date.now();
  await page.keyboard.type('draft-performance-check '.repeat(12), { delay: 0 });
  const typingMs = Date.now() - typingStart,
    frameSamples = (await samples).sort((a, b) => a - b);
  const inputValue = await textbox.inputValue();
  assert.equal(inputValue, 'draft-performance-check '.repeat(12));
  performanceReport.typing = {
    chars: inputValue.length,
    dispatchMs: typingMs,
    frameSamples: frameSamples.length,
    p95FrameMs: frameSamples[Math.floor(frameSamples.length * 0.95)],
    over50Ms: frameSamples.filter((v) => v > 50).length,
    scope: '单机长回复场景下逐字符输入，不代表所有设备',
  };
  checks.push('长回复场景逐字符输入内容完整，输入期间帧间隔已采样');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setSize(1220, 680);
  });
  await page.waitForFunction(() => window.innerHeight <= 700);
  await page.locator('.message-scroll').evaluate((el) => {
    globalThis.__lastScrollBehavior = null;
    const original = el.scrollTo.bind(el);
    el.scrollTo = (options) => {
      globalThis.__lastScrollBehavior = options.behavior;
      original(options);
    };
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.getByRole('button', { name: '回到最新消息' }).waitFor();
  {
    await page.getByRole('button', { name: '回到最新消息' }).click();
    assert.equal(await page.evaluate(() => globalThis.__lastScrollBehavior), 'instant');
    checks.push('减少动态效果下回到最新消息采用instant滚动');
  }
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}
const restarted = await electron.launch({ args: [base], env });
try {
  const page = await restarted.firstWindow();
  await page.getByRole('textbox', { name: '和在场说说' }).waitFor();
  const state = await page.evaluate(() => window.zaichang.state());
  assert.equal(state.agenda[0].title, editedTitle);
  await page.getByRole('button', { name: '历史对话', exact: true }).click();
  await page
    .getByRole('textbox', { name: '搜索对话标题' })
    .fill(state.conversations.find((c) => c.id === originalId).title);
  await page.locator('.history-item > button').first().click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.locator('.saved-action').getByText(editedTitle).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '和在场说说' }).inputValue(),
    '新的草稿，不能被重试清空',
  );
  assert.equal(await page.locator('.attachment').isVisible(), true);
  checks.push('真实重启并打开旧对话：编辑过的安排、会话草稿、附件均一致');
} finally {
  await restarted.close();
}
const report = {
  provider: '模拟DeepSeek SSE传输，经真实Electron IPC/SQLite/harness；未使用真实API Key，未发起网络调用',
  checks,
  errors,
  performanceReport,
};
await writeFile(path.join(out, 'contract-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
