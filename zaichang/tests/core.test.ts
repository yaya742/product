import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store';
import { DeepSeekClient, ProviderError, friendlyError, type Completion, type WireMessage } from '../src/main/provider';
import { Harness } from '../src/main/harness';
import { ZjuAdapter } from '../src/main/zjuAdapter';
import { ToolRegistry, type ToolContext } from '../src/main/tools';
import { campusSchema } from '../src/shared/schemas';
import type { Message, RunEvent } from '../src/shared/types';
import { controlProposal, supported } from './harness/support';
import type { TurnControlProposal } from '../src/main/runtime/turn-controls';

const complete = (content: string): Completion => ({ content, tool_calls: [] });
const tool = (name: string, args: unknown): Completion => ({
  content: '',
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

interface CoreHostFixture { controls?: TurnControlProposal | (() => TurnControlProposal); review?: (input: any) => { missing: any[]; contradictions: string[]; requests: any[] }; allowPurpose?: boolean; }
const wrapped = new WeakMap<DeepSeekClient, { options: CoreHostFixture }>();
/** Explicit host protocol fixtures, never claims of natural-language quality. */
function hostClient(client: DeepSeekClient, options?: CoreHostFixture) {
  const existing = wrapped.get(client);
  if (existing) { if (options) existing.options = options; return client; }
  const state = { options: options || {} }; wrapped.set(client, state);
  const original = client.complete.bind(client);
  client.complete = async (...args) => {
    const names = args[1].map(spec => spec.function.name);
    if (names.length === 1 && names[0] === 'propose_turn_controls') {
      const proposal = typeof state.options.controls === 'function' ? state.options.controls() : state.options.controls || controlProposal();
      const { sources, ...value } = proposal;
      return tool(names[0], { ...value, sourceAllowlist: sources === 'current_only' ? ['current'] : value.sourceAllowlist });
    }
    if (names.length === 1 && names[0] === 'report_completion_gaps') return tool(names[0], state.options.review?.(JSON.parse(String(args[0][1].content))) || { missing: [], contradictions: [], requests: [] });
    if (names.length === 1 && names[0] === 'verify_read_purpose') {
      const input = JSON.parse(String(args[0][1].content));
      return tool(names[0], { allowed: !!state.options.allowPurpose, sourceQuote: state.options.allowPurpose ? input.original : '', reason: 'Explicit host mechanism fixture.' });
    }
    if (names.length === 1 && names[0] === 'verify_local_delegation') return tool(names[0], { decision: 'draft_only', basis: [], missing: [], reason: 'No automatic approval in this fixture.' });
    return original(...args);
  };
  return client;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tmpdir(){if(process.env.ZAICHANG_TEST!=='1'||!process.env.ZAICHANG_DATA_DIR)throw new Error('Run through scripts/test.mjs with an isolated test directory.');return process.env.ZAICHANG_DATA_DIR;}
function message(sessionId: string, content: string, role: 'user' | 'assistant' = 'user'): Message {
  return {
    id: randomUUID(),
    sessionId,
    content,
    role,
    createdAt: new Date().toISOString(),
    status: 'done',
    steps: [],
    obligations: [],
    actions: [],
  };
}
function ctx(store: Store, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    signal: new AbortController().signal,
    userText: '我喜欢整段思考，不喜欢来回跑。',
    currentUserId: '',
    child: false,
    step: () => {},
    plan: () => {},
    action: () => {},
    changed: () => {},
    delegate: async () => [],
    ...extra,
  };
}
function stream(parts: unknown[], split = 7, done = true): Response {
  const bytes = new TextEncoder().encode(
    parts.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test('本地重启可恢复记录，中文短词与全文索引均能检索，删除无残留', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zaichang-test-'));
  const file = path.join(dir, 'store.sqlite');
  let store = new Store(file);
  const id = store.session(undefined, '物理与羽毛球');
  store.putMessage(message(id, '我喜欢整段思考，周三打羽毛球，物理考试在周五。'));
  store.close();
  store = new Store(file);
  assert.equal(store.search('物理').length, 1);
  assert.equal(store.search('羽毛球').length, 1);
  assert.equal(store.search('物理 周五').length, 1);
  assert.equal(store.search('%').length, 0);
  store.deleteSession(id);
  assert.equal(store.search('羽毛球').length, 0);
  assert.equal(store.messages(id).length, 0);
  store.close();
});
test('崩溃恢复把未完成步骤标成中断', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'zaichang-crash-')), 'db');
  let store = new Store(file);
  const id = store.session();
  store.putMessage({
    ...message(id, '', 'assistant'),
    status: 'running',
    steps: [{ id: 's', title: '正在查询', status: 'running' }],
    obligations: [
      { id: 'o', title: '核对课表', status: 'running' },
      { id: 'o2', title: '选择时间', status: 'pending' },
    ],
  });
  store.close();
  store = new Store(file);
  assert.equal(store.messages(id)[0].status, 'cancelled');
  assert.equal(store.messages(id)[0].steps[0].status, 'cancelled');
  assert.ok(store.messages(id)[0].obligations.every((o) => o.status === 'blocked'));
  store.close();
});
test('SSE 可处理跨字节中文与工具参数碎片，内部推理不外泄', async () => {
  let body: any;
  const output: string[] = [];
  const client = new DeepSeekClient('test-key', 'deepseek-flash', (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return stream(
      [
        { choices: [{ delta: { reasoning_content: '不要展示的内部内容' } }] },
        {
          choices: [
            {
              delta: {
                content: '先看看你的课表。',
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'query_campus', arguments: '{"kind":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"schedule"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ],
      5,
    );
  }) as typeof fetch);
  const result = await client.complete(
    [{ role: 'user', content: '安排今天' }],
    [],
    new AbortController().signal,
    (t) => output.push(t),
    { toolChoice: { type: 'function', function: { name: 'campus_full_context' } } },
  );
  assert.equal(result.content, '先看看你的课表。');
  assert.equal(result.tool_calls[0].function.arguments, '{"kind":"schedule"}');
  assert.equal(output.join(''), result.content);
  assert.ok(!JSON.stringify(result).includes('内部'));
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.tool_choice.function.name, 'campus_full_context');
});
test('401 错误不回显响应体里的秘密', async () => {
  const client = new DeepSeekClient(
    'secret-test',
    'deepseek-flash',
    (async () => new Response('secret-test', { status: 401 })) as typeof fetch,
  );
  await assert.rejects(
    () => client.complete([], [], new AbortController().signal),
    (e) => e instanceof ProviderError && !e.message.includes('secret-test') && e.message.includes('无效'),
  );
});
test('半截响应不会被伪装成成功，也不重复请求已流出的内容', async () => {
  let calls = 0;
  const client = new DeepSeekClient('test-key', 'deepseek-flash', (async () => {
    calls++;
    return stream([{ choices: [{ delta: { content: '半截' } }] }], 7, false);
  }) as typeof fetch);
  await assert.rejects(() => client.complete([], [], new AbortController().signal), /断开/);
  assert.equal(calls, 1);
});
test('取消请求会传递到 provider 网络请求', async () => {
  const c = new AbortController();
  let linked = false;
  const client = new DeepSeekClient(
    'test-key',
    'deepseek-flash',
    ((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          linked = true;
          reject(init.signal?.reason);
        });
      })) as typeof fetch,
  );
  const request = client.complete([], [], c.signal);
  c.abort();
  await assert.rejects(request);
  assert.equal(linked, true);
});
test('provider transport failure is surfaced as a retryable network error', async () => {
  let attempts = 0;
  const client = new DeepSeekClient('test-key', 'deepseek-flash', (async () => {
    attempts++;
    throw new TypeError('fetch failed: https://api.deepseek.com with secret payload');
  }) as typeof fetch);
  await assert.rejects(
    () => client.complete([], [], new AbortController().signal),
    (error) => error instanceof ProviderError && error.code === 'network' && error.retryable && error.message.includes('无法连接 DeepSeek') && !error.message.includes('secret'),
  );
  assert.equal(attempts, 2);
});
test('Hermes diagnostic is actionable and provider terminal reasons are not hidden as a generic interruption', async () => {
  const engineError = Object.assign(new Error('internal'), {
    name: 'HermesRunError',
    diagnostic: { code: 'engine_incomplete', errorCode: 'network' },
  });
  assert.match(friendlyError(engineError), /无法连接 DeepSeek/);
  for (const [finish_reason, code] of [
    ['content_filter', 'content_filter'],
    ['insufficient_system_resource', 'provider_busy'],
    ['aborted', 'provider_aborted'],
  ] as const) {
    const client = new DeepSeekClient('test-key', 'deepseek-flash', (async () =>
      stream([{ choices: [{ delta: {}, finish_reason }] }])) as typeof fetch);
    await assert.rejects(
      () => client.complete([], [], new AbortController().signal),
      (error) => error instanceof ProviderError && error.code === code,
    );
  }
});
test('分身权限是主代理的只读子集，关闭的天气和记忆不能调用', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ weatherEnabled: false, memoryEnabled: false });
  const registry = new ToolRegistry(ctx(store, { child: true }));
  const names = registry.specs().map((s) => s.function.name);
  assert.ok(['look_up', 'read_evidence', 'resolve_time'].every(name => names.includes(name)));
  assert.ok(['delegate', 'prepare_action', 'change_local_action', 'propose_memory_change'].every(name => !names.includes(name)));
  assert.ok(['not_connected', 'unsupported', 'forbidden'].includes(JSON.parse(await registry.execute('look_up', '{"source":"campus","mode":"refresh","domain":"schedule"}')).status));
  assert.match(await registry.execute('delegate', '{"tasks":[]}'), /不可用/);
  assert.match(await registry.execute('remember_preference', '{}'), /不可用/);
  store.close();
});
test('校园工具按真实权限提供，兼容别名不进入模型 schema', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const campus = {
    describe: () => ({ configured: true, available: true, credentialsConfigured: true, authStatus: 'verified' }),
    capabilities: async () => ({ status: 'ok', catalogued: 40 }),
    fullContext: async (args: any) => { calls.push('full:' + Boolean(args.refresh)); return { status: 'ok', batches: [] }; },
    read: async (args: any) => { calls.push('read:' + args.domain + ':' + Boolean(args.refresh)); return { status: 'ok', domain: args.domain, records: [], fetched_at: new Date().toISOString(), coverage: { complete: true } }; },
    refresh: async (args: any) => { calls.push('refresh:' + args.scope); return { status: 'ok', scope: args.scope, domain: args.domain }; },
  };
  const registry = new ToolRegistry(ctx(store, { campus: campus as any, userText: '查课程和考试，需要时更新最新资料。' }));
  const names = registry.specs().map(s => s.function.name);
  assert.ok(['delegate', 'inspect_action', 'look_up', 'prepare_action', 'propose_memory_change', 'read_evidence'].every(name => names.includes(name)));
  assert.ok(names.includes('look_up')); assert.ok(names.includes('prepare_action')); assert.ok(!names.includes('campus_full_context')); assert.ok(!names.includes('campus_read')); assert.ok(!names.includes('campus_refresh')); assert.ok(!names.includes('query_campus'));
  const detail = JSON.parse(await registry.execute('look_up', '{"source":"campus","mode":"detail","domain":"schedule","window":"next:7d"}'));
  assert.equal(detail.sourceId, 'campus:zju-account');
  assert.equal(detail.data.origin, 'zju_account');
  assert.match(JSON.stringify(detail), /schedule/);
  const overview = JSON.parse(await registry.execute('look_up', '{"source":"campus","mode":"overview"}'));
  assert.equal(overview.sourceId, 'campus:zju-account');
  assert.ok(Array.isArray(overview.data.domains));
  assert.match(await registry.execute('look_up', '{"source":"campus","mode":"refresh","domain":"schedule"}'), /schedule/);
  assert.deepEqual(calls, ['read:schedule:false', 'full:false', 'read:schedule:true']); store.close();
});
test('校园读取的 partial/auth 状态进入 blocked 步骤，不伪装成完成', async () => {
  const store = new Store(':memory:'); const statuses: string[] = [];
  const campus = {
    describe: () => ({ configured: true, available: true, credentialsConfigured: true, authStatus: 'verified' }),
    read: async () => ({ status: 'partial', records: [], coverage: { complete: false } }),
  };
  const registry = new ToolRegistry(ctx(store, { campus: campus as any, step: s => statuses.push(s.status), campusMemo: { fullContextUsed: false, domains: new Set(), results: new Map() } }));
  const output = JSON.parse(await registry.execute('look_up', '{"source":"campus","domain":"schedule"}'));
  assert.equal(output.status, 'unknown'); assert.equal(statuses.at(-1), 'blocked'); store.close();
});
test('校园读取按任务取单域，合格缓存不重复扫描，也不主动读取成绩', async () => {
  const store = new Store(':memory:'); store.saveSettings({ mode: 'deepseek' });
  const reads: string[] = []; const fakeCampus = { describe: () => ({ configured: true, available: true, credentialsConfigured: true, authStatus: 'verified', label: 'test' }), read: async (args: any) => { reads.push(args.domain); return { data: { status: 'ok', records: [], fetched_at: new Date().toISOString(), coverage: { complete: true }, origin: 'zju_account', authenticated_at: new Date().toISOString() } }; } };
  let calls = 0;
  const fake = { complete: async (messages: WireMessage[]) => { if(messages[0].content?.includes('[harness:extract')) return complete(JSON.stringify({status:'no_personal_fact',changes:[]})); calls++; return calls <= 2 ? tool('look_up', { source: 'campus', domain: 'schedule' }) : complete('已读取允许的课程范围，其他领域没有查询。'); } } as unknown as DeepSeekClient;
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake), fakeCampus as any);
  const first = harness.start(undefined, '帮我看看我明天的课程'); await harness.idle();
  assert.deepEqual(reads, ['schedule']); assert.equal(store.messages(first.sessionId).at(-1)?.status, 'done'); store.close();
});
test('ZJU adapter 只通过受限子进程传参，不依赖应用内 Python import', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaichang-zju-')); fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'references'));
  fs.writeFileSync(path.join(root, 'references', 'endpoints.json'), '{"endpoints":[]}');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '# test connector');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'GPL-3.0 test fixture');
  fs.writeFileSync(path.join(root, 'connector.json'), JSON.stringify({ schemaVersion: 1, id: 'zju-student-info', protocolVersion: 1, accessMode: 'compatibility_local', entrypoint: 'scripts/zju.py', allowedHosts: ['zjuam.zju.edu.cn'], supportedDomains: ['schedule', 'courses', 'exams', 'assignments', 'source_status'] }));
  fs.writeFileSync(path.join(root, 'scripts', 'zju.py'), `import json,sys
args=sys.argv[1:]
if args and args[0]=='auth': out={'status':'ok','sso':True}
elif args and args[0]=='history': out={'status':'ok','items':[{'kind':'academic','semester_id':'2026-2027-1','bundle_id':'${'a'.repeat(32)}'}]}
else: out={'status':'ok','argv':args,'records':[{'summary':'合成课程'}]}
print(json.dumps(out))
`);
  const store = new Store(':memory:');
  const adapter = new ZjuAdapter(store, { credentialsConfigured: () => true });
  adapter.configure(root);
  const result = await adapter.read({ domain: 'schedule', window: 'next:7d', limit: 1 }, new AbortController().signal);
  assert.equal(result.data.status, 'ok'); assert.deepEqual(result.data.records, [{ summary: '合成课程' }]);
  store.close();
});
test('ZJU adapter 先校验统一认证，再读取账号数据，并在模型边界隐藏身份字段', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaichang-zju-auth-'));
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'references'));
  fs.writeFileSync(path.join(root, 'references', 'endpoints.json'), '{"endpoints":[]}');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '# test connector');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'GPL-3.0 test fixture');
  fs.writeFileSync(path.join(root, 'connector.json'), JSON.stringify({ schemaVersion: 1, id: 'zju-student-info', protocolVersion: 1, accessMode: 'compatibility_local', entrypoint: 'scripts/zju.py', allowedHosts: ['zjuam.zju.edu.cn'], supportedDomains: ['schedule', 'courses', 'exams', 'assignments', 'source_status'] }));
  fs.writeFileSync(
    path.join(root, 'scripts', 'zju.py'),
    `import json,sys\nfrom pathlib import Path\nroot=Path(__file__).resolve().parent.parent\nwith (root/'calls.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\nif sys.argv[1:]==['auth']: out={'status':'ok','authenticated_at':'2026-09-12T08:00:00Z','sso':True}\nelif sys.argv[1:] and sys.argv[1]=='history': out={'status':'ok','items':[{'kind':'academic','semester_id':'2026-2027-1','bundle_id':'${'b'.repeat(32)}'}]}\nelse: out={'status':'ok','evaluated_at':'2026-09-12T08:01:00Z','total_matches':1,'coverage':{'complete':True},'records':[{'summary':'合成课程','course_id':'123','xh':'private-student-number','password':'private-password'}]}\nprint(json.dumps(out))\n`,
  );
  const store = new Store(':memory:');
  const adapter = new ZjuAdapter(store, { credentialsConfigured: () => true });
  adapter.configure(root);
  const result = await adapter.read({ domain: 'schedule', limit: 1 }, new AbortController().signal);
  const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call[0]), ['auth', 'history', 'quick']);
  assert.equal(calls[2][calls[2].indexOf('--bundle') + 1], 'b'.repeat(32));
  assert.equal(result.data.origin, 'zju_account');
  assert.equal(result.data.records[0].summary, '合成课程');
  assert.equal(result.data.records[0].course_id, '123');
  assert.equal(result.data.records[0].xh, '[redacted]');
  assert.equal(result.data.records[0].password, '[redacted]');
  assert.equal(adapter.describe().authStatus, 'verified');
  store.close();
});
test('ZJU adapter 保留安全的认证失败原因并刷新为需要重试状态', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaichang-zju-failure-'));
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'references'));
  fs.writeFileSync(path.join(root, 'references', 'endpoints.json'), '{"endpoints":[]}');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '# test connector');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT test fixture');
  fs.writeFileSync(path.join(root, 'connector.json'), JSON.stringify({ schemaVersion: 1, id: 'zju-student-info', protocolVersion: 1, accessMode: 'compatibility_local', entrypoint: 'scripts/zju.py', allowedHosts: ['zjuam.zju.edu.cn'], supportedDomains: ['schedule'] }));
  fs.writeFileSync(path.join(root, 'scripts', 'zju.py'), "import json,sys\nprint(json.dumps({'status':'error','error':{'code':'CAPTCHA_REQUIRED','message':'统一身份认证要求额外验证码，请先在浏览器完成安全校验。'}}))\nsys.exit(2)\n");
  const store = new Store(':memory:');
  const adapter = new ZjuAdapter(store, { credentialsConfigured: () => true });
  adapter.configure(root);
  const result = await adapter.verifyAccount(new AbortController().signal);
  assert.equal(result.status, 'error');
  assert.equal(adapter.describe().authStatus, 'failed');
  assert.equal(adapter.describe().reason, '统一身份认证要求额外验证码，请先在浏览器完成安全校验。');
  store.close();
});
test('记忆需本轮原话，有长度预算，拒绝凭空引用与敏感信息', async () => {
  const store = new Store(':memory:');
  store.runtime.memory.reviewer = async () => supported;
  const registry = new ToolRegistry(ctx(store));
  assert.match(
    await registry.execute(
      'remember_preference',
      JSON.stringify({ text: '喜欢整段思考', source_quote: '我喜欢整段思考' }),
    ),
    /saved/,
  );
  assert.match(
    await new ToolRegistry(ctx(store)).execute(
      'remember_preference',
      JSON.stringify({ text: '喜欢晨跑', source_quote: '我喜欢晨跑' }),
    ),
    /原文|原话|引用/,
  );
  assert.equal(store.memories().length, 1);
  assert.match(
    await registry.execute(
      'remember_preference',
      JSON.stringify({ text: '喜欢整段思考', source_quote: '我喜欢整段思考' }),
    ),
    /saved/,
  );
  const sensitive = new ToolRegistry(ctx(store, { userText: '密码是 test-only' }));
  assert.match(
    await sensitive.execute(
      'remember_preference',
      JSON.stringify({ text: '密码是 test-only', source_quote: '密码是 test-only' }),
    ),
    /不可用/,
  );
  for (let i = 0; i < 20; i++) store.saveMemory(`${i}${'长'.repeat(130)}`);
  assert.equal(store.memories().length, 21);
  assert.throws(() => store.saveMemory('余'.repeat(4001)));
  store.close();
});
test('校园日期必须含时区；账号未连接时明确标注离线导入来源', async () => {
  const store = new Store(':memory:');
  assert.equal(campusSchema.safeParse({ source: 'test', updatedAt: '2026-09-09' }).success, false);
  const data = campusSchema.parse({
    source: '测试导出',
    updatedAt: '2026-09-09T10:00:00+08:00',
    schedule: [
      {
        id: '1',
        title: '跨日事件',
        startsAt: '2026-09-09T23:30:00+08:00',
        endsAt: '2026-09-10T00:30:00+08:00',
        location: '示例',
        status: 'cancelled',
        source: '停课通知',
      },
    ],
  });
  store.putMeta('campus', data);
  const result = JSON.parse(
    await new ToolRegistry(ctx(store)).execute(
      'query_campus',
      JSON.stringify({
        kind: 'schedule',
        from: '2026-09-10T00:00:00+08:00',
        to: '2026-09-11T00:00:00+08:00',
      }),
    ),
  );
  assert.equal(result.status, 'stale');
  assert.equal(result.data.origin, 'legacy_import');
  assert.equal(result.data.authenticated, false);
  assert.match(result.reason, /离线|账号/);
  store.close();
});
test('未连接校园查询准确返回 unavailable，不能伪装成已查到', async () => {
  const store = new Store(':memory:');
  const states: string[] = [];
  const registry = new ToolRegistry(ctx(store, { step: (s) => states.push(s.status) }));
  assert.equal(JSON.parse(await registry.execute('query_campus', '{"kind":"exams"}')).status, 'unsupported');
  assert.equal(states.at(-1), 'blocked');
  store.close();
});

