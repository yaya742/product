import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ID = 'plugin:campus.zju-public';
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_SCRIPT = path.join(PLUGIN_ROOT, 'connector', 'scripts', 'zju.py');
const CALENDAR_INDEX_URL = 'https://ugrs.zju.edu.cn/28218/list1.htm';
const NOTICE_INDEX_URL = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_cxMoreLoginNews.html';
const NOTICE_DETAIL_PATH = '/jwglxt/xtgl/xwck_ckLoginNews.html';
const COLLEGE_DIRECTORY_URL = 'https://www.zju.edu.cn/599/listm.htm';
const REQUEST_HOSTS = new Set(['ugrs.zju.edu.cn', 'zdbk.zju.edu.cn', 'www.zju.edu.cn']);
const OFFICIAL_HOST_SUFFIX = '.zju.edu.cn';
const MAX_RESPONSE_CHARS = 300_000;
const MAX_DETAIL_CHARS = 6_000;
const MAX_RECORDS = 20;
const MAX_CONNECTOR_OUTPUT_BYTES = 480_000;
const ACADEMIC_RESOURCES = new Set([
  'schedule',
  'courses',
  'exams',
  'assignments',
  'grades',
  'grade_alerts',
  'gpa',
  'gpa_semesters',
  'gpa_cumulative',
  'practice',
  'sports',
  'projects',
]);
const RESOURCE_NAMES = {
  schedule: 'classes',
  courses: 'courses',
  exams: 'exams',
  assignments: 'todos',
  grades: 'grades',
  grade_alerts: 'grade_alerts',
  gpa: 'gpa_overall',
  gpa_semesters: 'gpa_semesters',
  gpa_cumulative: 'gpa_cumulative',
  practice: 'practice_summary',
  sports: 'practice_summary',
  projects: 'projects',
  learning_courses: 'learning_courses',
  activities: 'activities',
};
const SUPPORTED_PERSONAL_DOMAINS = new Set([
  ...ACADEMIC_RESOURCES,
  'holidays',
  'notices',
  'learning_courses',
  'activities',
  'source_status',
]);
const SENSITIVE_FIELD = /^(?:password|passwd|token|ticket|cookie|authorization|synjones|secret|openid|unionid|accesskey|qrcode|qr_code|barcode|voucher|body_b64|student.?no|student.?id|card.?no|card_number|identity.?no|identity.?id|id.?card|phone|mobile|email|account|sno|xh|yhm|xm|zgh|custid|custmemberid|acctid|cardid|bankacc|cert|schcode|yktschoolcode)$/i;
const SAFE_FIELDS = new Set([
  'uid', 'summary', 'startTime', 'endTime', 'location', 'teacher', 'weekday', 'periods', 'half', 'weekPattern', 'rescheduled', 'time_precision',
  'key', 'name', 'semester_id', 'credit', 'teachers', 'confirmed', 'online', 'id', 'course_code', 'start_date', 'end_date', 'study_completeness',
  'type', 'dateLabel', 'seat', 'deadline', 'status', 'original', 'fivePoint', 'gpaIncluded', 'gpa_exclusion_reason', 'level', 'note',
  'through_semester', 'gpa', 'gpa_credit_denominator', 'eligible_attempts', 'counted_attempts', 'excluded_attempts', 'complete',
  'course_key', 'attempts', 'selected', 'selection_policy', 'categoryId', 'categoryName', 'projectName', 'projectType', 'qualityType', 'score',
  'statusValue', 'statusLabel', 'approved', 'deleted', 'countsTowardTotal', 'activityStart', 'activityEnd', 'updatedAt',
  'dektJf', 'dsktJf', 'dsiktJf', 'dektXf', 'dsktXf', 'dsiktXf', 'dektDj', 'dsktDj', 'dsiktDj', 'dektTg', 'dsktTg', 'dsiktTg', 'myTg', 'lyTg',
  'title', 'publishedAt', 'publisher', 'url', 'summary', 'category', 'detail', 'detailSource', 'pinned', 'source', 'startDate', 'endDate', 'kind',
  'code', 'courseId', 'startTime', 'endTime', 'activityId',
]);

