import { Capacitor, CapacitorCookies, CapacitorHttp } from '@capacitor/core';
import type {
  CampusCourse,
  CampusExam,
  CampusGrade,
  CampusNotice,
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
const NOTICES_LIST_URL = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_cxMoreLoginNews.html';
const NOTICE_DETAIL_PATH = '/jwglxt/xtgl/xwck_ckLoginNews.html';

const TRUSTED_HOSTS = new Set([
  'zjuam.zju.edu.cn',
  'identity.zju.edu.cn',
  'zdbk.zju.edu.cn',
  'courses.zju.edu.cn',
]);

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

interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expiresAt?: number;
}

/** Keep CAS, academic-system and courses cookies across native requests. */
class CookieJar {
  private readonly cookies = new Map<string, CookieRecord>();

  clear() {
    this.cookies.clear();
  }

  capture(headers: Record<string, string>, sourceUrl: string) {
    const setCookie = headerValue(headers, 'set-cookie');
    if (!setCookie) return;
    const source = new URL(sourceUrl);
    for (const rawCookie of splitSetCookieHeader(setCookie)) {
      const segments = rawCookie.split(';').map((segment) => segment.trim()).filter(Boolean);
      const pair = segments.shift();
      if (!pair) continue;
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;

      let domain = source.hostname.toLowerCase();
      let path = defaultCookiePath(source.pathname);
      let secure = false;
      let expiresAt: number | undefined;
      let remove = !value;
      for (const segment of segments) {
        const attributeSeparator = segment.indexOf('=');
        const attribute = (attributeSeparator >= 0 ? segment.slice(0, attributeSeparator) : segment).trim().toLowerCase();
        const attributeValue = attributeSeparator >= 0 ? segment.slice(attributeSeparator + 1).trim() : '';
        if (attribute === 'domain' && attributeValue) domain = attributeValue.replace(/^\./, '').toLowerCase();
        if (attribute === 'path' && attributeValue.startsWith('/')) path = attributeValue;
        if (attribute === 'secure') secure = true;
        if (attribute === 'max-age') {
          const seconds = Number(attributeValue);
          if (Number.isFinite(seconds)) {
            expiresAt = Date.now() + seconds * 1000;
            if (seconds <= 0) remove = true;
          }
        }
        if (attribute === 'expires') {
          const timestamp = Date.parse(attributeValue);
          if (Number.isFinite(timestamp)) {
            expiresAt = timestamp;
            if (timestamp <= Date.now()) remove = true;
          }
        }
      }

      const key = `${name}\u0000${domain}\u0000${path}`;
      if (remove) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, domain, path, secure, expiresAt });
    }
  }

  has(name: string, hostSuffix?: string): boolean {
    const normalizedSuffix = hostSuffix?.replace(/^\./, '').toLowerCase();
    return [...this.cookies.values()].some((cookie) => {
      if (cookie.name !== name || isExpired(cookie)) return false;
      return !normalizedSuffix || hostMatches(cookie.domain, normalizedSuffix);
    });
  }

  headerFor(targetUrl: string): string {
    const target = new URL(targetUrl);
    return [...this.cookies.values()]
      .filter((cookie) => !isExpired(cookie) && (!cookie.secure || target.protocol === 'https:'))
      .filter((cookie) => hostMatches(target.hostname, cookie.domain) && pathMatches(target.pathname, cookie.path))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}

let activeCookieJar: CookieJar | null = null;
let zdbkSessionReady = false;

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

function headerValue(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1] || '';
}

function splitSetCookieHeader(value: string): string[] {
  // Android may join multiple Set-Cookie headers with a comma. Keep commas
  // inside Expires attributes intact.
  return value.replace(/\r?\n/g, ',').split(/,(?=\s*[^;,=\s]+\s*=)/g).map((item) => item.trim()).filter(Boolean);
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith('/') || pathname === '/') return '/';
  const index = pathname.lastIndexOf('/');
  return index <= 0 ? '/' : pathname.slice(0, index);
}

function isExpired(cookie: CookieRecord): boolean {
  return cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now();
}

function hostMatches(host: string, domain: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedDomain = domain.replace(/^\./, '').toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  if (cookiePath === '/') return true;
  return pathname === cookiePath || pathname.startsWith(`${cookiePath}/`);
}

