import fs from 'node:fs';
import path from 'node:path';

const [runFile, outFile] = process.argv.slice(2);
if (!runFile || !outFile)
  throw new Error('Usage: node scripts/score-conversation-quality.mjs RUNS.json OUTPUT.json');

const runs = JSON.parse(fs.readFileSync(runFile, 'utf8'));
if (!Array.isArray(runs)) throw new Error('RUNS.json must contain an array.');

const listPattern = /(^|\n)\s*(?:[-*•]|\d+[.、)])\s/;
const metaPattern = /连接器|资料栏|本轮|上下文|工作流|正式条件|状态矩阵|provider|coverage|schema|memory|scope|流程报告|候选/gi;
// These are possible prompt/protocol echoes, not proof of copying. A human
// must check whether the same idea was also present in the user's wording.
const promptEchoPattern = /本轮使用协议|受当前范围约束|宿主执行|scope|schema|memory|coverage|provider|原始请求|工具名称|工作流报告/gi;
const emotionPattern = /慌|害怕|压人|喘不过气|不好受|累|难受|烦|委屈|听着|慢慢|不急|别急|放心|辛苦|心里发紧/;
const genericUnsupportedPattern = /通常每周|随时能来|随时能走|随时可以退出|不去也不用打招呼|不需要固定每周|不去也没负担|报名就能去|不怎么考核|一定可以|肯定可以|先当(?:作)?不下雨|默认不下雨/;
const normalize = (value) =>
  String(value || '')
    .replace(/\s+/g, '')
    .replace(/[“”"'‘’.,，。！？!?；;：:、()（）]/g, '');

const rows = runs.map((run) => {
  const output = String(run.output || '');
  const trace = Array.isArray(run.trace) ? run.trace : [];
  const foreground = trace.filter((entry) => entry.kind === 'generation');
  const background = trace.filter((entry) => entry.kind !== 'generation');
  const modelToolCalls = foreground.flatMap((entry) => entry.toolCalls || []);
  const duplicateForeground =
    foreground.length > 1 &&
    foreground.slice(0, -1).some((entry) => {
      const prior = normalize(entry.outputText);
      const last = normalize(foreground.at(-1)?.outputText);
      return prior.length >= 24 && (last.includes(prior) || prior.includes(last));
    });
  const issues = [];
  if (run.contract?.interactionMode === 'listen' && modelToolCalls.length)
    issues.push('tool_call_during_listen');
  if (duplicateForeground) issues.push('duplicate_foreground_answer');
  if (listPattern.test(output)) issues.push('list_or_numbering');
  if (metaPattern.test(output)) issues.push('internal_or_process_word');
  if (promptEchoPattern.test(output)) issues.push('possible_prompt_echo');
  if (genericUnsupportedPattern.test(output)) issues.push('unsupported_activity_rule');
  return {
    episodeId: run.episodeId,
    variant: run.variant,
    split: run.split,
    status: run.status,
    contract: run.contract,
    outputCharacters: output.length,
    foregroundGenerations: foreground.length,
    backgroundCalls: background.length,
    modelToolCalls: modelToolCalls.map((call) => call.name),
    modelToolCallCount: modelToolCalls.length,
    listMarkers: listPattern.test(output) ? 1 : 0,
    metaWordCount: (output.match(metaPattern) || []).length,
    promptEchoSignalCount: (output.match(promptEchoPattern) || []).length,
    emotionSignal: emotionPattern.test(output) ? 1 : 0,
    unsupportedActivityRule: genericUnsupportedPattern.test(output) ? 1 : 0,
    duplicateForeground: duplicateForeground ? 1 : 0,
    issues,
  };
});

const sum = (key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
const count = (predicate) => rows.filter(predicate).length;
const report = {
  kind: 'observable_conversation_quality_review',
  source: path.resolve(runFile),
  runs: rows.length,
  failedRuns: count((row) => row.status === 'failed'),
  aggregates: {
    outputCharacters: sum('outputCharacters'),
    foregroundGenerations: sum('foregroundGenerations'),
    backgroundCalls: sum('backgroundCalls'),
    modelToolCalls: sum('modelToolCallCount'),
    runsWithLists: sum('listMarkers'),
    metaWordCount: sum('metaWordCount'),
    promptEchoSignalCount: sum('promptEchoSignalCount'),
    emotionSignals: sum('emotionSignal'),
    unsupportedActivityRules: sum('unsupportedActivityRule'),
    duplicateForegroundRuns: sum('duplicateForeground'),
  },
  rates: {
    listenToolCallRate: rows.length
      ? count((row) => row.issues.includes('tool_call_during_listen')) /
        count((row) => row.contract?.interactionMode === 'listen')
      : null,
    duplicateForegroundRate: rows.length ? sum('duplicateForeground') / rows.length : null,
    listRate: rows.length ? sum('listMarkers') / rows.length : null,
    metaWordRunRate: rows.length ? count((row) => row.metaWordCount > 0) / rows.length : null,
    promptEchoRunRate: rows.length
      ? count((row) => row.promptEchoSignalCount > 0) / rows.length
      : null,
    unsupportedActivityRuleRate: rows.length
      ? sum('unsupportedActivityRule') / rows.length
      : null,
  },
  rows,
  interpretation:
    'These are observable signals, not a semantic oracle. Emotion and style regexes are prompts for human review; they cannot prove empathy or understanding. Background calls are separated from user-visible foreground generations.',
};
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