test('当前这句撤回健康资料后仍会得到新范围内的正常回复', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek', memoryEnabled: false });
  store.runtime.policy.grant('health:use');
  store.runtime.policy.registerSource('health:local');
  const fake = {
    complete: async () => complete('好，这一小时不使用健康资料；你想先做哪一件事？'),
  } as unknown as DeepSeekClient;
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake, { controls: controlProposal({ sourceExclusions: ['health:local'], sourceBasis: '别用健康数据' }) }));
  const run = harness.start(undefined, '安排接下来一小时，别用健康数据。');
  await harness.idle();
  const answer = store.messages(run.sessionId).at(-1)!;
  assert.equal(answer.status, 'done');
  assert.match(answer.content, /不使用健康资料/);
  assert.doesNotMatch(answer.content, /资料使用范围已更新/);
  store.close();
});

test('单位缺证据时通过定向复核继续修正，不靠词面替换金额', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek', memoryEnabled: false });
  const campus = {
    describe: () => ({ configured: true, available: true, credentialsConfigured: true, authStatus: 'verified' }),
    read: async () => ({
      data: {
        status: 'ok',
        records: [{ balance_raw: 115855, balance_unit: 'unverified_source_unit' }],
        evaluated_at: new Date().toISOString(),
        coverage: { complete: true },
        origin: 'zju_account',
        authenticated_at: new Date().toISOString(),
      },
    }),
  };
  let round = 0;
  const fake = {
    complete: async () => (++round === 1 ? tool('look_up', { source: 'campus', domain: 'card' }) : complete(round === 2 ? '余额是115855分。' : '115855（学校系统原始单位，未核实）')), 
  } as unknown as DeepSeekClient;
  hostClient(fake, { allowPurpose: true, review: input => ({ missing: [], contradictions: input.reply.includes('115855分') ? ['观察只支持原始数值，单位未核实，不能写成分。'] : [], requests: [] }) });
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake), campus as any);
  const run = harness.start(undefined, '查一下我的校园卡余额。');
  await harness.idle();
  const answer = store.messages(run.sessionId).at(-1)!.content;
  assert.match(answer, /115855（学校系统原始单位，未核实）/);
  assert.doesNotMatch(answer, /115855\s*(?:分|元)/);
  store.close();
});

