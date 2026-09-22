import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/main/store';
import { Harness } from '../src/main/harness';
import { ZjuAdapter } from '../src/main/zjuAdapter';
import { DeepSeekClient, type WireMessage } from '../src/main/provider';

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required; use the repository DPAPI wrapper.');

const reportPath = path.resolve(
  process.env.ZAICHANG_ZJU_DEEPSEEK_REPORT || 'artifacts/zju-account/deepseek-e2e-smoke.json',
);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaichang-zju-deepseek-'));
const store = new Store(path.join(dataDir, 'store.sqlite'));
const adapter = new ZjuAdapter(store);
const calls: any[] = [];
const emitted: any[] = [];
let latestAssistant: any;
const responses: any[] = [];
const observation = (query: string, response: string, status: string) => ({
  query,
  status,
  responseCharacters: response.length,
  responseSha256: createHash('sha256').update(response).digest('hex'),
});

function redactText(value: string) {
  return value
    .replace(/\b\d{10,}\b/g, '[number-redacted]')
    .replace(/(学号|手机号|邮箱|账号|卡号)\s*[:：]\s*[A-Za-z0-9@._+-]{4,}/g, '$1[redacted]');
}

const clientFactory = (key: string, model: string) => {
  const client = new DeepSeekClient(key, model);
  const complete = client.complete.bind(client);
  client.complete = async (...args) => {
    const messages = args[0] as WireMessage[];
    const item: any = {
      kind: messages[0]?.content?.includes('[harness:extract')
        ? 'extraction'
        : messages[0]?.content?.includes('[harness:verify')
          ? 'verification'
          : 'generation',
      inputCharacters: JSON.stringify(messages).length,
      roles: messages.map((message) => message.role),
      toolResults: messages
        .filter((message) => message.role === 'tool')
        .map((message) => {
          let parsed: any;
          try {
            parsed = JSON.parse(message.content || '{}');
          } catch {}
          return {
            status: parsed?.status,
            sourceId: parsed?.sourceId,
            capability: parsed?.capability,
            origin: parsed?.data?.origin,
            domain: parsed?.data?.domain,
            total: parsed?.data?.total,
          };
        }),
    };
    try {
      const result = await complete(...args);
      item.outputCharacters = JSON.stringify(result).length;
      item.toolCalls = result.tool_calls.map((call) => ({ name: call.function.name }));
      item.output = redactText(result.content || '');
      calls.push(item);
      return result;
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      calls.push(item);
      throw error;
    }
  };
  return client;
};

async function main() {
try {
  store.saveSettings({ mode: 'deepseek', model: 'deepseek-flash' });
  const before = adapter.describe();
  const auth = await adapter.verifyAccount(AbortSignal.timeout(75_000));
  if (auth.status !== 'ok') throw new Error(auth.error?.message || auth.reason || 'ZJU authentication failed.');
  const harness = new Harness(
    store,
    () => process.env.DEEPSEEK_API_KEY!,
    (event) => {
      if (event.type === 'message') {
        emitted.push({
          role: event.message.role,
          status: event.message.status,
          content: event.message.role === 'assistant' ? redactText(event.message.content) : undefined,
          steps: event.message.steps.map((step) => ({ title: step.title, status: step.status })),
        });
        if (event.message.role === 'assistant') latestAssistant = event.message;
      }
    },
    clientFactory,
    adapter,
  );
  const query =
    '根据我浙大账号里的下周课程和考试，帮我安排今晚复习的第一步。只给一个方向，结合我的实际安排，不要讲工具或流程。';
  const session = harness.start(undefined, query);
  await harness.idle();
  responses.push(observation(redactText(query), latestAssistant?.content || '', latestAssistant?.status));
  const accountQuery = '请从我浙大账号里查一下我的校园卡余额，直接告诉我，不要解释过程。';
  const second = harness.start(session.sessionId, accountQuery);
  await harness.idle();
  responses.push(observation(redactText(accountQuery), latestAssistant?.content || '', latestAssistant?.status));
  await harness.stop();
  const receipt = latestAssistant?.contextReceipt;
  const sourceIds = [...new Set(receipt?.providedSourceIds || [])];
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    operation: 'real_deepseek_with_zju_account_read_only',
    queries: responses,
    connector: {
      discovered: before.configured,
      sourceKind: before.sourceKind,
      credentialsPresent: before.credentialsConfigured === true,
      authentication: auth.status,
      sso: auth.sso === true,
      after: adapter.describe().authStatus,
    },
    provider: {
      model: 'deepseek-flash',
      calls: calls.length,
      callKinds: calls.map((call) => call.kind),
      toolCallNames: calls.flatMap((call) => call.toolCalls || []),
    },
    harness: {
      sessionId: session.sessionId,
      assistantStatus: latestAssistant?.status,
      responseCharacters: latestAssistant?.content?.length || 0,
      responses,
      sourceIds,
      accountSourceObserved: sourceIds.includes('campus:zju-account'),
      noLegacyImportInReceipt: !sourceIds.includes('campus:local'),
      toolAttempts: (receipt?.toolAttempts || []).map((attempt: any) => ({
        capability: attempt.capability,
        status: attempt.status,
      })),
      emittedSteps: emitted.filter((event) => event.role === 'assistant').at(-1)?.steps || [],
    },
    assertions: {
      ssoVerified: auth.status === 'ok' && auth.sso === true,
      realAccountSourceObserved: sourceIds.includes('campus:zju-account'),
      assistantCompleted: latestAssistant?.status === 'done',
      responseIsNotEmpty: Boolean(latestAssistant?.content?.trim()),
      explicitAccountToolCallObserved: calls.some((call) =>
        (call.toolResults || []).some((result: any) => result.sourceId === 'campus:zju-account'),
      ),
      noInternalEndpointDump: !/(zju\.py|quick |campus\.lookup|source ID|sourceId|scope|provider)/i.test(
        latestAssistant?.content || '',
      ),
      noNumberLikeIdentifier: !/\b\d{10,}\b/.test(latestAssistant?.content || ''),
    },
    limitations: [
      'One real DeepSeek trajectory is an integration smoke test, not a semantic accuracy or satisfaction study.',
      'Personal answer text is not written to the project; only length and hash are retained.',
      'No enrollment, reservation, payment or other external write was attempted.',
    ],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ status: Object.values(report.assertions).every(Boolean) ? 'passed' : 'failed', report: reportPath }));
  if (!Object.values(report.assertions).every(Boolean)) process.exitCode = 1;
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
