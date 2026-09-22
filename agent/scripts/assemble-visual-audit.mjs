import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const round = process.argv[2] || 'round22';
const read = (file) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : undefined;
const exists = (file) => fs.existsSync(path.join(root, file));
const desktop = read(path.join(root, 'artifacts', 'review', round, 'desktop-report.json'));
const connection = read(path.join(root, 'artifacts', 'review', 'contracts', 'contract-report.json'));
const map = read(path.join(root, 'artifacts', 'map-v2', 'desktop', 'report.json'));
const ui = read(path.join(root, 'artifacts', 'harness', 'frontend-review', 'ui-report.json'));
const page = (id, purpose, screenshots, checks, note = '') => ({
  id,
  purpose,
  screenshots: screenshots.filter(exists),
  missingScreenshots: screenshots.filter((file) => !exists(file)),
  checks,
  status: checks.every(Boolean) && screenshots.every(exists) ? 'reviewed' : 'partial',
  note,
});
const pages = [
  page(
    'home',
    '开始输入并看到一个清楚的第一步',
    [
      `artifacts/review/${round}/01-home.png`,
      `artifacts/review/${round}/01-dark-home.png`,
      `artifacts/review/${round}/01-light-home.png`,
    ],
    [!!desktop, !!desktop?.checks?.some((item) => String(item).includes('内部白色方框'))],
    '焦点提示保留在外层容器。',
  ),
  page(
    'conversation',
    '阅读回复、过程摘要和可编辑建议',
    [
      `artifacts/review/${round}/02-conversation.png`,
      `artifacts/review/${round}/02a-action-draft.png`,
      `artifacts/review/${round}/03-process.png`,
      `artifacts/review/${round}/06-stopped.png`,
    ],
    [!!desktop, !!connection?.checks?.length],
    '建议、保存和停止状态分开。',
  ),
  page(
    'connection',
    '连接模型，遇到错误时仍可恢复',
    [`artifacts/review/${round}/04-connection.png`, 'artifacts/review/contracts/11-connection-error.png'],
    [!!desktop, !!connection && !connection.errors?.length],
    '真实模型请求没有在本次视觉回归中发送。',
  ),
  page(
    'campus',
    '查看校园资料连接和导入入口',
    [`artifacts/review/${round}/04a-campus-connector.png`],
    [!!desktop],
    '来源状态保持可见，但不展示内部端点。',
  ),
  page(
    'memory',
    '只看会影响回答的理解，并按需修改',
    [
      `artifacts/review/${round}/05-memory.png`,
      'artifacts/harness/frontend-review/02-understanding-light.png',
      'artifacts/harness/frontend-review/03-understanding-dark.png',
      'artifacts/harness/frontend-review/04-correction-source.png',
    ],
    [!!desktop, !!ui && ui.status === 'passed'],
    '主视图隐藏内部生命周期词；来源和操作在单条展开后出现。',
  ),
  page(
    'preferences',
    '决定提醒和回复方式',
    [`artifacts/review/${round}/04b-preferences.png`, `artifacts/review/${round}/04c-preferences-dark.png`],
    [!!desktop],
    '本地导出降为次级入口。',
  ),
  page(
    'agenda',
    '查看已确认安排与需要核查的结果',
    [`artifacts/review/${round}/02b-agenda.png`, 'artifacts/harness/frontend-review/05-goal-unknown.png'],
    [!!desktop, !!ui && ui.status === 'passed'],
    '已确认安排先出现，未知回执保留核查路径。',
  ),
  page(
    'history',
    '找回曾经的对话',
    [`artifacts/review/${round}/06-history-empty.png`],
    [!!desktop],
    '搜索框使用外层焦点提示。',
  ),
  page(
    'map',
    '直接浏览地图和选择路线',
    [
      'artifacts/map-v2/desktop/01-overview.png',
      'artifacts/map-v2/desktop/03-wangyue-missing-entry.png',
      'artifacts/map-v2/desktop/08-final.png',
    ],
    [!!map && map.status === 'passed'],
    '地图保持独立二维交互；返回按钮重复悬停和点击已验证。',
  ),
  page(
    'scope-and-recovery',
    '限定本轮资料、临时输入和失败恢复',
    [
      'artifacts/harness/frontend-review/07-scope.png',
      'artifacts/harness/frontend-review/08-scope-small.png',
      'artifacts/harness/frontend-review/10-world-diff.png',
    ],
    [!!ui && ui.status === 'passed', !!connection && !connection.errors?.length],
    '小窗口、临时保留和设想采用均走原入口。',
  ),
];
const report = {
  createdAt: new Date().toISOString(),
  round,
  status: pages.every((item) => item.status === 'reviewed') ? 'reviewed' : 'partial',
  principle: '一个对话框承接主要任务；次要状态在用户需要时出现，视觉层级沿自然阅读顺序展开。',
  pages,
  actualRuns: { desktop, connection, map, ui },
  limitations: [
    '截图和自动化操作证明当前合成状态与指定路径，不替代真实学生研究。',
    '真实 DeepSeek、校园账号、天气网络和设备服务没有在本轮调用。',
    '视觉审核未覆盖所有缩放比例、辅助技术和操作系统主题组合。',
  ],
};
fs.mkdirSync(path.join(root, 'artifacts', 'review', round), { recursive: true });
fs.writeFileSync(
  path.join(root, 'artifacts', 'review', round, 'full-visual-audit.json'),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({ status: report.status, pages: pages.map(({ id, status }) => ({ id, status })) }, null, 2),
);
if (report.status !== 'reviewed') process.exitCode = 1;
