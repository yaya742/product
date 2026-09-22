import { Capacitor, CapacitorCookies, CapacitorHttp } from '@capacitor/core';
import aesjs from 'aes-js';
import { isMobileVmOffline } from './mobileVm';
import type {
  CampusCourse,
  CampusCourseOffering,
  CampusActivity,
  CampusExam,
  CampusGrade,
  CampusGradeAlert,
  CampusGpaSummary,
  CampusHoliday,
  CampusLearningCourse,
  CampusNotice,
  CampusPracticeProject,
  CampusPracticeSummary,
  CampusTodo,
  CampusPublicCategory,
  CampusPublicInfo,
  MobileCampusData,
} from './types';

const LOGIN_URL = 'https://zjuam.zju.edu.cn/cas/login';
const PUBLIC_KEY_URL = 'https://zjuam.zju.edu.cn/cas/v2/getPubKey';
const ZDBK_HOME = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html';
const ZDBK_SERVICE = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html';
const SCHEDULE_URL = 'https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151';
const EXAMS_URL = 'https://zdbk.zju.edu.cn/jwglxt/xskscx/kscx_cxXsgrksIndex.html?doType=query&queryModel.showCount=5000';
const GRADES_URL = 'https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000';
const COURSES_HOME = 'https://courses.zju.edu.cn/user/index';
const TODOS_URL = 'https://courses.zju.edu.cn/api/todos';
const MY_COURSES_URL = 'https://courses.zju.edu.cn/api/my-courses';
const COURSE_ACTIVITIES_URL = 'https://courses.zju.edu.cn/api/courses/{courseId}/activities';
const SZTZ_SERVICE = 'https://sztz.zju.edu.cn/dekt/';
const SZTZ_CTX = 'https://sztz.zju.edu.cn/dekt/ctx';
const SZTZ_PROJECTS = 'https://sztz.zju.edu.cn/dekt/student/home/getSqjl';
const SZTZ_SUMMARY = 'https://sztz.zju.edu.cn/dekt/student/home/getMyInfo';
const NOTICES_LIST_URL = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_cxMoreLoginNews.html';
const NOTICE_DETAIL_PATH = '/jwglxt/xtgl/xwck_ckLoginNews.html';
const PERSON_SERVER_URL = 'https://person.zju.edu.cn/server';
const PERSON_PORTAL_URL = 'https://person.zju.edu.cn/';
const ZJU_INSTITUTION_DIRECTORY_URL = 'https://www.zju.edu.cn/599/listm.htm';
const CALENDAR_LIST_URL = 'https://ugrs.zju.edu.cn/28218/list1.htm';
const CALENDAR_LIST_FALLBACK_URL = 'https://ugrs.zju.edu.cn/28218/list.htm';
const PERSON_APP_KEY = '50634610756a4c0e82d5a13bb692e257';
const PERSON_SIGN_SECRET = '1f11192bd9d14a09b29fc59d556e24e3';
const WEBVPN_ROOT = 'https://webvpn.zju.edu.cn';
const WEBVPN_DO_LOGIN = `${WEBVPN_ROOT}/do-login`;
const WEBVPN_CONFIRM_LOGIN = `${WEBVPN_ROOT}/do-confirm-login`;
// The WebVPN gateway uses different keys for the encrypted target route and
// the encrypted login password. Reusing one key makes the login request fail
// even though the generated WebVPN URL still looks valid.
const WEBVPN_ROUTE_CIPHER_KEY = 'wrdvpnisthebest!';
const WEBVPN_PASSWORD_CIPHER_KEY = 'wrdvpnisawesome!';

const TRUSTED_HOSTS = new Set([
  'zjuam.zju.edu.cn',
  'identity.zju.edu.cn',
  'zdbk.zju.edu.cn',
  'courses.zju.edu.cn',
  'sztz.zju.edu.cn',
  'person.zju.edu.cn',
  'www.zju.edu.cn',
  'ugrs.zju.edu.cn',
]);
const WEBVPN_HOST = 'webvpn.zju.edu.cn';
const ZJU_DOMAIN = 'zju.edu.cn';
type CampusTransport = 'direct' | 'webvpn';

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
      let pathSpecified = false;
      let secure = false;
      let expiresAt: number | undefined;
      let remove = !value;
      for (const segment of segments) {
        const attributeSeparator = segment.indexOf('=');
        const attribute = (attributeSeparator >= 0 ? segment.slice(0, attributeSeparator) : segment).trim().toLowerCase();
        const attributeValue = attributeSeparator >= 0 ? segment.slice(attributeSeparator + 1).trim() : '';
        if (attribute === 'domain' && attributeValue) domain = attributeValue.replace(/^\./, '').toLowerCase();
        if (attribute === 'path' && attributeValue.startsWith('/')) {
          path = attributeValue;
          pathSpecified = true;
        }
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

      if (source.hostname.toLowerCase() === WEBVPN_HOST) {
        if (!hostMatches(source.hostname, domain)) domain = source.hostname;
        if (!pathSpecified) path = '/';
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

  hasHost(hostSuffix: string): boolean {
    const normalizedSuffix = hostSuffix.replace(/^\./, '').toLowerCase();
    return [...this.cookies.values()].some((cookie) => !isExpired(cookie) && hostMatches(cookie.domain, normalizedSuffix));
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
let campusTransport: CampusTransport = 'direct';
let activeCampusCredentials: { studentId: string; password: string } | null = null;

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

function isWebVpnProxyPath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length >= 2 && /^https?$/.test(parts[0]) && /^[0-9a-f]{32,}(?:-\d+)?$/i.test(parts[1]);
}

function isTrustedCampusHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return TRUSTED_HOSTS.has(normalized) || normalized === ZJU_DOMAIN || normalized.endsWith(`.${ZJU_DOMAIN}`);
}

function trustedUrl(value: string, source?: string, options: { allowWebVpn?: boolean } = {}): string {
  let parsed: URL;
  try { parsed = new URL(value, source); } catch { throw new CampusError('校园系统返回了无法识别的跳转地址。', 'response'); }
  const hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && hostname === WEBVPN_HOST) {
    // Some campus gateways emit an http Location even though the actual
    // WebVPN endpoint is HTTPS. Normalize it before applying the allowlist;
    // otherwise a valid WebVPN handoff is reported as an untrusted URL.
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    const allowedPath = parsed.pathname === '/'
      || parsed.pathname === '/login'
      || parsed.pathname === '/do-login'
      || parsed.pathname === '/do-confirm-login'
      || parsed.pathname === '/do-second-login'
      || parsed.pathname.startsWith('/captcha/')
      || isWebVpnProxyPath(parsed.pathname);
    if (options.allowWebVpn && allowedPath) return parsed.toString();
    throw new CampusError('教务网已跳转到浙大 WebVPN，正在尝试应用内自动登录。', 'network');
  }
  if (!/^https?:$/.test(parsed.protocol) || !isTrustedCampusHost(hostname)) {
    throw new CampusError(`校园系统返回了不受信任的跳转地址（域名：${hostname || '未知'}），已停止连接。`, 'response');
  }
  // Some official ZJU pages still emit an HTTP Location. Upgrade only an
  // already trusted ZJU host; arbitrary external HTTP redirects remain blocked.
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  return parsed.toString();
}

