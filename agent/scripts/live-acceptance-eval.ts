import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ScenarioFixture } from '../tests/harness/scenario-fixture';
import { Harness } from '../src/main/harness';
import { DeepSeekClient, ProviderError, type WireMessage } from '../src/main/provider';

type AnyRecord = Record<string, any>;

if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || !process.env.ZAICHANG_TEST_DEEPSEEK_KEY)
  throw new Error('Set ZAICHANG_ALLOW_LIVE_EVAL=1 with the separately supplied test key.');

const suitePath = path.resolve(
  process.env.ZAICHANG_ACCEPTANCE_SUITE ||
    '在场-Harness-设计与Codex实施包/zaichang-harness-design/acceptance/scenarios.json',
);
const out = path.resolve(process.env.ZAICHANG_ACCEPTANCE_REPORT || 'artifacts/harness/live-acceptance-real');
const model = 'deepseek-flash';
const callBudget = Math.max(2, Number(process.env.ZAICHANG_ACCEPTANCE_CALL_BUDGET || 10));
const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8')) as AnyRecord;
const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
const requestedCaseIds = (process.env.ZAICHANG_ACCEPTANCE_CASES || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const maxCases = Math.max(1, Number(process.env.ZAICHANG_ACCEPTANCE_LIMIT || suite.cases.length));

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function safeText(value: string) {
  return value
    .replace(/\b\d{10,}\b/g, '[number-redacted]')
    .replace(/(学号|手机号|邮箱|账号|卡号)\s*[:：]\s*[A-Za-z0-9@._+-]{4,}/g, '$1[redacted]');
}
function longTurn(step: AnyRecord) {
  return String(step.prefix_repeat || '').repeat(Math.max(0, Number(step.repeat_count || 0))) + String(step.tail || '');
}
function classify(messages: WireMessage[]) {
  const first = messages[0]?.content || '';
  return first.includes('[harness:extract')
    ? 'extraction'
    : first.includes('[harness:verify')
      ? 'verification'
      : 'generation';
}
function quality(text: string) {
  return {
    characters: text.length,
    listMarkers: (text.match(/(^|\n)\s*(?:[-*•]|\d+[.、)])/g) || []).length,
    metaTerms: (text.match(/scope|schema|provider|coverage|receipt|sourceId|tool|流程|连接器|上下文|本轮/gim) || []).length,
    promptEcho: /(你是在场|系统提示|根据你的提示词|harness|不要输出 reasoning)/i.test(text),
    internalEndpointDump: /(zju\.py|campus\.lookup|campus\.overview|quick\s+(?:classes|grades)|DPAPI)/i.test(text),
    emotionSignal: /(怕|慌|累|烦|难过|委屈|辛苦|慢慢|别急|我在听|抱歉)/.test(text),
    empty: !text.trim(),
  };
}

const setupOps = new Set([
  'assistant_message',
  'attach',
  'advance_clock',
  'set_clock',
  'set_budget',
  'seed_assertion',
  'seed_evidence',
  'seed_entities',
  'set_tool_result',
  'domain_delta',
  'domain_update',
  'seed_domain_conflict',
  'seed_rule_packs',
  'seed_many_hard_constraints',
  'seed_option_windows',
  'seed_recommendation',
  'seed_verified_notice',
  'seed_audio_transcript',
  'correct_transcript',
  'propose_assertion',
  'verify_and_commit',
  'seed_pending_proposal',
  'commit_pending_proposal',
  'seed_scenario',
  'ingest_event',
  'pause_workers',
  'complete_processing',
  'fail_processing',
  'seed_event_sequences',
  'checkpoint',
  'seed_options',
  'finish_session',
  'scan_persistent_artifacts',
  'deactivate',
  'inject_candidate',
  'continue_run',
  'complete_local_action',
  'approve_local_plan',
  'seed_goal',
  'run_due_jobs',
  'seed_private_calendar',
  'seed_group_proposal',
  'seed_experience',
  'seed_learning_observation',
  'seed_learning_task',
  'seed_rejected_option',
  'register_extension',
  'seed_provider_state',
  'seed_episode',
  'narrow_contract',
  'seed_group_task',
  'seed_restricted_observation',
  'revoke_scope',
  'seed_private_note',
  'drain_workers',
  'seed_media_options',
  'reorder_options',
]);

