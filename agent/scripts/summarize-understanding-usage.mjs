import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { usageCost, DEEPSEEK_PRICING } from '../src/main/runtime/model-usage.ts';

const root = path.resolve('artifacts/understanding-action');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const containers = ['rows', 'runs', 'results', 'requests', 'cases', 'tasks'];
export function extractCalls(report, file) {
  const calls = [];
  const walk = (node, pointer) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, pointer + '/' + i)); return; }
    if (!node || typeof node !== 'object') return;
    const isCall = (Array.isArray(node.input) || Array.isArray(node.messages) || Number.isFinite(node.inputBytes) || Number.isFinite(node.inputCharacters))
      && ('usage' in node || 'elapsedMs' in node || 'error' in node || 'startedAt' in node);
    if (isCall) {
      const responseIds = (node.toolCalls || []).map(call => call?.id).filter(Boolean);
      const identity = node.startedAt ? hash({ startedAt: node.startedAt, phase: node.phase, actorId: node.actorId, input: node.input || node.messages || node.inputBytes, responseIds }) : file + '#' + pointer;
      calls.push({ identity, identifiable: !!node.startedAt, phase: node.phase || 'unclassified_legacy', usage: node.usage, recordedCost: node.cost });
      return; // Never interpret model inputs, tool arguments or observations as usage evidence.
    }
    if (Array.isArray(node.calls)) walk(node.calls, pointer + '/calls');
    for (const key of containers) if (node[key] && typeof node[key] === 'object') walk(node[key], pointer + '/' + key);
  };
  if (report.kind === 'real_model_control_development' && Array.isArray(report.rows)) {
    report.rows.forEach((row, i) => {
      const entries = Array.isArray(row.usage) ? row.usage : row.usage ? [{ usage: row.usage, cost: row.cost }] : [];
      entries.forEach((entry, j) => calls.push({ identity: file + '#control/' + i + '/' + j, identifiable: false, phase: 'control', usage: entry.usage, recordedCost: entry.cost }));
    });
  } else walk(report, '');
  const declared = Number.isInteger(report.totalCalls) ? report.totalCalls : Number.isInteger(report.calls) ? report.calls : null;
  return { calls, declared, uncaptured: declared === null ? null : Math.max(0, declared - calls.length) };
}

export function summarizeUsage(reports) {
  const seen = new Set(), rows = [], files = [];
  const perCaseCounts = new Map(reports.filter(({ file }) => /(?:^|\/)[SNVAL]\d+(?:-r\d+)?\.json$/.test(file)).map(({ file, report }) => [file, extractCalls(report, file).calls.length]));
  let duplicateRecords = 0, uncapturedReportedCalls = 0;
  for (const { file, report } of reports) {
    const extracted = extractCalls(report, file);
    // Incremental report.json files contain totals and compact case outcomes,
    // not another set of calls. Account for their backing case files once.
    if (!extracted.calls.length && Array.isArray(report.results) && report.results.every(row => /^[SNVAL]\d+$/.test(row.id))) {
      const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const backing = report.results.map(row => directory + row.id + (Number.isInteger(row.repeat) ? '-r' + row.repeat : '') + '.json');
      if (backing.every(name => perCaseCounts.has(name))) {
        extracted.coveredByCaseFiles = backing.reduce((sum, name) => sum + perCaseCounts.get(name), 0);
        extracted.uncaptured = extracted.declared === null ? null : Math.max(0, extracted.declared - extracted.coveredByCaseFiles);
      }
    }
    for (const call of extracted.calls) {
      if (seen.has(call.identity)) { duplicateRecords++; continue; }
      seen.add(call.identity); rows.push(call);
    }
    uncapturedReportedCalls += extracted.uncaptured || 0;
    files.push({ file, declaredCalls: extracted.declared, captured: extracted.calls.length, coveredByCaseFiles: extracted.coveredByCaseFiles, uncaptured: extracted.uncaptured });
  }
  const phases = {}, providers = {};
  let knownMin = 0, knownMax = 0, available = 0, costAvailable = 0;
  for (const row of rows) {
    const phase = phases[row.phase] ||= { calls: 0, usageAvailable: 0, inputTokens: 0, outputTokens: 0, usdMinKnown: 0, usdMaxKnown: 0 };
    phase.calls++;
    const u = row.usage;
    if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) continue;
    available++; phase.usageAvailable++; phase.inputTokens += u.prompt_tokens; phase.outputTokens += u.completion_tokens;
    const provider = providers[u.providerId || 'deepseek'] ||= { callsWithUsage: 0, inputTokens: 0, outputTokens: 0, costKnown: 0 };
    provider.callsWithUsage++; provider.inputTokens += u.prompt_tokens; provider.outputTokens += u.completion_tokens;
    const cost = usageCost(u);
    if (!cost || !Number.isFinite(cost.usdMin) || !Number.isFinite(cost.usdMax)) continue;
    costAvailable++; provider.costKnown++;
    phase.usdMinKnown += cost.usdMin; phase.usdMaxKnown += cost.usdMax;
    knownMin += cost.usdMin; knownMax += cost.usdMax;
  }
  return { generatedAt: new Date().toISOString(), kind: 'captured_model_usage_inventory', attemptsCaptured: rows.length, usageAvailable: available, usageMissing: rows.length - available,
    estimatedUsdMinKnownUsage: knownMin, estimatedUsdMaxKnownUsage: knownMax, duplicateRecords, legacyRecordsWithoutGlobalCallIdentity: rows.filter(row => !row.identifiable).length,
    uncapturedReportedCalls, phases, providers, costAvailable, costUnknown: rows.length - costAvailable, files, pricing: DEEPSEEK_PRICING,
    limitations: ['Only tagged real-model development/replay reports under this artifact root are inspected; deterministic tests are excluded.', 'Modern duplicate captures use timestamp, phase, actor, input hash and returned tool IDs. Legacy records without global identities are counted by file/position and may include copied evidence.', 'Uncaptured reported calls and calls without usage have unknown cost, not zero cost.', 'Counts are complete() attempts, not every internal HTTP retry. This is not an account bill or a precise cumulative charge.', 'Model inputs are hashed for deduplication and are not copied into this report.'] };
}

if (path.basename(process.argv[1] || '') === 'summarize-understanding-usage.mjs') {
  const reports = [];
  const scan = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!entry.name.endsWith('.json') || ['CURRENT-REPORT.json', 'resume-model-usage.json', 'MODEL-USAGE.json'].includes(entry.name)) continue;
      let report;
      try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (typeof report.kind !== 'string' || (!report.kind.startsWith('real_model') && report.kind !== 'recorded_trajectory_judge_replay')) continue;
      reports.push({ file: path.relative(root, file).replaceAll('\\', '/'), report });
      if (report.kind === 'real_model_long_input_cancellation') for (const row of report.results || []) {
        if (!/^L\d+$/.test(row.id)) continue;
        const source = path.join(directory, row.id + '.json');
        if (fs.existsSync(source)) reports.push({ file: path.relative(root, source).replaceAll('\\', '/'), report: JSON.parse(fs.readFileSync(source, 'utf8')) });
      }
    }
  };
  scan(root);
  const result = summarizeUsage(reports);
  fs.writeFileSync(path.join(root, 'MODEL-USAGE.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ attemptsCaptured: result.attemptsCaptured, usageAvailable: result.usageAvailable, usageMissing: result.usageMissing, uncapturedReportedCalls: result.uncapturedReportedCalls, usdMinKnown: result.estimatedUsdMinKnownUsage, usdMaxKnown: result.estimatedUsdMaxKnownUsage }));
}
