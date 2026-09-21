import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Narrow documentation check: no app launch, database access, network or model calls.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const toPosix = (p) => p.replaceAll('\\', '/');
const sourceDirs = [
  'src',
  'scripts',
  'tests',
  'prompts',
  'examples',
  '.agents/skills',
  'assets',
  'public',
  'runtime',
  '在场-Harness-设计与Codex实施包',
  '在场-Harness-人本协作设计与Codex实施包',
  '在场-Harness-理解与行动-设计实施包',
  '在场-Harness-审查研究与语义重构包',
  '在场-手机驻留式演进-v2-研究与Codex实施包',
];
const excludedDirs = new Set([
  '.git',
  '.test-data',
  '.runtime',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  'artifacts',
  'build',
  'licenses',
  '.agents',
  'output',
  'tmp',
]);
const errors = [];
const walk = (dir) =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = toPosix(path.join(dir, entry.name));
    if (relative.startsWith('build/runtime-staging-') || relative === 'build/hermes-builder.json' || entry.name === '__pycache__') return [];
    if (entry.isSymbolicLink()) {
      errors.push(`不跟随索引中的符号链接：${relative}`);
      return [];
    }
    return entry.isDirectory() ? walk(relative) : [relative];
  });
const rootFiles = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !/^\.env(?:\.|$)/.test(entry.name) && !/\.log$/i.test(entry.name))
  .map((entry) => entry.name);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && !sourceDirs.includes(entry.name) && !excludedDirs.has(entry.name))
    errors.push(`未归类的顶层目录：${entry.name}`);
}
const owned = [...rootFiles, ...sourceDirs.flatMap(walk)].sort();
const skillFiles = ['project-foundations', 'project-navigation', 'product-design'].map(
  (n) => `.agents/skills/${n}/SKILL.md`,
);
const docs = [
  'AGENTS.md',
  'PROJECT-NAVIGATION.md',
  'README.md',
  'DESIGN.md',
  'HARNESS-IMPLEMENTATION.md',
  'THIRD_PARTY_NOTICES.md',
  ...skillFiles,
];
if (fs.existsSync(path.join(root, 'artifacts/documentation/HANDOFF-VALIDATION.md')))
  docs.push('artifacts/documentation/HANDOFF-VALIDATION.md');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const nav = read('PROJECT-NAVIGATION.md');
const links = (text) =>
  [...text.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)].map((m) => m[1] || m[2]);
const localLink = (from, href) => {
  if (/^https?:\/\//i.test(href)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    errors.push(`不支持的本地引用形式：${from}`);
    return null;
  }
  const [file, fragment = ''] = href.split('#');
  const absolute = path.resolve(root, path.dirname(from), decodeURIComponent(file || path.basename(from)));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    errors.push(`引用超出项目，不读取：${from} → ${href}`);
    return null;
  }
  return {
    relative: toPosix(path.relative(root, absolute)),
    absolute,
    fragment: decodeURIComponent(fragment),
  };
};
const anchors = (text) =>
  new Set([
    ...[...text.matchAll(/<a\s+id="([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s+/g, '-'),
    ),
  ]);
let checkedLinks = 0,
  remoteReferences = 0;
for (const file of docs) {
  if (!fs.existsSync(path.join(root, file))) {
    errors.push(`缺少文档：${file}`);
    continue;
  }
  const text = read(file);
  for (const href of links(text)) {
    if (/^https?:\/\//i.test(href)) {
      remoteReferences++;
      continue;
    }
    const target = localLink(file, href);
    if (!target) continue;
    checkedLinks++;
    if (!fs.existsSync(target.absolute)) {
      errors.push(`失效引用：${file} → ${href}`);
      continue;
    }
    if (
      target.fragment &&
      path.extname(target.absolute) === '.md' &&
      !anchors(read(target.relative)).has(target.fragment)
    )
      errors.push(`缺少锚点：${file} → ${href}`);
  }
  // Detect likely credential values, never print the matching value. Semantic privacy review is separate.
  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /Bearer\s+[A-Za-z0-9_.-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/,
  ];
  if (secretPatterns.some((p) => p.test(text))) errors.push(`疑似凭据值，需人工处理：${file}`);
}
const indexBlock = nav.match(/<!-- owned-file-index:start -->([\s\S]*?)<!-- owned-file-index:end -->/);
if (!indexBlock) errors.push('导航没有明确的自有文件索引块。');
const indexed = (indexBlock ? links(indexBlock[1]) : [])
  .map((href) => localLink('PROJECT-NAVIGATION.md', href)?.relative)
  .filter(Boolean);
const coveredByIndex = (file) =>
  indexed.some((entry) => file === entry || file.startsWith(entry.endsWith('/') ? entry : entry + '/'));
const missing = owned.filter((file) => !coveredByIndex(file));
const extra = indexed.filter(
  (file) =>
    !owned.includes(file) && !owned.some((item) => item.startsWith(file.endsWith('/') ? file : file + '/')),
);
const duplicate = indexed.filter((file, i) => indexed.indexOf(file) !== i);
for (const file of missing) errors.push(`自有文件未入索引：${file}`);
for (const file of extra) errors.push(`索引文件不在声明范围：${file}`);
for (const file of duplicate) errors.push(`索引重复：${file}`);

const skillMetadata = [];
for (const file of skillFiles) {
  const text = read(file),
    front = text.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  const name = front?.[1].match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  const expected = path.basename(path.dirname(file));
  if (name !== expected || !front?.[1].match(/^description:\s*\S/m)) errors.push(`基础元信息不完整：${file}`);
  if (/\[TODO:/.test(text)) errors.push(`残留 Skill 模板占位：${file}`);
  skillMetadata.push({ name, path: file, basicFormat: name === expected });
}

// Keep a code baseline separate from document creation; this does not run the code.
const baselineRoots = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.harness-tests.json',
  'vite.config.ts',
  'index.html',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
];
const baselineDirs = [
  'src',
  'scripts',
  'tests',
  'prompts',
  'examples',
  'build',
  'licenses',
  'assets/map-v2',
  'public/map-v2',
  'runtime',
];
const baselineFiles = [...baselineRoots, ...baselineDirs.flatMap(walk)]
  .filter((p) => p !== 'scripts/check-project-docs.mjs')
  .sort();
const digest = createHash('sha256');
for (const file of baselineFiles)
  digest.update(
    file +
      '\0' +
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex') +
      '\n',
  );
const actualDigest = digest.digest('hex');
const expectedDigest = nav.match(/<!-- app-baseline-sha256: ([a-f0-9]{64}) -->/)?.[1];
if (actualDigest !== expectedDigest)
  errors.push('应用代码基准已变化：核实影响并同次更新导航和证据，不能将旧报告当作新版本验证。');
const report = {
  checkedAt: new Date().toISOString(),
  ok: errors.length === 0,
  ownedFiles: owned.length,
  indexedFiles: indexed.length,
  checkedLocalLinks: checkedLinks,
  remoteReferencesNotFetched: remoteReferences,
  skillMetadata,
  applicationBaseline: {
    files: baselineFiles.length,
    sha256: actualDigest,
    unchanged: actualDigest === expectedDigest,
  },
  scope:
    '文档/索引与自有代码字节指纹；不运行App、不读取个人运行库、不联网。基础格式检查不能代替宿主发现或行为交接。',
  notAssessedByScript: ['需求/事实/建议分层', '来源与证据等级', '敏感语义及独立模块授权', '新会话行为交接'],
  errors,
};
if (process.argv.includes('--report')) {
  fs.mkdirSync(path.join(root, 'artifacts/documentation'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'artifacts/documentation/validation.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
