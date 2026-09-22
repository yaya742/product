import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/main/store';
import { Harness } from '../src/main/harness';
import { ZjuAdapter } from '../src/main/zjuAdapter';
import { DeepSeekClient, type WireMessage } from '../src/main/provider';

type AnyRecord = Record<string, any>;
const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || !key)
  throw new Error('Set ZAICHANG_ALLOW_LIVE_EVAL=1 with the repository test-key wrapper.');

const outputDir = path.resolve(process.env.ZAICHANG_ZJU_EVAL_DIR || 'artifacts/zju-account/deepseek-full');
const model = 'deepseek-flash';
fs.mkdirSync(outputDir, { recursive: true });

const queries = [
  {
    id: 'schedule_exam_first_step',
    text: '根据我浙大账号里的下周课程和考试，帮我安排今晚复习的第一步。只给一个方向，结合我的实际安排，不要讲工具或流程。',
    domains: ['schedule', 'exams'],
  },
  {
    id: 'next_class',
    text: '查一下我浙大账号明天最早的一节课，直接告诉我时间和地点。',
    domains: ['schedule'],
  },
  {
    id: 'nearest_exam',
    text: '从我的浙大账号查最近一场考试，只说考试名称和时间；没有公布就直说。',
    domains: ['exams'],
  },
  {
    id: 'grade_gpa_explanation',
    text: '查我的成绩和绩点，用白话说清楚目前总绩点是哪一种口径，不要把不同口径混在一起。',
    domains: ['grades', 'gpa'],
  },
  {
    id: 'practice_gap',
    text: '查我浙大账号里的实践和体育记录，告诉我还缺什么；不确定的地方不要猜。',
    domains: ['practice', 'projects'],
  },
  {
    id: 'learning_activity',
    text: '查我在“学在浙大”的课程，挑一门有活动记录的课告诉我完成情况；你先自己找到我的课程，不要问我要内部编号。',
    domains: ['learning_courses', 'activities'],
  },
  {
    id: 'card_balance',
    text: '请从我浙大账号查校园卡余额，直接告诉我原始数值和单位；单位不确定就说不确定，不要换算。',
    domains: ['card'],
  },
  {
    id: 'recent_spending',
    text: '查我最近一周的校园卡流水，只告诉我最值得注意的一件事，不要把每笔消费列出来，也不要猜金额单位。',
    domains: ['transactions'],
  },
  {
    id: 'next_reservation',
    text: '查我下一次图书馆预约是什么时候；请区分预约记录和实际入馆，不要替我预约。',
    domains: ['reservations'],
  },
  {
    id: 'profile_minimal',
    text: '查我的浙大学生资料，只告诉我所属院系或专业，不要读出学号、姓名或联系方式。',
    domains: ['profile'],
  },
  {
    id: 'weekly_personalized_direction',
    text: '结合我浙大账号里的课表、考试和实践记录，给我这周一个最值得先做的安排。只说一个重点，别列清单。',
    domains: ['schedule', 'exams', 'practice'],
  },
  {
    id: 'all_account_overview',
    text: '把我浙大账号里所有可读的校园个人资料做一个简短总览，只说现在会影响我安排的内容，不要吐出工程术语或完整档案。',
    domains: ['overview'],
  },
];

function redactText(value: string) {
  return value
    .replace(/\b\d{10,}\b/g, '[number-redacted]')
    .replace(/(学号|手机号|邮箱|账号|卡号)\s*[:：]\s*[A-Za-z0-9@._+-]{4,}/g, '$1[redacted]');
}
function publicResult(result: AnyRecord) {
  const output = String(result.output || '');
  return {
    ...result,
    output: undefined,
    outputCharacters: output.length,
    outputSha256: createHash('sha256').update(output).digest('hex'),
    traces: (result.traces || []).map((trace: AnyRecord) => ({
      ...trace,
      output: undefined,
      outputSha256:
        typeof trace.output === 'string'
          ? createHash('sha256').update(trace.output).digest('hex')
          : undefined,
    })),
    note: '真实个人字段值和完整回答未写入项目；这里只保留状态、长度、哈希和可观察质量信号。',
  };
}
function inspectOutput(text: string, query: AnyRecord) {
  return {
    characters: text.length,
    listMarkers: (text.match(/(^|\n)\s*(?:[-*•]|\d+[.、)])/g) || []).length,
    internalTerms: (text.match(/scope|schema|provider|coverage|receipt|sourceId|DPAPI|zju\.py|campus\.lookup|连接器|本轮|流程/gim) || []).length,
    promptEcho: /(系统提示|根据你的提示词|harness|reasoning_content|不要输出 reasoning)/i.test(text),
    unsupportedMoneyUnit: /\d[\d,]*\s*(?:元|人民币|块钱?|角|分)(?!钟)/.test(text) && query.domains.includes('card'),
    containsIdentifierLikeNumber: /\b\d{10,}\b/.test(text),
    personalizedSignal: query.domains.some((domain: string) =>
      domain === 'schedule' || domain === 'exams' || domain === 'practice'
        ? /课|考试|实践|今晚|明天|安排|时间|地点/.test(text)
        : false,
    ),
  };
}

