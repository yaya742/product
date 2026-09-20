import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Validate the human-cooperation development trajectories as a mechanism-only
 * intake.  This deliberately does not execute a chat, call an LLM, or inspect
 * an assistant reply.  The natural-language expected/forbidden observations
 * remain L/U evaluation material and are reported as not_run.
 */

export const RUNNER_VERSION = 'trajectory-mechanism-validator@1.0.0';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const specRelative =
  '在场-Harness-人本协作设计与Codex实施包/在场-Harness-人本协作重构/acceptance/trajectories.json';
const architectureRelative =
  '在场-Harness-人本协作设计与Codex实施包/在场-Harness-人本协作重构/02-人本协作架构.md';
const acceptanceRelative =
  '在场-Harness-人本协作设计与Codex实施包/在场-Harness-人本协作重构/04-行为验收规范.md';
const manifestRelative =
  '在场-Harness-人本协作设计与Codex实施包/在场-Harness-人本协作重构/交付一致性说明.json';

const allowedKinds = new Set([
  'user',
  'user_generated',
  'system_checkpoint',
  'fault',
  'source_change',
  'restart',
  'clock',
]);
const caseKeys = new Set([
  'id',
  'title',
  'source_groups',
  'requirements',
  'initial_state',
  'steps',
  'final_outcome',
  'counterfactual_variants',
]);
const stepKeys = new Set(['kind', 'content', 'expected_observations', 'forbidden_observations']);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /Bearer\s+[A-Za-z0-9_.-]{20,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/,
];

const readText = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(readText(relative));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => new Set(values).size === values.length;

function pushIssue(issues, code, message, pathValue) {
  issues.push({ code, message, ...(pathValue ? { path: pathValue } : {}) });
}

function walkStrings(value, visit, currentPath = '$') {
  if (typeof value === 'string') {
    visit(value, currentPath);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    walkStrings(child, visit, `${currentPath}.${key}`);
  }
}

function buildGeneratedInput(generator) {
  if (!isObject(generator)) return null;
  const prefix = typeof generator.prefix === 'string' ? generator.prefix : '';
  const suffix = typeof generator.suffix === 'string' ? generator.suffix : '';
  const repeat = Number(generator.repeat_to_characters);
  if (!Number.isInteger(repeat) || repeat < 0) return null;
  // This is only an in-process integrity check; the resulting text is never
  // sent to a model or persisted in the report.
  const filler = prefix.repeat(Math.ceil(repeat / Math.max(prefix.length, 1))).slice(0, repeat);
  return filler + suffix;
}