const CATEGORY_HINTS = {
  all: ['通知', '公告', '新闻', '教学', '本科', '学生', '动态'],
  profile: ['学院概况', '学院简介', '学院介绍', '历史沿革', '机构设置', 'about', 'profile'],
  faculty: ['师资', '教师', '教工', '导师', '师资队伍', 'faculty', 'teacher'],
  program: ['培养方案', '培养', '专业', '课程', '教学', '本科', '研究生', 'program'],
  contact: ['联系', '联系方式', '联系我们', '地址', '电话', '邮箱', 'contact'],
  labs: ['实验室', '科研', '研究所', '研究中心', '科研平台', '平台', '实验中心', 'lab'],
};

const COLLEGE_ALIASES = {
  数院: '数学科学学院',
  物院: '物理学院',
  信电学院: '信息与电子工程学院',
  信院: '信息与电子工程学院',
  计院: '计算机科学与技术学院',
  电气学院: '电气工程学院',
  建工: '建筑工程学院',
  化工: '化学工程与生物工程学院',
};

function cleanText(value, limit) {
  let text = String(value ?? '');
  text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtml(text).replace(/\s+/g, ' ').trim();
  return limit ? text.slice(0, limit) : text;
}

function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => codePoint(hex, 16))
    .replace(/&#(\d+);?/g, (_, decimal) => codePoint(decimal, 10))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function codePoint(value, radix) {
  const number = Number.parseInt(value, radix);
  return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
}

function officialUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || ''), baseUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || (!host.endsWith(OFFICIAL_HOST_SUFFIX) && host !== 'zju.edu.cn')) return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function requestableUrl(value) {
  const url = officialUrl(value, value);
  if (!url) return null;
  const parsed = new URL(url);
  return REQUEST_HOSTS.has(parsed.hostname) ? url : null;
}

async function requestText(context, url) {
  const requestUrl = requestableUrl(url);
  if (!requestUrl) throw new Error('目标地址不在插件声明的浙江大学官方出站范围内。');
  const response = await context.request(requestUrl, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.1',
      'User-Agent': 'ZaichangSchoolPlugin/1.0 (+read-only)',
    },
  });
  if (!response || !response.ok) throw new Error(`浙江大学官方页面暂时无法访问（HTTP ${response?.status ?? 'unknown'}）。`);
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error('官方页面返回内容过大，已停止读取。');
  return body;
}

function parseLinks(body, baseUrl) {
  const links = [];
  const pattern = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = pattern.exec(body))) {
    const url = officialUrl(match[2], baseUrl);
    const title = cleanText(match[3], 240);
    if (url && title) links.push({ url, title });
  }
  return links;
}

function uniqueLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function envelope(status, data, reason) {
  return {
    status,
    sourceId: SOURCE_ID,
    ...(data === undefined ? {} : { data }),
    ...(reason ? { reason: cleanText(reason, 500) } : {}),
    simulated: false,
  };
}

function sanitizeScalar(value) {
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function sanitizeValue(value, depth = 0, record = false) {
  if (depth > 8) return '[内容已截断]';
  const scalar = sanitizeScalar(value);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1, record));
  if (!value || typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key) || /身份证|学号|手机号|邮箱|密码|令牌|cookie/i.test(key)) continue;
    if (record && !SAFE_FIELDS.has(key)) continue;
    const cleaned = sanitizeValue(item, depth + 1, false);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function sanitizeConnectorResult(result) {
  const cleaned = sanitizeValue(result) || {};
  if (Array.isArray(result?.records)) cleaned.records = result.records.map((item) => sanitizeValue(item, 0, true));
  if (Array.isArray(result?.items)) cleaned.items = result.items.map((item) => sanitizeValue(item, 0, true));
  return cleaned;
}