test('忙碌投影不能被群消息写成可约时间或其余时间都可以', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek', memoryEnabled: false });
  store.runtime.domains.importSnapshot({
    source: '合成离线课表',
    updatedAt: '2026-09-14T06:00:00Z',
    schedule: [{
      id: 'busy-1', title: '私人事项', startsAt: '2026-09-15T09:00:00+08:00',
      endsAt: '2026-09-15T10:00:00+08:00', location: '隐藏', status: 'scheduled', source: '合成',
    }],
    exams: [], places: [], rules: [],
  });
  let round = 0;
  const fake = {
    complete: async () => ++round === 1 ? tool('availability_projection', { from: '2026-09-15T00:00:00Z', to: '2026-09-15T12:00:00Z' }) : complete(round === 2 ? '我9月15日09:00–10:00有空，其他时间都可以。' : '9月15日09:00–10:00不方便；其他时段还不能保证没有未同步的安排。'),
  } as unknown as DeepSeekClient;
  hostClient(fake, { controls: controlProposal({ audience: 'group', release: { recipient: '小组', purpose: '沟通可约时段', allowedFacts: [], tone: '自然', useAvailability: true } }), review: input => ({ missing: [], contradictions: input.reply.includes('09:00–10:00有空') ? ['忙碌投影中的09:00–10:00不能当作空闲，也不能保证其他时段。'] : [], requests: [] }) });
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake));
  const run = harness.start(undefined, '给小组写一段可约时间，别解释我没空的原因，先别发送。');
  await harness.idle();
  const answer = store.messages(run.sessionId).at(-1)!.content;
  assert.match(answer, /09:00–10:00不方便/);
  assert.doesNotMatch(answer, /09:00–10:00有空|其他时间都可以/);
  assert.doesNotMatch(answer, /私人事项|隐藏/);
  store.close();
});

