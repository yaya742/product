import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const dir = path.resolve(process.argv[2] || 'artifacts/harness/offline-evaluation'),
  bundle = '在场-Harness-设计与Codex实施包/zaichang-harness-design';
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
  hash = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : [],
    );
const spec = read(path.join(bundle, 'acceptance/scenarios.json')),
  trace = read(path.join(bundle, 'acceptance/traceability.json'));
const reports = spec.cases.map((c) => {
  const file = path.join(dir, 'scenarios', c.id, 'result.json');
  return {
    id: c.id,
    invariants: c.invariants,
    status: fs.existsSync(file) ? read(file).status : 'not_run',
    path: file,
  };
});
const suites = fs.existsSync(path.join(dir, 'tests.json')) ? read(path.join(dir, 'tests.json')) : null;
const requirements = Object.fromEntries(
  trace.invariant_ids.map((id) => [
    id,
    reports
      .filter((r) => r.invariants.includes(id))
      .map((r) => ({ id: r.id, status: r.status, path: r.path })),
  ]),
);
const groups = trace.groups.map((g) => ({
  ...g,
  results: g.scenario_ids.map((id) => reports.find((r) => r.id === id)),
  realExternalService: 'not_claimed_by_mechanism_test',
}));
const expected = new Map(
  fs
    .readFileSync(path.join(bundle, 'CHECKSUMS.sha256'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([a-f\d]+)\s+(.+)$/);
      return [m[2], m[1]];
    }),
);
const intake = walk(bundle).map((file) => {
  const relative = path.relative(bundle, file).replaceAll('\\', '/'),
    sha256 = hash(file);
  return {
    file: relative,
    sha256,
    manifestStatus: expected.has(relative)
      ? expected.get(relative) === sha256
        ? 'match'
        : 'changed'
      : 'not_listed',
  };
});
const sourceFiles = [
  'package.json',
  'package-lock.json',
  ...['src', 'scripts', 'tests', 'prompts'].flatMap(walk),
]
  .sort()
  .map((file) => ({ file: file.replaceAll('\\', '/'), sha256: hash(file) }));
const result = {
  createdAt: new Date().toISOString(),
  status:
    suites?.status === 'passed' && reports.every((r) => r.status === 'passed') ? 'passed' : 'incomplete',
  evidenceKind: 'deterministic_mechanism_and_real_electron',
  suiteResults: suites?.results,
  source: {
    gitSha: null,
    reason: 'repository has no commit at intake',
    sha256: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
    files: sourceFiles,
  },
  bundleIntake: intake,
  invariants: requirements,
  groups,
  extensions: trace.extension_ids.map((id) => ({
    id,
    groups: groups.filter((g) => g.extension_contracts.includes(id)).map((g) => g.group_id),
  })),
  metrics: {
    scenarioDenominator: reports.length,
    passed: reports.filter((r) => r.status === 'passed').length,
    failed: reports.filter((r) => r.status === 'failed').length,
    notRun: reports.filter((r) => r.status === 'not_run').length,
    realSemanticDenominator: 0,
    realSemanticAccuracy: null,
  },
  external: {
    campus: 'not_run_no_explicit_module_path_or_test_account',
    weather: 'not_run_no_live_smoke',
    position: 'not_run_no_live_permission',
    externalWrites: 'controlled_http_sink_only',
    vector: 'not_run_no_embedding_provider',
  },
  limits: [
    '94 cases verify specified probes; they do not prove every question is solved.',
    'Scripted semantic fixtures are not measured DeepSeek understanding.',
    'Uncommitted source fingerprint, not a fabricated commit SHA.',
  ],
};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'evidence-manifest.json'), JSON.stringify(result, null, 2));
console.log(
  `Evidence: ${reports.filter((r) => r.status === 'passed').length}/${reports.length} scenarios; ${groups.length} groups; ${intake.length} bundle files`,
);
if (result.status !== 'passed') process.exitCode = 1;
