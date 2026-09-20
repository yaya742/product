import { Capacitor, CapacitorCookies, CapacitorHttp } from '@capacitor/core';
import type {
  CampusCourse,
  CampusExam,
  CampusGrade,
  CampusTodo,
  MobileCampusData,
} from './types';

const LOGIN_URL = 'https://zjuam.zju.edu.cn/cas/login';
const PUBLIC_KEY_URL = 'https://zjuam.zju.edu.cn/cas/v2/getPubKey';
const ZDBK_HOME = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html';
const ZDBK_SERVICE = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html';
const SCHEDULE_URL = 'https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html';
const EXAMS_URL = 'https://zdbk.zju.edu.cn/jwglxt/xskscx/kscx_cxXsgrksIndex.html?doType=query&queryModel.showCount=5000';
const GRADES_URL = 'https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000';
const COURSES_HOME = 'https://courses.zju.edu.cn/user/index';
const TODOS_URL = 'https://courses.zju.edu.cn/api/todos';

export type CampusErrorCode = 'native_required' | 'credentials' | 'network' | 'authentication' | 'captcha' | 'response';

export class CampusError extends Error {
  constructor(message: string, readonly code: CampusErrorCode = 'response') {
    super(message);
    this.name = 'CampusError';
  }
}

interface HttpResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
  url: string;
}