function validateCase(scenario, index, globalIssues) {
  const issues = [];
  const casePath = `cases[${index}]`;
  if (!isObject(scenario)) {
    pushIssue(issues, 'case_not_object', 'case must be an object', casePath);
    return { id: `index-${index}`, status: 'failed', issues };
  }
  for (const key of ['id', 'title', 'initial_state', 'steps', 'final_outcome', 'counterfactual_variants']) {
    if (!hasOwn(scenario, key)) pushIssue(issues, 'missing_case_field', `missing ${key}`, `${casePath}.${key}`);
  }
  for (const key of Object.keys(scenario)) {
    if (!caseKeys.has(key)) pushIssue(issues, 'unknown_case_field', `unknown field ${key}`, `${casePath}.${key}`);
  }
  if (!/^T\d{2}$/.test(scenario.id || ''))
    pushIssue(issues, 'invalid_case_id', 'id must match T00 format', `${casePath}.id`);
  if (!nonEmptyString(scenario.title)) pushIssue(issues, 'invalid_title', 'title must be non-empty', `${casePath}.title`);
  if (!isObject(scenario.initial_state))
    pushIssue(issues, 'invalid_initial_state', 'initial_state must be an object', `${casePath}.initial_state`);
  if (!Array.isArray(scenario.source_groups) || !scenario.source_groups.length)
    pushIssue(issues, 'invalid_source_groups', 'source_groups must be a non-empty array', `${casePath}.source_groups`);
  else {
    if (!unique(scenario.source_groups))
      pushIssue(issues, 'duplicate_source_group', 'source_groups must be unique', `${casePath}.source_groups`);
    for (const [i, group] of scenario.source_groups.entries())
      if (!/^[A-E][1-8]$/.test(group))
        pushIssue(issues, 'invalid_source_group', `unexpected source group ${String(group)}`, `${casePath}.source_groups[${i}]`);
  }
  if (!Array.isArray(scenario.requirements) || !scenario.requirements.length)
    pushIssue(issues, 'invalid_requirements', 'requirements must be a non-empty array', `${casePath}.requirements`);
  else {
    if (!unique(scenario.requirements))
      pushIssue(issues, 'duplicate_requirement', 'requirements must be unique', `${casePath}.requirements`);
    for (const [i, requirement] of scenario.requirements.entries())
      if (!/^H(?:0[1-9]|1[0-3])$/.test(requirement))
        pushIssue(issues, 'invalid_requirement', `unexpected requirement ${String(requirement)}`, `${casePath}.requirements[${i}]`);
  }
  for (const listName of ['final_outcome', 'counterfactual_variants']) {
    if (!Array.isArray(scenario[listName]) || !scenario[listName].length)
      pushIssue(issues, 'invalid_case_list', `${listName} must be a non-empty array`, `${casePath}.${listName}`);
    else {
      for (const [i, item] of scenario[listName].entries())
        if (!nonEmptyString(item)) pushIssue(issues, 'invalid_case_list_item', `${listName} items must be strings`, `${casePath}.${listName}[${i}]`);
    }
  }
  if (!Array.isArray(scenario.steps) || !scenario.steps.length) {
    pushIssue(issues, 'invalid_steps', 'steps must be a non-empty array', `${casePath}.steps`);
  } else {
    for (const [stepIndex, step] of scenario.steps.entries()) {
      const stepPath = `${casePath}.steps[${stepIndex}]`;
      if (!isObject(step)) {
        pushIssue(issues, 'step_not_object', 'step must be an object', stepPath);
        continue;
      }
      for (const key of ['kind', 'content', 'expected_observations', 'forbidden_observations']) {
        if (!hasOwn(step, key)) pushIssue(issues, 'missing_step_field', `missing ${key}`, `${stepPath}.${key}`);
      }
      for (const key of Object.keys(step)) {
        if (!stepKeys.has(key)) pushIssue(issues, 'unknown_step_field', `unknown field ${key}`, `${stepPath}.${key}`);
      }
      if (!allowedKinds.has(step.kind)) pushIssue(issues, 'invalid_step_kind', `unsupported kind ${String(step.kind)}`, `${stepPath}.kind`);
      if (!nonEmptyString(step.content)) pushIssue(issues, 'invalid_step_content', 'content must be non-empty', `${stepPath}.content`);
      for (const listName of ['expected_observations', 'forbidden_observations']) {
        if (!Array.isArray(step[listName])) {
          pushIssue(issues, 'invalid_observation_list', `${listName} must be an array`, `${stepPath}.${listName}`);
        } else {
          for (const [i, item] of step[listName].entries())
            if (!nonEmptyString(item)) pushIssue(issues, 'invalid_observation', `${listName} items must be strings`, `${stepPath}.${listName}[${i}]`);
        }
      }
      if (Array.isArray(step.expected_observations) && Array.isArray(step.forbidden_observations)) {
        const forbidden = new Set(step.forbidden_observations);
        for (const observation of step.expected_observations)
          if (forbidden.has(observation))
            pushIssue(issues, 'observation_overlap', 'same observation is both expected and forbidden', `${stepPath}.expected_observations`);
      }
      if (step.kind === 'user_generated') {
        const generator = scenario.initial_state?.long_input_generator;
        const generated = buildGeneratedInput(generator);
        if (!generated) pushIssue(issues, 'missing_long_input_generator', 'user_generated requires a valid long_input_generator', `${casePath}.initial_state.long_input_generator`);
        else if (typeof generator.suffix !== 'string' || !generated.endsWith(generator.suffix))
          pushIssue(issues, 'suffix_not_retained', 'generated input must retain suffix at the end', `${casePath}.initial_state.long_input_generator.suffix`);
      }
    }
  }
  const expectedCount = Array.isArray(scenario.steps)
    ? scenario.steps.reduce((sum, step) => sum + (Array.isArray(step?.expected_observations) ? step.expected_observations.length : 0), 0)
    : 0;
  const forbiddenCount = Array.isArray(scenario.steps)
    ? scenario.steps.reduce((sum, step) => sum + (Array.isArray(step?.forbidden_observations) ? step.forbidden_observations.length : 0), 0)
    : 0;
  const result = {
    id: scenario.id || `index-${index}`,
    title: scenario.title || '',
    status: issues.length ? 'failed' : 'passed',
    mechanism: {
      status: issues.length ? 'failed' : 'passed',
      checks: ['schema', 'steps', 'expected_forbidden_shape', 'state_source_boundary'],
      expectedObservationCount: expectedCount,
      forbiddenObservationCount: forbiddenCount,
      finalOutcomeCount: Array.isArray(scenario.final_outcome) ? scenario.final_outcome.length : 0,
      counterfactualCount: Array.isArray(scenario.counterfactual_variants) ? scenario.counterfactual_variants.length : 0,
    },
    semanticEvaluation: {
      layer: 'L',
      status: 'not_run',
      reason: 'Natural-language expected/forbidden observations are not graded by this mechanism runner.',
    },
    experienceEvaluation: {
      layer: 'U',
      status: 'not_run',
      reason: 'No human or UX study is executed by this runner.',
    },
    sourceGroups: Array.isArray(scenario.source_groups) ? scenario.source_groups : [],
    requirements: Array.isArray(scenario.requirements) ? scenario.requirements : [],
    steps: Array.isArray(scenario.steps) ? scenario.steps.length : 0,
    ...(issues.length ? { issues } : {}),
  };
  if (issues.length) globalIssues.push(...issues.map((issue) => ({ ...issue, caseId: result.id })));
  return result;
}