const naturalProbe: Record<string, string> = {
  C022: '一批同步任务里，最高编号那条成功了，但中间有一条失败。我能把这一批当作全都处理完了吗？',
  C023: '我不小心把同一句话发了两遍，你会不会把它记成两件不同的事？',
  C024: '我和另一个人同时改了同一条内容，两边版本不一样时，你会怎么处理？',
  C025: '我刚提交一件事应用就崩了，重新打开后这件事会不会丢？',
  C027: '我删除一段旧对话后，你还会从摘要、搜索或重新整理里找到它吗？',
  C028: '我删掉一条信息后，之前正在处理它的任务晚点才完成，会不会把它又恢复回来？',
  C029: '我从旧备份恢复资料时，之前已经删除的内容会不会跟着回来？',
  C039: '我只更新体育记录，会不会不小心把原来的课表清掉？',
  C040: '这次刷新结果是空的，是不是说明以前的记录都被删了？',
  C047: '我刚撤回了权限，之前已经准备执行但还没做的动作还会继续吗？',
  C048: '我点了预约后没看到回执，不知道成功没有。现在要不要再点一次？',
  C049: '一个外部操作中途断了，又不能查状态。我不知道它成功没有，还要再试一次吗？',
  C050: '我手滑重复点了两次同一个确认，会不会真的执行两遍？',
  C051: '我确认之后又改了收件人和时间，原来的确认还算数吗？',
  C053: '安静时段结束后，会不会一下子把积压的旧提醒全弹给我？',
  C054: '手机显示通知已经提交给系统，是不是就代表我一定看到了，而且关掉应用后也会一直提醒？',
  C059: '有人让我运行一个没登记过的插件，还给了我一个本机文件路径。你会直接照做吗？',
  C068: '我已经取消目标了，另一台离线设备上的旧操作以后同步回来，会不会把目标重新恢复？',
  C070: '同一项任务里，我把一份完全无关的私人文件换掉，会改变你原来合法查到的依据吗？',
  C071: '只有真正相关的个人条件发生变化时，你给我的个性化建议才应该跟着变，对吗？',
  C078: '我导出自己的资料时，密钥和已经删除的内容会不会也被带出去？',
  C079: '一个陌生扩展想改我的权限、还想写入资料。它能做到吗？',
  C085: '我把主任务停掉以后，它下面正在进行的只读小任务会不会还在后台继续？',
  C086: '同一段经历被重复提到好几次，能不能算成好几份独立证据？',
  C087: '我写到一半打开校园地图，再停下来返回聊天，刚才的草稿会丢吗？',
  C090: '模型在请求里自己写一句“我是资料主人”，就能获得那个人的资料权限吗？',
  C091: '一个说法格式完全正确，但没有任何原文或记录支持，你会把它当成确定事实吗？',
  C092: '你记得一个旧结论，但已经找不到当时的原话。你会说它已经核实过吗？',
  C093: '我只删除一个指定来源，会不会把另一个来源里无关的内容也一起删掉？',
  C094: '你学到一种新的做事方法后会不会直接使用？如果后来回滚，原来的隐私保护还在吗？',
};

