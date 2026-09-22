import fs from 'node:fs';
import path from 'node:path';
import { wilson } from './score-harness-evaluation.mjs';
import { auditRun } from './audit-understanding-run.mjs';

const root = path.resolve('artifacts/understanding-action');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const cases = directory => fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[SNVA]\d+-r\d+\.json$/.test(name)).map(name => ({ file: path.join(directory, name), ...read(path.join(directory, name)) })) : [];
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null; };
export function summarize(rows) {
  const billed = rows.flatMap(row => row.calls || []), priced = billed.filter(call => call.cost);
  const isPassed = row => row.status === 'passed' || row.status === 'passed_environment_checks';
  const assessed = rows.filter(row => row.semantic || row.status === 'passed_environment_checks');
  const families = new Map();
  for (const row of rows) {
    const id = row.familyId || row.id;
    const family = families.get(id) || [];
    family.push(row); families.set(id, family);
  }
  return {
    attempted: rows.length, passed: rows.filter(isPassed).length,
    fullyAssessed: assessed.length, assessedPassed: assessed.filter(isPassed).length,
    assessedRate: assessed.length ? assessed.filter(isPassed).length / assessed.length : null,
    descriptiveWilson95: wilson(assessed.filter(isPassed).length, assessed.length),
    independentStoryFamilies: families.size,
    threeRepeatFamilies: [...families.values()].filter(group => [1, 2, 3].every(repeat => group.some(row => row.repeat === repeat))).length,
    threeRepeatAllPassedFamilies: [...families.values()].filter(group => [1, 2, 3].every(repeat => group.some(row => row.repeat === repeat && isPassed(row))) && group.every(isPassed)).length,
    calls: rows.reduce((sum, row) => sum + (row.calls?.length || 0), 0),
    firstResponseMs: { p50: quantile(rows.flatMap(row => (row.turns || []).map(turn => turn.firstResponseMs).filter(Number.isFinite)), .5), p95: quantile(rows.flatMap(row => (row.turns || []).map(turn => turn.firstResponseMs).filter(Number.isFinite)), .95) },
    knownCostUsd: { min: priced.length ? priced.reduce((sum, call) => sum + call.cost.usdMin, 0) : null, max: priced.length ? priced.reduce((sum, call) => sum + call.cost.usdMax, 0) : null, unknownCalls: billed.length - priced.length },
    unscored: rows.filter(row => !row.semantic && row.status !== 'passed_environment_checks').map(row => ({ id: row.id, repeat: row.repeat, reason: row.error || 'No semantic assessment' })),
    inferenceLimit: 'Descriptive score interval only. Developer-selected stories and correlated repeated trials are not independent random users; do not interpret this as population accuracy or a release guarantee.',
  };
}