function consistencyFindings(spec, architectureText, acceptanceText, manifest) {
  const usedGroups = [...new Set(spec.cases.flatMap((scenario) => scenario.source_groups || []))].sort();
  const documentedGroups = [...acceptanceText.matchAll(/^\|\s+([A-E][1-8])\s+/gm)].map((match) => match[1]);
  const documentedUniqueGroups = [...new Set(documentedGroups)].sort();
  const architectureRequirements = [...architectureText.matchAll(/^##\s+H(\d{2})[．.、\s]/gm)].map((match) => `H${match[1]}`);
  const requirements = [...new Set(spec.cases.flatMap((scenario) => scenario.requirements || []))].sort();
  const manifestClaim = manifest?.document_consistency_checks?.forty_source_groups_mapped === true;
  return {
    sourceGroups: {
      trajectoryDistinct: usedGroups.length,
      documentedDistinct: documentedUniqueGroups.length,
      documentedOnly: documentedUniqueGroups.filter((group) => !usedGroups.includes(group)),
      trajectoryOnly: usedGroups.filter((group) => !documentedUniqueGroups.includes(group)),
      manifestClaimFortyMapped: manifestClaim,
      warning:
        manifestClaim && documentedUniqueGroups.length === 40 && usedGroups.length !== 40
          ? '交付一致性说明.json 声称 40 source groups 已映射，但 32 条轨迹实际覆盖了 31 个；这不是 runner 失败，不能据此宣称 40 组已执行。'
          : null,
    },
    requirements: {
      architecture: [...new Set(architectureRequirements)].sort(),
      trajectory: requirements,
      architectureOnly: [...new Set(architectureRequirements)].filter((id) => !requirements.includes(id)).sort(),
      trajectoryOnly: requirements.filter((id) => !architectureRequirements.includes(id)),
      warning:
        architectureRequirements.includes('H13') && !requirements.includes('H13')
          ? '02-人本协作架构.md 声明 H13 行为评估，但 trajectories.json 没有任何 H13 requirement；M runner 不能把 H13 语义/U 证据补出来。'
          : null,
    },
  };
}

export function validateTrajectories({ spec = readJson(specRelative), architectureText = readText(architectureRelative), acceptanceText = readText(acceptanceRelative), manifest = readJson(manifestRelative) } = {}) {
  const issues = [];
  if (!isObject(spec)) {
    return { runner: RUNNER_VERSION, status: 'failed', issues: [{ code: 'spec_not_object', message: 'trajectory spec must be an object' }] };
  }
  for (const key of ['schema_version', 'status', 'description', 'count', 'defaults', 'runner_notes', 'cases'])
    if (!hasOwn(spec, key)) pushIssue(issues, 'missing_spec_field', `missing ${key}`, key);
  if (spec.schema_version !== '1.0-design-spec') pushIssue(issues, 'schema_version_mismatch', 'unexpected schema_version', 'schema_version');
  if (spec.status !== 'development_seed_specifications_not_executed') pushIssue(issues, 'status_mismatch', 'trajectory seeds must remain non-executed specifications', 'status');
  if (!Number.isInteger(spec.count) || spec.count !== 32) pushIssue(issues, 'count_mismatch', 'count must remain 32', 'count');
  if (!isObject(spec.defaults)) pushIssue(issues, 'invalid_defaults', 'defaults must be an object', 'defaults');
  else {
    const requiredBoundaries = [
      ['external_effects', 'denied_unless_case_explicitly_configures_and_user_authorizes'],
      ['workspace', 'isolated-test'],
    ];
    for (const [key, expected] of requiredBoundaries)
      if (spec.defaults[key] !== expected) pushIssue(issues, 'boundary_mismatch', `${key} must preserve ${expected}`, `defaults.${key}`);
    if (!String(spec.defaults.provider_truth || '').includes('不接受模型自报成功')) pushIssue(issues, 'provider_truth_boundary_missing', 'provider truth boundary is missing', 'defaults.provider_truth');
    if (!String(spec.defaults.llm || '').includes('not_run')) pushIssue(issues, 'llm_boundary_missing', 'LLM not_run boundary is missing', 'defaults.llm');
    if (!String(spec.defaults.secrets || '').includes('不使用真实')) pushIssue(issues, 'secret_boundary_missing', 'synthetic-secret boundary is missing', 'defaults.secrets');
  }
  if (!Array.isArray(spec.runner_notes) || !spec.runner_notes.length) pushIssue(issues, 'runner_notes_missing', 'runner_notes must be non-empty', 'runner_notes');
  if (!Array.isArray(spec.cases)) pushIssue(issues, 'cases_not_array', 'cases must be an array', 'cases');
  const cases = Array.isArray(spec.cases) ? spec.cases : [];
  walkStrings(spec, (text, stringPath) => {
    if (secretPatterns.some((pattern) => pattern.test(text)))
      pushIssue(issues, 'secret_like_value', 'secret-like value is not allowed in trajectory fixtures', stringPath);
  });
  if (cases.length !== spec.count) pushIssue(issues, 'case_count_mismatch', 'cases length does not match count', 'cases');
  const ids = cases.map((scenario) => scenario?.id);
  if (!unique(ids)) pushIssue(issues, 'duplicate_case_id', 'case ids must be unique', 'cases');
  const caseReports = cases.map((scenario, index) => validateCase(scenario, index, issues));
  const consistency = consistencyFindings(spec, architectureText, acceptanceText, manifest);
  return {
    runner: RUNNER_VERSION,
    status: issues.length ? 'failed' : 'passed',
    mechanism: {
      layer: 'M',
      status: issues.length ? 'failed' : 'passed',
      cases: { total: cases.length, passed: caseReports.filter((item) => item.status === 'passed').length, failed: caseReports.filter((item) => item.status === 'failed').length },
      checks: ['schema', 'steps', 'expected_forbidden_shape', 'state_source_boundary'],
      modelInvoked: false,
      goldForwardedToModel: false,
    },
    layers: {
      M: { status: issues.length ? 'failed' : 'passed', scope: 'schema/fixture/state-source boundaries only' },
      L: { status: 'not_run', scope: 'DeepSeek semantic behavior; requires separately authorized test configuration' },
      U: { status: 'not_run', scope: 'human/experience evaluation' },
    },
    spec: { path: specRelative, sha256: sha256(readText(specRelative)), schemaVersion: spec.schema_version, declaredCount: spec.count },
    cases: caseReports,
    consistency,
    issues,
  };
}

function markdownReport(report) {
  const rows = report.cases
    .map((item) => `| ${item.id} | ${item.status} | ${item.mechanism.expectedObservationCount} | ${item.mechanism.forbiddenObservationCount} | ${item.semanticEvaluation.status} | ${item.experienceEvaluation.status} |`)
    .join('\n');
  const warnings = [report.consistency.sourceGroups.warning, report.consistency.requirements.warning].filter(Boolean);
  return `# 32 条人本协作轨迹：机制接入报告\n\n` +
    `- runner: \`${report.runner}\`\n` +
    `- M 机制校验：**${report.mechanism.status}**（${report.mechanism.cases.passed}/${report.mechanism.cases.total} cases）\n` +
    `- L DeepSeek 语义：**not_run**；U 人本体验：**not_run**\n` +
    `- modelInvoked: \`${report.mechanism.modelInvoked}\`; goldForwardedToModel: \`${report.mechanism.goldForwardedToModel}\`\n\n` +
    `本报告只校验规格形状、步骤种类、expected/forbidden 字段形状、合成长输入尾部完整性和状态/来源边界。expected/forbidden 与 final_outcome 的自然语言意义没有被正则判分，也没有发送给模型。开发种子仍不是独立盲测。\n\n` +
    `## 逐 case\n\n| ID | M 状态 | expected 条数 | forbidden 条数 | L | U |\n|---|---|---:|---:|---|---|\n${rows}\n\n` +
    `## 文档一致性提示\n\n` +
    `- 轨迹实际覆盖 **${report.consistency.sourceGroups.trajectoryDistinct}** 个 source group；04 文档列出 **${report.consistency.sourceGroups.documentedDistinct}** 个，交付一致性 JSON 的 “forty_source_groups_mapped” 为 **${report.consistency.sourceGroups.manifestClaimFortyMapped}**。这只说明设计包声称已映射，不能当作本 runner 已执行 40 组。\n` +
    `- 架构文档声明的 H13 是否出现在轨迹 requirements：**${report.consistency.requirements.trajectory.includes('H13') ? '是' : '否'}**；因此 H13 只能保持待独立评估，不能由这 32 条 M 校验补足。\n` +
    (warnings.length ? `\n> ${warnings.join('\n> ')}\n` : '') +
    `\n机器报告：同目录的 \`report.json\`。\n`;
}

export function writeReport(report, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDirectory, 'REPORT.md'), markdownReport(report));
}

function main() {
  const outArgumentIndex = process.argv.indexOf('--out');
  const outputDirectory = path.resolve(
    outArgumentIndex >= 0 ? process.argv[outArgumentIndex + 1] : 'artifacts/harness/trajectory-validation',
  );
  const report = validateTrajectories();
  writeReport(report, outputDirectory);
  console.log(`Trajectory mechanism validation: ${report.status} (${report.mechanism.cases.passed}/${report.mechanism.cases.total} cases); L/U not_run.`);
  console.log(`Report: ${outputDirectory}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