test('主模型表达中的必要限定不会被宿主按关键词截去', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek', memoryEnabled: false });
  const fake = {
    complete: async () => complete('先把最急的作业打开，只做第一小题；资料不足时不要提交。'),
  } as unknown as DeepSeekClient;
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake));
  const run = harness.start(undefined, '我有点慌，先帮我想第一步，只给一个方向。');
  await harness.idle();
  const answer = store.messages(run.sessionId).at(-1)!.content;
  assert.match(answer, /先把最急的作业打开/);
  assert.equal(answer, '先把最急的作业打开，只做第一小题；资料不足时不要提交。');
  store.close();
});

test('首答不等待长期记忆后台提取，显式 idle 仍可等待队列排空', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek' });
  let releaseExtraction!: () => void,
    resolveReply!: () => void,
    extractionSettled = false;
  const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    }),
    replyDone = new Promise<void>((resolve) => {
      resolveReply = resolve;
    }),
    order: string[] = [];
  const fake = {
    complete: async (messages: WireMessage[]) => {
      if (messages[0].content?.includes('[harness:extract')) {
        order.push('extract');
        await extractionGate;
        extractionSettled = true;
        return complete(JSON.stringify({ status: 'no_personal_fact', changes: [] }));
      }
      order.push('foreground');
      return complete('前台回复已完成。');
    },
  } as unknown as DeepSeekClient;
  const harness = new Harness(
    store,
    () => 'test-key',
    (event) => {
      if (event.type === 'message' && event.message.role === 'assistant' && event.message.status === 'done')
        resolveReply();
    },
    () => hostClient(fake),
  );
  harness.start(undefined, '请先回答，后台再整理这句话。');
  assert.equal(
    await Promise.race([replyDone.then(() => 'reply'), delay(30000).then(() => 'timeout')]),
    'reply',
  );
  assert.equal(order[0], 'foreground');
  assert.equal(extractionSettled, false);
  releaseExtraction();
  await harness.idle();
  assert.equal(extractionSettled, true);
  store.close();
});