function trustedUrl(value: string, source?: string): string {
  let parsed: URL;
  try { parsed = new URL(value, source); } catch { throw new CampusError('校园系统返回了无法识别的跳转地址。', 'response'); }
  if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new CampusError('校园系统返回了不受信任的跳转地址，已停止连接。', 'response');
  }
  return parsed.toString();
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
  const url = trustedUrl(options.url);
  const cookie = activeCookieJar?.headerFor(url);
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Zaichang-ZJU-Connector/0.2 (Android; read-only)',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      ...options.headers,
    };
    if (cookie) headers.Cookie = cookie;
    const result = await CapacitorHttp.request({
      url,
      method: options.method || 'GET',
      data: options.data,
      headers,
      responseType: options.responseType || 'text',
      disableRedirects: options.disableRedirects ?? true,
      connectTimeout: 20_000,
      readTimeout: 30_000,
    });
    const normalizedHeaders = (result.headers || {}) as Record<string, string>;
    activeCookieJar?.capture(normalizedHeaders, url);
    return { status: result.status, data: result.data, headers: normalizedHeaders, url: result.url || url };
  } catch (error) {
    if (error instanceof CampusError) throw error;
    throw new CampusError(error instanceof Error ? error.message : '无法连接校方服务，请检查网络。', 'network');
  }
}

async function followGet(startUrl: string): Promise<HttpResult> {
  let current = trustedUrl(startUrl);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await request({ url: current, responseType: 'text', disableRedirects: true });
    if (result.status < 300 || result.status >= 400) return result;
    const location = headerValue(result.headers, 'location');
    if (!location) throw new CampusError('校园系统跳转缺少目标地址。', 'response');
    current = trustedUrl(location, current);
  }
  throw new CampusError('校园系统跳转次数过多，登录流程已停止。', 'response');
}

function casServiceLoginUrl(): string {
  return `${LOGIN_URL}?service=${encodeURIComponent(ZDBK_SERVICE)}`;
}

function parseExecution(body: string): string {
  const matches = [
    /name\s*=\s*["']execution["'][^>]*value\s*=\s*["']([^"']+)/i,
    /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']execution["']/i,
  ];
  for (const pattern of matches) {
    const match = body.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  throw new CampusError('统一身份认证页面缺少本次登录会话信息，请重新读取校园信息。', 'authentication');
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
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
  activeCookieJar?.clear();
  zdbkSessionReady = false;
  await Promise.allSettled([
    CapacitorCookies.clearCookies({ url: 'https://zjuam.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://identity.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://zdbk.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://courses.zju.edu.cn' }),
  ]);
}

async function authenticate(studentId: string, password: string) {
  // The CAS entry point may redirect to the current trusted identity host.
  // Follow only trusted ZJU redirects so the execution token remains tied to
  // the same manual cookie jar without treating a normal HTTP 302 as failure.
  const loginPage = await followGet(LOGIN_URL);
  if (loginPage.status !== 200) throw new CampusError(`无法打开统一身份认证（HTTP ${loginPage.status}）。`, 'authentication');
  const execution = parseExecution(responseText(loginPage));
  const publicKeyResponse = await request({ url: PUBLIC_KEY_URL, responseType: 'text', disableRedirects: true });
  const publicKey = parseJson(publicKeyResponse, '统一身份认证公钥');
  const key = publicKey && typeof publicKey === 'object' && !Array.isArray(publicKey) ? publicKey as Record<string, unknown> : {};
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
  if (body.includes('验证码') || body.toLowerCase().includes('captcha')) {
    throw new CampusError('统一身份认证要求验证码，手机端暂不绕过安全校验。', 'captcha');
  }
  if (loginResult.status >= 400 || body.includes('name="execution"') || !activeCookieJar?.has('iPlanetDirectoryPro', 'zju.edu.cn')) {
    throw new CampusError('统一身份认证没有完成，请检查学号、密码或账号状态。', 'authentication');
  }
}

async function loginZdbk() {
  if (zdbkSessionReady && activeCookieJar?.has('JSESSIONID', 'zdbk.zju.edu.cn')) return;
  const result = await followGet(casServiceLoginUrl());
  const body = responseText(result);
  if (isAuthenticationPage(body)) throw new CampusError('教务网没有建立登录会话，请重新读取校园信息。', 'authentication');
  if (result.status < 200 || result.status >= 300) throw new CampusError(`教务网登录失败（HTTP ${result.status}）。`, 'authentication');
  if (!activeCookieJar?.has('JSESSIONID', 'zdbk.zju.edu.cn') || !activeCookieJar.has('route', 'zdbk.zju.edu.cn')) {
    throw new CampusError('教务网登录会话不完整，请重新读取校园信息。', 'authentication');
  }
  zdbkSessionReady = true;
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

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['name', 'value', 'text', 'label', 'mc']) {
      const nested = textValue(record[key]);
      if (nested) return nested;
    }
  }
  return '';
}