function webVpnEncrypt(value: string): string {
  const key = aesjs.utils.utf8.toBytes(WEBVPN_ROUTE_CIPHER_KEY);
  const iv = aesjs.utils.utf8.toBytes(WEBVPN_ROUTE_CIPHER_KEY);
  const bytes = Array.from(aesjs.utils.utf8.toBytes(value));
  const padded = bytes.length % 16 === 0 ? bytes : bytes.concat(new Array(16 - (bytes.length % 16)).fill(0));
  const cipher = new aesjs.ModeOfOperation.cfb(key, iv, 16).encrypt(padded).slice(0, bytes.length);
  return aesjs.utils.hex.fromBytes(iv) + aesjs.utils.hex.fromBytes(cipher);
}

function webVpnUrl(value: string): string {
  let target: URL;
  try { target = new URL(value); } catch { throw new CampusError('无法生成 WebVPN 访问地址。', 'response'); }
  const hostname = target.hostname.toLowerCase();
  if (!/^https?:$/.test(target.protocol) || !isTrustedCampusHost(hostname)) {
    throw new CampusError('校园系统返回了不受信任的 WebVPN 目标地址。', 'response');
  }
  const protocol = target.protocol.slice(0, -1);
  const port = target.port ? `-${target.port}` : '';
  const encryptedHost = `${webVpnEncrypt(hostname)}${port}`;
  const path = `${target.pathname.replace(/^\/+/, '')}${target.search}${target.hash}`;
  return `${WEBVPN_ROOT}/${protocol}/${encryptedHost}${path ? `/${path}` : ''}`;
}

function shouldProxyHost(hostname: string): boolean {
  return isTrustedCampusHost(hostname);
}

function campusCookieHost(hostname: string): string {
  return campusTransport === 'webvpn' ? WEBVPN_HOST : hostname;
}

function routedUrl(value: string, source?: string): string {
  let resolved: URL;
  try { resolved = new URL(value, source); } catch { throw new CampusError('校园系统返回了无法识别的跳转地址。', 'response'); }
  if (campusTransport === 'webvpn' && resolved.hostname.toLowerCase() !== WEBVPN_HOST && shouldProxyHost(resolved.hostname)) {
    return webVpnUrl(resolved.toString());
  }
  return resolved.toString();
}