test('隐私 epoch 变化会取消后台提取并保留 pending 供重启恢复', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek' });
  let resolveReply!: () => void,
    resolveStarted!: () => void;
  const replyDone = new Promise<void>((resolve) => {
      resolveReply = resolve;
    }),
    extractionStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
  const fake = {
    complete: async (messages: WireMessage[], _tools: unknown, signal: AbortSignal) => {
      if (messages[0].content?.includes('[harness:extract')) {
        resolveStarted();
        signal.throwIfAborted();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return complete('前台回复已完成。');
    },
  } as unknown as DeepSeekClient;
  const harness = new Harness(
    store,
    () => 'test-key',
    (event) => {
      if (event.type === 'message' && event.message.role === 'assistant' && event.message.status === 'done')
        resolveReply();
    },
    () => hostClient(fake),
  );
  const { sessionId } = harness.start(undefined, '我喜欢安静地读书。');
  await replyDone;
  assert.equal(
    await Promise.race([extractionStarted.then(() => 'started'), delay(30000).then(() => 'timeout')]),
    'started',
  );
  store.runtime.policy.revoke('memory:write');
  await harness.backgroundIdle();
  const userId = store.messages(sessionId).find((message) => message.role === 'user')!.id,
    statuses = store.db
      .prepare('SELECT status FROM h_spans WHERE event_id=? ORDER BY start_cp')
      .all(userId)
      .map((row) => String(row.status));
  assert.deepEqual(statuses, ['pending']);
  assert.equal(store.runtime.memory.views().length, 0);
  await harness.stop();
  store.close();
});