function cleanDisplayText(value: unknown): string {
  return decodeHtml(textValue(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function field(value: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const candidate = cleanDisplayText(value[key]);
    if (candidate) return candidate;
  }
  return fallback;
}

function officialNoticeUrl(value: string, noticeId: string): string {
  const fallback = `https://zdbk.zju.edu.cn${NOTICE_DETAIL_PATH}?xwbh=${encodeURIComponent(noticeId)}`;
  try {
    const parsed = new URL(value || fallback, NOTICES_LIST_URL);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'zdbk.zju.edu.cn') return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function listFromPayload(value: unknown, keys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  for (const key of ['data', 'result', 'rows']) {
    if (record[key] && typeof record[key] === 'object') {
      const nested = listFromPayload(record[key], keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function parseJson(result: HttpResult, label: string): unknown {
  if (result.data && typeof result.data === 'object') return result.data;
  const body = responseText(result).trim();
  if (body === 'null' || body === '') return null;
  try { return JSON.parse(body) as unknown; } catch { throw new CampusError(`${label}返回了无法识别的数据。`, 'response'); }
}

function isAuthenticationPage(body: string): boolean {
  return /name\s*=\s*["']execution["']/i.test(body)
    || (/统一身份认证/.test(body) && /登录|login|cas/i.test(body));
}

function scheduleParts(value: string): string[] {
  return cleanDisplayText(value).replace(/zwf.*$/i, '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
}

function weekdayLabel(value: string): string {
  const clean = value.trim();
  if (!clean) return '';
  if (/^(周|星期)/.test(clean)) return clean.replace(/^星期/, '周');
  const numeric = Number(clean.replace(/\D/g, ''));
  if (numeric >= 1 && numeric <= 7) return `周${['一', '二', '三', '四', '五', '六', '日'][numeric - 1]}`;
  return `周${clean}`;
}

function normalizeCourse(item: Record<string, unknown>, index: number): CampusCourse | null {
  if (field(item, ['sfyjskc']) === '1') return null;
  const parts = scheduleParts(textValue(item.kcb));
  const rawName = field(item, ['kcmc', 'course_name', 'courseName', 'jxbmc', 'kcm', 'course_name_full']);
  const rawTeacher = field(item, ['jsxx', 'jsxms', 'jsxm', 'teacher', 'teacherName', 'teacher_name', 'jsmc', 'teacherList']);
  const rawLocation = field(item, ['cdmc', 'jxcdmc', 'jxcd', 'classroom', 'room', 'location', 'place', 'jxcdm']);
  if (!parts.length && !rawName && !rawTeacher && !rawLocation) return null;
  const day = weekdayLabel(field(item, ['xqj', 'xqjmc', 'week_day', 'weekday', 'weekdayName']));
  const firstPeriod = numberValue(field(item, ['djj', 'start_period', 'startPeriod']));
  const duration = numberValue(field(item, ['skcd', 'period_count', 'periodCount']));
  const lastPeriod = firstPeriod && duration ? firstPeriod + duration - 1 : undefined;
  const periodLabel = firstPeriod && lastPeriod ? `第${firstPeriod}-${lastPeriod}节` : field(item, ['jcs', 'jssj', 'sksj', 'period', 'skjc', 'time', 'class_time']);
  const oddEven = field(item, ['dsz', 'odd_even']);
  const weeks = field(item, ['zcd', 'zc', 'zcmc', 'zcsm', 'weeks', 'week', 'week_range', 'weekRange', 'weekList'])
    || (oddEven === '0' ? '单周' : oddEven === '1' ? '双周' : '');
  return {
    id: field(item, ['jxb_id', 'jxbid', 'kch_id', 'xkkh', 'kch', 'course_id'], `course-${index}`),
    name: (rawName || parts[0] || '未命名课程').replace(/\(/g, '（').replace(/\)/g, '）'),
    teacher: rawTeacher || parts[2] || '教师未提供',
    location: rawLocation || parts[3] || '地点未提供',
    time: [day, periodLabel].filter(Boolean).join(' · ') || '时间未提供',
    weeks: weeks || '周次未提供',
  };
}

function examStatus(value: string): CampusExam['status'] {
  const match = value.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (match) {
    const timeMatch = value.match(/(\d{1,2}):(\d{2})/);
    const timestamp = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(timeMatch?.[1] || 23), Number(timeMatch?.[2] || 59)).getTime();
    return timestamp < Date.now() ? 'finished' : 'upcoming';
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? (parsed < Date.now() ? 'finished' : 'upcoming') : 'unknown';
}

function normalizeExams(item: Record<string, unknown>, index: number): CampusExam[] {
  const name = field(item, ['kcmc', 'course_name', 'courseName'], '未命名考试');
  const courseId = field(item, ['xkkh', 'kch', 'course_id', 'exam_id'], `exam-${index}`);
  const candidates = [
    { type: '期中', time: field(item, ['qzkssj', 'midterm_time']), location: field(item, ['qzjsmc', 'midterm_room']), seat: field(item, ['qzzwxh', 'midterm_seat']) },
    { type: '期末', time: field(item, ['kssj', 'exam_time', 'final_time']), location: field(item, ['jsmc', 'ksdd', 'cdmc', 'exam_room', 'final_room']), seat: field(item, ['zwxh', 'zwh', 'seat', 'final_seat']) },
  ];
  return candidates.flatMap((candidate) => candidate.time ? [{ id: `${courseId}-${candidate.type}`, name, time: candidate.time, location: candidate.location || '地点未提供', seat: candidate.seat, type: candidate.type, status: examStatus(candidate.time) }] : []);
}

function normalizeGrade(item: Record<string, unknown>, index: number): CampusGrade {
  return {
    id: field(item, ['xkkh', 'kch', 'kcmc', 'grade_id'], `grade-${index}`),
    name: field(item, ['kcmc', 'course_name', 'courseName'], '未命名课程'),
    score: field(item, ['cj', 'score', 'original_score', 'cjbj'], '—'),
    credit: field(item, ['xf', 'credit', 'course_credit'], '—'),
    point: field(item, ['jd', 'point', 'five_point', 'gpa'], '—'),
  };
}

async function readSchedule(year: string, term: string): Promise<CampusCourse[]> {
  await loginZdbk();
  const seasons = term === '1' ? ['1|秋', '1|冬'] : ['2|春', '2|夏'];
  const result: CampusCourse[] = [];
  for (const season of seasons) {
    const response = await request({ url: SCHEDULE_URL, method: 'POST', data: { xnm: year, xqm: season, captcha_value: '' }, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
    const body = responseText(response);
    if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
    if (body.toLowerCase().includes('captcha_error')) throw new CampusError('教务网要求验证码，手机端暂不绕过安全校验。', 'captcha');
    const payload = parseJson(response, '教务网课表');
    if (payload === null) continue;
    const items = listFromPayload(payload, ['kbList', 'items', 'rows']).filter((item) => field(item, ['sfyjskc']) !== '1');
    if (!items.length && payload && typeof payload === 'object' && !['kbList', 'items', 'rows', 'data', 'result'].some((key) => key in (payload as Record<string, unknown>))) throw new CampusError('教务网课表返回了无法识别的数据。', 'response');
    result.push(...items.map(normalizeCourse).filter((item): item is CampusCourse => item !== null));
  }
  const unique = new Map<string, CampusCourse>();
  for (const course of result) unique.set(`${course.id}|${course.time}|${course.name}`, course);
  return [...unique.values()];
}

async function readExams(): Promise<CampusExam[]> {
  await loginZdbk();
  const response = await request({ url: EXAMS_URL, method: 'POST', data: {}, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
  const body = responseText(response);
  if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
  return listFromPayload(parseJson(response, '教务网考试'), ['items', 'ksList', 'rows']).flatMap(normalizeExams);
}

async function readGrades(): Promise<CampusGrade[]> {
  await loginZdbk();
  const response = await request({ url: GRADES_URL, method: 'POST', data: {}, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
  const body = responseText(response);
  if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
  return listFromPayload(parseJson(response, '教务网成绩'), ['items', 'cjList', 'rows']).map(normalizeGrade);
}

function metaRefresh(body: string, source: string): string | undefined {
  const match = body.match(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'; >]+)/i) || body.match(/<meta\b[^>]*content=["'][^"']*url=([^"'; >]+)[^"']*[^>]*http-equiv=["']?refresh/i);
  if (!match?.[1]) return undefined;
  try { return trustedUrl(decodeHtml(match[1]), source); } catch { return undefined; }
}

async function readTodos(): Promise<CampusTodo[]> {
  let current = trustedUrl(COURSES_HOME);
  for (let index = 0; index < 8; index += 1) {
    const response = await request({ url: current, responseType: 'text', disableRedirects: true });
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, 'location');
      if (!location) throw new CampusError('学在浙大登录跳转缺少目标地址。', 'authentication');
      current = trustedUrl(location, current);
      continue;
    }
    const body = responseText(response);
    if (response.status < 200 || response.status >= 300) throw new CampusError(`学在浙大登录失败（HTTP ${response.status}）。`, 'authentication');
    if (isAuthenticationPage(body)) throw new CampusError('学在浙大没有建立登录会话，请重新读取。', 'authentication');
    const target = metaRefresh(body, current);
    if (target) { current = target; continue; }
    break;
  }
  if (!activeCookieJar?.has('session', 'courses.zju.edu.cn')) throw new CampusError('学在浙大没有建立可用登录会话，请重新读取。', 'authentication');
  const response = await request({ url: TODOS_URL, responseType: 'text', disableRedirects: true });
  const body = responseText(response);
  if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('学在浙大登录态已失效，请重新读取。', 'authentication');
  const todos = listFromPayload(parseJson(response, '学在浙大待办'), ['todo_list', 'items', 'rows']);
  return todos.flatMap((item) => {
    if (!item.id || !(item.is_student === true || item.is_student === 1 || item.is_student === '1')) return [];
    return [{ id: String(item.id), name: field(item, ['title', 'name'], '未命名作业'), course: field(item, ['course_name', 'course'], '未知课程'), deadline: field(item, ['end_time', 'deadline'], '未提供截止时间'), status: 'pending' }];
  });
}

export interface CampusNoticeResult {
  notices: CampusNotice[];
  page: number;
  totalAvailable: number;
}

export async function readPublicNotices(query = '', page = 1): Promise<CampusNoticeResult> {
  assertNative();
  const safeQuery = query.trim().slice(0, 100);
  const safePage = Math.max(1, Math.min(50, Math.trunc(page) || 1));
  const searchTerms = [safeQuery];
  const collegeCore = safeQuery.match(/([\u4e00-\u9fa5]{2,})(?=学院|系|书院)/)?.[1];
  const withoutCollege = safeQuery.replace(/学院|系|书院/g, '').trim();
  for (const candidate of [collegeCore, withoutCollege, '转专业', '选课', '考试', '开学', '奖学金', '毕业']) {
    if (candidate && candidate !== safeQuery && !searchTerms.includes(candidate) && (candidate === collegeCore || safeQuery.includes(candidate))) searchTerms.push(candidate);
  }
  let rawPayload: Record<string, unknown> = {};
  let rawItems: Record<string, unknown>[] = [];
  for (const searchTerm of searchTerms) {
    const params = new URLSearchParams({
      doType: 'query',
      'queryModel.currentPage': String(safePage),
      'queryModel.showCount': '10',
      'queryModel.sortName': 'sfzd desc,fbsj',
      'queryModel.sortOrder': 'desc',
      xwbt: searchTerm,
    });
    const response = await followGet(`${NOTICES_LIST_URL}?${params.toString()}`);
    if (response.status < 200 || response.status >= 300) throw new CampusError(`浙大官方公告暂时无法访问（HTTP ${response.status}）。`, 'network');
    const payload = parseJson(response, '浙大官方公告');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CampusError('浙大官方公告返回格式不正确。', 'response');
    rawPayload = payload as Record<string, unknown>;
    rawItems = listFromPayload(payload, ['items', 'rows', 'list']);
    if (rawItems.length || searchTerm === searchTerms[searchTerms.length - 1]) break;
  }
  if (!rawItems.length && !Array.isArray(rawPayload.items) && !Array.isArray(rawPayload.rows) && !Array.isArray(rawPayload.list)) {
    throw new CampusError('浙大官方公告没有返回可识别的列表。', 'response');
  }
  const notices = rawItems.slice(0, 20).flatMap((item, index) => {
    const id = field(item, ['xwbh', 'id', 'noticeId'], `notice-${safePage}-${index}`);
    const title = field(item, ['xwbt', 'title', 'name']);
    if (!title) return [];
    return [{
      id: `zju-notice-${id}`,
      title: title.slice(0, 240),
      publisher: field(item, ['xwfbr', 'publisher', 'author'], '浙江大学本科生院').slice(0, 120),
      publishedAt: field(item, ['fbsj', 'publishedAt', 'publishTime']).slice(0, 40),
      summary: field(item, ['fbnr', 'summary', 'content', 'jj']).slice(0, 360),
      url: officialNoticeUrl(field(item, ['fbdz', 'url', 'link']), id),
      pinned: field(item, ['sfzd', 'pinned']) === '1' || field(item, ['sfzd', 'pinned']).toLowerCase() === 'true',
    } satisfies CampusNotice];
  });
  const totalCandidate = Number(rawPayload.totalCount ?? rawPayload.totalResult ?? rawPayload.total ?? notices.length);
  return { notices, page: safePage, totalAvailable: Number.isFinite(totalCandidate) && totalCandidate >= 0 ? totalCandidate : notices.length };
}

function errorText(error: unknown): string {
  return error instanceof CampusError ? error.message : error instanceof Error ? error.message : '读取失败';
}

function isFatalModuleError(error: unknown): boolean {
  return error instanceof CampusError && (error.code === 'authentication' || error.code === 'captcha');
}

export async function readCampusInfo(studentId: string, password: string): Promise<MobileCampusData> {
  assertNative();
  const cleanId = studentId.trim();
  if (!cleanId || !password) throw new CampusError('请先填写学号和校园密码。', 'credentials');
  activeCookieJar = new CookieJar();
  try {
    await clearCampusCookies();
    await authenticate(cleanId, password);
    const { year, term } = academicTerm();
    const warnings: string[] = [];
    let courses: CampusCourse[] = [];
    let exams: CampusExam[] = [];
    let grades: CampusGrade[] = [];
    let todos: CampusTodo[] = [];
    let successfulModules = 0;

    try { courses = await readSchedule(year, term); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`课表：${errorText(error)}`); }
    try { exams = await readExams(); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`考试：${errorText(error)}`); }
    try { grades = await readGrades(); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`成绩：${errorText(error)}`); }
    try { todos = await readTodos(); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`待办：${errorText(error)}`); }
    if (!successfulModules && warnings.length) throw new CampusError(warnings.join('；'), 'response');

    const countedGrades = grades.flatMap((grade) => {
      const credit = numberValue(grade.credit);
      const point = numberValue(grade.point);
      return credit !== undefined && credit > 0 ? [{ credit, point }] : [];
    });
    const totalCredit = countedGrades.reduce((sum, grade) => sum + grade.credit, 0);
    const gpaGrades = countedGrades.filter((grade): grade is { credit: number; point: number } => grade.point !== undefined && Number.isFinite(grade.point));
    const gpaDenominator = gpaGrades.reduce((sum, grade) => sum + grade.credit, 0);
    const gpa = gpaDenominator ? gpaGrades.reduce((sum, grade) => sum + grade.credit * grade.point, 0) / gpaDenominator : null;
    return { fetchedAt: new Date().toISOString(), academicYear: year, term, courses, exams, grades, todos, gpa, totalCredit, warnings };
  } finally {
    activeCookieJar = null;
    zdbkSessionReady = false;
  }
}