async function runOne(query: AnyRecord, store: Store, adapter: ZjuAdapter) {
  const traces: AnyRecord[] = [];
  const emitted: AnyRecord[] = [];
  let latest: AnyRecord | undefined;
  let callCount = 0;
  const clientFactory = (clientKey: string, clientModel: string) => {
    const client = new DeepSeekClient(clientKey, clientModel);
    const complete = client.complete.bind(client);
    client.complete = async (...args) => {
      const messages = args[0] as WireMessage[];
      const trace: AnyRecord = {
        kind: messages[0]?.content?.includes('[harness:extract')
          ? 'extraction'
          : messages[0]?.content?.includes('[harness:verify')
            ? 'verification'
            : 'generation',
        inputCharacters: JSON.stringify(messages).length,
        roles: messages.map((message) => message.role),
        toolResults: messages.filter((message) => message.role === 'tool').map((message) => {
          let parsed: AnyRecord = {};
          try {
            parsed = JSON.parse(message.content || '{}');
          } catch {}
          return {
            status: parsed.status,
            sourceId: parsed.sourceId,
            capability: parsed.capability,
            domain: parsed.data?.domain,
            origin: parsed.data?.origin,
          };
        }),
      };
      callCount++;
      try {
        const result = await complete(...args);
        trace.output = redactText(result.content || '');
        trace.outputCharacters = result.content?.length || 0;
        trace.toolCalls = result.tool_calls.map((call) => ({ name: call.function.name }));
        traces.push(trace);
        return result;
      } catch (error) {
        trace.error = error instanceof Error ? error.message : String(error);
        traces.push(trace);
        throw error;
      }
    };
    return client;
  };
  const harness = new Harness(
    store,
    () => key!,
    (event) => {
      if (event.type !== 'message') return;
      emitted.push({ role: event.message.role, status: event.message.status, steps: event.message.steps.length });
      if (event.message.role === 'assistant') latest = event.message as AnyRecord;
    },
    clientFactory,
    adapter,
  );
  const started = performance.now();
  let error: string | undefined;
  try {
    store.saveSettings({ mode: 'deepseek', model, memoryEnabled: false, weatherEnabled: false });
    const session = harness.start(undefined, query.text);
    await harness.idle();
    await harness.stop();
    const receipt = latest?.contextReceipt;
    const sourceIds = [...new Set(receipt?.providedSourceIds || [])];
    const output = latest?.content || '';
    return {
      id: query.id,
      input: redactText(query.text),
      expectedDomains: query.domains,
      status: latest?.status === 'done' ? 'requires_semantic_review' : latest?.status || 'error',
      output: redactText(output),
      quality: inspectOutput(output, query),
      calls: callCount,
      traces,
      sourceIds,
      accountSourceObserved: sourceIds.includes('campus:zju-account'),
      legacySourceObserved: sourceIds.includes('campus:local'),
      receipt: receipt
        ? {
            coverage: receipt.coverage,
            needResults: receipt.needResults,
            toolAttempts: receipt.toolAttempts?.map((attempt: AnyRecord) => ({
              capability: attempt.capability,
              status: attempt.status,
            })),
          }
        : undefined,
      emitted: emitted.slice(-10),
      latencyMs: performance.now() - started,
      sessionId: session.sessionId,
    };
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    return {
      id: query.id,
      input: redactText(query.text),
      expectedDomains: query.domains,
      status: 'failed',
      error,
      output: latest?.content ? redactText(latest.content) : '',
      quality: inspectOutput(latest?.content || '', query),
      calls: callCount,
      traces,
      sourceIds: [],
      accountSourceObserved: false,
      legacySourceObserved: false,
      emitted: emitted.slice(-10),
      latencyMs: performance.now() - started,
    };
  } finally {
    await harness.stop().catch(() => {});
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaichang-zju-full-eval-'));
  const store = new Store(path.join(dataDir, 'store.sqlite'));
  const adapter = new ZjuAdapter(store);
  try {
    const before = adapter.describe();
    const authentication = await adapter.verifyAccount(AbortSignal.timeout(75_000));
    if (authentication.status !== 'ok')
      throw new Error(authentication.error?.message || authentication.reason || 'ZJU authentication failed.');
    const results: AnyRecord[] = [];
    for (const query of queries) {
      const result = await runOne(query, store, adapter);
      results.push(result);
      fs.writeFileSync(path.join(outputDir, `${query.id}.json`), JSON.stringify(publicResult(result), null, 2), 'utf8');
      console.log(`${query.id} ${result.status} calls=${result.calls}`);
    }
    const failed = results.filter((result) => result.status === 'failed' || result.status === 'error');
    const report = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      operation: 'real_deepseek_zju_account_domain_evaluation',
      provider: { model, endpoint: 'https://api.deepseek.com/chat/completions', keySource: 'explicit_dpapi_wrapper' },
      connector: {
        sourceKind: before.sourceKind,
        skillFound: before.configured,
        credentialsPresent: before.credentialsConfigured === true,
        ssoVerified: authentication.status === 'ok' && authentication.sso === true,
        authStatusAfter: adapter.describe().authStatus,
      },
      coverage: {
        queryCount: results.length,
        completed: results.filter((result) => result.status === 'requires_semantic_review').length,
        failed: failed.length,
        accountSourceObserved: results.filter((result) => result.accountSourceObserved).length,
        legacySourceObserved: results.filter((result) => result.legacySourceObserved).length,
        expectedDomains: [...new Set(queries.flatMap((query) => query.domains))],
      },
      quality: {
        responsesWithLists: results.filter((result) => result.quality.listMarkers > 0).length,
        responsesWithInternalTerms: results.filter((result) => result.quality.internalTerms > 0).length,
        responsesWithPromptEcho: results.filter((result) => result.quality.promptEcho).length,
        unsupportedMoneyUnitResponses: results.filter((result) => result.quality.unsupportedMoneyUnit).length,
        responsesWithIdentifierLikeNumber: results.filter((result) => result.quality.containsIdentifierLikeNumber).length,
        personalizedSignalResponses: results.filter((result) => result.quality.personalizedSignal).length,
      },
      criticalAssertions: {
        everyQueryUsedAccountSource: results.every((result) => result.accountSourceObserved),
        noLegacyImportSource: results.every((result) => !result.legacySourceObserved),
        noInternalImplementationTerms: results.every((result) => result.quality.internalTerms === 0),
        noPromptEcho: results.every((result) => !result.quality.promptEcho),
        noUnsupportedMoneyUnit: results.every((result) => !result.quality.unsupportedMoneyUnit),
        noIdentifierLikeNumber: results.every((result) => !result.quality.containsIdentifierLikeNumber),
        reservationDoesNotEquateSignInWithEntry: !/到馆.{0,12}看.{0,8}签到|看.{0,8}签到.{0,12}到馆/.test(
          results.find((result) => result.id === 'next_reservation')?.output || '',
        ),
      },
      results: results.map((result) => ({
        id: result.id,
        status: result.status,
        calls: result.calls,
        accountSourceObserved: result.accountSourceObserved,
        legacySourceObserved: result.legacySourceObserved,
        sourceIds: result.sourceIds,
        quality: result.quality,
        latencyMs: result.latencyMs,
      })),
      semanticEvaluation: {
        status: 'requires_independent_human_adjudication',
        reason: '通过真实模型并不自动证明每条推荐、情绪承接或事实解释都正确；本次在运行中人工查看，项目只保留去值后的结构证据。',
      },
      limitations: [
        '每个查询都实际经过 DeepSeek；账号资料来自当前 Windows 用户保存的浙大 DPAPI 凭据。',
        '仅做只读查询；没有选课、预约、缴费、修改资料或发送外部消息。',
        '报告不保存密码、Cookie、票据、完整学号/姓名或原始响应。',
      ],
    };
    fs.writeFileSync(path.join(outputDir, 'runs.json'), JSON.stringify(results.map(publicResult), null, 2), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'live.json'), JSON.stringify(report, null, 2), 'utf8');
    const criticalPassed = Object.values(report.criticalAssertions).every(Boolean);
    console.log(JSON.stringify({ status: failed.length || !criticalPassed ? 'failed' : 'requires_semantic_review', report: path.join(outputDir, 'live.json') }));
    if (failed.length || !criticalPassed) process.exitCode = 1;
  } finally {
    store.close();
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (path.resolve(dataDir).startsWith(tempRoot)) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