test('只读分身按 child scope 重编 ContextPack，不继承父 pack 正文', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek' });
  const parentCanary = 'PARENT_PACK_CANARY_619',
    childPayloads: string[] = [],
    originalCompile = store.runtime.compile.bind(store.runtime);
  (store.runtime as any).compile = async (...args: Parameters<typeof originalCompile>) => {
    const pack = await originalCompile(...args);
    pack.data.parentOnly = { secret: parentCanary };
    return pack;
  };
  let foregroundCalls = 0;
  const fake = {
    complete: async (messages: WireMessage[]) => {
      if (messages[0].content?.includes('[harness:extract'))
        return complete(JSON.stringify({ status: 'no_personal_fact', changes: [] }));
      if (messages[0].content?.includes('这是独立只读取证任务')) {
        childPayloads.push(messages.at(-1)?.content || '');
        return complete('子任务只使用自己的范围。');
      }
      foregroundCalls++;
      return foregroundCalls === 1
        ? tool('delegate', { tasks: [{ title: '范围核对', instruction: '只核对当前请求的资料范围。', sources: [] }] })
        : complete('已完成范围核对。');
    },
  } as unknown as DeepSeekClient;
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake));
  harness.start(undefined, '请分头核对当前请求。');
  await harness.idle();
  assert.equal(childPayloads.length, 1);
  assert.equal(childPayloads[0].includes(parentCanary), false);
  assert.match(childPayloads[0], /只核对当前请求/);
  store.close();
});