function assertNative() {
  if (!Capacitor.isNativePlatform()) {
    throw new CampusError('请安装 APK 后读取校园信息。浏览器预览不具备校方登录所需的原生网络能力。', 'native_required');
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

function responseText(result: HttpResult): string {
  return asText(result.data);
}

async function request(options: {
  url: string;
  method?: 'GET' | 'POST';
  data?: Record<string, string>;
  headers?: Record<string, string>;
  responseType?: 'text' | 'json';
  disableRedirects?: boolean;
}): Promise<HttpResult> {
  assertNative();
  try {
    const result = await CapacitorHttp.request({
      url: options.url,
      method: options.method || 'GET',
      data: options.data,
      headers: options.headers,
      responseType: options.responseType || 'text',
      disableRedirects: options.disableRedirects,
      connectTimeout: 20_000,
      readTimeout: 30_000,
    });
    return result;
  } catch (error) {
    throw new CampusError(error instanceof Error ? error.message : '无法连接校方服务，请检查网络。', 'network');
  }
}

function field(value: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return fallback;
}

function listFromPayload(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function parseExecution(body: string): string {
  const matches = [
    /name=["']execution["'][^>]*value=["']([^"']+)/i,
    /value=["']([^"']+)["'][^>]*name=["']execution["']/i,
  ];
  for (const pattern of matches) {
    const match = body.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  throw new CampusError('统一身份认证页面缺少登录会话信息，请稍后重试。', 'authentication');
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/gi, "'").replace(/&#39;/g, "'");
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let current = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    power >>= 1n;
  }
  return result;
}

function encryptPassword(password: string, modulusHex: string, exponentHex: string): string {
  const bytes = new TextEncoder().encode(password);
  if (!bytes.length) throw new CampusError('校园密码不能为空。', 'credentials');
  const rawHex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const encrypted = modPow(BigInt(`0x${rawHex}`), BigInt(`0x${exponentHex}`), BigInt(`0x${modulusHex}`));
  const width = Math.max(128, Math.ceil(modulusHex.length / 2) * 2);
  return encrypted.toString(16).padStart(width, '0');
}

async function clearCampusCookies() {
  await Promise.all([
    CapacitorCookies.clearCookies({ url: 'https://zjuam.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://zdbk.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://courses.zju.edu.cn' }),
  ]);
}

async function authenticate(studentId: string, password: string) {
  const loginPage = await request({ url: LOGIN_URL, responseType: 'text' });
  if (loginPage.status !== 200) throw new CampusError(`无法打开统一身份认证（HTTP ${loginPage.status}）。`, 'authentication');
  const execution = parseExecution(responseText(loginPage));
  const publicKey = await request({ url: PUBLIC_KEY_URL, responseType: 'json' });
  const key = publicKey.data && typeof publicKey.data === 'object' ? publicKey.data as Record<string, unknown> : {};
  const modulus = field(key, ['modulus']);
  const exponent = field(key, ['exponent']);
  if (!modulus || !exponent) throw new CampusError('统一身份认证没有返回可用公钥。', 'authentication');
  const loginResult = await request({
    url: LOGIN_URL,
    method: 'POST',
    data: {
      username: studentId,
      password: encryptPassword(password, modulus, exponent),
      execution,
      _eventId: 'submit',
      rememberMe: 'true',
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    responseType: 'text',
    disableRedirects: true,
  });
  const body = responseText(loginResult);
  if (body.includes('验证码') || body.toLowerCase().includes('captcha')) throw new CampusError('统一身份认证要求验证码，手机端暂不绕过安全校验。', 'captcha');
  if (loginResult.status >= 400 || body.includes('name="execution"')) throw new CampusError('校园登录未完成，请检查学号、密码或账号状态。', 'authentication');
}

async function loginZdbk() {
  const serviceLogin = `${LOGIN_URL}?service=${encodeURIComponent(ZDBK_SERVICE)}`;
  const result = await request({ url: serviceLogin, responseType: 'text' });
  if (result.status < 200 || result.status >= 400) throw new CampusError(`教务网登录失败（HTTP ${result.status}）。`, 'authentication');
  const body = responseText(result);
  if (body.includes('统一身份认证') && body.includes('execution')) throw new CampusError('教务网登录态未建立，请重新验证账号。', 'authentication');
}

function ajaxHeaders() {
  return {
    Referer: ZDBK_HOME,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
  };
}

function academicTerm(): { year: string; term: string } {
  const now = new Date();
  const month = now.getMonth() + 1;
  return { year: String(month >= 8 ? now.getFullYear() : now.getFullYear() - 1), term: month >= 2 && month < 8 ? '2' : '1' };
}

function numberValue(value: string): number | undefined {
  const numeric = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(numeric) ? numeric : undefined;
}

function scheduleParts(value: string): string[] {
  return value
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/zwf.*$/i, '')
    .split(/\r?\n/)
    .map((part) => part.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
}

function normalizeCourse(item: Record<string, unknown>, index: number): CampusCourse {
  const parts = scheduleParts(field(item, ['kcb']));
  const day = field(item, ['xqj', 'week_day']);
  const firstPeriod = numberValue(field(item, ['djj', 'start_period']));
  const duration = numberValue(field(item, ['skcd', 'period_count']));
  const lastPeriod = firstPeriod && duration ? firstPeriod + duration - 1 : undefined;
  const periodLabel = firstPeriod && lastPeriod
    ? `第${firstPeriod}-${lastPeriod}节`
    : field(item, ['jcs', 'period']);
  const weeks = field(item, ['zcd', 'weeks']) || [field(item, ['xxq']), field(item, ['dsz']) === '0' ? '单周' : field(item, ['dsz']) === '1' ? '双周' : ''].filter(Boolean).join(' · ');
  return {
    id: field(item, ['jxb_id', 'kch_id', 'kch'], `course-${index}`),
    name: field(item, ['kcmc', 'course_name'], parts[0] || '未命名课程'),
    teacher: field(item, ['jsxx', 'jsxm', 'teacher'], parts[2] || '教师未提供'),
    location: field(item, ['cdmc', 'jxcdmc', 'classroom'], parts[3] || '地点未提供'),
    time: [day ? `周${day}` : '', periodLabel].filter(Boolean).join(' · ') || '时间未提供',
    weeks: weeks || '周次未提供',
  };
}

function examStatus(value: string): CampusExam['status'] {
  const match = value.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!match) return 'unknown';
  const timestamp = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59).getTime();
  return timestamp < Date.now() ? 'finished' : 'upcoming';
}

function normalizeExams(item: Record<string, unknown>, index: number): CampusExam[] {
  const name = field(item, ['kcmc', 'course_name'], '未命名考试');
  const courseId = field(item, ['xkkh', 'kch', 'exam_id'], `exam-${index}`);
  const candidates = [
    { type: '期中', time: field(item, ['qzkssj']), location: field(item, ['qzjsmc']), seat: field(item, ['qzzwxh']) },
    { type: '期末', time: field(item, ['kssj', 'exam_time']), location: field(item, ['jsmc', 'ksdd', 'cdmc', 'exam_room']), seat: field(item, ['zwxh', 'zwh', 'seat']) },
  ];
  return candidates.flatMap((candidate) => candidate.time ? [{
    id: `${courseId}-${candidate.type}`,
    name,
    time: candidate.time,
    location: candidate.location || '地点未提供',
    seat: candidate.seat,
    type: candidate.type,
    status: examStatus(candidate.time),
  }] : []);
}

function normalizeGrade(item: Record<string, unknown>, index: number): CampusGrade {
  return {
    id: field(item, ['kch', 'kcmc', 'grade_id'], `grade-${index}`),
    name: field(item, ['kcmc', 'course_name'], '未命名课程'),
    score: field(item, ['cj', 'score'], '—'),
    credit: field(item, ['xf', 'credit'], '—'),
    point: field(item, ['jd', 'point'], '—'),
  };
}

async function readSchedule(year: string, term: string): Promise<CampusCourse[]> {
  await loginZdbk();
  const seasons = term === '1' ? ['1|秋', '1|冬'] : ['2|春', '2|夏'];
  const result: CampusCourse[] = [];
  for (const season of seasons) {
    const response = await request({
      url: SCHEDULE_URL,
      method: 'POST',
      data: { xnm: year, xqm: season, captcha_value: '' },
      headers: ajaxHeaders(),
      responseType: 'json',
    });
    const body = responseText(response);
    if (body.includes('统一身份认证') || response.status === 401 || response.status === 403) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
    if (body.includes('captcha_error')) throw new CampusError('教务网要求验证码，手机端暂不绕过安全校验。', 'captcha');
    if (body.trim() === 'null' || response.data === null) continue;
    const items = listFromPayload(response.data, 'kbList').filter((item) => field(item, ['sfyjskc']) !== '1');
    if (!items.length && response.data && typeof response.data === 'object' && !('kbList' in (response.data as Record<string, unknown>))) throw new CampusError('教务网课表返回了无法识别的数据。', 'response');
    result.push(...items.map(normalizeCourse));
  }
  return result;
}

async function readExams(): Promise<CampusExam[]> {
  await loginZdbk();
  const response = await request({ url: EXAMS_URL, method: 'POST', data: {}, headers: ajaxHeaders(), responseType: 'json' });
  const body = responseText(response);
  if (body.includes('统一身份认证') || response.status === 401 || response.status === 403) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
  return listFromPayload(response.data, 'items').flatMap(normalizeExams);
}

async function readGrades(): Promise<CampusGrade[]> {
  await loginZdbk();
  const response = await request({ url: GRADES_URL, method: 'POST', data: {}, headers: ajaxHeaders(), responseType: 'json' });
  const body = responseText(response);
  if (body.includes('统一身份认证') || response.status === 401 || response.status === 403) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
  return listFromPayload(response.data, 'items').map(normalizeGrade);
}

function metaRefresh(body: string, source: string): string | undefined {
  const match = body.match(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'; >]+)/i)
    || body.match(/<meta\b[^>]*content=["'][^"']*url=([^"'; >]+)[^"']*[^>]*http-equiv=["']?refresh/i);
  if (!match?.[1]) return undefined;
  try { return new URL(decodeHtml(match[1]), source).toString(); } catch { return undefined; }
}

async function readTodos(): Promise<CampusTodo[]> {
  let current = COURSES_HOME;
  for (let index = 0; index < 5; index += 1) {
    const response = await request({ url: current, responseType: 'text' });
    if (response.status < 200 || response.status >= 300) throw new CampusError(`学在浙大登录失败（HTTP ${response.status}）。`, 'authentication');
    const target = metaRefresh(responseText(response), current);
    if (!target) break;
    current = target;
  }
  const response = await request({ url: TODOS_URL, responseType: 'json' });
  const todos = listFromPayload(response.data, 'todo_list');
  return todos.flatMap((item) => {
    if (!item.id || !(item.is_student === true || item.is_student === 1 || item.is_student === '1')) return [];
    return [{
      id: String(item.id),
      name: field(item, ['title'], '未命名作业'),
      course: field(item, ['course_name'], '未知课程'),
      deadline: field(item, ['end_time'], '未提供截止时间'),
      status: 'pending',
    }];
  });
}

export async function readCampusInfo(studentId: string, password: string): Promise<MobileCampusData> {
  assertNative();
  const cleanId = studentId.trim();
  if (!cleanId || !password) throw new CampusError('请先填写学号和校园密码。', 'credentials');
  await clearCampusCookies();
  await authenticate(cleanId, password);
  const { year, term } = academicTerm();
  const courses = await readSchedule(year, term);
  const exams = await readExams();
  const grades = await readGrades();
  const todos = await readTodos();
  const countedGrades = grades.flatMap((grade) => {
    const credit = numberValue(grade.credit);
    const point = numberValue(grade.point);
    return credit !== undefined && credit > 0 ? [{ credit, point }] : [];
  });
  const totalCredit = countedGrades.reduce((sum, grade) => sum + grade.credit, 0);
  const gpaGrades = countedGrades.filter((grade): grade is { credit: number; point: number } => grade.point !== undefined && Number.isFinite(grade.point));
  const gpaDenominator = gpaGrades.reduce((sum, grade) => sum + grade.credit, 0);
  const gpa = gpaDenominator ? gpaGrades.reduce((sum, grade) => sum + grade.credit * grade.point, 0) / gpaDenominator : null;
  return { fetchedAt: new Date().toISOString(), academicYear: year, term, courses, exams, grades, todos, gpa, totalCredit };
}