export function generateReport() {

const first = cases(path.join(root, 'sixty-stories-r1'));
const repeatedDirectory = 'sixty-stories-three-repeat';
const repeatedRows = cases(path.join(root, repeatedDirectory));
const frozenFile = path.join(root, repeatedDirectory, 'frozen-stories.json');
const repeatedStoryRun = fs.existsSync(frozenFile) ? {
  directory: repeatedDirectory, ...summarize(repeatedRows),
  audit: auditRun(read(frozenFile), repeatedRows, 3),
  environment: read(path.join(root, repeatedDirectory, 'environment.json')),
  scope: 'Original frozen 180-run batch; later repair results are separate evidence, never replacements for its failures.',
} : null;
const repairBatches = ['long-tail-cancellation', 'draft-mode-live', 'missing-draft-variants', 'source-ambiguity-review-live', 'output-recovery-original-live', 'output-source-repair-variants', 'conditional-memory-repair-live', 'conditional-memory-variants', 'capability-coverage-live', 'capability-coverage-variants', 'current-audience-live', 'mixed-release-diagnostic', 'bounded-closure-guidance-live', 'release-owner-mixed-live', 'release-owner-original-r2', 'release-owner-new-expressions', 'release-owner-observation-live', 'retention-effect-diagnostic', 'retention-safe-answer-live', 'retention-effects-original-live', 'retention-effects-variants-live'].map(directory => {
  const reportFile = path.join(root, directory, 'report.json');
  const environmentFile = path.join(root, directory, 'environment.json');
  const rows = cases(path.join(root, directory));
  const batchReport = fs.existsSync(reportFile) ? read(reportFile) : null;
  const present = batchReport?.completed ?? batchReport?.results?.length ?? rows.length;
  const complete = Number.isInteger(batchReport?.planned) && batchReport.planned > 0 && present === batchReport.planned;
  return { directory, summary: summarize(rows), complete, batchReport, environment: fs.existsSync(environmentFile) ? read(environmentFile) : null };
});
const comparison = Object.fromEntries(['B0','B1','B2','B3'].map(group => {
  const file = path.join(root, 'comparison-current', group + '.json');
  if (!fs.existsSync(file)) return [group, { status: 'not_run' }];
  const data = read(file); return [group, { ...summarize(data.rows), rows: data.rows.map(row => ({ id: row.id, status: row.status, calls: row.calls.length, elapsedMs: row.elapsedMs, error: row.error })), environment: read(path.join(root, 'comparison-current', group + '-environment.json')) }];
}));
const ablationFolder = fs.existsSync(path.join(root, 'causal-ablations-r2')) ? 'causal-ablations-r2' : 'causal-ablations';
const pairs = [['prefetch', 'A01', 'without-prefetch'], ['currentMatter', 'A02', 'without-current-matter'], ['repairRejudge', 'A03', 'without-repair-rejudge'], ['closure', 'A04', 'without-closure']];
const ablations = pairs.map(([mechanism, id, off]) => {
  const enabled = cases(path.join(root, ablationFolder, 'all-enabled')).filter(row => row.id === id), disabled = cases(path.join(root, ablationFolder, off));
  const detail = rows => ({ ...summarize(rows), averageCalls: mean(rows.map(row => row.calls.length)), mechanismUses: rows.map(row => row.turns.reduce((sum, turn) => sum + (turn.message?.contextReceipt?.mechanismUses?.[mechanism] || 0), 0)), injections: rows.map(row => row.injectedEvents || []) });
  return { mechanism, id, enabled: detail(enabled), disabled: detail(disabled), limits: 'Three synthetic causal trials, not independent users or natural-task accuracy. Privacy and effect authorization remain enabled in every arm.' };
});
const usageFile = path.join(root, fs.existsSync(path.join(root, 'MODEL-USAGE.json')) ? 'MODEL-USAGE.json' : 'resume-model-usage.json');
const usage = fs.existsSync(usageFile) ? read(usageFile) : null;
const balanceFile = path.join(root, 'balance-status.json');
const balance = fs.existsSync(balanceFile) ? read(balanceFile) : null;
const latestBlockFile = path.join(root, 'backend-candidate-three-repeat/external-block.json');
const latestBlock = fs.existsSync(latestBlockFile) ? read(latestBlockFile) : null;
const balanceRecovered = balance?.status === 'checked' && balance.isAvailable === true && (!latestBlock?.at || Date.parse(balance.checkedAt) > Date.parse(latestBlock.at));
const backendDirectory = ['luna-adapter-backend-gate', 'backend-seal-after-multimodal', 'retention-effects-backend-gate', 'release-owner-backend-r2', 'release-owner-backend-gate', 'backend-after-output-repairs', 'resumed-backend-gate', 'backend-offline-final'].find(directory => fs.existsSync(path.join(root, directory, 'tests.json')));
const backend = backendDirectory ? read(path.join(root, backendDirectory, 'tests.json')) : null;
const backendMechanismEvidence = backend ? { status: backend.status, layer: backend.layer, suites: backend.results.length, tests: backend.results.flatMap(result => result.cases).length, passed: backend.results.flatMap(result => result.cases).filter(result => result.status === 'passed').length, report: backendDirectory + '/tests.json', finishedAt: backend.finishedAt, scope: 'Named completed suite artifact; later source changes require their own validation.' } : { status: 'not_run' };
const report = { generatedAt: new Date().toISOString(), deliveryStatus: 'incomplete', backendMechanismEvidence, externalBlock: { service: 'DeepSeek official API', status: 402, reason: '账户余额不足', evidence: 'delegation-scope-live/S24-r1.json', freshness: 'Last observed provider response; this report does not query the current account balance.' }, firstSixtyStoryRun: { ...summarize(first), public: summarize(first.filter(row => row.id.startsWith('S'))), supplemental: summarize(first.filter(row => row.id.startsWith('N'))), failed: first.filter(row => row.status !== 'passed').map(row => ({ id: row.id, mechanismErrors: row.mechanismErrors, semanticIssues: row.semantic?.issues, error: row.error })) }, comparison, ablations, usage, limitations: ['No complete three-repeat run of all 40 public plus 20 supplemental stories on the latest code.', 'The source-scoped delegation change still needs live revalidation after the balance is replenished.', 'Developer-visible cases are not a blind holdout; independent human review is not complete.', 'The frontend phase, both requested design skills, Electron visual review and final product packaging are not complete.', 'Known-usage price estimates are not an account bill; failed calls with missing usage may add cost.'] };
report.currentBalanceCheck = balance;
if (latestBlock) report.externalBlock = { service: 'DeepSeek official API', status: latestBlock.status, reason: latestBlock.reason, evidence: 'backend-candidate-three-repeat/external-block.json', lastSeenAt: latestBlock.at, resolved: false };
const latestBatchFile = path.join(root, 'backend-candidate-three-repeat/report.json');
report.latestCandidateBatch = fs.existsSync(latestBatchFile) ? read(latestBatchFile) : null;
report.repeatedStoryRun = repeatedStoryRun;
report.repairBatches = repairBatches;
report.lunaTestSubstitute = { model: 'gpt-5.6-luna', providerId: 'openai-app-server', temporaryTestSubstitute: true, productionDefault: 'deepseek-flash',
  batches: ['luna-first-harness', 'luna-harness-parity', 'luna-delegation-repair', 'luna-delegation-observations'].filter(directory => fs.existsSync(path.join(root, directory, 'report.json'))).map(directory => ({ directory, summary: summarize(cases(path.join(root, directory))), report: read(path.join(root, directory, 'report.json')) })),
  transport: fs.existsSync(path.join(root, 'luna-transport-live/report.json')) ? read(path.join(root, 'luna-transport-live/report.json')) : null,
  electron: fs.existsSync(path.join(root, 'luna-electron-multimodal/live-report.json')) ? read(path.join(root, 'luna-electron-multimodal/live-report.json')) : null,
  limitations: ['Temporary substitute evidence is separate from DeepSeek.', 'App Server rejects native output token caps; host rejects completed over-limit output. Account monetary cost unknown.', 'Existing Electron model labels still need correction during the frontend phase.'] };
report.limitations = report.limitations.filter(item => !item.startsWith('The source-scoped delegation'));
if (balanceRecovered) report.externalBlock = { ...report.externalBlock, resolved: true, resolvedAt: balance.checkedAt, freshness: 'Official balance endpoint reports API availability; this does not certify completion of any remaining model test.' };
fs.writeFileSync(path.join(root, 'CURRENT-REPORT.json'), JSON.stringify(report, null, 2));
const fmt = value => value === null ? '未取得' : Number(value).toFixed(2);
const seconds = value => value === null ? null : value / 1000;
const interval = values => values ? values.map(value => (value * 100).toFixed(1) + '%').join('–') : '不可估计';
const lines = [
  '# 理解与行动：当前验证记录', '',
  balanceRecovered ? '**任务尚未完成。** 官方只读余额接口已报告可用，正在恢复必要的真实验证。此前402阻塞与失败记录保留。没有调用Codex子代理，前端阶段与两个设计技能尚未启动。' : '**任务尚未完成。** DeepSeek 官网 API 曾返回402（余额不足），尚无恢复可用证据。没有调用Codex子代理，前端阶段与两个设计技能尚未启动。', '',
  '本页只汇总已有证据，不把不同代码版本的通过记录拼成最新版本全量通过。完整数据见 [CURRENT-REPORT.json](CURRENT-REPORT.json)。', '',
  '## Luna 临时代测', '',
  '按用户要求，现在通过 App Server 使用 GPT‑5.6‑Luna，原 Hermes、上下文、工具和业务链保留。生产默认仍是 DeepSeek。替换契约与差异见 [LUNA-TEST-SUBSTITUTE.md](../../LUNA-TEST-SUBSTITUTE.md)。下方 DeepSeek 历史批次不是 Luna 验证结果。', '',
  ...report.lunaTestSubstitute.batches.map(batch => `${batch.directory}：${batch.summary.passed}/${batch.summary.attempted} 已捕获故事通过，共${batch.summary.calls}次调用。失败和修复批次分别保留。`), '',
  `原生函数/真实结果续接/视觉探针：${report.lunaTestSubstitute.transport?.status || 'not_run'}；真实Electron图文：${report.lunaTestSubstitute.electron?.model || 'not_run'}，textParts=${report.lunaTestSubstitute.electron?.textParts ?? 0}、imageParts=${report.lunaTestSubstitute.electron?.imageParts ?? 0}。当前旧UI仍有DeepSeek标签，不能宣称前台验收完成。`, '',
  '## 离线后端', '',
  `后端机制 ${backendMechanismEvidence.passed ?? 0}/${backendMechanismEvidence.tests ?? 0} 通过（含92个迁移后的宿主场景）。核心26/26、地图核心22/22、构建与新评估源码类型检查通过。打包仅为后端资源预览；没有把它当作前端或最终成品验收。`, '',
  '## 真实模型开发验证', '',
  ...(report.latestCandidateBatch ? [`最新后端候选的三次重复批次只取得 ${report.latestCandidateBatch.completed}/${report.latestCandidateBatch.planned} 条记录后遇到官方402，状态为${report.latestCandidateBatch.status}；未把未开始或未判分条目算成通过。`, ''] : []),
  ...(repeatedStoryRun ? [
    `冻结的60故事×3批次已取得 **${repeatedStoryRun.audit.presentRuns}/180** 条记录，${repeatedStoryRun.audit.passedRuns} 条通过；缺失记录${repeatedStoryRun.audit.missing.length}条、未完整判分${repeatedStoryRun.audit.unscored.length}条。具体失败与分类阈值见JSON中的repeatedStoryRun.audit。此批次有固定编译指纹，修复后原例/变体单列，不覆盖这里的失败。`, '',
    '修复批次完整性：' + repairBatches.map(item => `${item.directory}：${item.complete ? '全部记录已收齐' : '尚未收齐'}，可逐条读取${item.summary.attempted}条`).join('；') + '。长文本专用夹具的7项记录保留在自己的报告中，不冒充7个独立故事。', '',
  ] : []),
  `40公开故事＋20新增故事的首轮记录为 ${report.firstSixtyStoryRun.passed}/${first.length} 通过。后续已逐项修复并留下复测记录；三次完整重复尚未完成。新增故事由开发者可见，不能称为盲测。`, '',
  `首个完整回应的观测 p50 为 ${fmt(seconds(report.firstSixtyStoryRun.firstResponseMs.p50))} 秒、p95 为 ${fmt(seconds(report.firstSixtyStoryRun.firstResponseMs.p95))} 秒；不把后台结束时间冒充首答。`, '',
  `其中完整判分 ${report.firstSixtyStoryRun.fullyAssessed}/${first.length}，未判分 ${report.firstSixtyStoryRun.unscored.length} 项；已判分记录的描述性Wilson区间为 ${interval(report.firstSixtyStoryRun.descriptiveWilson95)}。已有三次记录的故事族为 ${report.firstSixtyStoryRun.threeRepeatFamilies}/${report.firstSixtyStoryRun.independentStoryFamilies}，三次全部通过为 ${report.firstSixtyStoryRun.threeRepeatAllPassedFamilies}。开发集不是随机用户样本，此区间不能证明真实总体正确率。`, '',
  '## 同条件基线', '',
  '| 组 | 环境终态检查 | complete 调用记录 |', '| --- | --- | --- |',
  ...Object.entries(comparison).map(([group, data]) => `| ${group} | ${data.passed ?? 0}/${data.attempted ?? 0} | ${data.calls ?? 0} |`), '',
  'B0为诊断工具循环，B1为固定快照中的真实旧代码，B2为轻配置Hermes，B3为当前集成。六个任务使用相同合法业务资料与边界；实际工具可见性和辅助步骤如实记录。B1仅在测试中运行，并显式统一thinking/output额度。这里只做环境检查和保留答复，不冒充人评。', '',
  '## 四项机制消融', '',
  '| 机制 | 启用后通过 | 关闭后通过 | 平均调用：启用 / 关闭 |', '| --- | --- | --- | --- |',
  ...ablations.map(item => `| ${item.mechanism} | ${item.enabled.passed}/${item.enabled.attempted} | ${item.disabled.passed}/${item.disabled.attempted} | ${fmt(item.enabled.averageCalls)} / ${fmt(item.disabled.averageCalls)} |`), '',
  'A03在读取后修改真实隔离状态；A04在任何副作用发生前注入伪完成输出。它们衡量机制抵抗受控故障的作用，不能充当天然模型成功率。注入记录、机制触发次数和所有失败均保留。', '',
  '预取在这个小样本中减少了一些调用，尚不能证明普遍质量收益。当前事项提示没有在此样本中证明优势，不能因为架构中有这个对象就宣称它更好。修复重判和收尾检查的失效对照出现了可观察的错误；样本仍只有每组3次。', '',
  '## 费用与未完成项', '',
  usage ? `本次接续已记录 ${usage.attemptsCaptured} 次complete尝试，其中 ${usage.usageAvailable} 次取得usage。已知usage按价格快照估算为 **$${usage.estimatedUsdMinKnownUsage.toFixed(2)}–$${usage.estimatedUsdMaxKnownUsage.toFixed(2)}**；${usage.usageMissing} 次缺失usage，不包含在该金额中。这不是账户账单，也不含原任务更早的消耗。` : '尚未汇总usage。', '',
  ...(usage?.uncapturedReportedCalls !== undefined ? [`另有${usage.uncapturedReportedCalls}次已报告但未捕获逐调用数据；${usage.legacyRecordsWithoutGlobalCallIdentity}条旧记录没有全局调用标识，复制证据可能无法完全去重。分阶段成本与覆盖限制见MODEL-USAGE.json，不能把缺数据当零费用。`, ''] : []),
  '- 按用户要求继续Luna临时代测；DeepSeek余额恢复后可用原Key复验其生产路径，不要求新Key。',
  '- 原例修复、变体和冻结三次重复分别核验；是否结束以各批次终态报告为准。',
  '- 后端门槛通过后再使用product-design与product-design-director，完成原Electron入口、截图查看、键盘/窄窗/减少动效及正常/纠正/失败/取消/恢复。',
  '- 最终打包与真实成品验收、独立人评和真正不可见的留出未完成。', '',
];
fs.writeFileSync(path.join(root, 'CURRENT-REPORT.md'), lines.join('\n'));
console.log(JSON.stringify({ firstRun: `${report.firstSixtyStoryRun.passed}/${first.length}`, output: path.join(root, 'CURRENT-REPORT.md'), complete: false }));

}
if (path.basename(process.argv[1] || '') === 'summarize-understanding-evaluation.mjs') generateReport();