test('前台范围摘要只显示可纠正的参与方式与公开草稿边界，不暴露内部推理', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek' });
  store.runtime.memory.paused = true;
  const draftText = '给老师写一段，沟通目的：确认时间；公开内容：周三下午可以；语气：礼貌自然；先别发送。';
  const brief = { recipient: '老师', purpose: '确认时间', allowedFacts: ['周三下午可以'], tone: '礼貌自然', useAvailability: false, requestedOperation: 'draft' as const };
  let draftStage = false, requested = false;
  const fake = new DeepSeekClient('synthetic');
  fake.complete = async (_messages, tools, _signal, _onText, options) => {
    if (tools.length === 1 && tools[0].function.name === 'project_release_brief') return tool('project_release_brief', brief);
    if (options?.phase === 'release_write') return complete('老师您好，我周三下午可以。');
    if (draftStage && !requested) { requested = true; return tool('prepare_release', { sourceQuote: draftText, task: '给老师起草确认时间的消息。' }); }
    return complete('已按本轮边界处理。');
  };
  let controlledTurn = 0;
  hostClient(fake, { controls: () => ++controlledTurn === 1 ? controlProposal() : controlProposal({ audience: 'group', release: { recipient: '老师', purpose: '确认时间', allowedFacts: ['周三下午可以'], tone: '礼貌自然', useAvailability: false } }) });
  const harness = new Harness(store, () => 'test-key', () => {}, () => hostClient(fake));
  const mixed = harness.start(undefined, '我只是想吐槽，顺手把明天九点小组会记一下。');
  await harness.idle();
  const mixedReply = store.messages(mixed.sessionId).at(-1)!;
  assert.equal(mixedReply.scopeSummary?.interpretation, undefined);
  assert.equal(store.agenda().length, 0, 'host does not turn wording into action authorization');
  draftStage = true;
  const draft = harness.start(
    undefined,
    draftText,
  );
  await harness.idle();
  const draftReply = store.messages(draft.sessionId).at(-1)!;
  assert.equal(draftReply.scopeSummary?.release?.recipient, '老师');
  assert.equal(draftReply.scopeSummary?.release?.mode, 'draft');
  assert.deepEqual(draftReply.scopeSummary?.release?.allowedFacts, ['周三下午可以']);
  assert.equal(draftReply.releaseArtifacts?.[0].body, '老师您好，我周三下午可以。');
  assert.equal(JSON.stringify(draftReply.scopeSummary).includes('内部推理'), false);
  store.close();
});


