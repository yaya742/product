import fs from 'node:fs';
import path from 'node:path';
import { DeepSeekClient } from '../src/main/provider';

type AnyRecord = Record<string, any>;
const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || !key)
  throw new Error('Explicit live-evaluation authorization and test key are required.');

const runFile = path.resolve(process.env.ZAICHANG_JUDGE_RUNS || 'artifacts/harness/live-acceptance-real/runs.json');
const outFile = path.resolve(process.env.ZAICHANG_JUDGE_REPORT || 'artifacts/harness/live-acceptance-real/model-assisted-review.json');
const partialFile = outFile.replace(/\.json$/i, '.partial.json');
const suiteFile = path.resolve(
  process.env.ZAICHANG_ACCEPTANCE_SUITE ||
    '在场-Harness-设计与Codex实施包/zaichang-harness-design/acceptance/scenarios.json',
);
const model = 'deepseek-flash';
const batchSize = Math.min(6, Math.max(1, Number(process.env.ZAICHANG_JUDGE_BATCH_SIZE || 4)));
const requested = (process.env.ZAICHANG_JUDGE_CASES || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const runs = JSON.parse(fs.readFileSync(runFile, 'utf8')) as AnyRecord[];
const suite = JSON.parse(fs.readFileSync(suiteFile, 'utf8')) as AnyRecord;
const specs = new Map((suite.cases || []).map((item: AnyRecord) => [item.id, item]));
const selected = runs.filter((run) => !requested.length || requested.includes(run.id));
const client = new DeepSeekClient(key, model);

function parseJson(text: string) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(stripped);
}
function compact(run: AnyRecord) {
  const spec = specs.get(run.id) || {};
  return {
    id: run.id,
    title: run.title,
    groups: run.groups,
    exactUserTurns: run.exactUserTurns,
    expectedStateChecks: (spec.expected || []).map((item: AnyRecord) => ({
      probe: item.probe,
      operator: item.operator,
      rationale: item.rationale,
    })),
    turns: (run.responses || []).map((response: AnyRecord) => ({
      user: response.input,
      assistant: response.output,
    })),
    process: (run.traces || []).map((trace: AnyRecord) => ({
      kind: trace.kind,
      toolCalls: (trace.toolCalls || []).map((call: AnyRecord) => call.name),
      toolResults: trace.toolResults || [],
      failed: trace.failed || false,
    })),
    skippedSetupOperations: run.skippedOps || [],
    sourceIds: run.sourceIds || [],
  };
}

async function judgeBatch(batch: AnyRecord[]) {
  const system = `你是“在场”校园个人助手的严格回复评审。重点不是外部事实核验，而是看回复和处理过程是否真的理解人：
- 是否接住用户的情绪、年龄/理解负担和明确表达要求；
- 是否直接、自然、简洁，而不是清单、工程术语、提示词复读或应付式套话；
- 是否连贯使用前文、当前纠正、条件、受众和工具结果；
- 是否胡乱补出人格、规则、时间、权限、已执行状态或个人事实；
- 是否尊重自主、隐私和“建议/已保存/已执行/未知”的边界。

对每个案例给出 JSON 对象。verdict 只能是 pass/minor/major。scores 中 empathy、directness、naturalness、contextUse、epistemicHonesty、continuity、autonomyPrivacy 各为 0、1、2 或 null（不适用）。issues 用短标签。stageHypotheses 必须同时给 primary 和 competing：从 routing/context/tool/model_generation/host_presentation/evaluation_fixture 里选，并说明两种解释各自的可观察依据；不要把所有问题都归咎于模型。fix 必须是可实施的最小改动，不写空泛“优化提示词”。

只输出 JSON 数组，不加代码块或解释。不要因为有输出就判通过；也不要因测试标题是技术性就强求情绪化。30 个 syntheticProbe 只评估探针下的可见回答，不能当成原始用户话语。`;
  const response = await client.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(batch.map(compact)) },
    ],
    [],
    AbortSignal.timeout(90_000),
  );
  let parsed: AnyRecord[];
  try {
    parsed = parseJson(response.content);
  } catch {
    const repaired = await client.complete(
      [
        { role: 'system', content: '把下面内容修成一个有效 JSON 数组；不改含义，不加解释或代码块。' },
        { role: 'user', content: response.content },
      ],
      [],
      AbortSignal.timeout(90_000),
    );
    parsed = parseJson(repaired.content);
  }
  if (!Array.isArray(parsed)) throw new Error('Judge did not return an array.');
  const byId = new Map(parsed.map((item) => [item.id, item]));
  return batch.map((run) =>
    byId.get(run.id) || {
      id: run.id,
      verdict: 'major',
      issues: ['judge_missing_case'],
      stageHypotheses: {
        primary: { stage: 'evaluation_fixture', evidence: '评审返回中缺少该案例。' },
        competing: { stage: 'model_generation', evidence: '结构化评审可能被模型漏项。' },
      },
      fix: '单独重跑此案例的评审。',
    },
  );
}

async function main() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let judgments: AnyRecord[] = [];
  if (fs.existsSync(partialFile)) {
    try {
      const partial = JSON.parse(fs.readFileSync(partialFile, 'utf8'));
      if (partial.source === runFile && partial.model === model && Array.isArray(partial.judgments))
        judgments = partial.judgments;
    } catch {}
  }
  const done = new Set(judgments.map((item) => item.id));
  const pending = selected.filter((item) => !done.has(item.id));
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const values = await judgeBatch(batch);
    judgments.push(...values);
    fs.writeFileSync(
      partialFile,
      JSON.stringify({ source: runFile, model, judgments }, null, 2),
      'utf8',
    );
    console.log(`judged ${judgments.length}/${selected.length}`);
  }
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    kind: 'model_assisted_competing_explanation_review',
    source: runFile,
    model,
    cases: judgments.length,
    counts: {
      pass: judgments.filter((item) => item.verdict === 'pass').length,
      minor: judgments.filter((item) => item.verdict === 'minor').length,
      major: judgments.filter((item) => item.verdict === 'major').length,
    },
    judgments,
    limitations: [
      '同一供应商模型参与评审，适合发现线索，不是独立人类裁决。',
      '每个结论必须回到对应案例的真实回复和工具轨迹复核。',
      '事实正确性不是主要评分对象，但无来源的确定说法、状态混淆和自相矛盾仍算问题。',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  fs.rmSync(partialFile, { force: true });
  console.log(JSON.stringify({ report: outFile, ...report.counts }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