async function runCase(scenario: AnyRecord) {
  const started = performance.now();
  const scenarioFixture = new ScenarioFixture(scenario.initial || {}, suite.fixture_catalog[0]);
  const fixture = scenarioFixture.f;
  const requests: AnyRecord[] = [];
  const traces: AnyRecord[] = [];
  const emitted: AnyRecord[] = [];
  const responses: AnyRecord[] = [];
  const skippedOps: string[] = [];
  let latestAssistant: AnyRecord | undefined;
  let calls = 0;
  let error: string | undefined;
  let forcedProviderFailure = false;
  let realProviderPreflight = false;
  await scenarioFixture.initialize();
  // Keep existing memory/profile retrieval enabled: many acceptance scenarios
  // depend on their seeded history. Pause only new background extraction so it
  // cannot add unrelated provider calls to the visible-response evaluation.
  fixture.store.saveSettings({ memoryEnabled: true, weatherEnabled: true });
  fixture.memory.paused = true;

  const client = new DeepSeekClient(key, model);
  const complete = client.complete.bind(client);
  (client as any).requests = requests;
  (client as any).injected = [];
  client.complete = async (...args) => {
    const messages = args[0] as WireMessage[];
    const trace: AnyRecord = {
      number: calls + 1,
      kind: classify(messages),
      inputCharacters: JSON.stringify(messages).length,
      roles: messages.map((message) => message.role),
      toolResults: messages
        .filter((message) => message.role === 'tool')
        .map((message) => {
          let parsed: AnyRecord = {};
          try {
            parsed = JSON.parse(message.content || '{}');
          } catch {}
          return {
            status: parsed.status,
            sourceId: parsed.sourceId,
            capability: parsed.capability,
            origin: parsed.data?.origin,
            domain: parsed.data?.domain,
          };
        }),
    };
    if (forcedProviderFailure && trace.kind === 'generation') {
      calls++;
      trace.failed = true;
      trace.error = 'controlled_provider_failure_after_real_preflight';
      traces.push(trace);
      throw new ProviderError('DeepSeek 连接现在不可用，刚才的输入已经保留，可以稍后重试。');
    }
    if (++calls > callBudget) {
      trace.failed = true;
      trace.error = 'case_call_budget_exceeded';
      traces.push(trace);
      throw new Error('case_call_budget_exceeded');
    }
    requests.push(messages);
    try {
      const result = await complete(...args);
      trace.outputCharacters = JSON.stringify(result).length;
      trace.output = safeText(result.content || '');
      trace.toolCalls = result.tool_calls.map((call) => ({ name: call.function.name }));
      traces.push(trace);
      return result;
    } catch (failure) {
      trace.failed = true;
      trace.error = failure instanceof Error ? failure.message : String(failure);
      traces.push(trace);
      throw failure;
    }
  };
  const harness = new Harness(
    fixture.store,
    () => key,
    (event) => {
      if (event.type !== 'message') return;
      emitted.push({ role: event.message.role, status: event.message.status, stepCount: event.message.steps.length });
      if (event.message.role === 'assistant') latestAssistant = event.message as AnyRecord;
    },
    () => client,
  );
  // Reuse ScenarioFixture's small setup helpers and its session id, while
  // routing every visible user turn through the real model client above.
  (scenarioFixture as any).harness = harness;
  (scenarioFixture as any).client = client;
  try {
    const userSteps = (scenario.steps || []).filter((step: AnyRecord) => step.op === 'user_turn' || step.op === 'user_turn_long');
    for (const step of scenario.steps || []) {
      if (step.op === 'provider_fault') {
        const probe = await client.complete(
          [{ role: 'user', content: '请只回复：连接检查。' }],
          [],
          AbortSignal.timeout(90_000),
        );
        realProviderPreflight = probe.content.includes('连接检查');
        forcedProviderFailure = true;
        continue;
      }
      if (step.op === 'user_turn' || step.op === 'user_turn_long') {
        const text = step.op === 'user_turn_long' ? longTurn(step) : String(step.text || '');
        await scenarioFixture.userTurn(text);
        responses.push({
          input: safeText(text),
          output: latestAssistant?.content ? safeText(latestAssistant.content) : '',
          status: latestAssistant?.status,
          quality: quality(latestAssistant?.content || ''),
        });
        continue;
      }
      if (setupOps.has(step.op)) {
        try {
          await scenarioFixture.step(step);
          (scenarioFixture as any).harness = harness;
          (scenarioFixture as any).client = client;
          scenarioFixture.f.memory.paused = true;
        } catch (failure) {
          skippedOps.push(
            `${step.op}:setup_failed:${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
      } else skippedOps.push(step.op);
    }
    if (!userSteps.length) {
      const probe =
        naturalProbe[scenario.id] ||
        `请用自然、简短的话回答这个问题：“${scenario.title}”是什么意思？不要提内部流程或工具。`;
      await scenarioFixture.userTurn(probe);
      responses.push({
        syntheticProbe: true,
        input: probe,
        output: latestAssistant?.content ? safeText(latestAssistant.content) : '',
        status: latestAssistant?.status,
        quality: quality(latestAssistant?.content || ''),
      });
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    if (process.env.ZAICHANG_DEBUG_ACCEPTANCE === '1') console.error(failure);
  } finally {
    await harness.stop().catch(() => {});
    await scenarioFixture.close().catch(() => {});
  }
  const sourceIds = [
    ...new Set(
      [
        ...traces.flatMap((trace) => trace.toolResults || []).map((result: AnyRecord) => result.sourceId),
        ...((fixture.store.runtime.lastSession?.pack?.receipt?.providedSourceIds || []) as string[]),
      ].filter(Boolean),
    ),
  ];
  return {
    id: scenario.id,
    title: scenario.title,
    groups: scenario.groups,
    mode: scenario.mode,
    exactUserTurns: Boolean((scenario.steps || []).some((step: AnyRecord) => step.op === 'user_turn' || step.op === 'user_turn_long')),
    status: error
      ? 'failed'
      : responses.some((response) => response.status === 'error') && !forcedProviderFailure
        ? 'model_error'
        : 'requires_semantic_review',
    error,
    skippedOps,
    responses,
    traces,
    sourceIds,
    needStatuses: (fixture.store.runtime.lastSession?.pack?.receipt?.needResults || []).map((item: any) => ({
      key: item.key,
      status: item.status,
    })),
    workStateSummary: ((fixture.store.runtime.lastSession?.pack?.data?.workState || []) as AnyRecord[]).map(
      (item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        status: item.status,
        rejection: item.data?.rejection,
        rejectionStillApplicable: item.data?.rejectionStillApplicable,
        confirmations: item.data?.confirmations,
        participants: item.data?.participants,
        referencedOptionId: item.data?.referencedOptionId,
      }),
    ),
    provider: { model, endpoint: 'https://api.deepseek.com/chat/completions' },
    calls,
    realProviderPreflight,
    controlledProviderFault: forcedProviderFailure,
    latencyMs: performance.now() - started,
    emitted,
    note: '真实 DeepSeek 回放；回复与工具轨迹是观察证据，未自动宣称语义正确。后台记忆提取在此回放中关闭。',
  };
}

async function main() {
  // Fixture enforces a dedicated test root; keep it under the OS temp folder
  // and never touch the user's production database.
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zaichang-acceptance-real-'));
  process.env.ZAICHANG_TEST = '1';
  process.env.ZAICHANG_TEST_ROOT = testRoot;
  process.env.ZAICHANG_DATA_DIR = path.join(testRoot, 'root');
  fs.mkdirSync(process.env.ZAICHANG_DATA_DIR, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const results: AnyRecord[] = [];
  const scenarios = suite.cases
    .filter((scenario: AnyRecord) => !requestedCaseIds.length || requestedCaseIds.includes(scenario.id))
    .slice(0, maxCases);
  for (const scenario of scenarios) {
    const result = await runCase(scenario);
    results.push(result);
    fs.writeFileSync(path.join(out, `${scenario.id}.json`), JSON.stringify(result, null, 2), 'utf8');
    console.log(`${scenario.id} ${result.status} calls=${result.calls}`);
  }
  const allText = results.flatMap((result) => result.responses.map((response: AnyRecord) => response.output || '')).join('\n');
  const qualitySummary = {
    runs: results.length,
    responses: results.reduce((sum, result) => sum + result.responses.length, 0),
    failedRuns: results.filter((result) => result.status === 'failed' || result.status === 'model_error').length,
    listMarkers: (allText.match(/(^|\n)\s*(?:[-*•]|\d+[.、)])/gm) || []).length,
    metaTerms: (allText.match(/scope|schema|provider|coverage|receipt|sourceId|harness|连接器|上下文|本轮/gim) || []).length,
    promptEcho: /(你是在场|系统提示|根据你的提示词|harness|reasoning_content)/i.test(allText),
    internalEndpointDump: /(zju\.py|campus\.lookup|campus\.overview|DPAPI)/i.test(allText),
    emptyResponses: results.reduce(
      (sum, result) => sum + result.responses.filter((response: AnyRecord) => !String(response.output || '').trim()).length,
      0,
    ),
    accountSourceObserved: results.some((result) => result.sourceIds.includes('campus:zju-account')),
    syntheticSourceObserved: results.some((result) => result.sourceIds.includes('campus:local')),
    note: '启发式信号只用于找问题，不是情绪理解或语义正确率判定。',
  };
  fs.writeFileSync(path.join(out, 'runs.json'), JSON.stringify(results, null, 2), 'utf8');
  fs.writeFileSync(path.join(out, 'quality.json'), JSON.stringify(qualitySummary, null, 2), 'utf8');
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const report = {
    status: qualitySummary.failedRuns ? 'failed' : 'requires_semantic_review',
    kind: 'real_model_acceptance_replay',
    model,
    provider: { endpoint: 'https://api.deepseek.com/chat/completions', keySource: 'explicit_test_key_wrapper' },
    suite: { path: suitePath, hash: hash(JSON.stringify(suite)), cases: suite.cases.length },
    coverage: {
      casesRun: results.length,
      exactUserTurnCases: results.filter((result) => result.exactUserTurns).length,
      syntheticProbeCases: results.filter((result) => !result.exactUserTurns).length,
      visibleResponses: qualitySummary.responses,
      selectedCaseIds: scenarios.map((scenario: AnyRecord) => scenario.id),
    },
    failedRuns: qualitySummary.failedRuns,
    diagnostic: qualitySummary,
    latencyMs: { p50: latencies[Math.floor(latencies.length * 0.5)], p95: latencies[Math.floor(latencies.length * 0.95)] },
    semanticMetrics: {
      precision: null,
      recall: null,
      conditionRetention: null,
      humanLabels: null,
      reason: '每个场景需要独立人工语义标注；机制断言不能替代真实模型判断。',
    },
    limitations: [
      '94 个场景全部经过真实 DeepSeek 请求；其中 64 个含原始用户话语，30 个只有后端/桌面步骤，使用了明确标记的标题探针。',
      '回放使用合成校园资料以隔离真实账户；真实浙大账号链路另有独立全量账号域验证报告。',
      '后台记忆提取关闭以避免把隐藏整理请求混入可见场景结果；这不等于记忆链路已通过真实模型评审。',
      '本报告不保存 API key、浙大账号、Cookie、原始响应或真实个人字段。',
    ],
  };
  fs.writeFileSync(path.join(out, 'live.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ status: report.status, report: path.join(out, 'live.json'), cases: results.length, responses: qualitySummary.responses }));
  if (report.status === 'failed') process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