test('完整 harness：拆解、并行分身、汇总、只准备行动、不擅自保存', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek' });
  let mainCalls = 0,
    active = 0,
    maxActive = 0;
  const events: RunEvent[] = [];
  const fake = {
    complete: async (messages: WireMessage[]) => {
      if (messages[0].content?.includes('[harness:extract'))
        return complete(JSON.stringify({ status: 'no_personal_fact', changes: [] }));
      if (messages[0].content?.includes('[harness:verify'))
        return complete(
          JSON.stringify({
            supported: true,
            preservesSubject: true,
            preservesWorld: true,
            preservesTime: true,
            preservesConditions: true,
            reason: 'test',
          }),
        );
      if (messages[0].content?.includes('这是独立只读取证任务')) {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(25);
        active--;
        return complete('缺少实时资料，不能断言安排可行。');
      }
      mainCalls++;
      if (mainCalls === 1)
        return tool('set_plan', { items: [{ id: '1', title: '核对课程与体育', status: 'running' }] });
      if (mainCalls === 2)
        return tool('delegate', {
          tasks: [
            { title: '课程方向', instruction: '查询下周课程并指出未知信息。', sources: [] },
            { title: '体育方向', instruction: '核对体育要求和缺失的资料。', sources: [] },
          ],
        });
      if (mainCalls === 3) return tool('prepare_action', { title: '核对运动时间', detail: '等待真实数据。' });
      if (mainCalls === 4)
        return tool('set_plan', { items: [{ id: '1', title: '核对课程与体育', status: 'blocked' }] });
      return complete('还缺少校园资料。建议先导入。');
    },
  } as unknown as DeepSeekClient;
  const harness = new Harness(
    store,
    () => 'test-key',
    (e) => events.push(e),
    () => hostClient(fake),
  );
  const result = harness.start(undefined, '帮我综合下周课程和体育打卡');
  await harness.idle();
  const m = store.messages(result.sessionId).at(-1)!;
  assert.equal(m.status, 'done');
  assert.equal(maxActive, 2, JSON.stringify({ mainCalls, reply: m.content, status: m.status, steps: m.steps, delegations: m.contextReceipt?.delegations, observations: store.runtime.lastSession?.observations }));
  assert.equal(m.actions.length, 1);
  assert.equal(store.agenda().length, 0);
  assert.equal(m.obligations[0].status, 'blocked');
  assert.ok(events.some((e) => e.type === 'message' && e.message.steps.some((s) => s.scope === '分开核对')));
  store.close();
});
test('停止后的会话可继续，旧的运行状态不会污染新回复', async () => {
  const store = new Store(':memory:');
  const harness = new Harness(
    store,
    () => '',
    () => {},
  );
  const { sessionId } = harness.start(undefined, '安排今天');
  await delay(20);
  await harness.stop();
  assert.equal(harness.running, false);
  const stopped = store.messages(sessionId).at(-1)!;
  assert.equal(stopped.status, 'cancelled');
  assert.ok(stopped.steps.every((s) => s.status !== 'running'));
  harness.start(sessionId, '最近有点累');
  await harness.idle();
  assert.equal(store.messages(sessionId).at(-1)!.status, 'done');
  store.close();
});
test('长对话不依赖递归摘要，未提取的原文限制可经工具进入当前上下文', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ mode: 'deepseek' });
  const id = store.session();
  for (let i = 0; i < 26; i++)
    store.putMessage(message(id, i === 0 ? '未完成要求：保留晚间休息。' : `测试消息 ${i}`));
  let main: WireMessage[] = []; let reads = 0;
  const fake = {
    complete: async (messages: WireMessage[]) => {
      if (messages[0].content?.includes('[harness:extract'))
        return complete(JSON.stringify({ status: 'no_personal_fact', changes: [] }));
      if (messages[0].content?.includes('[harness:verify'))
        return complete(
          JSON.stringify({
            supported: true,
            preservesSubject: true,
            preservesWorld: true,
            preservesTime: true,
            preservesConditions: true,
            reason: 'test',
          }),
        );
      if (messages[0].content?.includes('压缩对话')) return complete('未完成要求：保留晚间休息。');
      main = structuredClone(messages);
      if (reads++ === 0) return tool('search_context', { query: '未完成要求 晚间休息' });
      return complete('会保留晚间休息。');
    },
  } as unknown as DeepSeekClient;
  const harness = new Harness(
    store,
    () => 'test-key',
    () => {},
    () => hostClient(fake),
  );
  harness.start(id, '继续安排');
  await harness.idle();
  assert.equal(store.summary(id).count, 0);
  assert.ok(main.some(item => item.role === 'tool' && item.content?.includes('保留晚间休息')));
  assert.equal(store.search('未完成要求').length, 1);
  assert.ok(main.length >= 3);
  store.close();
});