async function request(options: {
  url: string;
  method?: 'GET' | 'POST';
  data?: Record<string, string>;
  headers?: Record<string, string>;
  responseType?: 'text' | 'json';
  disableRedirects?: boolean;
  allowWebVpn?: boolean;
}): Promise<HttpResult> {
  if (isMobileVmOffline()) throw new CampusError('虚拟机已模拟断网，校园请求未发送。', 'network');
  assertNative();
  const url = trustedUrl(routedUrl(options.url), undefined, { allowWebVpn: options.allowWebVpn || campusTransport === 'webvpn' });
  const cookie = activeCookieJar?.headerFor(url);
  try {
    const requestHeaders: Record<string, string> = { ...options.headers };
    const referer = headerValue(requestHeaders, 'referer');
    if (referer) requestHeaders.Referer = routedUrl(referer);
    const headers: Record<string, string> = {
      'User-Agent': 'Zaichang-ZJU-Connector/0.2 (Android; read-only)',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      ...requestHeaders,
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
  let current = routedUrl(startUrl);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await request({ url: current, responseType: 'text', disableRedirects: true, allowWebVpn: campusTransport === 'webvpn' });
    if (result.status < 300 || result.status >= 400) return result;
    const location = headerValue(result.headers, 'location');
    if (!location) throw new CampusError('校园系统跳转缺少目标地址。', 'response');
    current = routedUrl(location, current);
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
  // A direct campus request may land on the generic identity entry page
  // without a CAS service ticket. Treat that as a transport fallback signal;
  // the caller will retry through WebVPN instead of blaming the credentials.
  throw new CampusError('统一身份认证页面缺少本次登录会话信息，请重新读取校园信息。', 'network');
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

function hiddenInput(body: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<input[^>]+name\\s*=\\s*["']${escaped}["'][^>]*value\\s*=\\s*["']([^"']*)`, 'i'),
    new RegExp(`<input[^>]+value\\s*=\\s*["']([^"']*)["'][^>]*name\\s*=\\s*["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const value = body.match(pattern)?.[1];
    if (value !== undefined) return decodeHtml(value);
  }
  return '';
}

function webVpnPasswordKey(body: string): string {
  const embeddedKey = body.match(/encrypt\(data\[i\]\.value,\s*["']([^"']+)["']/i)?.[1]?.trim();
  return embeddedKey && aesjs.utils.utf8.toBytes(embeddedKey).length === 16
    ? embeddedKey
    : WEBVPN_PASSWORD_CIPHER_KEY;
}

function encryptWebVpnPassword(password: string, cipherKey = WEBVPN_PASSWORD_CIPHER_KEY): string {
  const originalLength = password.length;
  if (!originalLength) throw new CampusError('校园密码不能为空。', 'credentials');
  const padded = originalLength % 16 === 0 ? password : password.padEnd(originalLength + (16 - originalLength % 16), '0');
  const key = aesjs.utils.utf8.toBytes(cipherKey);
  const iv = aesjs.utils.utf8.toBytes(cipherKey);
  const plaintext = aesjs.utils.utf8.toBytes(padded);
  const encrypted = new aesjs.ModeOfOperation.cfb(key, iv, 16).encrypt(plaintext).slice(0, originalLength);
  return aesjs.utils.hex.fromBytes(iv) + aesjs.utils.hex.fromBytes(encrypted);
}

async function loginWebVpn(studentId: string, password: string): Promise<void> {
  // The current WebVPN gateway redirects its root endpoint to /login before
  // rendering the form. Follow only the allowlisted WebVPN redirect so the
  // native flow does not mistake the normal 302 for a failed login page.
  const loginPage = await followGet(WEBVPN_ROOT);
  const body = responseText(loginPage);
  if (loginPage.status !== 200) throw new CampusError(`WebVPN 登录页请求失败（HTTP ${loginPage.status}）。`, 'network');
  const csrf = hiddenInput(body, '_csrf');
  if (!csrf) throw new CampusError('WebVPN 登录页缺少会话校验信息，请稍后重试。', 'authentication');
  const result = await request({
    url: WEBVPN_DO_LOGIN,
    method: 'POST',
    data: {
      _csrf: csrf,
      auth_type: hiddenInput(body, 'auth_type') || 'local',
      username: studentId,
      password: encryptWebVpnPassword(password, webVpnPasswordKey(body)),
      sms_code: '',
      captcha: '',
      needCaptcha: hiddenInput(body, 'needCaptcha') || 'false',
      captcha_id: hiddenInput(body, 'captcha_id'),
    },
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: WEBVPN_ROOT,
      Referer: `${WEBVPN_ROOT}/`,
    },
    responseType: 'text',
    disableRedirects: true,
    allowWebVpn: true,
  });
  const payload = parseJson(result, 'WebVPN 登录');
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  if (record.success === true) return;
  const code = String(record.error || '').toUpperCase();
  const message = field(record, ['message'], 'WebVPN 登录未完成。');
  if (code === 'NEED_CONFIRM') {
    // The web form asks the user to confirm when an older WebVPN session is
    // still active. Mobile auto-read has no browser dialog, so perform the
    // same explicit confirmation request on the user's behalf.
    const confirmation = await request({
      url: WEBVPN_CONFIRM_LOGIN,
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: WEBVPN_ROOT,
        Referer: `${WEBVPN_ROOT}/login`,
      },
      responseType: 'text',
      disableRedirects: true,
      allowWebVpn: true,
    });
    const confirmationPayload = parseJson(confirmation, 'WebVPN 确认登录');
    const confirmationRecord = confirmationPayload && typeof confirmationPayload === 'object' && !Array.isArray(confirmationPayload)
      ? confirmationPayload as Record<string, unknown>
      : {};
    if (confirmationRecord.success === true) return;
    throw new CampusError(field(confirmationRecord, ['message', 'url'], 'WebVPN 确认登录未完成。'), 'authentication');
  }
  if (/CAPTCHA|SMS|TWO_STEP|SECOND/.test(code) || /验证码|二次认证|短信/.test(message)) {
    throw new CampusError(`WebVPN 需要人工安全校验：${message}`, 'captcha');
  }
  if (/INVALID_ACCOUNT|PASSWORD|ACCOUNT|AUTH/.test(code)) {
    throw new CampusError(`WebVPN 登录失败：${message}`, 'authentication');
  }
  throw new CampusError(message, 'authentication');
}

async function clearCampusCookies() {
  activeCookieJar?.clear();
  zdbkSessionReady = false;
  await Promise.allSettled([
    CapacitorCookies.clearCookies({ url: 'https://zjuam.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://identity.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://zdbk.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://courses.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://sztz.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: WEBVPN_ROOT }),
  ]);
}

async function authenticate(studentId: string, password: string) {
  // The CAS entry point may redirect to the current trusted identity host.
  // Follow only trusted ZJU redirects so the execution token remains tied to
  // the same manual cookie jar without treating a normal HTTP 302 as failure.
  // Include the actual academic-system service so CAS returns an execution
  // token for this login instead of the generic identity landing page.
  const casLoginUrl = casServiceLoginUrl();
  const loginPage = await followGet(casLoginUrl);
  if (loginPage.status !== 200) throw new CampusError(`无法打开统一身份认证（HTTP ${loginPage.status}）。`, 'authentication');
  const execution = parseExecution(responseText(loginPage));
  const publicKeyResponse = await request({ url: PUBLIC_KEY_URL, responseType: 'text', disableRedirects: true });
  const publicKey = parseJson(publicKeyResponse, '统一身份认证公钥');
  const key = publicKey && typeof publicKey === 'object' && !Array.isArray(publicKey) ? publicKey as Record<string, unknown> : {};
  const modulus = field(key, ['modulus']);
  const exponent = field(key, ['exponent']);
  if (!modulus || !exponent) throw new CampusError('统一身份认证没有返回可用公钥。', 'authentication');

  const loginResult = await request({
    url: casLoginUrl,
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
  if (loginResult.status >= 400 || body.includes('name="execution"') || (campusTransport === 'direct' && !activeCookieJar?.has('iPlanetDirectoryPro', 'zju.edu.cn'))) {
    throw new CampusError('统一身份认证没有完成，请检查学号、密码或账号状态。', 'authentication');
  }
}

async function activateWebVpn(): Promise<void> {
  const credentials = activeCampusCredentials;
  if (!credentials) throw new CampusError('缺少校园账号，无法自动登录 WebVPN。', 'credentials');
  await clearCampusCookies();
  campusTransport = 'webvpn';
  await loginWebVpn(credentials.studentId, credentials.password);
  await authenticate(credentials.studentId, credentials.password);
}

async function loginZdbk() {
  if (zdbkSessionReady && (campusTransport === 'webvpn' || activeCookieJar?.has('JSESSIONID', campusCookieHost('zdbk.zju.edu.cn')))) return;
  let result: HttpResult;
  try {
    result = await followGet(casServiceLoginUrl());
  } catch (error) {
    if (campusTransport === 'direct' && error instanceof CampusError && error.code === 'network' && /WebVPN/.test(error.message)) {
      await activateWebVpn();
      return loginZdbk();
    }
    throw error;
  }
  const body = responseText(result);
  if (isCampusNetworkRestriction(body)) {
    if (campusTransport === 'direct') {
      await activateWebVpn();
      return loginZdbk();
    }
    throw new CampusError('WebVPN 已登录，但教务网仍返回了网络限制。', 'network');
  }
  if (isAuthenticationPage(body)) throw new CampusError('教务网没有建立登录会话，请重新读取校园信息。', 'authentication');
  if (result.status < 200 || result.status >= 300) throw new CampusError(`教务网登录失败（HTTP ${result.status}）。`, 'authentication');
  if (campusTransport === 'direct' && (!activeCookieJar?.has('JSESSIONID', campusCookieHost('zdbk.zju.edu.cn')) || !activeCookieJar.has('route', campusCookieHost('zdbk.zju.edu.cn')))) {
    throw new CampusError('教务网登录会话不完整，请重新读取校园信息。', 'authentication');
  }
  zdbkSessionReady = true;
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, '') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isAuthenticatedSztzContext(body: string): boolean {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (payload.success !== true || Number(payload.code) !== 0 || typeof payload.data !== 'string') return false;
    const context = JSON.parse(decodeBase64Utf8(payload.data)) as Record<string, unknown>;
    const userId = typeof context.userId === 'string' ? context.userId.trim() : '';
    return context.anonymous === false && !!userId && userId.toUpperCase() !== 'ANONYMOUS' && !JSON.stringify(context.roles || '').includes('ANONYMOUS_USER_ROLE');
  } catch {
    return false;
  }
}

async function loginSztz() {
  const serviceLogin = `${LOGIN_URL}?service=${encodeURIComponent(SZTZ_SERVICE)}`;
  const ticketResponse = await request({ url: serviceLogin, responseType: 'text', disableRedirects: true });
  const location = headerValue(ticketResponse.headers, 'location');
  if (ticketResponse.status < 300 || ticketResponse.status >= 400 || !location) throw new CampusError('素质拓展平台没有返回有效的统一认证跳转。', 'authentication');
  const callback = routedUrl(location, ticketResponse.url);
  const parsed = new URL(callback);
  const validDirectCallback = parsed.hostname.toLowerCase() === 'sztz.zju.edu.cn'
    && parsed.pathname.replace(/\/$/, '') === '/dekt'
    && !!parsed.searchParams.get('ticket');
  const validWebVpnCallback = parsed.hostname.toLowerCase() === WEBVPN_HOST && isWebVpnProxyPath(parsed.pathname);
  if ((!validDirectCallback && !validWebVpnCallback) || (campusTransport === 'direct' && !validDirectCallback)) {
    throw new CampusError('素质拓展平台返回了不受信任的认证回调。', 'authentication');
  }
  const callbackResponse = await request({ url: callback, responseType: 'text', disableRedirects: true, allowWebVpn: campusTransport === 'webvpn' });
  if (callbackResponse.status !== 200 || (campusTransport === 'direct' && !activeCookieJar?.has('SESSION', campusCookieHost('sztz.zju.edu.cn')))) {
    throw new CampusError('素质拓展平台没有建立正式登录会话。', 'authentication');
  }
  const contextResponse = await request({
    url: SZTZ_CTX,
    method: 'POST',
    data: {},
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://sztz.zju.edu.cn',
      Referer: SZTZ_SERVICE,
    },
    responseType: 'text',
    disableRedirects: true,
  });
  if (contextResponse.status !== 200 || !isAuthenticatedSztzContext(responseText(contextResponse))) throw new CampusError('素质拓展平台身份确认未完成。', 'authentication');
}

function practiceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true' || value === '通过' || value === '已通过' || value === '达标' || value === '合格') return true;
  if (value === 0 || value === '0' || value === 'false' || value === '未通过' || value === '不通过' || value === '未达标' || value === '不合格') return false;
  return null;
}

function practiceNumber(value: unknown): number | null {
  const parsed = numberValue(String(value ?? ''));
  return parsed === undefined ? null : parsed;
}

function normalizePracticeSummary(value: Record<string, unknown>): CampusPracticeSummary {
  if (!['dektJf', 'dsktJf', 'dsiktJf'].some((key) => key in value)) throw new CampusError('素质拓展汇总缺少课堂记点字段。', 'response');
  return {
    secondClassPoints: practiceNumber(value.dektJf) ?? 0,
    thirdClassPoints: practiceNumber(value.dsktJf) ?? 0,
    fourthClassPoints: practiceNumber(value.dsiktJf) ?? 0,
    aestheticEducationPassed: practiceBoolean(value.myTg),
    laborEducationPassed: practiceBoolean(value.lyTg),
    source: '素质拓展平台 getMyInfo',
  };
}

function normalizePracticeProject(value: Record<string, unknown>, index: number): CampusPracticeProject | null {
  const id = String(value.id ?? '').trim();
  if (!id) return null;
  const project = value.xm && typeof value.xm === 'object' && !Array.isArray(value.xm) ? value.xm as Record<string, unknown> : {};
  const category = project.xmfl && typeof project.xmfl === 'object' && !Array.isArray(project.xmfl) ? project.xmfl as Record<string, unknown> : {};
  const projectType = project.xmlb && typeof project.xmlb === 'object' && !Array.isArray(project.xmlb) ? project.xmlb as Record<string, unknown> : {};
  const qualityType = project.xmlx && typeof project.xmlx === 'object' && !Array.isArray(project.xmlx) ? project.xmlx as Record<string, unknown> : {};
  const status = value.cyrshzt && typeof value.cyrshzt === 'object' && !Array.isArray(value.cyrshzt) ? value.cyrshzt as Record<string, unknown> : {};
  const currentState = value.currentState && typeof value.currentState === 'object' && !Array.isArray(value.currentState) ? value.currentState as Record<string, unknown> : {};
  const categoryId = Number(category.id || 0);
  const categoryName = field(category, ['mc'], categoryId === 1 ? '第二课堂' : categoryId === 2 ? '第三课堂' : categoryId === 3 ? '第四课堂' : '未分类课堂');
  const statusLabel = field(status, ['label'], field(currentState, ['name'], '状态未知'));
  const statusValue = Number(status.value);
  const approved = statusValue === 5 || statusLabel === '审核通过';
  return {
    id: `${id}-${index}`,
    name: field(project, ['mc'], '未命名项目'),
    category: categoryName,
    projectType: field(projectType, ['mc'], '未填写'),
    qualityType: field(qualityType, ['mc'], '未填写'),
    score: practiceNumber(value.jd),
    status: statusLabel,
    approved,
    role: field(value, ['hdjjygrcdgz']),
    remark: field(value, ['qksm']),
    activityTime: [field(value, ['hdsj']), field(value, ['hdjssj'])].filter(Boolean).join(' — '),
  };
}

async function readPractice(): Promise<{ summary: CampusPracticeSummary | null; projects: CampusPracticeProject[]; warnings: string[] }> {
  await loginSztz();
  let summary: CampusPracticeSummary | null = null;
  const projects: CampusPracticeProject[] = [];
  const warnings: string[] = [];
  try {
    const response = await request({ url: SZTZ_SUMMARY, responseType: 'text', headers: { Accept: 'application/json, text/plain, */*', Referer: SZTZ_SERVICE }, disableRedirects: true });
    if (response.status !== 200) throw new CampusError(`素质拓展汇总请求失败（HTTP ${response.status}）。`, 'response');
    const payload = parseJson(response, '素质拓展汇总');
    const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const extend = root.extend && typeof root.extend === 'object' && !Array.isArray(root.extend) ? root.extend as Record<string, unknown> : {};
    const myInfo = extend.myInfo && typeof extend.myInfo === 'object' && !Array.isArray(extend.myInfo) ? extend.myInfo as Record<string, unknown> : {};
    summary = normalizePracticeSummary(myInfo);
  } catch (error) {
    if (error instanceof CampusError && (error.code === 'authentication' || error.code === 'captcha')) throw error;
    warnings.push(`素质拓展汇总：${error instanceof Error ? error.message : '读取失败'}`);
  }
  try {
    const response = await request({ url: SZTZ_PROJECTS, responseType: 'text', headers: { Accept: 'application/json, text/html, */*', Referer: SZTZ_SERVICE }, disableRedirects: true });
    if (response.status !== 200) throw new CampusError(`素质拓展项目请求失败（HTTP ${response.status}）。`, 'response');
    const payload = parseJson(response, '素质拓展项目');
    const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (root.success !== true || Number(root.code) !== 0 || !Array.isArray(root.data)) throw new CampusError('素质拓展项目返回了无法识别的数据。', 'response');
    const seen = new Set<string>();
    root.data.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const normalized = normalizePracticeProject(item as Record<string, unknown>, index);
      if (!normalized || seen.has(normalized.id)) return;
      seen.add(normalized.id);
      projects.push(normalized);
    });
  } catch (error) {
    if (error instanceof CampusError && (error.code === 'authentication' || error.code === 'captcha')) throw error;
    warnings.push(`素质拓展项目：${error instanceof Error ? error.message : '读取失败'}`);
  }
  if (!summary && !projects.length) throw new CampusError(warnings.join('；') || '素质拓展没有返回可识别的数据。', 'response');
  if (!summary) {
    const totals = projects.reduce((result, project) => {
      if (!project.approved || project.score === null) return result;
      const key = project.category === '第二课堂' ? 'secondClassPoints' : project.category === '第三课堂' ? 'thirdClassPoints' : project.category === '第四课堂' ? 'fourthClassPoints' : '';
      if (key) result[key] += project.score;
      return result;
    }, { secondClassPoints: 0, thirdClassPoints: 0, fourthClassPoints: 0 });
    summary = { ...totals, aestheticEducationPassed: null, laborEducationPassed: null, source: '素质拓展项目明细合计（汇总接口不可用）' };
  }
  return { summary, projects, warnings };
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

export function currentAcademicTerm(): { year: string; term: string } {
  return academicTerm();
}

function academicYearValue(value: string | undefined): string {
  const candidate = String(value || '').trim();
  return /^20\d{2}$/.test(candidate) ? candidate : academicTerm().year;
}

function termValue(value: string | undefined): string {
  return value === '2' ? '2' : '1';
}

function inferYearLevel(studentId: string, academicYear: string): string {
  const cleanId = studentId.trim();
  const fullYear = cleanId.match(/^(20\d{2})/)?.[1];
  // ZJU student IDs commonly use either a four-digit admission year or a
  // compact 3xx prefix such as 323/324 for 2023/2024 cohorts.
  const compactYear = cleanId.match(/^3(2\d)/)?.[1];
  const entryYear = fullYear ? Number(fullYear) : compactYear ? 2000 + Number(compactYear) : NaN;
  const startYear = Number(academicYear);
  if (!Number.isFinite(startYear) || startYear < entryYear - 1 || startYear > entryYear + 7) return '';
  return `大${Math.max(1, Math.min(8, startYear - entryYear + 1))}`;
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

function isCampusNetworkRestriction(body: string): boolean {
  return /仅限校内|校内网络|WebVPN|使用 VPN|使用VPN|VPN 访问|VPN访问/i.test(body);
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
    credit: field(item, ['xf', 'credit', 'course_credit', 'kcxzxf'], '—'),
    score: field(item, ['cj', 'score', 'original_score'], '—'),
    completed: false,
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
  const score = field(item, ['cj', 'score', 'original_score', 'cjbj'], '—');
  const point = field(item, ['jd', 'point', 'five_point', 'gpa'], '—');
  return {
    id: field(item, ['xkkh', 'kch', 'kcmc', 'grade_id'], `grade-${index}`),
    name: field(item, ['kcmc', 'course_name', 'courseName'], '未命名课程'),
    score,
    credit: field(item, ['xf', 'credit', 'course_credit'], '—'),
    point,
    semesterId: field(item, ['semester_id', 'semester', 'xq_id', 'xqmmc', 'xnm'], ''),
    courseKey: field(item, ['xkkh', 'course_key', 'kch'], ''),
    gpaIncluded: numberValue(field(item, ['xf', 'credit', 'course_credit'])) !== undefined && numberValue(point) !== undefined,
    gpaExclusionReason: numberValue(field(item, ['xf', 'credit', 'course_credit'])) !== undefined && numberValue(point) !== undefined ? '' : '成绩接口未提供可纳入绩点计算的学分或绩点。',
  };
}

function normalizeCourseOffering(item: CampusCourse, semesterId: string): CampusCourseOffering {
  return {
    id: item.id,
    name: item.name,
    semesterId,
    credit: item.credit,
    teachers: item.teacher,
    confirmed: null,
    online: null,
  };
}

function normalizeLearningCourse(item: Record<string, unknown>): CampusLearningCourse | null {
  const id = field(item, ['id', 'course_id', 'courseId', 'cid']);
  const name = field(item, ['name', 'title', 'course_name', 'courseName']);
  if (!id || !name) return null;
  return {
    id: id.slice(0, 100),
    name: name.slice(0, 240),
    code: field(item, ['code', 'course_code', 'courseCode']),
    teachers: field(item, ['teachers', 'teacher', 'instructor', 'instructors']),
    term: field(item, ['term', 'semester', 'semester_name', 'semesterName']),
    credit: field(item, ['credit', 'credits']),
    status: field(item, ['status', 'course_status', 'courseStatus']),
  };
}

function normalizeActivity(item: Record<string, unknown>, courseId: string): CampusActivity | null {
  const id = field(item, ['id', 'activity_id', 'activityId', 'aid']);
  const title = field(item, ['title', 'name', 'activity_name', 'activityName']);
  if (!id || !title) return null;
  const rawUrl = field(item, ['url', 'href', 'link']);
  let url = '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, COURSES_HOME);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'zju.edu.cn' || parsed.hostname.endsWith('.zju.edu.cn'))) url = parsed.toString();
    } catch {
      url = '';
    }
  }
  return {
    id: id.slice(0, 100),
    courseId,
    title: title.slice(0, 240),
    type: field(item, ['type', 'activity_type', 'activityType']),
    startTime: field(item, ['start_time', 'startTime', 'start_at', 'startAt']),
    endTime: field(item, ['end_time', 'endTime', 'end_at', 'endAt']),
    deadline: field(item, ['deadline', 'due_time', 'dueTime', 'due_at', 'dueAt']),
    status: field(item, ['status', 'state']),
    url,
  };
}

async function readSchedule(year: string, term: string): Promise<CampusCourse[]> {
  await loginZdbk();
  // The official form submits the full academic-year label and one
  // sub-semester at a time. Sending only the start year ("2026") or the
  // internal aggregate codes ("3"/"12") can return a valid-looking fallback
  // dataset from an older term.
  const academicYear = `${year}-${Number(year) + 1}`;
  const semesterCodes = term === '1' ? ['1|秋', '1|冬'] : ['2|春', '2|夏'];
  const result: CampusCourse[] = [];
  for (const semesterCode of semesterCodes) {
    const response = await request({ url: SCHEDULE_URL, method: 'POST', data: { xnm: academicYear, xqm: semesterCode, captcha_value: '' }, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
    const body = responseText(response);
    if (isCampusNetworkRestriction(body)) throw new CampusError('教务网提示需要校内网络；请先开启浙大 VPN 或 WebVPN 后再读取。', 'network');
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

function normalizedCourseName(value: string): string {
  return value.replace(/[\s()（）【】[\]·:：,，.。]/g, '').toLowerCase();
}

function gradeRecorded(score: string): boolean {
  const value = score.trim();
  return !!value && value !== '—' && value !== '-' && value !== '未录入' && value !== '暂无';
}

function gradePassed(score: string): boolean {
  const value = score.trim();
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric >= 60;
  if (/优秀|良好|中等|通过|合格|免修|免考|优|良/.test(value)) return true;
  return !/不及格|不通过|未通过|缺考|取消|缓考|违纪/.test(value) && value === '通过';
}

function enrichCoursesWithGrades(courses: CampusCourse[], grades: CampusGrade[]): CampusCourse[] {
  const byId = new Map(grades.map((grade) => [grade.id.trim(), grade]));
  const byName = new Map<string, CampusGrade>();
  for (const grade of grades) {
    const key = normalizedCourseName(grade.name);
    if (key && !byName.has(key)) byName.set(key, grade);
  }
  return courses.map((course) => {
    const grade = byId.get(course.id.trim()) || byName.get(normalizedCourseName(course.name));
    if (!grade) return course;
    return {
      ...course,
      credit: course.credit !== '—' ? course.credit : grade.credit,
      score: course.score !== '—' ? course.score : grade.score,
      completed: gradeRecorded(grade.score),
    };
  });
}

function md5Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 8) >> 6 << 6) + 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, bitLength >>> 0, true);
  view.setUint32(buffer.length - 4, Math.floor(bitLength / 0x100000000), true);
  const rotate = (value: number, amount: number) => (value << amount) | (value >>> (32 - amount));
  const add = (a: number, b: number) => (a + b) | 0;
  const sine = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0);
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;
  for (let offset = 0; offset < buffer.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getInt32(offset + index * 4, true));
    let a = a0; let b = b0; let c = c0; let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let functionValue: number; let wordIndex: number;
      if (index < 16) { functionValue = (b & c) | (~b & d); wordIndex = index; }
      else if (index < 32) { functionValue = (d & b) | (~d & c); wordIndex = (5 * index + 1) % 16; }
      else if (index < 48) { functionValue = b ^ c ^ d; wordIndex = (3 * index + 5) % 16; }
      else { functionValue = c ^ (b | ~d); wordIndex = (7 * index) % 16; }
      const next = add(add(add(a, functionValue), words[wordIndex]), sine[index]);
      const rotated = rotate(next, shifts[index]);
      const nextB = add(b, rotated);
      a = d; d = c; c = b; b = nextB;
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }
  const output = new Uint8Array(16);
  const result = new DataView(output.buffer);
  result.setInt32(0, a0, true); result.setInt32(4, b0, true); result.setInt32(8, c0, true); result.setInt32(12, d0, true);
  return [...output].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestPersonApi(path: string, data: Record<string, string>): Promise<unknown> {
  const payload: Record<string, string> = { ...data, lang: 'cn' };
  const timestamp = String(Date.now());
  const signatureInput = `${PERSON_SIGN_SECRET}${path}${Object.keys(payload).sort().map((key) => `${key}${payload[key]}`).join('')}${timestamp} ${PERSON_SIGN_SECRET}`;
  const params = new URLSearchParams(payload);
  const response = await request({
    url: `${PERSON_SERVER_URL}${path}?${params.toString()}`,
    headers: {
      appKey: PERSON_APP_KEY,
      sign: md5Hex(signatureInput),
      timestamp,
      Referer: PERSON_PORTAL_URL,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
    },
    responseType: 'text',
    disableRedirects: true,
  });
  if (response.status < 200 || response.status >= 300) throw new CampusError(`浙大教师门户暂时无法访问（HTTP ${response.status}）。`, 'network');
  const parsed = parseJson(response, '浙大教师门户');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Number((parsed as Record<string, unknown>).code) !== 200) {
    throw new CampusError('浙大教师门户返回了无法识别的数据。', 'response');
  }
  return (parsed as Record<string, unknown>).data;
}

function extractPublicContact(body: string, label: string): string {
  const escapedLabel = label;
  const patterns = [
    new RegExp(`<label[^>]*>\\s*${escapedLabel}\\s*</label>([\\s\\S]{0,360})`, 'i'),
    new RegExp(`<li[^>]*class=["'][^"']*(?:email|telephone)[^"']*["'][^>]*>([\\s\\S]{0,360})`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (!match?.[1]) continue;
    const segment = match[1].split(/<li\b/i)[0];
    const mailto = segment.match(/mailto:([^"' >]+)/i)?.[1];
    if (mailto) return decodeHtml(mailto);
    const value = cleanDisplayText(segment).replace(new RegExp(`^${escapedLabel}\\s*[:：]?\\s*`, 'i'), '').trim();
    if (value) return value.slice(0, 180);
  }
  const plainEmail = label === '邮箱'
    ? cleanDisplayText(body).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    : '';
  return plainEmail || '';
}

function officialProfileUrl(mappingName: string): string {
  return `${PERSON_PORTAL_URL}${encodeURIComponent(mappingName)}/0.html`;
}

async function readInstitutionLinks(query: string): Promise<{ title: string; url: string; source: string }[]> {
  try {
    const response = await request({ url: ZJU_INSTITUTION_DIRECTORY_URL, responseType: 'text', disableRedirects: true });
    if (response.status < 200 || response.status >= 300) return [];
    const needle = query.replace(/[\s（）()]/g, '').toLowerCase();
    const links: { title: string; url: string; source: string }[] = [];
    const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of responseText(response).matchAll(anchorPattern)) {
      const title = cleanDisplayText(match[2] || '');
      const normalizedTitle = title.replace(/[\s（）()]/g, '').toLowerCase();
      if (!title || !normalizedTitle.includes(needle)) continue;
      try {
        const parsed = new URL(decodeHtml(match[1]), ZJU_INSTITUTION_DIRECTORY_URL);
        if (parsed.protocol !== 'https:' || !(parsed.hostname === 'www.zju.edu.cn' || parsed.hostname.endsWith('.zju.edu.cn'))) continue;
        links.push({ title: `打开${title}官网`, url: parsed.toString(), source: '浙江大学官网院系目录' });
      } catch {
        // Ignore malformed links in the public directory.
      }
      if (links.length >= 4) break;
    }
    return links;
  } catch {
    return [];
  }
}

export interface CampusPublicInfoResult {
  status: 'ok' | 'not_found';
  query: string;
  category: CampusPublicCategory;
  results: CampusPublicInfo[];
  links: { title: string; url: string; source: string }[];
  reason?: string;
}

export async function readPublicCollegeInfo(query: string, category: CampusPublicCategory = 'all'): Promise<CampusPublicInfoResult> {
  assertNative();
  const cleanQuery = query.trim().slice(0, 80);
  if (!cleanQuery) throw new CampusError('请提供要查询的教师或院系名称。', 'response');
  const links = [
    { title: '浙江大学学院（系）目录', url: ZJU_INSTITUTION_DIRECTORY_URL, source: '浙江大学官网' },
    { title: '浙江大学教师个人主页门户', url: PERSON_PORTAL_URL, source: '浙江大学教师个人主页门户' },
  ];
  if (category === 'program' || category === 'labs') links.push(...await readInstitutionLinks(cleanQuery));
  const data = await requestPersonApi('/api/front/psons/search', { q: cleanQuery, page: '0', size: '8' });
  const items = listFromPayload(data, ['content']).slice(0, 8);
  const results: CampusPublicInfo[] = [];
  for (const item of items) {
    const name = field(item, ['cn_name', 'name']);
    const mappingName = field(item, ['mapping_name', 'mappingName']);
    if (!name || !mappingName) continue;
    const title = field(item, ['work_title_name', 'work_title'], '教师');
    const college = field(item, ['college_name', 'collegeName'], '浙江大学');
    if (category === 'program' || category === 'labs') continue;
    const profileUrl = officialProfileUrl(mappingName);
    let phone = ''; let email = '';
    try {
      const profile = await followGet(profileUrl);
      if (profile.status >= 200 && profile.status < 300) {
        const body = responseText(profile);
        phone = extractPublicContact(body, '电话');
        email = extractPublicContact(body, '邮箱');
      }
    } catch {
      // Keep the official profile URL even if the optional detail page is unavailable.
    }
    results.push({ id: String(item.id || mappingName), name, college, title, phone, email, profileUrl, sourceUrl: profileUrl, source: '浙江大学教师个人主页门户' });
  }
  return {
    status: results.length || links.length > 2 ? 'ok' : 'not_found',
    query: cleanQuery,
    category,
    results,
    links,
    reason: results.length ? undefined : '官方教师门户没有找到匹配结果；可以打开学院目录继续查找公开页面。',
  };
}

function metaRefresh(body: string, source: string): string | undefined {
  const match = body.match(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'; >]+)/i) || body.match(/<meta\b[^>]*content=["'][^"']*url=([^"'; >]+)[^"']*[^>]*http-equiv=["']?refresh/i);
  if (!match?.[1]) return undefined;
  try { return routedUrl(decodeHtml(match[1]), source); } catch { return undefined; }
}

async function ensureCoursesSession(): Promise<void> {
  let current = routedUrl(COURSES_HOME);
  for (let index = 0; index < 8; index += 1) {
    const response = await request({ url: current, responseType: 'text', disableRedirects: true });
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, 'location');
      if (!location) throw new CampusError('学在浙大登录跳转缺少目标地址。', 'authentication');
      current = routedUrl(location, current);
      continue;
    }
    const body = responseText(response);
    if (response.status < 200 || response.status >= 300) throw new CampusError(`学在浙大登录失败（HTTP ${response.status}）。`, 'authentication');
    if (isAuthenticationPage(body)) throw new CampusError('学在浙大没有建立登录会话，请重新读取。', 'authentication');
    const target = metaRefresh(body, current);
    if (target) { current = target; continue; }
    break;
  }
  if (campusTransport === 'direct' && !activeCookieJar?.has('session', campusCookieHost('courses.zju.edu.cn'))) {
    throw new CampusError('学在浙大没有建立可用登录会话，请重新读取。', 'authentication');
  }
}

async function readLearningCourses(): Promise<CampusLearningCourse[]> {
  await ensureCoursesSession();
  const response = await request({ url: MY_COURSES_URL, responseType: 'text', disableRedirects: true });
  const body = responseText(response);
  if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('学在浙大登录态已失效，请重新读取。', 'authentication');
  const courses = listFromPayload(parseJson(response, '学在浙大课程'), ['courses', 'course_list', 'items', 'data', 'results'])
    .map(normalizeLearningCourse)
    .filter((item): item is CampusLearningCourse => item !== null);
  const seen = new Set<string>();
  return courses.filter((course) => {
    if (seen.has(course.id)) return false;
    seen.add(course.id);
    return true;
  }).slice(0, 500);
}

export async function readLearningActivities(studentId: string, password: string, courseId: string): Promise<CampusActivity[]> {
  assertNative();
  const cleanId = studentId.trim();
  const cleanCourseId = courseId.trim();
  if (!cleanId || !password) throw new CampusError('请先填写学号和校园密码。', 'credentials');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cleanCourseId)) throw new CampusError('学在浙大课程编号格式不正确。', 'response');
  campusTransport = 'direct';
  activeCampusCredentials = { studentId: cleanId, password };
  activeCookieJar = new CookieJar();
  try {
    await clearCampusCookies();
    try {
      await authenticate(cleanId, password);
    } catch (error) {
      if (error instanceof CampusError && error.code === 'network') {
        await activateWebVpn();
      } else {
        throw error;
      }
    }
    await ensureCoursesSession();
    const response = await request({ url: COURSE_ACTIVITIES_URL.replace('{courseId}', encodeURIComponent(cleanCourseId)), responseType: 'text', disableRedirects: true });
    const body = responseText(response);
    if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('学在浙大登录态已失效，请重新读取。', 'authentication');
    const activities = listFromPayload(parseJson(response, '学在浙大课程活动'), ['activities', 'activity_list', 'items', 'data', 'results'])
      .map((item) => normalizeActivity(item, cleanCourseId))
      .filter((item): item is CampusActivity => item !== null);
    const seen = new Set<string>();
    return activities.filter((activity) => {
      if (seen.has(activity.id)) return false;
      seen.add(activity.id);
      return true;
    }).slice(0, 500);
  } finally {
    activeCookieJar = null;
    zdbkSessionReady = false;
    campusTransport = 'direct';
    activeCampusCredentials = null;
  }
}

async function readTodos(): Promise<CampusTodo[]> {
  await ensureCoursesSession();
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

export async function readPublicNotices(query = '', page = 1, options: { college?: string; category?: CampusPublicCategory; detail?: boolean } = {}): Promise<CampusNoticeResult> {
  assertNative();
  const safeQuery = query.trim().slice(0, 100);
  const safeCollege = (options.college || '').trim().slice(0, 80);
  const category = options.category || 'all';
  const safePage = Math.max(1, Math.min(50, Math.trunc(page) || 1));
  const searchTerms = [safeQuery, safeCollege].filter(Boolean);
  const collegeCore = safeQuery.match(/([\u4e00-\u9fa5]{2,})(?=学院|系|书院)/)?.[1];
  const withoutCollege = safeQuery.replace(/学院|系|书院/g, '').trim();
  const categoryHint = category === 'program' ? '培养' : category === 'faculty' ? '师资' : category === 'contact' ? '联系' : category === 'labs' ? '实验室' : '';
  for (const candidate of [collegeCore, withoutCollege, categoryHint, '转专业', '选课', '考试', '开学', '奖学金', '毕业']) {
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
  const notices: CampusNotice[] = rawItems.slice(0, 20).flatMap((item, index) => {
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
      category,
    } satisfies CampusNotice];
  });
  if (options.detail && notices.length) {
    for (const notice of notices.slice(0, 3)) {
      try {
        const detailResponse = await followGet(notice.url);
        if (detailResponse.status >= 200 && detailResponse.status < 300) {
          notice.detail = cleanDisplayText(responseText(detailResponse)).slice(0, 6000);
          notice.detailSource = '浙江大学本科教学管理信息服务平台官方详情页';
        }
      } catch {
        // Keep the list result and official link when optional detail is unavailable.
      }
    }
  }
  const totalCandidate = Number(rawPayload.totalCount ?? rawPayload.totalResult ?? rawPayload.total ?? notices.length);
  return { notices, page: safePage, totalAvailable: Number.isFinite(totalCandidate) && totalCandidate >= 0 ? totalCandidate : notices.length };
}

function academicDate(academicYear: string, month: number, day: number): string | null {
  const startYear = Number(academicYear.slice(0, 4));
  const year = month <= 7 ? startYear + 1 : startYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function readHolidayEvents(body: string, academicYear: string, source: string): CampusHoliday[] {
  const text = cleanDisplayText(body).replace(/\s+/g, '');
  const events: CampusHoliday[] = [];
  for (const title of ['中秋节', '国庆节']) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${escaped}.{0,100}?(\\d{1,2})月(\\d{1,2})日.{0,60}?(?:至|到|—|-)\\s*(?:(\\d{1,2})月)?(\\d{1,2})日`, 'i'));
    if (!match) continue;
    const startDate = academicDate(academicYear, Number(match[1]), Number(match[2]));
    const endDate = academicDate(academicYear, Number(match[3] || match[1]), Number(match[4]));
    if (!startDate || !endDate) continue;
    events.push({
      id: title === '中秋节' ? 'mid-autumn-festival' : 'national-day',
      title,
      startDate,
      endDate,
      kind: 'holiday',
      note: '仅采用浙大官方教学安排页面明确写出的日期。',
      source,
    });
  }
  const studentDay = text.match(/浙江大学学生节.*?(\d{1,2})月(\d{1,2})日.*?停课.*?(20\d{2})年(\d{1,2})月(\d{1,2})日.*?补课/);
  if (studentDay) {
    const startDate = academicDate(academicYear, Number(studentDay[1]), Number(studentDay[2]));
    const makeupDate = `${studentDay[3]}-${String(Number(studentDay[4])).padStart(2, '0')}-${String(Number(studentDay[5])).padStart(2, '0')}`;
    if (startDate) events.push({ id: 'zju-student-day', title: '浙江大学学生节', startDate, endDate: startDate, kind: 'campus_event', note: `停课，${makeupDate}补课。`, source });
  }
  return events;
}

export async function readPublicHolidays(academicYear: string): Promise<CampusHoliday[]> {
  assertNative();
  const safeYear = /^20\d{2}-20\d{2}$/.test(academicYear) ? academicYear : currentAcademicTerm().year + '-' + (Number(currentAcademicTerm().year) + 1);
  let index = await request({ url: CALENDAR_LIST_URL, responseType: 'text', disableRedirects: true });
  if (index.status < 200 || index.status >= 300) index = await request({ url: CALENDAR_LIST_FALLBACK_URL, responseType: 'text', disableRedirects: true });
  if (index.status < 200 || index.status >= 300) throw new CampusError(`浙大官方校历列表暂时无法访问（HTTP ${index.status}）。`, 'network');
  const indexBody = responseText(index);
  const links = [...indexBody.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap((match) => {
    const title = cleanDisplayText(match[2] || '');
    if (!title.replace(/[—–]/g, '-').includes(`${safeYear}学年校历`) && !match[1].includes(safeYear)) return [];
    try {
      const url = routedUrl(decodeHtml(match[1]), CALENDAR_LIST_URL);
      return [{ title, url }];
    } catch { return []; }
  });
  const page = links[0];
  if (!page) return [];
  const pageResponse = await followGet(page.url);
  if (pageResponse.status < 200 || pageResponse.status >= 300) throw new CampusError(`浙大官方校历页面暂时无法访问（HTTP ${pageResponse.status}）。`, 'network');
  return readHolidayEvents(responseText(pageResponse), safeYear, page.url);
}

function makeGradeAlerts(grades: CampusGrade[]): CampusGradeAlert[] {
  return grades.flatMap((grade) => {
    const numeric = numberValue(grade.score);
    const failed = (numeric !== undefined && numeric < 60) || /不及格|不通过|挂科|未通过/.test(grade.score);
    const attention = !failed && ((numeric !== undefined && numeric >= 60 && numeric < 70) || (numberValue(grade.point) !== undefined && Number(grade.point) < 3));
    if (!failed && !attention) return [];
    return [{ id: grade.id, courseKey: grade.courseKey || grade.id, name: grade.name, credit: grade.credit, score: grade.score, point: grade.point, level: failed ? 'failed' : 'attention', note: '按成绩原值/绩点做的提示，不代表学校最终的补考、重修或学籍认定。' } satisfies CampusGradeAlert];
  });
}

function makeGpaSummary(grades: CampusGrade[], semesterId?: string): CampusGpaSummary | null {
  const scoped = semesterId ? grades.filter((grade) => grade.semesterId === semesterId) : grades;
  if (!scoped.length) return null;
  const eligible = scoped.filter((grade) => numberValue(grade.credit) !== undefined);
  const counted = eligible.filter((grade) => numberValue(grade.point) !== undefined);
  const denominator = counted.reduce((sum, grade) => sum + (numberValue(grade.credit) || 0), 0);
  const gpa = denominator ? counted.reduce((sum, grade) => sum + (numberValue(grade.credit) || 0) * (numberValue(grade.point) || 0), 0) / denominator : null;
  return {
    ...(semesterId ? { semesterId } : {}),
    throughSemester: semesterId || 'all_available',
    gpa: gpa === null ? null : Number(gpa.toFixed(3)),
    creditDenominator: Number(denominator.toFixed(3)),
    eligibleAttempts: eligible.length,
    countedAttempts: counted.length,
    excludedAttempts: eligible.length - counted.length,
    complete: false,
    note: '教务成绩接口未返回重修取舍和学期排除口径，仅按可用成绩、绩点和学分计算近似汇总。',
  };
}

function errorText(error: unknown): string {
  return error instanceof CampusError ? error.message : error instanceof Error ? error.message : '读取失败';
}

function isFatalModuleError(error: unknown): boolean {
  return error instanceof CampusError && (error.code === 'authentication' || error.code === 'captcha');
}

export async function readCampusInfo(studentId: string, password: string, options: { academicYear?: string; term?: string } = {}): Promise<MobileCampusData> {
  assertNative();
  const cleanId = studentId.trim();
  if (!cleanId || !password) throw new CampusError('请先填写学号和校园密码。', 'credentials');
  campusTransport = 'direct';
  activeCampusCredentials = { studentId: cleanId, password };
  activeCookieJar = new CookieJar();
  try {
    await clearCampusCookies();
    try {
      await authenticate(cleanId, password);
    } catch (error) {
      if (error instanceof CampusError && error.code === 'network') {
        await activateWebVpn();
      } else {
        throw error;
      }
    }
    const year = academicYearValue(options.academicYear);
    const term = termValue(options.term || academicTerm().term);
    const warnings: string[] = [];
    let courses: CampusCourse[] = [];
    let courseOfferings: CampusCourseOffering[] = [];
    let learningCourses: CampusLearningCourse[] = [];
    let activities: CampusActivity[] = [];
    let exams: CampusExam[] = [];
    let grades: CampusGrade[] = [];
    let gradeAlerts: CampusGradeAlert[] = [];
    let gpaSemesters: CampusGpaSummary[] = [];
    let gpaCumulative: CampusGpaSummary | null = null;
    let todos: CampusTodo[] = [];
    let practiceSummary: CampusPracticeSummary | null = null;
    let practiceProjects: CampusPracticeProject[] = [];
    let holidays: CampusHoliday[] = [];
    let successfulModules = 0;

    try { courses = await readSchedule(year, term); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`课表：${errorText(error)}`); }
    courseOfferings = [...new Map(courses.map((course) => [course.id, normalizeCourseOffering(course, `${year}-${term}`)])).values()];
    try { exams = await readExams(); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`考试：${errorText(error)}`); }
    try { grades = await readGrades(); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`成绩：${errorText(error)}`); }
    try {
      learningCourses = await readLearningCourses();
      successfulModules += 1;
    } catch (error) {
      if (isFatalModuleError(error)) throw error;
      warnings.push(`学在浙大课程：${errorText(error)}`);
    }
    try { todos = await readTodos(); successfulModules += 1; } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`待办：${errorText(error)}`); }
    try {
      const practice = await readPractice();
      practiceSummary = practice.summary;
      practiceProjects = practice.projects;
      warnings.push(...practice.warnings);
      successfulModules += 1;
    } catch (error) {
      warnings.push(`体育与素质拓展：${errorText(error)}`);
    }
    try {
      holidays = await readPublicHolidays(`${year}-${Number(year) + 1}`);
      successfulModules += 1;
    } catch (error) {
      warnings.push(`校历：${errorText(error)}`);
    }
    if (!successfulModules && warnings.length) throw new CampusError(warnings.join('；'), 'response');

    courses = enrichCoursesWithGrades(courses, grades);
    courseOfferings = [...new Map(courses.map((course) => [course.id, normalizeCourseOffering(course, `${year}-${term}`)])).values()];
    gradeAlerts = makeGradeAlerts(grades);
    gpaCumulative = makeGpaSummary(grades);
    const semesterIds = [...new Set(grades.map((grade) => grade.semesterId).filter((item): item is string => Boolean(item)))];
    gpaSemesters = semesterIds.flatMap((semesterId) => {
      const summary = makeGpaSummary(grades, semesterId);
      return summary ? [summary] : [];
    });
    const countedGrades = grades.flatMap((grade) => {
      const credit = numberValue(grade.credit);
      const point = numberValue(grade.point);
      return credit !== undefined && credit > 0 ? [{ credit, point }] : [];
    });
    const totalCredit = countedGrades.reduce((sum, grade) => sum + grade.credit, 0);
    const completedCredit = grades.reduce((sum, grade) => {
      const credit = numberValue(grade.credit);
      return credit !== undefined && credit > 0 && gradeRecorded(grade.score) ? sum + credit : sum;
    }, 0);
    const earnedCredit = grades.reduce((sum, grade) => {
      const credit = numberValue(grade.credit);
      return credit !== undefined && credit > 0 && gradePassed(grade.score) ? sum + credit : sum;
    }, 0);
    const gpaGrades = countedGrades.filter((grade): grade is { credit: number; point: number } => grade.point !== undefined && Number.isFinite(grade.point));
    const gpaDenominator = gpaGrades.reduce((sum, grade) => sum + grade.credit, 0);
    const gpa = gpaDenominator ? gpaGrades.reduce((sum, grade) => sum + grade.credit * grade.point, 0) / gpaDenominator : null;
    return {
      fetchedAt: new Date().toISOString(),
      academicYear: year,
      term,
      courses,
      courseOfferings,
      learningCourses,
      activities,
      exams,
      grades,
      gradeAlerts,
      gpaSemesters,
      gpaCumulative,
      todos,
      practiceSummary,
      practiceProjects,
      gpa,
      totalCredit,
      completedCredit,
      earnedCredit,
      yearLevel: inferYearLevel(cleanId, year),
      holidays,
      sourceStatus: {
        available: true,
        credentialsConfigured: true,
        authStatus: 'credentials_saved',
        supportedDomains: ['schedule', 'courses', 'learning_courses', 'activities', 'exams', 'assignments', 'grades', 'grade_alerts', 'gpa', 'gpa_semesters', 'gpa_cumulative', 'practice', 'sports', 'projects', 'holidays', 'notices', 'source_status'],
        note: '手机端使用浙江大学官方只读来源；未执行任何教务写操作。',
      },
      warnings,
    };
  } finally {
    activeCookieJar = null;
    zdbkSessionReady = false;
    campusTransport = 'direct';
    activeCampusCredentials = null;
  }
}