function runProcess(file, prefixArgs, args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefixArgs, ...args], {
      cwd: path.dirname(path.dirname(CONNECTOR_SCRIPT)),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let tooLarge = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      child.kill();
      finish(new Error('校园资料读取已取消。'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('校园资料读取超时。'));
    }, timeoutMs);
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_CONNECTOR_OUTPUT_BYTES && !tooLarge) {
        tooLarge = true;
        child.kill();
        finish(new Error('校园资料连接器返回内容过大。'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8');
    });
    child.on('close', () => {
      if (tooLarge || settled) return;
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) {
        finish(new Error(stderr.trim() || '校园资料连接器没有返回结果。'));
        return;
      }
      try {
        finish(undefined, JSON.parse(line));
      } catch {
        finish(new Error('校园资料连接器返回了无法识别的数据。'));
      }
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runConnector(args, signal, timeoutMs = 85_000) {
  if (!existsSync(CONNECTOR_SCRIPT)) throw new Error('插件内没有找到校园资料连接器。');
  const candidates = process.platform === 'win32'
    ? [['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];
  let lastError;
  for (const [file, prefixArgs] of candidates) {
    try {
      return await runProcess(file, prefixArgs, [CONNECTOR_SCRIPT, ...args], signal, timeoutMs);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('当前设备没有可用的 Python 运行时。');
}

function connectorStatus(result) {
  if (result?.status === 'ok') return 'fresh';
  if (result?.status === 'partial') return 'partial';
  if (result?.status === 'error') return 'failed';
  return 'unknown';
}

function connectorReason(result) {
  return result?.error?.message || result?.error?.code || result?.reason || '校园资料读取未完成。';
}

function connectorEnvelope(result, data) {
  const status = connectorStatus(result);
  return envelope(status, data === undefined ? sanitizeConnectorResult(result) : sanitizeConnectorResult(data), status === 'failed' ? connectorReason(result) : undefined);
}

function academicYearForArgs(args) {
  return validAcademicYear(args?.academicYear) || currentAcademicYear();
}

function termForArgs(args) {
  if (args?.term === '1' || args?.term === '2') return args.term;
  const month = new Date().getMonth();
  return month >= 7 || month === 0 ? '1' : '2';
}

async function connectorStatusRead(context) {
  try {
    const result = await runConnector(['status'], context?.signal, 15_000);
    return connectorEnvelope(result, {
      available: true,
      credentialsConfigured: Boolean(result.credentialsConfigured),
      authStatus: result.credentialsConfigured ? 'credentials_saved' : 'needs_login',
      supportedDomains: result.supportedDomains,
      cache: Array.isArray(result.cache) ? result.cache : [],
      note: result.credentialsConfigured
        ? '本机已保存校园连接器凭据；账号本身不会返回给插件结果。'
        : '本机尚未保存校园账号，公开校历和通知仍可读取。',
    });
  } catch (error) {
    return envelope('failed', undefined, error instanceof Error ? error.message : '校园连接器状态读取失败。');
  }
}

async function resolveAcademicBundle(args, context) {
  const academicYear = academicYearForArgs(args);
  const term = termForArgs(args);
  if (!args?.refresh) {
    const history = await runConnector(['history', '--limit', '100'], context?.signal, 15_000);
    const expected = `${academicYear}-${term}`;
    const item = Array.isArray(history?.items)
      ? history.items.find((entry) => entry?.kind === 'academic' && String(entry.semester_id || '') === expected)
      : undefined;
    if (item?.bundle_id) return { bundleId: String(item.bundle_id), academicYear, term, cached: true };
  }
  const synced = await runConnector([
    'academic', '--year', academicYear, '--term', term,
  ], context?.signal, 85_000);
  if (!['ok', 'partial'].includes(String(synced?.status)) || !synced?.bundle_id) {
    return { error: synced, academicYear, term, cached: false };
  }
  return { bundleId: String(synced.bundle_id), academicYear, term, cached: false, sync: synced };
}

async function resolveLearningBundle(args, context) {
  const courseId = String(args?.courseId || '').trim();
  const scope = courseId ? `course:${courseId}` : 'all';
  if (!args?.refresh) {
    const history = await runConnector(['history', '--limit', '100'], context?.signal, 15_000);
    const item = Array.isArray(history?.items)
      ? history.items.find((entry) => entry?.kind === 'learning' && String(entry.scope || 'all') === scope)
      : undefined;
    if (item?.bundle_id) return { bundleId: String(item.bundle_id), cached: true, scope };
  }
  const syncArgs = ['learning'];
  addOption(args, syncArgs, '--course-id', courseId);
  if (args?.refreshActivities || courseId) syncArgs.push('--activities');
  if (args?.refresh) syncArgs.push('--refresh');
  const synced = await runConnector(syncArgs, context?.signal, 85_000);
  if (!['ok', 'partial'].includes(String(synced?.status)) || !synced?.bundle_id) {
    return { error: synced, cached: false, scope };
  }
  return { bundleId: String(synced.bundle_id), cached: false, scope, sync: synced };
}

function addOption(args, output, name, value) {
  if (value === undefined || value === null || value === '') return;
  output.push(name, String(value));
}

async function readConnectorDomain(args, context) {
  const domain = String(args?.domain || '');
  if (!SUPPORTED_PERSONAL_DOMAINS.has(domain)) return envelope('unsupported', undefined, `校园资料类别 ${domain} 尚未接入。`);
  if (domain === 'source_status') return connectorStatusRead(context);
  if (domain === 'holidays') {
    try {
      const year = academicYearForArgs(args);
      const calendar = await runConnector(['calendar', '--year', year, ...(args.refresh ? ['--refresh'] : [])], context?.signal, 45_000);
      if (!calendar?.bundle_id) return connectorEnvelope(calendar);
      const quick = await runConnector(['quick', 'holidays', '--bundle', String(calendar.bundle_id), '--limit', String(Math.min(50, args.limit || 20)), '--offset', String(args.offset || 0)], context?.signal, 20_000);
      return connectorEnvelope(quick, { ...quick, calendar_status: calendar.status, academic_year: year });
    } catch (error) {
      return envelope('failed', undefined, error instanceof Error ? error.message : '校历读取失败。');
    }
  }
  if (domain === 'notices') {
    try {
      const noticeArgs = ['notices', '--page', String(Math.max(1, Math.min(50, args.page || 1))), ...(args.detail ? ['--detail'] : [])];
      addOption(args, noticeArgs, '--query', args.query);
      addOption(args, noticeArgs, '--college', args.college);
      addOption(args, noticeArgs, '--category', args.college ? (args.category || 'all') : 'all');
      if (args.refresh) noticeArgs.push('--refresh');
      const notices = await runConnector(noticeArgs, context?.signal, 85_000);
      if (!notices?.bundle_id) return connectorEnvelope(notices);
      const quickArgs = ['quick', 'notices', '--bundle', String(notices.bundle_id), '--limit', String(Math.min(50, args.limit || 20)), '--offset', String(args.offset || 0)];
      addOption(args, quickArgs, '--query', args.query);
      const quick = await runConnector(quickArgs, context?.signal, 25_000);
      return connectorEnvelope(quick, { ...quick, notices_status: notices.status, notices_source: notices.source });
    } catch (error) {
      return envelope('failed', undefined, error instanceof Error ? error.message : '校园通知读取失败。');
    }
  }
  if (domain === 'learning_courses' || domain === 'activities') {
    try {
      if (domain === 'activities' && !String(args?.courseId || '').trim()) {
        return envelope('failed', undefined, '查询学在浙大课程活动时请提供 courseId，避免一次读取过多课程。');
      }
      const bundle = await resolveLearningBundle(args, context);
      if (bundle.error) return connectorEnvelope(bundle.error, { domain, scope: bundle.scope });
      const resource = RESOURCE_NAMES[domain];
      const quickArgs = ['quick', resource, '--bundle', bundle.bundleId, '--limit', String(Math.min(50, args.limit || 20)), '--offset', String(Math.max(0, args.offset || 0))];
      addOption(args, quickArgs, '--query', args.query);
      addOption(args, quickArgs, '--course-id', args.courseId);
      if (Array.isArray(args.fields) && args.fields.length) addOption({}, quickArgs, '--fields', args.fields.join(','));
      const quick = await runConnector(quickArgs, context?.signal, 20_000);
      return connectorEnvelope(quick, { ...quick, domain, scope: bundle.scope, cached: bundle.cached });
    } catch (error) {
      return envelope('failed', undefined, error instanceof Error ? error.message : '学在浙大课程读取失败。');
    }
  }
  try {
    const bundle = await resolveAcademicBundle(args, context);
    if (bundle.error) return connectorEnvelope(bundle.error, { domain, academic_year: bundle.academicYear, term: bundle.term });
    const resource = RESOURCE_NAMES[domain];
    const quickArgs = ['quick', resource, '--bundle', bundle.bundleId, '--limit', String(Math.min(50, args.limit || 8)), '--offset', String(Math.max(0, args.offset || 0))];
    addOption(args, quickArgs, '--query', args.query);
    if (Array.isArray(args.fields) && args.fields.length) addOption({ }, quickArgs, '--fields', args.fields.join(','));
    const quick = await runConnector(quickArgs, context?.signal, args.refresh ? 45_000 : 20_000);
    return connectorEnvelope(quick, { ...quick, domain, academic_year: bundle.academicYear, term: bundle.term, cached: bundle.cached });
  } catch (error) {
    return envelope('failed', undefined, error instanceof Error ? error.message : '个人校园资料读取失败。');
  }
}

async function readOverview(args, context) {
  const sections = {};
  const issues = [];
  const academicDomains = ['schedule', 'courses', 'exams', 'assignments', 'grades', 'grade_alerts', 'gpa', 'gpa_semesters', 'gpa_cumulative', 'practice', 'sports', 'projects'];
  for (const domain of academicDomains) {
    const result = await readConnectorDomain({ ...args, domain, limit: 6 }, context);
    sections[domain] = result.data || { status: result.status, reason: result.reason };
    if (result.status !== 'fresh') issues.push({ domain, status: result.status, reason: result.reason });
  }
  for (const domain of ['holidays', 'notices']) {
    const result = await readConnectorDomain({ ...args, domain, limit: 6 }, context);
    sections[domain] = result.data || { status: result.status, reason: result.reason };
    if (result.status !== 'fresh') issues.push({ domain, status: result.status, reason: result.reason });
  }
  const learning = await readConnectorDomain({ ...args, domain: 'learning_courses', limit: 8 }, context);
  sections.learning_courses = learning.data || { status: learning.status, reason: learning.reason };
  if (learning.status !== 'fresh') issues.push({ domain: 'learning_courses', status: learning.status, reason: learning.reason });
  const account = await connectorStatusRead(context);
  sections.source_status = account.data || { status: account.status, reason: account.reason };
  if (account.status !== 'fresh') issues.push({ domain: 'source_status', status: account.status, reason: account.reason });
  const status = issues.length === 0 ? 'fresh' : Object.values(sections).some((section) => section?.records?.length || section?.notices?.length || section?.events?.length) ? 'partial' : 'failed';
  return envelope(status, {
    academicYear: academicYearForArgs(args),
    term: termForArgs(args),
    sections,
    issues,
    note: '总览只返回有界摘要；需要某一类别的更多记录时，请调用 school.read 并指定 limit/offset。',
  }, status === 'failed' ? '校园总览没有读到可用资料。' : undefined);
}

function currentAcademicYear(now = new Date()) {
  const year = now.getFullYear();
  return `${now.getMonth() + 1 >= 8 ? year : year - 1}-${now.getMonth() + 1 >= 8 ? year + 1 : year}`;
}

function validAcademicYear(value) {
  const year = String(value || currentAcademicYear());
  return /^20\d{2}-20\d{2}$/.test(year) && Number(year.slice(5)) === Number(year.slice(0, 4)) + 1 ? year : null;
}

function textTitle(body) {
  const match = body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return cleanText(match?.[1] || '浙江大学校历', 240);
}

function findPdfUrl(body, pageUrl) {
  const candidates = [];
  const pdfsrc = body.match(/pdfsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (pdfsrc) candidates.push(pdfsrc);
  for (const link of parseLinks(body, pageUrl)) if (/\.pdf(?:$|[?#])/i.test(link.url)) candidates.push(link.url);
  return candidates.map((candidate) => officialUrl(candidate, pageUrl)).find(Boolean) || null;
}

function academicDate(academicYear, month, day) {
  const startYear = Number(academicYear.slice(0, 4));
  const year = month <= 7 ? startYear + 1 : startYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function explicitHolidayEvents(body, academicYear, sourceUrl) {
  const text = cleanText(body);
  const events = [];
  for (const title of ['中秋节', '国庆节']) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${escaped}.{0,100}?(\\d{1,2})月(\\d{1,2})日.{0,50}?(?:至|到|—|-)\\s*(?:(\\d{1,2})月)?(\\d{1,2})日`, 'i'));
    if (!match) continue;
    const startMonth = Number(match[1]);
    const startDate = academicDate(academicYear, startMonth, Number(match[2]));
    const endMonth = Number(match[3] || startMonth);
    const endDate = academicDate(academicYear, endMonth, Number(match[4]));
    if (!startDate || !endDate) continue;
    events.push({
      id: title === '中秋节' ? 'mid-autumn-festival' : 'national-day',
      title,
      startDate,
      endDate,
      kind: 'holiday',
      note: '仅采用官方教学安排页面中明确写出的日期。',
      source: sourceUrl,
    });
  }
  return events;
}

async function readCalendar(args, context) {
  const academicYear = validAcademicYear(args?.academicYear);
  if (!academicYear) return envelope('failed', undefined, '学年格式应为 2026-2027。');
  try {
    const indexBody = await requestText(context, CALENDAR_INDEX_URL);
    const indexLinks = parseLinks(indexBody, CALENDAR_INDEX_URL);
    const page = indexLinks.find(({ title, url }) => {
      const normalized = title.replace(/[—–]/g, '-');
      return normalized.includes(`${academicYear}学年校历`) || url.includes(academicYear);
    });
    if (!page) {
      return envelope('partial', {
        academicYear,
        events: [],
        holidays: [],
        sources: [{ title: '浙江大学校历列表', pageUrl: CALENDAR_INDEX_URL, kind: 'official_calendar_index' }],
        coverage: { complete: false, scope: academicYear, note: '官方列表暂未找到请求学年的校历页面。' },
      });
    }
    const pageBody = await requestText(context, page.url);
    const events = explicitHolidayEvents(pageBody, academicYear, page.url);
    const pdfUrl = findPdfUrl(pageBody, page.url);
    return envelope('fresh', {
      academicYear,
      title: textTitle(pageBody),
      events,
      holidays: events,
      sources: [
        { title: `浙江大学${academicYear}学年校历`, pageUrl: page.url, ...(pdfUrl ? { pdfUrl } : {}), kind: 'official_calendar' },
      ],
      coverage: {
        complete: true,
        scope: academicYear,
        note: '校历原件保留官方页面和 PDF 链接；图片型校历未进行 OCR 推断。',
      },
    });
  } catch (error) {
    return envelope('failed', undefined, error instanceof Error ? error.message : '官方校历读取失败。');
  }
}

function noticeId(value, index) {
  const raw = cleanText(value, 100).replace(/[^\w-]/g, '').toLowerCase();
  return `zju-notice-${raw || index + 1}`;
}

function noticeDetailUrl(value, id) {
  return officialUrl(value || `${NOTICE_DETAIL_PATH}?xwbh=${encodeURIComponent(id)}`, NOTICE_INDEX_URL);
}

function normalizeNotice(item, index, sourceUrl) {
  if (!item || typeof item !== 'object') return null;
  const id = cleanText(item.xwbh ?? item.id ?? item.noticeId, 100);
  const title = cleanText(item.xwbt ?? item.title ?? item.name, 240);
  if (!title) return null;
  const url = noticeDetailUrl(item.fbdz ?? item.url, id);
  if (!url || new URL(url).hostname !== 'zdbk.zju.edu.cn') return null;
  return {
    id: noticeId(id || title, index),
    title,
    publisher: cleanText(item.xwfbr ?? item.publisher, 120) || '浙江大学本科生院',
    publishedAt: cleanText(item.fbsj ?? item.publishedAt ?? item.date, 40),
    url,
    summary: cleanText(item.fbnr ?? item.summary, 360),
    pinned: String(item.sfzd ?? item.pinned ?? '') === '1' || item.pinned === true,
    source: sourceUrl,
  };
}

function jsonNoticeItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.records)) return payload.records;
  if (payload.data && typeof payload.data === 'object') return jsonNoticeItems(payload.data);
  return [];
}

function parseNoticeBody(body, pageUrl, query) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  let notices = [];
  let totalAvailable;
  if (payload) {
    const items = jsonNoticeItems(payload);
    notices = items.slice(0, MAX_RECORDS).map((item, index) => normalizeNotice(item, index, pageUrl)).filter(Boolean);
    const total = payload.totalCount ?? payload.total ?? payload.recordsTotal;
    totalAvailable = Number.isFinite(Number(total)) ? Number(total) : notices.length;
  } else {
    notices = uniqueLinks(parseLinks(body, pageUrl))
      .filter(({ title }) => !['首页', '更多', '下一页', '上一页'].includes(title))
      .slice(0, MAX_RECORDS)
      .map(({ title, url }, index) => normalizeNotice({ title, url }, index, pageUrl))
      .filter(Boolean);
    totalAvailable = notices.length;
  }
  const needle = cleanText(query, 100).toLocaleLowerCase();
  if (needle) notices = notices.filter((notice) => `${notice.title} ${notice.publisher} ${notice.summary}`.toLocaleLowerCase().includes(needle));
  return { notices, totalAvailable };
}

function noticeDetail(body, noticeUrl) {
  const title = cleanText(body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i)?.[1] || '', 240);
  const container = body.match(/<[^>]*class\s*=\s*["'][^"']*news_con[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1];
  const detail = cleanText(container || body, MAX_DETAIL_CHARS);
  return {
    ...(title ? { title } : {}),
    ...(detail ? { detail, detailSource: noticeUrl } : {}),
  };
}

async function readNotices(args, context) {
  const query = cleanText(args?.query, 100);
  const page = Math.max(1, Math.min(50, Number.isInteger(args?.page) ? args.page : 1));
  const detail = args?.detail === true;
  try {
    const url = new URL(NOTICE_INDEX_URL);
    url.searchParams.set('doType', 'query');
    url.searchParams.set('queryModel.currentPage', String(page));
    url.searchParams.set('queryModel.showCount', '10');
    url.searchParams.set('queryModel.sortName', 'sfzd desc,fbsj');
    url.searchParams.set('queryModel.sortOrder', 'desc');
    url.searchParams.set('xwbt', query);
    const body = await requestText(context, url.href);
    const parsed = parseNoticeBody(body, NOTICE_INDEX_URL, query);
    if (detail) {
      for (const notice of parsed.notices.slice(0, 3)) {
        try {
          const detailBody = await requestText(context, notice.url);
          Object.assign(notice, noticeDetail(detailBody, notice.url));
        } catch {
          // The list remains useful when a detail page is temporarily unavailable.
        }
      }
    }
    return envelope(parsed.notices.length ? 'fresh' : 'partial', {
      notices: parsed.notices,
      sources: [{ title: '浙江大学本科教学管理信息服务平台通知公告', url: NOTICE_INDEX_URL, kind: 'official_notice_index' }],
      coverage: {
        complete: parsed.notices.length > 0,
        scope: '官方通知公告列表搜索结果',
        page,
        query,
        totalAvailable: parsed.totalAvailable,
        detailsIncluded: detail,
      },
    });
  } catch (error) {
    return envelope('failed', undefined, error instanceof Error ? error.message : '官方通知读取失败。');
  }
}

function normalizeCollege(value) {
  const raw = cleanText(value, 80);
  return COLLEGE_ALIASES[raw] || raw;
}

function collegeKey(value) {
  return normalizeCollege(value).replace(/浙江大学|官方网站|官网|学院|科学|学校|大学|系/g, '').toLocaleLowerCase();
}

function categoryFor(title, category) {
  if (category !== 'all') return (CATEGORY_HINTS[category] || []).some((hint) => `${title}`.toLocaleLowerCase().includes(hint.toLocaleLowerCase())) ? category : 'general';
  for (const [name, hints] of Object.entries(CATEGORY_HINTS)) {
    if (name === 'all') continue;
    if (hints.some((hint) => title.toLocaleLowerCase().includes(hint.toLocaleLowerCase()))) return name;
  }
  return 'general';
}

async function readCollegeDirectory(args, context) {
  const requested = normalizeCollege(args?.college);
  if (!requested) return envelope('failed', undefined, '请提供要查询的学院名称。');
  try {
    const body = await requestText(context, COLLEGE_DIRECTORY_URL);
    const needle = collegeKey(requested);
    const candidates = uniqueLinks(parseLinks(body, COLLEGE_DIRECTORY_URL)).filter(({ title }) => {
      const candidate = collegeKey(title);
      return candidate && needle && (candidate.includes(needle) || needle.includes(candidate));
    });
    if (!candidates.length) {
      return envelope('partial', {
        college: requested,
        records: [],
        sources: [{ title: '浙江大学官方学院目录', url: COLLEGE_DIRECTORY_URL, kind: 'official_college_directory' }],
        coverage: { complete: false, scope: requested, note: '官方学院目录中暂未找到匹配的学院网站。' },
      });
    }
    const selected = candidates[0];
    const host = new URL(selected.url).hostname;
    const record = {
      id: `zju-college-${Buffer.from(selected.url).toString('hex').slice(0, 20)}`,
      title: selected.title,
      college: selected.title,
      url: selected.url,
      category: 'directory',
      summary: '浙江大学官方学院目录中的官网入口。',
      source: COLLEGE_DIRECTORY_URL,
      ...(REQUEST_HOSTS.has(host) ? {} : { detailUnavailable: '学院官网域名不在本插件的出站白名单内，仅返回官方入口链接。' }),
    };
    return envelope('fresh', {
      college: selected.title,
      collegeHome: selected.url,
      records: [record],
      sources: [{ title: '浙江大学官方学院目录', url: COLLEGE_DIRECTORY_URL, kind: 'official_college_directory' }],
      coverage: {
        complete: true,
        scope: selected.title,
        note: '插件只返回官方目录索引；不会读取学院账号、个人资料或未声明的外部站点。',
      },
    });
  } catch (error) {
    return envelope('failed', undefined, error instanceof Error ? error.message : '官方学院目录读取失败。');
  }
}

const plugin = {
  async invoke({ name, args, context }) {
    if (name === 'school.calendar.read') return readCalendar(args, context);
    if (name === 'school.notices.search') return readNotices(args, context);
    if (name === 'school.college.directory') return readCollegeDirectory(args, context);
    if (name === 'school.account.status') return connectorStatusRead(context);
    if (name === 'school.read') return readConnectorDomain(args, context);
    if (name === 'school.overview') return readOverview(args, context);
    return envelope('unsupported', undefined, `插件不支持能力 ${name}。`);
  },
};

export { academicDate, cleanText, parseNoticeBody, parseLinks, validAcademicYear };
export default plugin;
