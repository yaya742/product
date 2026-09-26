import { Capacitor, CapacitorCookies, CapacitorHttp, registerPlugin } from '@capacitor/core';
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
import { normalizeOfficialCourseUrl, normalizeTodoDetails, officialActivityUrl } from './todoDetails';

const LOGIN_URL = 'https://zjuam.zju.edu.cn/cas/login';
const PUBLIC_KEY_URL = 'https://zjuam.zju.edu.cn/cas/v2/getPubKey';
const ZDBK_HOME = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html';
const ZDBK_SERVICE = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html';
const SCHEDULE_URL = 'https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151';
const CHOSEN_COURSES_URL = 'https://zdbk.zju.edu.cn/jwglxt/xsxk/zzxkghb_cxZzxkGhbChoosed.html?gnmkdm=N253530';
const COURSE_CATALOG_URL = 'https://zdbk.zju.edu.cn/jwglxt/xsxk/zzxkghb_cxZzxkGhbDdkcList.html?gnmkdm=N253530';
const EXAMS_URL = 'https://zdbk.zju.edu.cn/jwglxt/xskscx/kscx_cxXsgrksIndex.html?doType=query&queryModel.showCount=5000';
const GRADES_URL = 'https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000';
const COURSES_HOME = 'https://courses.zju.edu.cn/user/index';
export const COURSES_HOME_URL = COURSES_HOME;
const TODOS_URL = 'https://courses.zju.edu.cn/api/todos';
const MY_COURSES_URL = 'https://courses.zju.edu.cn/api/my-courses';
const COURSE_ACTIVITIES_URL = 'https://courses.zju.edu.cn/api/courses/{courseId}/activities';
const COURSE_ACTIVITY_DETAIL_URL = 'https://courses.zju.edu.cn/api/activities/{activityId}';
const COURSE_ACTIVITY_REFERENCES_URL = 'https://courses.zju.edu.cn/api/activities/{activityId}/upload_references';
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
// Android's CookieManager and CapacitorHttp do not always observe a cookie
// write in the same event loop turn. A short settle window after every
// Set-Cookie response prevents intermittent CAS/WebVPN session loss.
const NATIVE_COOKIE_SYNC_DELAY_MS = 800;

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

interface CourseCreditRecord {
  id: string;
  courseKey: string;
  name: string;
  credit: string;
}

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

interface IsolatedHttpPlugin {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    responseType?: 'text' | 'arraybuffer';
    disableRedirects?: boolean;
    maxResponseBytes?: number;
  }): Promise<HttpResult>;
}

const IsolatedHttp = registerPlugin<IsolatedHttpPlugin>('IsolatedHttp');

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
        if (attribute === 'path' && attributeValue.startsWith('/')) {
          path = attributeValue;
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
        // A proxied target cookie may carry the original target path (for
        // example /dekt). The browser actually sends it to /https/<route>/dekt,
        // so retaining that original path prevents SESSION from reaching
        // /dekt/ctx. All cookies observed on the gateway are scoped to the
        // gateway root in this connector.
        domain = source.hostname;
        path = '/';
      }

      const key = `${name}\u0000${domain}\u0000${path}`;
      if (remove) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, domain, path, secure, expiresAt });
    }
  }

  remove(name: string, hostSuffix?: string) {
    const normalizedSuffix = hostSuffix?.replace(/^\./, '').toLowerCase();
    for (const [key, cookie] of this.cookies.entries()) {
      if (cookie.name !== name) continue;
      if (normalizedSuffix && !hostMatches(cookie.domain, normalizedSuffix)) continue;
      this.cookies.delete(key);
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

  headerFor(targetUrl: string, excludedNames: ReadonlySet<string> = new Set()): string {
    const target = new URL(targetUrl);
    return [...this.cookies.values()]
      .filter((cookie) => !excludedNames.has(cookie.name))
      .filter((cookie) => !isExpired(cookie) && (!cookie.secure || target.protocol === 'https:'))
      .filter((cookie) => hostMatches(target.hostname, cookie.domain) && pathMatches(target.pathname, cookie.path))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}

let activeCookieJar: CookieJar | null = null;
// The practice connector must not share Capacitor's process-wide CookieHandler
// with academic, course or WebVPN requests. Its cookies are passed explicitly
// through the native IsolatedHttp transport below.
let practiceCookieJar: CookieJar | null = null;
let practiceLoginPromise: Promise<string> | null = null;
let zdbkSessionReady = false;
let campusTransport: CampusTransport = 'direct';
let activeCampusCredentials: { studentId: string; password: string } | null = null;
let backgroundRunnerMode = false;
// Keep a good response for each half-semester so a transient empty or
// malformed response cannot erase a timetable that was already read.
const scheduleCache = new Map<string, CampusCourse[]>();
let scheduleReadWarning = '';

function assertNative(allowBackgroundRunner = false) {
  if (!allowBackgroundRunner && !Capacitor.isNativePlatform()) {
    throw new CampusError('请安装 APK 后读取校园信息。浏览器预览不具备校方登录所需的原生网络能力。', 'native_required');
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

function waitForNativeCookieSync(): Promise<void> {
  if (backgroundRunnerMode) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, NATIVE_COOKIE_SYNC_DELAY_MS));
}

interface CampusNativeHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  responseType: 'text' | 'arraybuffer';
}

declare global {
  // The Android WorkManager runner provides a synchronous native HTTP bridge
  // through its CapacitorKV adapter. Requests remain redirect-disabled in
  // IsolatedHttp and are individually checked against the ZJU host allowlist.
  var CapacitorKV: { get(key: string): { value?: string | null } } | undefined;
}

function requestThroughBackgroundBridge(options: CampusNativeHttpRequest): HttpResult {
  const bridge = globalThis.CapacitorKV;
  if (!bridge) throw new CampusError('后台校园读取通道不可用。', 'network');
  const raw = bridge.get(`zaichang-campus-http:${JSON.stringify(options)}`)?.value;
  if (typeof raw !== 'string') throw new CampusError('后台校园读取没有返回网络响应。', 'network');
  try {
    const result = JSON.parse(raw) as HttpResult;
    if (typeof result.status !== 'number' || typeof result.url !== 'string' || !result.headers || typeof result.headers !== 'object') {
      throw new Error('invalid_http_result');
    }
    return result;
  } catch {
    throw new CampusError('后台校园读取返回了无法识别的网络响应。', 'response');
  }
}

function responseText(result: HttpResult): string {
  const value = result.data;
  if (typeof value === 'string') {
    const normalized = value.replace(/^\uFEFF/, '');
    // Some Capacitor/Android combinations return a text response as a JSON
    // encoded string even when responseType is "text".
    if (normalized.trim().startsWith('"')) {
      try {
        const decoded = JSON.parse(normalized);
        if (typeof decoded === 'string') return decoded.replace(/^\uFEFF/, '');
      } catch {
        // Keep the original response when it is ordinary HTML/text.
      }
    }
    return normalized;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['body', 'text', 'html', 'content', 'data']) {
      if (typeof record[key] === 'string') return record[key].replace(/^\uFEFF/, '');
    }
  }
  return asText(value);
}

function decodeBase64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Decode the raw WebVPN response before parsing its form or JSON payload. */
async function responseArrayBufferText(result: HttpResult): Promise<string> {
  if (typeof result.data !== 'string') return responseText(result);
  const bytes = decodeBase64Bytes(result.data);
  const contentEncoding = headerValue(result.headers, 'content-encoding').toLowerCase();
  const isGzip = contentEncoding.includes('gzip') || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  const isDeflate = contentEncoding.includes('deflate') || bytes[0] === 0x78;
  let decodedBytes = bytes;
  if (isGzip || isDeflate) {
    if (typeof DecompressionStream === 'undefined') {
      throw new CampusError('手机运行环境不支持解压 WebVPN 登录响应，请升级 Android System WebView 后重试。', 'network');
    }
    const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream(isGzip ? 'gzip' : 'deflate'));
    decodedBytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new TextDecoder('utf-8').decode(decodedBytes).replace(/^\uFEFF/, '');
}

function headerValue(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  const value = entry?.[1] as unknown;
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function splitSetCookieHeader(value: string): string[] {
  // Android may join multiple Set-Cookie headers with a comma. Keep commas
  // inside Expires attributes intact.
  return value.replace(/\r?\n/g, ',').split(/,(?=\s*[^;,=\s]+\s*=)/g).map((item) => item.trim()).filter(Boolean);
}

/**
 * CapacitorHttp uses Android's CookieHandler, while the JS bridge only sees
 * the normalized response headers. Some Android/WebView versions do not
 * expose every Set-Cookie header back to JavaScript consistently. Persisting
 * the cookies explicitly keeps the native request layer and this read-only
 * connector on the same WebVPN/CAS session.
 */
async function persistNativeResponseCookies(headers: Record<string, string>, sourceUrl: string): Promise<boolean> {
  const setCookie = headerValue(headers, 'set-cookie');
  if (!setCookie) return false;
  let source: URL;
  try { source = new URL(sourceUrl); } catch { return false; }

  for (const rawCookie of splitSetCookieHeader(setCookie)) {
    const segments = rawCookie.split(';').map((segment) => segment.trim()).filter(Boolean);
    const pair = segments.shift();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key) continue;

    let path = defaultCookiePath(source.pathname);
    let expires = '';
    let remove = !value;
    for (const segment of segments) {
      const attributeSeparator = segment.indexOf('=');
      const attribute = (attributeSeparator >= 0 ? segment.slice(0, attributeSeparator) : segment).trim().toLowerCase();
      const attributeValue = attributeSeparator >= 0 ? segment.slice(attributeSeparator + 1).trim() : '';
      if (attribute === 'path' && attributeValue.startsWith('/')) path = attributeValue;
      if (attribute === 'expires' && attributeValue) {
        expires = attributeValue;
        const timestamp = Date.parse(attributeValue);
        if (Number.isFinite(timestamp) && timestamp <= Date.now()) remove = true;
      }
      if (attribute === 'max-age') {
        const seconds = Number(attributeValue);
        if (Number.isFinite(seconds) && seconds <= 0) remove = true;
      }
    }
    if (source.hostname.toLowerCase() === WEBVPN_HOST) path = '/';

    try {
      if (remove) {
        await CapacitorCookies.deleteCookie({ url: sourceUrl, key });
      } else {
        await CapacitorCookies.setCookie({ url: sourceUrl, key, value, path, ...(expires ? { expires } : {}) });
      }
    } catch {
      // The JS CookieJar remains the fallback when the native cookie bridge
      // is unavailable on an older Capacitor runtime.
    }
  }
  return true;
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
  responseType?: 'text' | 'json' | 'arraybuffer';
  disableRedirects?: boolean;
  allowWebVpn?: boolean;
  useCookieJar?: boolean;
  cookieHeader?: string;
  cookieJar?: CookieJar;
  isolated?: boolean;
}): Promise<HttpResult> {
  if (!backgroundRunnerMode && isMobileVmOffline()) throw new CampusError('虚拟机已模拟断网，校园请求未发送。', 'network');
  assertNative(backgroundRunnerMode);
  const url = trustedUrl(routedUrl(options.url), undefined, { allowWebVpn: options.allowWebVpn || campusTransport === 'webvpn' });
  try {
    const requestHeaders: Record<string, string> = { ...options.headers };
    const referer = headerValue(requestHeaders, 'referer');
    if (referer) requestHeaders.Referer = routedUrl(referer);
    // Direct campus requests need the JS fallback because some Android
    // Capacitor versions do not expose a freshly captured target cookie to
    // HttpURLConnection quickly enough. When WebVPN has just returned the
    // proxied target SESSION, explicitly carry the JS jar for that request
    // too; otherwise some Android versions send only the gateway cookies and
    // /dekt/ctx falls back to the anonymous context. Requests without a
    // target SESSION still rely on the native CookieHandler to avoid
    // duplicating the gateway ticket.
    const cookieJar = options.cookieJar || activeCookieJar;
    const hasProxiedSztzSession = campusTransport === 'webvpn' && cookieJar?.has('SESSION', WEBVPN_HOST);
    const scopedCookieHeader = options.useCookieJar && (campusTransport === 'direct' || hasProxiedSztzSession)
      ? cookieJar?.headerFor(url)
      : '';
    const sharedAuthCookieHeader = options.isolated && activeCookieJar && activeCookieJar !== cookieJar
      ? activeCookieJar.headerFor(url, new Set(['SESSION']))
      : '';
    const cookieHeader = options.cookieHeader?.trim() || [sharedAuthCookieHeader, scopedCookieHeader].filter(Boolean).join('; ');
    if (cookieHeader && !headerValue(requestHeaders, 'cookie')) {
      requestHeaders.Cookie = cookieHeader;
    }
    const headers: Record<string, string> = {
      'User-Agent': 'Zaichang-ZJU-Connector/0.2 (Android; read-only)',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      // CapacitorHttp's Android response reader does not transparently
      // decode every Content-Encoding variant. A compressed login form can
      // look like HTML but lose its _csrf field during text conversion.
      'Accept-Encoding': 'identity',
      ...requestHeaders,
    };
    const body = options.data ? new URLSearchParams(options.data).toString() : undefined;
    const result = backgroundRunnerMode
      ? requestThroughBackgroundBridge({
        url,
        method: options.method || 'GET',
        headers,
        body,
        responseType: options.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
      })
      : options.isolated
        ? await IsolatedHttp.request({
        url,
        method: options.method || 'GET',
        headers,
        body,
        responseType: options.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
        disableRedirects: options.disableRedirects ?? true,
        })
        : await CapacitorHttp.request({
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
    cookieJar?.capture(normalizedHeaders, url);
    // Do not start the next CAS/WebVPN request until the native cookie store
    // has had time to expose the Set-Cookie values to HttpURLConnection.
    if (!backgroundRunnerMode && !options.isolated && await persistNativeResponseCookies(normalizedHeaders, url)) await waitForNativeCookieSync();
    return { status: result.status, data: result.data, headers: normalizedHeaders, url: result.url || url };
  } catch (error) {
    if (error instanceof CampusError) throw error;
    throw new CampusError(error instanceof Error ? error.message : '无法连接校方服务，请检查网络。', 'network');
  }
}

async function followGet(
  startUrl: string,
  headers?: Record<string, string>,
  responseType: 'text' | 'arraybuffer' = 'text',
  useCookieJar = false,
  isolated = false,
): Promise<HttpResult> {
  let current = routedUrl(startUrl);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await request({ url: current, headers, responseType, disableRedirects: true, allowWebVpn: campusTransport === 'webvpn', useCookieJar, isolated });
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
  const candidates = body === decodeHtml(body) ? [body] : [body, decodeHtml(body)];
  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const value = candidate.match(pattern)?.[1];
      if (value !== undefined) return decodeHtml(value);
    }
  }
  // Keep working when the gateway changes attribute order or omits the
  // optional value attribute in its server-rendered form.
  try {
    const parsed = new DOMParser().parseFromString(body, 'text/html');
    const input = parsed.querySelector(`input[name="${name.replace(/"/g, '\\"')}"]`);
    return input?.getAttribute('value') || '';
  } catch {
    // The native runtime may not expose DOMParser; the regex path above is
    // still sufficient for the current gateway.
  }
  return '';
}

function webVpnPageHint(body: string): string {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();
  const markers = [
    ['登录表单', /name\s*=\s*["']username["']/i.test(body) && /name\s*=\s*["']password["']/i.test(body)],
    ['WebVPN 页面', /WebVPN|wengine-vpn/i.test(body)],
    ['验证码', /验证码|captcha|slider/i.test(body)],
    ['会话提示', /会话|session|登录失效|重新登录/i.test(body)],
    ['网关错误', /错误|异常|error|forbidden|拒绝/i.test(body)],
  ].filter(([, matched]) => matched).map(([label]) => label);
  return [title ? `标题：${title.slice(0, 40)}` : '', markers.length ? `特征：${markers.join('、')}` : '特征：未识别'].filter(Boolean).join('；');
}

function isWebVpnResourcePortalPage(body: string): boolean {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
  return /WebVPN\s*[-—–]\s*资源站点/i.test(title)
    || /WebVPN[^<]{0,80}资源站点/i.test(body);
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
  const noCacheHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
  };
  let loginPage: HttpResult | null = null;
  let body = '';
  let loginPageHasForm = false;
  let loginPageIsPortal = false;
  // The Android WebView cookie bridge writes/clears cookies asynchronously.
  // Retry the two known gateway entry points after a short gap so a stale
  // session cannot make the fresh form appear without its session-bound CSRF.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const entry of ['/', '/login']) {
      const candidate = await followGet(
        `${WEBVPN_ROOT}${entry}?zaichang=${Date.now()}-${attempt}`,
        noCacheHeaders,
        'arraybuffer',
      );
      const candidateBody = await responseArrayBufferText(candidate);
      loginPage = candidate;
      body = candidateBody;
      loginPageHasForm = candidate.status === 200 && isWebVpnLoginPage(candidateBody);
      loginPageIsPortal = candidate.status === 200 && isWebVpnResourcePortalPage(candidateBody);
      if (loginPageHasForm || loginPageIsPortal) break;
    }
    if (loginPageHasForm) break;
    if (attempt < 2) await waitForNativeCookieSync();
  }
  if (!loginPage) throw new CampusError('WebVPN 登录页没有返回响应。', 'network');
  if (loginPage.status !== 200) throw new CampusError(`WebVPN 登录页请求失败（HTTP ${loginPage.status}）。`, 'network');
  // A previously authenticated WebVPN session opens the resource portal
  // instead of rendering /login. It is already sufficient for the following
  // CAS service requests; forcing a second form login turns a valid session
  // into the misleading "login form not recognized" error.
  if (loginPageIsPortal) return;
  const csrf = hiddenInput(body, '_csrf');
  if (!isWebVpnLoginPage(body)) {
    const contentType = headerValue(loginPage.headers, 'content-type') || '未知';
    const contentEncoding = headerValue(loginPage.headers, 'content-encoding') || 'identity';
    throw new CampusError(`WebVPN 登录页未返回可识别的登录表单（响应类型：${contentType}，编码：${contentEncoding}，长度：${body.length}，${webVpnPageHint(body)}），请稍后重试。`, 'authentication');
  }
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
    responseType: 'arraybuffer',
    disableRedirects: true,
    allowWebVpn: true,
  });
  const payload = parseJsonBody(await responseArrayBufferText(result), 'WebVPN 登录');
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
      responseType: 'arraybuffer',
      disableRedirects: true,
      allowWebVpn: true,
    });
    const confirmationPayload = parseJsonBody(await responseArrayBufferText(confirmation), 'WebVPN 确认登录');
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
  if (backgroundRunnerMode) return;
  await Promise.allSettled([
    // URL-scoped removal is not consistently propagated by Android's
    // CookieManager when a previous WebVPN redirect set a parent-domain
    // cookie. The app has no shared browser account state, so clear the
    // native WebView cookie store before rebuilding the campus session.
    CapacitorCookies.clearAllCookies(),
    CapacitorCookies.clearCookies({ url: 'https://zjuam.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://identity.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://zdbk.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://courses.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: 'https://sztz.zju.edu.cn' }),
    CapacitorCookies.clearCookies({ url: WEBVPN_ROOT }),
    CapacitorCookies.clearCookies({ url: `${WEBVPN_ROOT}/login` }),
  ]);
  // Capacitor's Android cookie plugin resolves after scheduling WebView
  // CookieManager writes, not after those writes are visible to HttpURLConnection.
  // Let the native store settle before the first WebVPN request.
  await waitForNativeCookieSync();
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
  await waitForNativeCookieSync();
  try {
    await authenticate(credentials.studentId, credentials.password);
  } catch (error) {
    // The gateway can acknowledge the login before Android exposes its
    // session cookie to the native HTTP client. Rebuild the WebVPN/CAS pair
    // once instead of continuing with a half-created identity session.
    if (!(error instanceof CampusError) || error.code !== 'network') throw error;
    await clearCampusCookies();
    campusTransport = 'webvpn';
    await loginWebVpn(credentials.studentId, credentials.password);
    await waitForNativeCookieSync();
    await authenticate(credentials.studentId, credentials.password);
  }
}

async function loginZdbk(allowWebVpnRefresh = true) {
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
  if (isWebVpnLoginPage(body) || (campusTransport === 'webvpn' && isAuthenticationPage(body))) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginZdbk(false);
    }
    throw new CampusError('教务网没有建立登录会话，请重新读取校园信息。', 'authentication');
  }
  if (isCampusNetworkRestriction(body)) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginZdbk(false);
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
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseSztzContext(body: string): { payload: Record<string, unknown>; context: Record<string, unknown> } | null {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (payload.success !== true || Number(payload.code) !== 0) return null;
    const rawData = payload.data;
    let context: unknown = rawData;
    if (typeof rawData === 'string') {
      const trimmed = rawData.trim();
      try {
        context = JSON.parse(trimmed);
      } catch {
        context = JSON.parse(decodeBase64Utf8(trimmed));
      }
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
    return { payload, context: context as Record<string, unknown> };
  } catch {
    return null;
  }
}

function isAuthenticatedSztzContext(body: string): boolean {
  const parsed = parseSztzContext(body);
  if (!parsed) return false;
  const { payload, context } = parsed;
  const userId = String(context.userId ?? context.user_id ?? context.id ?? '').trim();
  const roles = JSON.stringify([context.roles, (payload.extend as Record<string, unknown> | undefined)?.roles]);
  const anonymousValue = context.anonymous;
  const isAnonymous = anonymousValue === true
    || anonymousValue === 1
    || (typeof anonymousValue === 'string' && anonymousValue.trim().toLowerCase() === 'true')
    || userId.toUpperCase() === 'ANONYMOUS'
    || roles.includes('ANONYMOUS_USER_ROLE');
  return !isAnonymous && !!userId;
}

async function clearSztzSessionCookie(): Promise<void> {
  // Practice has its own jar and the native transport never consults the
  // process-wide Capacitor CookieHandler. Clearing this jar is sufficient and
  // avoids destroying the academic/WebVPN session used by other modules.
  practiceCookieJar?.clear();
}

async function loginSztz(allowWebVpnRefresh = true) {
  await clearSztzSessionCookie();
  const cookieJar = practiceCookieJar || (practiceCookieJar = new CookieJar());
  const serviceLogin = `${LOGIN_URL}?service=${encodeURIComponent(SZTZ_SERVICE)}`;
  let ticketResponse: HttpResult;
  try {
    ticketResponse = await request({ url: serviceLogin, responseType: 'text', disableRedirects: true, useCookieJar: true, cookieJar, isolated: true });
  } catch (error) {
    if (campusTransport === 'direct' && allowWebVpnRefresh && error instanceof CampusError && error.code === 'network' && /WebVPN/.test(error.message)) {
      await activateWebVpn();
      return loginSztz(false);
    }
    throw error;
  }
  if (isWebVpnLoginPage(responseText(ticketResponse))) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginSztz(false);
    }
    throw new CampusError('素质拓展平台没有建立登录会话。', 'authentication');
  }
  const location = headerValue(ticketResponse.headers, 'location');
  if (ticketResponse.status < 300 || ticketResponse.status >= 400 || !location) throw new CampusError('素质拓展平台没有返回有效的统一认证跳转。', 'authentication');
  const callback = routedUrl(location, ticketResponse.url);
  const parsed = new URL(callback);
  if (isWebVpnLoginUrl(callback)) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginSztz(false);
    }
    throw new CampusError('素质拓展平台没有建立登录会话。', 'authentication');
  }
  const validDirectCallback = parsed.hostname.toLowerCase() === 'sztz.zju.edu.cn'
    && parsed.pathname.replace(/\/$/, '') === '/dekt'
    && !!parsed.searchParams.get('ticket');
  const validWebVpnCallback = parsed.hostname.toLowerCase() === WEBVPN_HOST && isWebVpnProxyPath(parsed.pathname);
  if ((!validDirectCallback && !validWebVpnCallback) || (campusTransport === 'direct' && !validDirectCallback)) {
    throw new CampusError('素质拓展平台返回了不受信任的认证回调。', 'authentication');
  }
  // CAS callbacks may set the authenticated SESSION on a 302 and then point
  // at /dekt/. That shell can set a new anonymous SESSION. Do not follow the
  // redirect: the callback response itself is enough to establish the
  // session, and /dekt/ctx can be called directly with that SESSION.
  const callbackHeaders = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Cache-Control': 'no-cache', Pragma: 'no-cache', Referer: ticketResponse.url };
  const callbackResponse = await request({ url: callback, headers: callbackHeaders, responseType: 'text', disableRedirects: true, useCookieJar: true, cookieJar, isolated: true });
  const callbackSessionReady = cookieJar.has('SESSION', campusCookieHost('sztz.zju.edu.cn')) === true;
  if (isWebVpnLoginPage(responseText(callbackResponse))) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginSztz(false);
    }
    throw new CampusError('素质拓展平台没有建立登录会话。', 'authentication');
  }
  const callbackStatusOkay = callbackResponse.status === 200 && callbackSessionReady;
  if (!callbackStatusOkay || (campusTransport === 'direct' && !callbackSessionReady)) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginSztz(false);
    }
    throw new CampusError(`素质拓展平台没有建立正式登录会话（${campusTransport === 'webvpn' ? 'WebVPN' : '直连'}；回调HTTP ${callbackResponse.status}；SESSION ${callbackSessionReady ? '已取得' : '未取得'}）。`, 'authentication');
  }
  const contextOrigins = campusTransport === 'webvpn' ? [WEBVPN_ROOT, 'https://sztz.zju.edu.cn'] : ['https://sztz.zju.edu.cn'];
  let contextAuthenticated = false;
  let contextStatus = 0;
  let contextIdentity = '未解析';
  for (const origin of contextOrigins) {
    const contextResponse = await request({
      url: SZTZ_CTX,
      method: 'POST',
      data: {},
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
        Referer: SZTZ_SERVICE,
        'X-Requested-With': 'XMLHttpRequest',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      responseType: 'text',
      disableRedirects: true,
      useCookieJar: true,
      cookieJar,
      isolated: true,
    });
    contextStatus = contextResponse.status;
    const contextBody = responseText(contextResponse);
    const parsedContext = parseSztzContext(contextBody);
    const authenticated = parsedContext !== null && isAuthenticatedSztzContext(contextBody);
    contextIdentity = parsedContext === null ? '响应无效' : authenticated ? '已登录' : '匿名';
    if (contextResponse.status === 200 && authenticated) {
      contextAuthenticated = true;
      break;
    }
  }
  if (!contextAuthenticated) {
    if (allowWebVpnRefresh) {
      await activateWebVpn();
      return loginSztz(false);
    }
    throw new CampusError(`素质拓展平台身份确认未完成（${campusTransport === 'webvpn' ? 'WebVPN' : '直连'}；回调HTTP ${callbackResponse.status}；SESSION ${cookieJar.has('SESSION', campusCookieHost('sztz.zju.edu.cn')) ? '已取得' : '未取得'}；ctx HTTP ${contextStatus || '无'}，${contextIdentity}）。`, 'authentication');
  }
  return cookieJar.headerFor(routedUrl(SZTZ_CTX));
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
  if (practiceBoolean(value.sfsc) === true) return null;
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

function isRetryablePracticeSessionError(error: unknown): boolean {
  if (!(error instanceof CampusError)) return false;
  if (error.code === 'network') return true;
  return error.code === 'authentication' && /素质拓展|登录会话|登录跳转|认证回调|身份确认|WebVPN/i.test(error.message);
}

async function ensurePracticeSession(): Promise<string> {
  if (practiceLoginPromise) return practiceLoginPromise;
  practiceLoginPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // A single CAS ticket must be consumed by one login flow only. Keep
        // the retry outside loginSztz so a failed context check cannot create
        // overlapping WebVPN/CAS sessions.
        return await loginSztz(false);
      } catch (error) {
        lastError = error;
        if (!isRetryablePracticeSessionError(error) || attempt === 1) throw error;
        await activateWebVpn();
      }
    }
    throw lastError instanceof Error ? lastError : new CampusError('素质拓展平台没有建立登录会话。', 'authentication');
  })();
  try {
    return await practiceLoginPromise;
  } finally {
    practiceLoginPromise = null;
  }
}

async function readPractice(): Promise<{ summary: CampusPracticeSummary | null; projects: CampusPracticeProject[]; warnings: string[] }> {
  await ensurePracticeSession();
  const cookieJar = practiceCookieJar;
  if (!cookieJar) throw new CampusError('素质拓展平台登录会话没有保存。', 'authentication');
  let summary: CampusPracticeSummary | null = null;
  const projects: CampusPracticeProject[] = [];
  const warnings: string[] = [];
  try {
    const response = await request({ url: SZTZ_SUMMARY, responseType: 'text', headers: { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache', Pragma: 'no-cache', Referer: SZTZ_SERVICE }, disableRedirects: true, useCookieJar: true, cookieJar, isolated: true });
    if (response.status !== 200) throw new CampusError(`素质拓展汇总请求失败（HTTP ${response.status}）。`, 'response');
    const payload = parseJson(response, '素质拓展汇总');
    const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const extend = root.extend && typeof root.extend === 'object' && !Array.isArray(root.extend) ? root.extend as Record<string, unknown> : {};
    const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : {};
    const myInfoCandidate = extend.myInfo || root.myInfo || data.myInfo || data;
    const myInfo = myInfoCandidate && typeof myInfoCandidate === 'object' && !Array.isArray(myInfoCandidate) ? myInfoCandidate as Record<string, unknown> : {};
    summary = normalizePracticeSummary(myInfo);
  } catch (error) {
    if (error instanceof CampusError && (error.code === 'authentication' || error.code === 'captcha')) throw error;
    warnings.push(`素质拓展汇总：${error instanceof Error ? error.message : '读取失败'}`);
  }
  try {
    const response = await request({ url: SZTZ_PROJECTS, responseType: 'text', headers: { Accept: 'application/json, text/html, */*', 'Cache-Control': 'no-cache', Pragma: 'no-cache', Referer: SZTZ_SERVICE }, disableRedirects: true, useCookieJar: true, cookieJar, isolated: true });
    if (response.status !== 200) throw new CampusError(`素质拓展项目请求失败（HTTP ${response.status}）。`, 'response');
    const payload = parseJson(response, '素质拓展项目');
    const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (root.success === false || (root.code !== undefined && Number(root.code) !== 0)) throw new CampusError('素质拓展项目返回了未认证或无法识别的数据。', 'response');
    const data = Array.isArray(root.data)
      ? root.data
      : root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? listFromPayload(root.data, ['items', 'rows', 'list', 'records', 'data'])
        : listFromPayload(root, ['items', 'rows', 'list', 'records']);
    if (!Array.isArray(data)) throw new CampusError('素质拓展项目响应缺少项目列表。', 'response');
    const seen = new Set<string>();
    data.forEach((item, index) => {
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
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
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

function academicYearLabel(value: string): string {
  const normalized = value.replace(/[—–]/g, '-').trim();
  const range = normalized.match(/(20\d{2})\s*-\s*(20?\d{2})/);
  if (range) {
    const endYear = range[2].length === 2 ? Number(`${range[1].slice(0, 2)}${range[2]}`) : Number(range[2]);
    return Number.isFinite(endYear) ? `${range[1]}-${endYear}` : `${range[1]}-${Number(range[1]) + 1}`;
  }
  const year = normalized.match(/20\d{2}/)?.[0];
  return year ? `${year}-${Number(year) + 1}` : '';
}

function semesterTermValue(value: string): string {
  const normalized = value.replace(/\s+/g, '');
  if (/春|夏/.test(normalized) || /(?:^|[-_])2(?:$|[-_])/.test(normalized)) return '2';
  if (/秋|冬/.test(normalized) || /(?:^|[-_])1(?:$|[-_])/.test(normalized)) return '1';
  return '';
}

function normalizeGradeSemester(item: Record<string, unknown>): { academicYear?: string; term?: string; semesterId: string } {
  const rawSemester = field(item, ['semester_id', 'semesterId', 'semester', 'xq_id']);
  const rawAcademicYear = field(item, ['xnmmc', 'xnxq', 'academic_year_name', 'academicYearName', 'academic_year', 'academicYear', 'xnm', 'xn']);
  const rawTerm = field(item, ['xqmmc', 'semester_name', 'semesterName', 'term_name', 'termName', 'xqm', 'xq', 'term']);
  const academicYear = academicYearLabel(rawAcademicYear || rawSemester);
  const term = semesterTermValue(rawTerm || rawSemester);
  const semesterId = academicYear && term
    ? `${academicYear}-${term}`
    : rawSemester || [academicYear, rawTerm].filter(Boolean).join(' · ');
  return {
    ...(academicYear ? { academicYear } : {}),
    ...(term ? { term } : {}),
    semesterId,
  };
}

function isStartedAcademicTerm(academicYear?: string, term?: string): boolean {
  if (!academicYear || (term !== '1' && term !== '2')) return true;
  const startYear = Number(academicYear.match(/20\d{2}/)?.[0]);
  if (!Number.isFinite(startYear)) return true;
  const start = new Date(startYear, term === '1' ? 7 : 1, 1, 0, 0, 0, 0);
  return start.getTime() <= Date.now();
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
  const level = Math.max(1, Math.min(8, startYear - entryYear + 1));
  const labels = ['', '一', '二', '三', '四', '五', '六', '七', '八'];
  return `大${labels[level] || level}`;
}

function numberValue(value: string): number | undefined {
  const numeric = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(numeric) ? numeric : undefined;
}

function integerValue(value: string): number | undefined {
  const match = value.replace(/,/g, '').match(/\d+/);
  if (!match) return undefined;
  const numeric = Number(match[0]);
  return Number.isInteger(numeric) ? numeric : undefined;
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

function normalizePublicPhone(value: unknown): string {
  const text = cleanDisplayText(value)
    .replace(/[‐‑‒–—−]/g, '-')
    .trim();
  if (!text || /^(未公开|未提供|暂无|无|未知|none|null|undefined|n\/?a|[-—])$/i.test(text)) return '';
  const mobile = text.match(/(?:\+?86[\s-]?)?1[3-9]\d{9}/)?.[0];
  if (mobile) {
    const remainder = text.replace(mobile, '').replace(/[()（）\s+\-]/g, '');
    if (remainder && !/^(电话|手机|座机|办公电话|联系电话|工作电话|移动电话|号码)$/i.test(remainder)) return '';
    return mobile.replace(/^(?:\+?86[\s-]?)/, '');
  }
  const landline = text.match(/(?:0\d{2,3}[\s-]?)?\d{7,8}(?:\s*(?:转|x|#)\s*\d{1,6})?/i)?.[0];
  if (!landline) return '';
  const digitCount = landline.replace(/\D/g, '').length;
  const remainder = text.replace(landline, '').replace(/[()（）\s+\-]/g, '');
  if (remainder && !/^(电话|手机|座机|办公电话|联系电话|工作电话|移动电话|号码)$/i.test(remainder)) return '';
  return digitCount >= 7 && digitCount <= 13 ? landline.replace(/\s+/g, ' ').trim() : '';
}

function normalizePublicEmail(value: unknown): string {
  const text = cleanDisplayText(value);
  if (!text || /^(未公开|未提供|暂无|无|未知|none|null|undefined|n\/?a|[-—])$/i.test(text)) return '';
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

function creditField(value: Record<string, unknown>): string {
  const parseCredit = (candidate: unknown): string => {
    const text = cleanDisplayText(candidate);
    const match = text.match(/^(\d+(?:\.\d+)?)(?:\s*学分)?$/);
    return match?.[1] || '';
  };
  for (const key of ['xf', 'credit', 'credits', 'course_credit', 'courseCredit', 'courseCredits', 'creditValue', 'kcxzxf', 'kczxf', 'xkxf', 'zxf', 'xuefen', 'xue_fen', '学分']) {
    const known = parseCredit(value[key]);
    if (known) return known;
  }
  const courseInfo = cleanDisplayText(value.kcxx);
  const compositeCredit = courseInfo.split('~')[1];
  const parsedCompositeCredit = parseCredit(compositeCredit);
  if (parsedCompositeCredit) return parsedCompositeCredit;
  for (const [key, candidate] of Object.entries(value)) {
    if (!/(?:^|[_-])(?:xf|credit|credits|xuefen)(?:$|[_-])/i.test(key) && !/学分|学分数/i.test(key)) continue;
    const parsed = parseCredit(candidate);
    if (parsed) return parsed;
  }
  return '—';
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
    if (Array.isArray(candidate) && candidate.length) return candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  for (const key of ['data', 'result', 'rows']) {
    if (typeof record[key] === 'string') {
      try {
        const nested = listFromPayload(JSON.parse(record[key] as string) as unknown, keys);
        if (nested.length) return nested;
      } catch {
        // Some campus endpoints wrap the JSON list in a string field.
      }
    }
    if (record[key] && typeof record[key] === 'object') {
      const nested = listFromPayload(record[key], keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function payloadContainsList(value: unknown, keys: string[]): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (keys.some((key) => Array.isArray(record[key]))) return true;
  return ['data', 'result', 'rows'].some((key) => payloadContainsList(record[key], keys));
}

function parseJson(result: HttpResult, label: string): unknown {
  if (result.data && typeof result.data === 'object') return result.data;
  const body = responseText(result).trim();
  if (body === 'null' || body === '') return null;
  try { return JSON.parse(body) as unknown; } catch { throw new CampusError(`${label}返回了无法识别的数据。`, 'response'); }
}

function parseJsonBody(body: string, label: string): unknown {
  const normalized = body.trim();
  if (normalized === 'null' || normalized === '') return null;
  try { return JSON.parse(normalized) as unknown; } catch { throw new CampusError(`${label}返回了无法识别的数据。`, 'response'); }
}

function isAuthenticationPage(body: string): boolean {
  return /name\s*=\s*["']execution["']/i.test(body)
    || (/统一身份认证/.test(body) && /登录|login|cas/i.test(body));
}

function isWebVpnLoginPage(body: string): boolean {
  // The current gateway renders _csrf as an empty hidden input and submits it
  // that way from its own browser form. Presence of the login form, rather
  // than a non-empty CSRF value, is the reliable signal.
  const hasUsername = /(?:name\s*=\s*["']username["']|id\s*=\s*["']user_name["'])/i.test(body);
  const hasPassword = /(?:name\s*=\s*["']password["']|type\s*=\s*["']password["'])/i.test(body);
  const hasGatewayMarker = /WebVPN|wengine-vpn|do-login|name\s*=\s*["']_csrf["']/i.test(body);
  return hasUsername && hasPassword && hasGatewayMarker;
}

function isWebVpnLoginUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase() === WEBVPN_HOST && (parsed.pathname === '/' || parsed.pathname === '/login');
  } catch {
    return false;
  }
}

function isCampusNetworkRestriction(body: string): boolean {
  // Do not match the ordinary word "WebVPN" appearing in a page footer or
  // navigation link. Only explicit access-denied wording is a restriction;
  // the previous broad matcher turned valid WebVPN responses into failures.
  return /仅限(?:校内|校园网)|校内网络(?:访问|环境|登录)|请在校内(?:网络|校园网)|(?:需要|请先|请开启|请连接).{0,16}(?:VPN|校园网)|网络访问(?:受限|被拒绝)|访问被拒绝|access\s+denied|403\s+forbidden/i.test(body);
}

function scheduleParts(value: string): string[] {
  return cleanDisplayText(value).replace(/zwf.*$/i, '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
}

function weekdayNumber(value: string): number | undefined {
  const clean = value.trim();
  if (!clean) return undefined;
  const named = clean.match(/(?:周|星期)\s*([一二三四五六日天1-7])/);
  if (named) {
    const day = named[1];
    if (/\d/.test(day)) return Number(day);
    return '一二三四五六日'.indexOf(day) + 1 || (day === '天' ? 7 : undefined);
  }
  const numeric = Number(clean.replace(/\D/g, ''));
  return numeric >= 1 && numeric <= 7 ? numeric : undefined;
}

function weekdayLabel(value: string): string {
  const day = weekdayNumber(value);
  return day ? `周${['一', '二', '三', '四', '五', '六', '日'][day - 1]}` : '';
}

function periodRangeFromText(value: string): { start?: number; end?: number } {
  const clean = value.trim();
  if (!clean) return {};
  const labelled = clean.match(/第\s*(\d{1,2})(?:\s*[-~至—–－]\s*(\d{1,2}))?\s*节/);
  if (labelled) {
    const start = Number(labelled[1]);
    const end = Number(labelled[2] || labelled[1]);
    return start >= 1 && start <= 20 && end >= start && end <= 20 ? { start, end } : {};
  }
  const range = clean.match(/(?:^|[^\d])(\d{1,2})\s*[-~至—–－]\s*(\d{1,2})(?:节)?(?:$|[^\d])/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return start >= 1 && start <= 20 && end >= start && end <= 20 ? { start, end } : {};
  }
  const single = clean.match(/(?:^|[^\d])(\d{1,2})(?:节)?$/);
  if (single) {
    const start = Number(single[1]);
    return start >= 1 && start <= 20 ? { start, end: start } : {};
  }
  return {};
}

function coursePeriodRangeFromNormalized(course: CampusCourse): { start?: number; end?: number } {
  if (course.startPeriod && course.endPeriod) {
    return { start: course.startPeriod, end: course.endPeriod };
  }
  return periodRangeFromText(course.time);
}

function periodLabel(start: number, end: number): string {
  return start === end ? `第${start}节` : `第${start}-${end}节`;
}

function courseIdentity(course: CampusCourse): string {
  const normalizedId = course.id.trim();
  if (normalizedId && !normalizedId.startsWith('course-')) return `id:${normalizedId}`;
  return [
    normalizedCourseName(course.name),
    course.teacher.trim(),
    course.location.trim(),
    String(course.weekday || weekdayNumber(course.time) || ''),
    course.weeks.trim(),
  ].join('|');
}

function sameCourseSlot(left: CampusCourse, right: CampusCourse): boolean {
  return courseIdentity(left) === courseIdentity(right)
    && (left.weekday || weekdayNumber(left.time)) === (right.weekday || weekdayNumber(right.time))
    && left.weeks.trim() === right.weeks.trim()
    && left.teacher.trim() === right.teacher.trim()
    && left.location.trim() === right.location.trim();
}

function updateCoursePeriod(course: CampusCourse, start: number, end: number): CampusCourse {
  const label = periodLabel(start, end);
  const time = /第\s*\d{1,2}(?:\s*[-~至—–－]\s*\d{1,2})?\s*节/.test(course.time)
    ? course.time.replace(/第\s*\d{1,2}(?:\s*[-~至—–－]\s*\d{1,2})?\s*节/, label)
    : [course.weekday ? weekdayLabel(String(course.weekday)) : '', label].filter(Boolean).join(' · ');
  return { ...course, time, startPeriod: start, endPeriod: end };
}

function mergeContiguousCourses(courses: CampusCourse[]): CampusCourse[] {
  const merged: CampusCourse[] = [];
  for (const course of sortCourses(courses)) {
    const currentRange = coursePeriodRangeFromNormalized(course);
    const previous = merged[merged.length - 1];
    const previousRange = previous ? coursePeriodRangeFromNormalized(previous) : {};
    if (
      previous
      && currentRange.start
      && currentRange.end
      && previousRange.start
      && previousRange.end
      && sameCourseSlot(previous, course)
      && currentRange.start <= previousRange.end + 1
    ) {
      const start = Math.min(previousRange.start, currentRange.start);
      const end = Math.max(previousRange.end, currentRange.end);
      const names = [...new Set([previous.name, course.name].map((name) => name.trim()).filter(Boolean))];
      merged[merged.length - 1] = updateCoursePeriod({
        ...previous,
        // Keep an unexpected source-name conflict visible instead of silently
        // dropping one of the names while still presenting one continuous slot.
        name: names.join(' / '),
        completed: previous.completed || course.completed,
      }, start, end);
      continue;
    }
    merged.push(course);
  }
  return sortCourses(merged);
}

function coursePeriodRange(item: Record<string, unknown>): { start?: number; end?: number } {
  const initialText = field(item, ['djj', 'start_period', 'startPeriod']);
  const initial = integerValue(initialText);
  const duration = integerValue(field(item, ['skcd', 'period_count', 'periodCount']));
  if (initial && duration && duration >= 1 && duration <= 20 && initial <= 20) {
    return { start: initial, end: initial + duration - 1 };
  }
  const explicit = periodRangeFromText(initialText);
  if (explicit.start) return explicit;
  for (const key of ['jcs', 'jssj', 'sksj', 'period', 'skjc', 'time', 'class_time']) {
    const parsed = periodRangeFromText(field(item, [key]));
    if (parsed.start) return parsed;
  }
  return {};
}

function semesterPartLabel(value: string): string {
  const parts = [...new Set(value.match(/[春夏秋冬]/g) || [])];
  return parts.length ? `${parts.join('')}学期` : '';
}

function normalizeCourse(item: Record<string, unknown>, index: number): CampusCourse | null {
  if (field(item, ['sfyjskc']) === '1') return null;
  const parts = scheduleParts(textValue(item.kcb));
  const courseId = field(item, ['jxb_id', 'jxbid', 'kch_id', 'xkkh', 'kch', 'course_id'], `course-${index}`);
  const courseKey = field(item, ['xkkh', 'course_key', 'kch', 'kch_id', 'course_id']);
  const rawName = field(item, ['kcmc', 'course_name', 'courseName', 'jxbmc', 'kcm', 'course_name_full']);
  const rawTeacher = field(item, ['jsxx', 'jsxms', 'jsxm', 'teacher', 'teacherName', 'teacher_name', 'jsmc', 'teacherList']);
  const rawLocation = field(item, ['cdmc', 'jxcdmc', 'jxcd', 'classroom', 'room', 'location', 'place', 'jxcdm']);
  if (!parts.length && !rawName && !rawTeacher && !rawLocation) return null;
  const dayNumber = weekdayNumber(field(item, ['xqj', 'xqjmc', 'week_day', 'weekday', 'weekdayName']));
  const day = dayNumber ? weekdayLabel(String(dayNumber)) : '';
  const { start: firstPeriod, end: lastPeriod } = coursePeriodRange(item);
  const displayPeriodLabel = firstPeriod && lastPeriod
    ? periodLabel(firstPeriod, lastPeriod)
    : field(item, ['jcs', 'period', 'skjc'], '时间未提供');
  const oddEven = field(item, ['dsz', 'odd_even']);
  const explicitWeeks = field(item, ['zcxx', 'zcd', 'zc', 'zcmc', 'zcsm', 'weeks', 'week', 'week_range', 'weekRange', 'weekList']);
  const semesterPart = semesterPartLabel(field(item, ['xxq', 'xq', 'semester_part', 'semesterPart']));
  const parity = oddEven === '0' ? '单周' : oddEven === '1' ? '双周' : '';
  const weeks = [explicitWeeks || semesterPart, parity && !explicitWeeks.includes(parity) ? parity : ''].filter(Boolean).join(' · ');
  return {
    id: courseId,
    ...(courseKey ? { courseKey } : {}),
    name: (rawName || parts[0] || '未命名课程').replace(/\(/g, '（').replace(/\)/g, '）'),
    teacher: rawTeacher || parts[2] || parts[1] || '教师未提供',
    location: rawLocation || parts[3] || '地点未提供',
    time: [day, displayPeriodLabel].filter(Boolean).join(' · ') || '时间未提供',
    ...(dayNumber ? { weekday: dayNumber } : {}),
    ...(firstPeriod ? { startPeriod: firstPeriod } : {}),
    ...(lastPeriod ? { endPeriod: lastPeriod } : {}),
    weeks: weeks || '周次未提供',
    credit: creditField(item),
    score: field(item, ['cj', 'score', 'original_score'], '—'),
    completed: false,
  };
}

function courseSortPosition(course: CampusCourse): { weekday: number; start: number; end: number } {
  const time = course.time || '';
  const weekday = course.weekday || weekdayNumber(time) || 99;
  const range = course.startPeriod && course.endPeriod
    ? { start: course.startPeriod, end: course.endPeriod }
    : periodRangeFromText(time);
  return { weekday, start: range.start || 99, end: range.end || 99 };
}

function sortCourses(courses: CampusCourse[]): CampusCourse[] {
  return [...courses].sort((left, right) => {
    const a = courseSortPosition(left);
    const b = courseSortPosition(right);
    return a.weekday - b.weekday
      || a.start - b.start
      || a.end - b.end
      || left.name.localeCompare(right.name, 'zh-CN')
      || left.location.localeCompare(right.location, 'zh-CN')
      || left.teacher.localeCompare(right.teacher, 'zh-CN')
      || left.id.localeCompare(right.id);
  });
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

function normalizedGradeLabel(score: string): string {
  return score.replace(/\s+/g, '').trim();
}

function gradeCreditIncluded(score: string): boolean {
  const value = normalizedGradeLabel(score);
  return !!value && value !== '—' && value !== '-' && !/^(弃修|待录|缓考|无效)$/.test(value);
}

function gradeGpaPolicyIncluded(score: string, courseId: string): boolean {
  const value = normalizedGradeLabel(score);
  return gradeCreditIncluded(value) && !/^(合格|不合格)$/.test(value) && !courseId.toLowerCase().includes('xtwkc');
}

function normalizeGrade(item: Record<string, unknown>, index: number): CampusGrade {
  const id = field(item, ['xkkh', 'kch', 'kcmc', 'grade_id'], `grade-${index}`);
  const score = field(item, ['cj', 'score', 'original_score', 'cjbj'], '—');
  const point = field(item, ['jd', 'point', 'five_point', 'gpa'], '—');
  const credit = creditField(item);
  const semester = normalizeGradeSemester(item);
  const creditIncluded = gradeCreditIncluded(score);
  const gpaPolicyIncluded = gradeGpaPolicyIncluded(score, id);
  const gpaIncluded = gpaPolicyIncluded && numberValue(credit) !== undefined && numberValue(point) !== undefined;
  return {
    id,
    name: field(item, ['kcmc', 'course_name', 'courseName'], '未命名课程'),
    score,
    credit,
    point,
    ...(semester.academicYear ? { academicYear: semester.academicYear } : {}),
    ...(semester.term ? { term: semester.term } : {}),
    ...(semester.semesterId ? { semesterId: semester.semesterId } : {}),
    courseKey: field(item, ['xkkh', 'course_key', 'kch', 'kch_id'], ''),
    creditIncluded,
    gpaIncluded,
    gpaExclusionReason: gpaIncluded
      ? ''
      : !creditIncluded
        ? `${score}记录不计学分和绩点。`
        : !gpaPolicyIncluded
          ? `${score}记录不计绩点。`
          : '成绩接口未提供可纳入绩点计算的学分或绩点。',
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
  const details = normalizeTodoDetails(item);
  const url = normalizeOfficialCourseUrl(item.url ?? item.href ?? item.link) || details.sourceUrl || '';
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
    ...(details.description ? { description: details.description } : {}),
    ...(details.submissionRequirements ? { submissionRequirements: details.submissionRequirements } : {}),
    ...(details.attachments.length ? { attachments: details.attachments } : {}),
    ...(details.updatedAt ? { updatedAt: details.updatedAt } : {}),
  };
}

function parseCourseActivities(response: HttpResult, courseId: string): CampusActivity[] {
  const body = responseText(response);
  if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('学在浙大登录态已失效，请重新读取。', 'authentication');
  if (response.status < 200 || response.status >= 300) throw new CampusError(`学在浙大课程活动读取失败（HTTP ${response.status}）。`, 'response');
  const activities = listFromPayload(parseJson(response, '学在浙大课程活动'), ['activities', 'activity_list', 'items', 'data', 'results'])
    .map((item) => normalizeActivity(item, courseId))
    .filter((item): item is CampusActivity => item !== null);
  const seen = new Set<string>();
  return activities.filter((activity) => {
    if (seen.has(activity.id)) return false;
    seen.add(activity.id);
    return true;
  }).slice(0, 500);
}

async function readCourseActivities(courseId: string): Promise<CampusActivity[]> {
  const response = await request({ url: COURSE_ACTIVITIES_URL.replace('{courseId}', encodeURIComponent(courseId)), responseType: 'text', disableRedirects: true });
  return parseCourseActivities(response, courseId);
}

async function readOfficialActivityPayload(url: string, label: string): Promise<unknown> {
  const response = await request({ url, responseType: 'text', disableRedirects: true });
  const body = responseText(response);
  if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('学在浙大登录态已失效，请重新读取。', 'authentication');
  if (response.status < 200 || response.status >= 300) throw new CampusError(`${label}读取失败（HTTP ${response.status}）。`, 'response');
  const payload = parseJson(response, label);
  if (!payload || typeof payload !== 'object') throw new CampusError(`${label}返回了无法识别的数据。`, 'response');
  return payload;
}

function officialActivityId(value: string): boolean {
  return /^\d{1,20}$/.test(value);
}

export async function readLearningActivityDetails(studentId: string, password: string, courseId: string, activityId: string): Promise<CampusActivity[]> {
  assertNative();
  const cleanId = studentId.trim();
  const cleanCourseId = courseId.trim();
  const cleanActivityId = activityId.trim();
  if (!cleanId || !password) throw new CampusError('请先填写学号和校园密码。', 'credentials');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cleanCourseId) || !officialActivityId(cleanActivityId)) throw new CampusError('学在浙大课程或作业编号格式不正确。', 'response');
  campusTransport = 'direct';
  activeCampusCredentials = { studentId: cleanId, password };
  activeCookieJar = new CookieJar();
  try {
    await establishCampusSession(cleanId, password);
    await ensureCoursesSession();
    const activities = await readCourseActivities(cleanCourseId);
    const matched = activities.find((activity) => activity.courseId === cleanCourseId && activity.id === cleanActivityId);
    if (!matched) return activities;

    const detailUrl = COURSE_ACTIVITY_DETAIL_URL.replace('{activityId}', encodeURIComponent(cleanActivityId));
    const detailPayload = await readOfficialActivityPayload(detailUrl, '学在浙大作业详情');
    if (Array.isArray(detailPayload)) throw new CampusError('学在浙大作业详情返回了无法识别的数据。', 'response');
    const detailRecord = detailPayload as Record<string, unknown>;
    const returnedId = field(detailRecord, ['id', 'activity_id', 'activityId']);
    const returnedCourseId = field(detailRecord, ['course_id', 'courseId']);
    if ((returnedId && returnedId !== cleanActivityId) || (returnedCourseId && returnedCourseId !== cleanCourseId)) {
      throw new CampusError('官方作业详情的课程或作业编号与待办不一致，已停止显示以避免错配。', 'response');
    }

    const referencesUrl = COURSE_ACTIVITY_REFERENCES_URL.replace('{activityId}', encodeURIComponent(cleanActivityId));
    const referencesPayload = await readOfficialActivityPayload(referencesUrl, '学在浙大作业附件');
    const referenceKeys = ['upload_references', 'references', 'items', 'results'];
    if (!payloadContainsList(referencesPayload, referenceKeys)) throw new CampusError('学在浙大作业附件接口返回了无法识别的数据。', 'response');
    const uploadReferences = listFromPayload(referencesPayload, referenceKeys);
    const normalized = normalizeActivity({ ...matched, ...detailRecord, upload_references: uploadReferences }, cleanCourseId);
    if (!normalized || normalized.id !== cleanActivityId || normalized.courseId !== cleanCourseId) {
      throw new CampusError('学在浙大作业详情无法与待办编号精确匹配。', 'response');
    }
    return [{
      ...normalized,
      url: normalized.url || officialActivityUrl(cleanCourseId, cleanActivityId) || '',
    }];
  } finally {
    activeCookieJar = null;
    zdbkSessionReady = false;
    campusTransport = 'direct';
    activeCampusCredentials = null;
  }
}

async function readSchedule(year: string, term: string): Promise<CampusCourse[]> {
  await loginZdbk();
  scheduleReadWarning = '';
  // The official form submits the full academic-year label and one
  // sub-semester at a time. Sending only the start year ("2026") or the
  // internal aggregate codes ("3"/"12") can return a valid-looking fallback
  // dataset from an older term.
  const academicYear = `${year}-${Number(year) + 1}`;
  const semesterCodes = term === '1' ? ['1|秋', '1|冬'] : ['2|春', '2|夏'];
  const result: CampusCourse[] = [];
  for (const semesterCode of semesterCodes) {
    const cacheKey = `${activeCampusCredentials?.studentId || 'current'}|${academicYear}|${semesterCode}`;
    let semesterCourses: CampusCourse[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2 && semesterCourses === null; attempt += 1) {
      try {
        if (attempt > 0) {
          // Rebuild the academic-system session before retrying a malformed
          // response. This avoids reusing a half-valid JSESSIONID/route pair.
          zdbkSessionReady = false;
          await waitForNativeCookieSync();
          await loginZdbk();
        }
        const response = await request({ url: SCHEDULE_URL, method: 'POST', data: { xnm: academicYear, xqm: semesterCode, captcha_value: '' }, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
        const body = responseText(response);
        if (isCampusNetworkRestriction(body)) throw new CampusError('教务网提示需要校内网络；请先开启浙大 VPN 或 WebVPN 后再读取。', 'network');
        if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
        if (body.toLowerCase().includes('captcha_error')) throw new CampusError('教务网要求验证码，手机端暂不绕过安全校验。', 'captcha');
        const payload = parseJson(response, '教务网课表');
        const cached = scheduleCache.get(cacheKey);
        if (payload === null) {
          if (!cached && attempt === 0) throw new CampusError('教务网课表本次返回为空，正在重试。', 'response');
          semesterCourses = cached ? [...cached] : [];
          if (cached?.length) scheduleReadWarning = '本次课表响应为空，已保留上次成功读取的数据。';
          continue;
        }
        if (!payloadContainsList(payload, ['kbList', 'items', 'rows'])) throw new CampusError('教务网课表返回了无法识别的数据。', 'response');
        const items = listFromPayload(payload, ['kbList', 'items', 'rows']).filter((item) => field(item, ['sfyjskc']) !== '1');
        const parsed = mergeContiguousCourses(items.map(normalizeCourse).filter((item): item is CampusCourse => item !== null));
        // A non-empty list whose every row is unusable is not an empty
        // timetable. Retry it so a broken bridge response cannot silently
        // replace a complete schedule with “暂无数据”.
        if (items.length && !parsed.length) throw new CampusError('教务网课表条目缺少有效星期或节次。', 'response');
        if (!parsed.length && !cached && attempt === 0) throw new CampusError('教务网课表本次没有可识别课程，正在重试。', 'response');
        if (parsed.length) scheduleCache.set(cacheKey, parsed);
        semesterCourses = parsed.length || !cached ? parsed : [...cached];
        if (!parsed.length && cached?.length) scheduleReadWarning = '本次课表响应不完整，已保留上次成功读取的数据。';
      } catch (error) {
        lastError = error;
      }
    }
    if (semesterCourses === null) {
      const cached = scheduleCache.get(cacheKey);
      if (cached?.length) {
        scheduleReadWarning = '课表实时读取失败，已保留上次成功读取的数据。';
        semesterCourses = [...cached];
      } else if (result.length) {
        scheduleReadWarning = `课表${semesterCode}读取失败，本次仅返回了另一半学期的数据。`;
        semesterCourses = [];
      } else {
        throw lastError instanceof Error ? lastError : new CampusError('教务网课表读取失败。', 'response');
      }
    }
    result.push(...semesterCourses);
  }
  const unique = new Map<string, CampusCourse>();
  for (const course of result) unique.set(`${course.id}|${course.time}|${course.name}`, course);
  return mergeContiguousCourses([...unique.values()]);
}

function normalizeCourseCreditRecord(item: Record<string, unknown>, index: number): CourseCreditRecord | null {
  const credit = creditField(item);
  if (!usableCredit(credit)) return null;
  const name = field(item, ['kcmc', 'course_name', 'courseName', 'kcm']);
  const courseKey = field(item, ['xkkh', 'course_key', 'kch', 'kcdm', 'xskcdm', 'kch_id', 'course_id']);
  const id = field(item, ['xkkh', 'jxb_id', 'jxbid', 'kch_id', 'kcdm', 'xskcdm', 'kch', 'course_id'], `selection-course-${index}`);
  if (!name && !courseKey) return null;
  return { id, courseKey, name, credit };
}

async function readSelectedCourseCredits(year: string, term: string): Promise<CourseCreditRecord[]> {
  await loginZdbk();
  const academicYear = `${year}-${Number(year) + 1}`;
  const semesterCode = term;
  const aggregateSemesterCode = term === '1' ? '3' : '12';
  const requestBodies: Record<string, string>[] = [
    { xn: academicYear, xq: semesterCode },
    { xnm: academicYear, xqm: semesterCode },
    { xn: academicYear, xq: aggregateSemesterCode },
    { xnm: academicYear, xqm: aggregateSemesterCode },
  ];
  let lastError: unknown;
  let parsedEmptyResponse = false;
  for (const data of requestBodies) {
    try {
      const response = await request({ url: CHOSEN_COURSES_URL, method: 'POST', data, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
      const body = responseText(response);
      if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
      const payload = parseJson(response, '教务网已选课程');
      const items = listFromPayload(payload, ['items', 'rows', 'result', 'data', 'chosen', 'xkList', 'courseList', 'courses', 'kbList', 'list']);
      const records = items
        .map(normalizeCourseCreditRecord)
        .filter((item): item is CourseCreditRecord => item !== null);
      const seen = new Set<string>();
      const uniqueRecords = records.filter((record) => {
        const key = `${record.courseKey}|${record.name}|${record.credit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!uniqueRecords.length) {
        parsedEmptyResponse = true;
        continue;
      }
      return uniqueRecords;
    } catch (error) {
      lastError = error;
    }
  }
  if (parsedEmptyResponse) return [];
  throw lastError instanceof Error ? lastError : new CampusError('教务网已选课程读取失败。', 'response');
}

async function readCourseCatalogCredits(year: string, term: string, courses: CampusCourse[]): Promise<CourseCreditRecord[]> {
  await loginZdbk();
  const academicYear = `${year}-${Number(year) + 1}`;
  const queryNames = [...new Set(courses.map((course) => course.name.trim()).filter(Boolean))].slice(0, 30);
  const records: CourseCreditRecord[] = [];
  const seen = new Set<string>();
  for (const name of queryNames) {
    const requestBodies: Record<string, string>[] = [
      {
        xnxq: `(${academicYear}-${term})-`,
        cx_ylcx: '0',
        cx_zbgx: 'and',
        kspage: '1',
        jspage: '50',
        'cxtjList[0].cxlb': 'kcmc',
        'cxtjList[0].cxgx': 'like',
        'cxtjList[0].cxnr': name,
      },
      {
        xn: academicYear,
        xq: term,
        xnxq: `(${academicYear}-${term})-`,
        cx_ylcx: '0',
        cx_zbgx: 'and',
        kspage: '1',
        jspage: '50',
        'cxtjList[0].cxlb': 'kcmc',
        'cxtjList[0].cxgx': 'like',
        'cxtjList[0].cxnr': name,
      },
    ];
    let matched = false;
    for (const data of requestBodies) {
      try {
        const response = await request({ url: COURSE_CATALOG_URL, method: 'POST', data, headers: ajaxHeaders(), responseType: 'text', disableRedirects: true });
        const body = responseText(response);
        if (response.status === 401 || response.status === 403 || isAuthenticationPage(body)) throw new CampusError('教务网登录态已失效，请重新读取。', 'authentication');
        const payload = parseJson(response, '教务网课程目录');
        const items = listFromPayload(payload, ['items', 'rows', 'result', 'data', 'courseList', 'courses', 'list']);
        for (const item of items) {
          const record = normalizeCourseCreditRecord(item, records.length);
          if (!record || !relatedCourseNames(name, record.name)) continue;
          const key = `${record.courseKey}|${record.name}|${record.credit}`;
          if (!seen.has(key)) {
            seen.add(key);
            records.push(record);
          }
          matched = true;
        }
        if (matched) break;
      } catch (error) {
        if (error instanceof CampusError && (error.code === 'authentication' || error.code === 'credentials')) throw error;
      }
    }
  }
  return records;
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

function relatedCourseNames(left: string, right: string): boolean {
  const leftKey = normalizedCourseName(left);
  const rightKey = normalizedCourseName(right);
  if (leftKey.length < 2 || rightKey.length < 2) return false;
  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function gradeRecorded(score: string): boolean {
  const value = normalizedGradeLabel(score);
  return gradeCreditIncluded(value) && value !== '未录入' && value !== '暂无';
}

function gradePassed(score: string): boolean {
  const value = normalizedGradeLabel(score);
  if (!gradeRecorded(value)) return false;
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric >= 60;
  if (/优秀|良好|中等|通过|合格|免修|免考|优|良/.test(value)) return true;
  return !/不及格|不通过|未通过|缺考|取消|缓考|违纪/.test(value) && value === '通过';
}

function usableCredit(value: string | undefined): boolean {
  const credit = value === undefined ? undefined : numberValue(value);
  return credit !== undefined && credit > 0;
}

export function enrichCoursesWithAcademicData(courses: CampusCourse[], grades: CampusGrade[], learningCourses: CampusLearningCourse[], courseCredits: CourseCreditRecord[] = []): CampusCourse[] {
  const creditById = new Map(courseCredits.map((record) => [record.id.trim(), record]));
  const creditByCourseKey = new Map(courseCredits.filter((record) => record.courseKey.trim()).map((record) => [record.courseKey.trim(), record]));
  const creditByName = new Map<string, CourseCreditRecord>();
  for (const record of courseCredits) {
    const key = normalizedCourseName(record.name);
    if (key && !creditByName.has(key)) creditByName.set(key, record);
  }
  const byId = new Map(grades.map((grade) => [grade.id.trim(), grade]));
  const byCourseKey = new Map(grades.filter((grade) => grade.courseKey?.trim()).map((grade) => [grade.courseKey!.trim(), grade]));
  const byName = new Map<string, CampusGrade>();
  for (const grade of grades) {
    const key = normalizedCourseName(grade.name);
    if (key && usableCredit(grade.credit) && !byName.has(key)) byName.set(key, grade);
  }
  const learningById = new Map<string, CampusLearningCourse>();
  const learningByName = new Map<string, CampusLearningCourse>();
  for (const learningCourse of learningCourses) {
    for (const key of [learningCourse.id, learningCourse.code].map((value) => value.trim()).filter(Boolean)) {
      if (!learningById.has(key)) learningById.set(key, learningCourse);
    }
    const nameKey = normalizedCourseName(learningCourse.name);
    if (nameKey && usableCredit(learningCourse.credit) && !learningByName.has(nameKey)) learningByName.set(nameKey, learningCourse);
  }
  const relatedGradeFor = (name: string): CampusGrade | undefined => {
    const matches = grades.filter((grade) => usableCredit(grade.credit) && relatedCourseNames(name, grade.name));
    const credits = new Set(matches.map((grade) => grade.credit.trim()));
    return credits.size === 1 ? matches[0] : undefined;
  };
  const relatedLearningCourseFor = (name: string): CampusLearningCourse | undefined => {
    const matches = learningCourses.filter((course) => usableCredit(course.credit) && relatedCourseNames(name, course.name));
    const credits = new Set(matches.map((course) => course.credit.trim()));
    return credits.size === 1 ? matches[0] : undefined;
  };
  const relatedCourseCreditFor = (name: string): CourseCreditRecord | undefined => {
    const matches = courseCredits.filter((record) => usableCredit(record.credit) && relatedCourseNames(name, record.name));
    const credits = new Set(matches.map((record) => record.credit.trim()));
    return credits.size === 1 ? matches[0] : undefined;
  };
  return courses.map((course) => {
    const courseId = course.id.trim();
    const nameKey = normalizedCourseName(course.name);
    const selectedCourse = [courseId, course.courseKey?.trim() || '']
      .filter(Boolean)
      .map((key) => creditById.get(key) || creditByCourseKey.get(key))
      .find((record): record is CourseCreditRecord => Boolean(record));
    const namedSelectedCourse = creditByName.get(nameKey) || relatedCourseCreditFor(course.name);
    const exactGrade = [courseId, course.courseKey?.trim() || '']
      .filter(Boolean)
      .map((key) => byId.get(key) || byCourseKey.get(key))
      .find((grade): grade is CampusGrade => Boolean(grade));
    const namedGrade = byName.get(nameKey) || relatedGradeFor(course.name);
    const learningCourse = learningById.get(courseId)
      || (course.courseKey ? learningById.get(course.courseKey.trim()) : undefined)
      || learningByName.get(nameKey)
      || relatedLearningCourseFor(course.name);
    const credit = usableCredit(course.credit)
      ? course.credit
      : usableCredit(selectedCourse?.credit)
        ? selectedCourse!.credit
        : usableCredit(namedSelectedCourse?.credit)
          ? namedSelectedCourse!.credit
          : usableCredit(exactGrade?.credit)
            ? exactGrade!.credit
            : usableCredit(learningCourse?.credit)
              ? learningCourse!.credit
              : usableCredit(namedGrade?.credit)
                ? namedGrade!.credit
                : '—';
    if (!exactGrade) return { ...course, credit };
    return {
      ...course,
      credit,
      score: course.score !== '—' ? course.score : exactGrade.score,
      completed: gradeRecorded(exactGrade.score),
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

function extractPublicContactLegacy(body: string, label: string): string {
  const escapedLabel = label;
  const contactClass = label === '电话' ? '(?:phone|telephone|tel|mobile)' : '(?:email|mail)';
  const normalize = label === '电话' ? normalizePublicPhone : normalizePublicEmail;
  const patterns = [
    new RegExp(`<label[^>]*>\\s*${escapedLabel}\\s*</label>([\\s\\S]{0,360})`, 'i'),
    new RegExp(`<li[^>]*class=["'][^"']*${contactClass}[^"']*["'][^>]*>([\\s\\S]{0,360})`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (!match?.[1]) continue;
    const segment = match[1].split(/<li\b/i)[0];
    const mailto = segment.match(/mailto:([^"' >]+)/i)?.[1];
    if (mailto && label === '邮箱') return normalize(decodeHtml(mailto));
    const value = cleanDisplayText(segment).replace(new RegExp(`^${escapedLabel}\\s*[:：]?\\s*`, 'i'), '').trim();
    const normalized = normalize(value);
    if (normalized) return normalized;
  }
  return label === '邮箱' ? normalizePublicEmail(body) : '';
}

function extractPublicContact(body: string, label: string): string {
  const legacy = extractPublicContactLegacy(body, label);
  if (legacy) return legacy;

  const labelPattern = label === '电话'
    ? '(?:办公电话|联系电话|工作电话|移动电话|电话|手机|座机)'
    : '(?:电子邮箱|邮箱|E-?mail)';
  const classPattern = label === '电话' ? '(?:telephone|phone|tel|mobile)' : '(?:email|mail)';
  const normalize = label === '电话' ? normalizePublicPhone : normalizePublicEmail;
  const stripLabel = new RegExp('^' + labelPattern + '\\s*[:：]?\\s*', 'i');
  const nextFieldPattern = /\s+(?:电子邮箱|邮箱|E-?mail|地址|办公地址|研究方向)\s*[:：]?/i;
  const patterns = [
    new RegExp('<label[^>]*>\\s*' + labelPattern + '\\s*</label>([\\s\\S]{0,360})', 'i'),
    new RegExp('<[^>]+(?:class|id)=[^>]*' + classPattern + '[^>]*>([\\s\\S]{0,360})', 'i'),
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (!match?.[1]) continue;
    const segment = match[1].split(/<li\b/i)[0];
    const mailto = segment.match(/mailto:([^"' >]+)/i)?.[1];
    if (mailto && label === '邮箱') return normalize(decodeHtml(mailto));
    const value = cleanDisplayText(segment).replace(stripLabel, '').split(nextFieldPattern)[0].trim();
    const normalized = normalize(value);
    if (normalized) return normalized;
  }

  const plain = cleanDisplayText(body);
  if (label === '邮箱') return normalizePublicEmail(plain);
  const plainValue = plain.match(new RegExp(labelPattern + '\\s*[:：]?\\s*([^\\n]{3,180})', 'i'))?.[1]
    ?.split(nextFieldPattern)[0]
    .trim() || '';
  return normalizePublicPhone(plainValue);
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
    let phone = normalizePublicPhone(field(item, ['phone', 'telephone', 'tel', 'mobile', 'mobile_phone', 'office_phone', 'work_phone', 'contact_phone']));
    let email = normalizePublicEmail(field(item, ['email', 'mail', 'email_address', 'contact_email']));
    try {
      if (!phone || !email) {
        const profile = await followGet(profileUrl);
        if (profile.status >= 200 && profile.status < 300) {
          const body = responseText(profile);
          phone = phone || normalizePublicPhone(extractPublicContact(body, '电话'));
          email = email || normalizePublicEmail(extractPublicContact(body, '邮箱'));
        }
      }
    } catch {
      // Keep the official profile URL even if the optional detail page is unavailable.
    }
    results.push({ id: String(item.id || mappingName), name, college, title, phone: phone || '未公开', email, profileUrl, sourceUrl: profileUrl, source: '浙江大学教师个人主页门户' });
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

async function ensureCoursesSession(allowWebVpnRefresh = true): Promise<void> {
  let current = routedUrl(COURSES_HOME);
  for (let index = 0; index < 8; index += 1) {
    const response = await request({ url: current, responseType: 'text', disableRedirects: true });
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, 'location');
      if (!location) throw new CampusError('学在浙大登录跳转缺少目标地址。', 'authentication');
      const next = routedUrl(location, current);
      if (isWebVpnLoginUrl(next)) {
        if (campusTransport === 'webvpn' && allowWebVpnRefresh) {
          await activateWebVpn();
          return ensureCoursesSession(false);
        }
        throw new CampusError('学在浙大没有建立登录会话，请重新读取。', 'authentication');
      }
      current = next;
      continue;
    }
    const body = responseText(response);
    if (response.status < 200 || response.status >= 300) throw new CampusError(`学在浙大登录失败（HTTP ${response.status}）。`, 'authentication');
    if (isWebVpnLoginPage(body) || (campusTransport === 'webvpn' && isAuthenticationPage(body))) {
      if (campusTransport === 'webvpn' && allowWebVpnRefresh) {
        await activateWebVpn();
        return ensureCoursesSession(false);
      }
      throw new CampusError('学在浙大没有建立登录会话，请重新读取。', 'authentication');
    }
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
    await establishCampusSession(cleanId, password);
    await ensureCoursesSession();
    return await readCourseActivities(cleanCourseId);
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
    const details = normalizeTodoDetails(item);
    const courseId = field(item, ['course_id', 'courseId', 'cid']);
    return [{
      id: String(item.id),
      name: field(item, ['title', 'name'], '未命名作业'),
      course: field(item, ['course_name', 'course'], '未知课程'),
      deadline: field(item, ['end_time', 'deadline']),
      status: 'pending',
      ...(courseId ? { courseId } : {}),
      ...details,
      source: '学在浙大待办列表',
      sourceUrl: details.sourceUrl || COURSES_HOME,
    }];
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

export async function readPublicHolidays(academicYear: string): Promise<{ holidays: CampusHoliday[]; calendarUrl: string }> {
  assertNative();
  const safeYear = /^20\d{2}-20\d{2}$/.test(academicYear) ? academicYear : currentAcademicTerm().year + '-' + (Number(currentAcademicTerm().year) + 1);
  const previousTransport = campusTransport;
  campusTransport = 'direct';
  try {
    let index = await request({ url: CALENDAR_LIST_URL, responseType: 'text', disableRedirects: true, isolated: true });
    if (index.status < 200 || index.status >= 300) index = await request({ url: CALENDAR_LIST_FALLBACK_URL, responseType: 'text', disableRedirects: true, isolated: true });
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
    if (!page) throw new CampusError(`本科生院没有找到${safeYear}学年校历。`, 'response');
    const pageResponse = await followGet(page.url, undefined, 'text', false, true);
    if (pageResponse.status < 200 || pageResponse.status >= 300) throw new CampusError(`浙大官方校历页面暂时无法访问（HTTP ${pageResponse.status}）。`, 'network');
    const pageBody = responseText(pageResponse);
    const pdfSource = pageBody.match(/\bpdfsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      || pageBody.match(/\bhref\s*=\s*["']([^"']+\.pdf(?:\?[^"']*)?)["']/i)?.[1];
    let calendarUrl = '';
    if (pdfSource) {
      try {
        const parsedUrl = new URL(decodeHtml(pdfSource), page.url);
        if (parsedUrl.protocol === 'https:' && parsedUrl.hostname.toLowerCase() === 'ugrs.zju.edu.cn') calendarUrl = parsedUrl.toString();
      } catch {
        // Do not expose an article page as a downloadable PDF fallback.
      }
    }
    return { holidays: readHolidayEvents(pageBody, safeYear, page.url), calendarUrl };
  } finally {
    campusTransport = previousTransport;
  }
}

const MAX_OFFICIAL_CALENDAR_PDF_BYTES = 16 * 1024 * 1024;

/** Read the public academic calendar from the official undergraduate-school host. */
export async function readOfficialCalendarPdf(value: string): Promise<Uint8Array> {
  assertNative();
  let current: URL;
  try {
    current = new URL(value);
  } catch {
    throw new CampusError('校历地址无效，请重新读取校园信息。', 'response');
  }
  const isOfficialCalendarUrl = (url: URL) => url.protocol === 'https:'
    && url.origin === 'https://ugrs.zju.edu.cn'
    && !url.username
    && !url.password;
  if (!isOfficialCalendarUrl(current)) {
    throw new CampusError('校历地址不是本科生院的官方地址，已停止读取。', 'response');
  }

  try {
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      const result = await IsolatedHttp.request({
        url: current.toString(),
        method: 'GET',
        headers: {
          Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'identity',
        },
        responseType: 'arraybuffer',
        disableRedirects: true,
        maxResponseBytes: MAX_OFFICIAL_CALENDAR_PDF_BYTES,
      });
      if (result.status >= 300 && result.status < 400) {
        const location = headerValue(result.headers, 'location');
        if (!location || attempt === 5) throw new CampusError('本科生院校历跳转异常，请稍后重试。', 'response');
        const next = new URL(location, current);
        if (!isOfficialCalendarUrl(next)) {
          throw new CampusError('校历跳转到非本科生院地址，已停止读取。', 'response');
        }
        current = next;
        continue;
      }
      if (result.status < 200 || result.status >= 300) {
        throw new CampusError(`本科生院校历暂时无法读取（HTTP ${result.status}）。`, 'network');
      }
      if (typeof result.data !== 'string') throw new CampusError('本科生院返回的校历格式无法识别。', 'response');
      const bytes = decodeBase64Bytes(result.data);
      if (bytes.byteLength > MAX_OFFICIAL_CALENDAR_PDF_BYTES) throw new CampusError('校历文件超过安全读取上限。', 'response');
      const signature = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
      if (!signature.includes('%PDF-')) throw new CampusError('本科生院返回的内容不是可识别的 PDF 校历。', 'response');
      return bytes;
    }
  } catch (error) {
    if (error instanceof CampusError) throw error;
    throw new CampusError(error instanceof Error && error.message === 'campus_response_too_large'
      ? '校历文件超过 16 MB，暂时无法在手机内打开。'
      : error instanceof Error ? error.message : '校历下载失败，请检查网络后重试。', 'network');
  }
  throw new CampusError('本科生院校历跳转次数过多，已停止读取。', 'response');
}

function makeGradeAlerts(grades: CampusGrade[]): CampusGradeAlert[] {
  return grades.flatMap((grade) => {
    if (!gradeCreditIncluded(grade.score)) return [];
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
  const representative = scoped[0];
  const eligible = scoped.filter((grade) => usableCredit(grade.credit) && gradeCreditIncluded(grade.score));
  const counted = eligible.filter((grade) => gradeGpaPolicyIncluded(grade.score, grade.id) && numberValue(grade.point) !== undefined);
  const denominator = counted.reduce((sum, grade) => sum + (numberValue(grade.credit) || 0), 0);
  const gpa = denominator ? counted.reduce((sum, grade) => sum + (numberValue(grade.credit) || 0) * (numberValue(grade.point) || 0), 0) / denominator : null;
  return {
    ...(representative.academicYear ? { academicYear: representative.academicYear } : {}),
    ...(representative.term ? { term: representative.term } : {}),
    ...(semesterId ? { semesterId } : {}),
    throughSemester: semesterId || 'all_available',
    gpa: gpa === null ? null : Number(gpa.toFixed(3)),
    creditDenominator: Number(denominator.toFixed(3)),
    eligibleAttempts: eligible.length,
    countedAttempts: counted.length,
    excludedAttempts: scoped.length - counted.length,
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

async function establishCampusSession(studentId: string, password: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clearCampusCookies();
      campusTransport = 'direct';
      try {
        await authenticate(studentId, password);
      } catch (error) {
        if (!(error instanceof CampusError) || error.code !== 'network') throw error;
        if (backgroundRunnerMode) throw error;
        await activateWebVpn();
      }
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof CampusError) || error.code !== 'network' || attempt === 1) throw error;
      // Give Android's cookie bridge one more settle window before rebuilding
      // the complete direct/CAS/WebVPN session.
      await waitForNativeCookieSync();
    }
  }
  throw lastError instanceof Error ? lastError : new CampusError('校园登录会话没有建立。', 'network');
}

export async function readCampusInfo(studentId: string, password: string, options: { academicYear?: string; term?: string; backgroundRefresh?: boolean } = {}): Promise<MobileCampusData> {
  assertNative(options.backgroundRefresh === true);
  const cleanId = studentId.trim();
  if (!cleanId || !password) throw new CampusError('请先填写学号和校园密码。', 'credentials');
  backgroundRunnerMode = options.backgroundRefresh === true;
  campusTransport = 'direct';
  activeCampusCredentials = { studentId: cleanId, password };
  activeCookieJar = new CookieJar();
  practiceCookieJar = new CookieJar();
  try {
    await establishCampusSession(cleanId, password);
    const year = academicYearValue(options.academicYear);
    const term = termValue(options.term || academicTerm().term);
    const warnings: string[] = [];
    let courses: CampusCourse[] = [];
    let courseCredits: CourseCreditRecord[] = [];
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
    let calendarUrl: string | undefined;
    let successfulModules = 0;
    const refreshedDomains: NonNullable<MobileCampusData['refreshedDomains']> = [];

    try {
      courses = await readSchedule(year, term);
      successfulModules += 1;
      refreshedDomains.push('schedule');
      if (scheduleReadWarning) warnings.push(`课表：${scheduleReadWarning}`);
    } catch (error) {
      if (isFatalModuleError(error)) throw error;
      warnings.push(`课表：${errorText(error)}`);
    }
    try {
      courseCredits = await readSelectedCourseCredits(year, term);
    } catch (error) {
      if (isFatalModuleError(error)) throw error;
      warnings.push(`课程学分：${errorText(error)}`);
    }
    if (courses.length && courseCredits.length < courses.length) {
      try {
        const catalogCredits = await readCourseCatalogCredits(year, term, courses);
        const mergedCredits = new Map<string, CourseCreditRecord>();
        for (const record of [...courseCredits, ...catalogCredits]) {
          mergedCredits.set(`${record.courseKey}|${record.name}|${record.credit}`, record);
        }
        courseCredits = [...mergedCredits.values()];
      } catch (error) {
        if (isFatalModuleError(error)) throw error;
        warnings.push(`课程目录学分：${errorText(error)}`);
      }
    }
    courseOfferings = [...new Map(courses.map((course) => [course.id, normalizeCourseOffering(course, `${year}-${term}`)])).values()];
    try { exams = await readExams(); successfulModules += 1; refreshedDomains.push('exams'); } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`考试：${errorText(error)}`); }
    try { grades = await readGrades(); successfulModules += 1; refreshedDomains.push('grades'); } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`成绩：${errorText(error)}`); }
    try {
      learningCourses = await readLearningCourses();
      successfulModules += 1;
      refreshedDomains.push('learningCourses');
    } catch (error) {
      if (isFatalModuleError(error)) throw error;
      warnings.push(`学在浙大课程：${errorText(error)}`);
    }
    try { todos = await readTodos(); successfulModules += 1; refreshedDomains.push('todos'); } catch (error) { if (isFatalModuleError(error)) throw error; warnings.push(`待办：${errorText(error)}`); }
    if (!backgroundRunnerMode) {
      try {
        const practice = await readPractice();
        practiceSummary = practice.summary;
        practiceProjects = practice.projects;
        warnings.push(...practice.warnings);
        successfulModules += 1;
        refreshedDomains.push('practice');
      } catch (error) {
        warnings.push(`体育与素质拓展：${errorText(error)}`);
      }
      try {
        const calendar = await readPublicHolidays(`${year}-${Number(year) + 1}`);
        holidays = calendar.holidays;
        calendarUrl = calendar.calendarUrl;
        successfulModules += 1;
        refreshedDomains.push('calendar');
      } catch (error) {
        warnings.push(`校历：${errorText(error)}`);
      }
    }
    if (!successfulModules && warnings.length) throw new CampusError(warnings.join('；'), 'response');

    const startedGrades = grades.filter((grade) => isStartedAcademicTerm(grade.academicYear, grade.term));
    if (startedGrades.length !== grades.length) warnings.push(`成绩：已隐藏${grades.length - startedGrades.length}条尚未开始学期的记录。`);
    grades = startedGrades;
    courses = enrichCoursesWithAcademicData(courses, grades, learningCourses, courseCredits);
    const missingCourseCredits = courses.filter((course) => !usableCredit(course.credit)).length;
    if (missingCourseCredits) {
      warnings.push(courseCredits.length
        ? `课程学分：教务已返回${courseCredits.length}条课程记录，但仍有${missingCourseCredits}门课未能匹配。`
        : `课程学分：教务已选课程接口未返回可用学分，仍有${missingCourseCredits}门课未显示。`);
    }
    courseOfferings = [...new Map(courses.map((course) => [course.id, normalizeCourseOffering(course, `${year}-${term}`)])).values()];
    gradeAlerts = makeGradeAlerts(grades);
    gpaCumulative = makeGpaSummary(grades);
    const semesterIds = [...new Set(grades.map((grade) => grade.semesterId).filter((item): item is string => Boolean(item)))];
    gpaSemesters = semesterIds.flatMap((semesterId) => {
      const summary = makeGpaSummary(grades, semesterId);
      return summary ? [summary] : [];
    });
    const creditGrades = grades.flatMap((grade) => {
      const credit = numberValue(grade.credit);
      const point = numberValue(grade.point);
      return credit !== undefined && credit > 0 && gradeCreditIncluded(grade.score) ? [{ grade, credit, point }] : [];
    });
    const totalCredit = creditGrades.reduce((sum, item) => sum + item.credit, 0);
    const completedCredit = creditGrades.reduce((sum, item) => gradeRecorded(item.grade.score) ? sum + item.credit : sum, 0);
    const earnedCredit = creditGrades.reduce((sum, item) => gradePassed(item.grade.score) ? sum + item.credit : sum, 0);
    const gpaGrades = creditGrades.filter((item): item is { grade: CampusGrade; credit: number; point: number } => gradeGpaPolicyIncluded(item.grade.score, item.grade.id) && item.point !== undefined && Number.isFinite(item.point));
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
      ...(calendarUrl ? { calendarUrl } : {}),
      sourceStatus: {
        available: true,
        credentialsConfigured: true,
        authStatus: 'credentials_saved',
        supportedDomains: ['schedule', 'courses', 'learning_courses', 'activities', 'exams', 'assignments', 'grades', 'grade_alerts', 'gpa', 'gpa_semesters', 'gpa_cumulative', 'practice', 'sports', 'projects', 'holidays', 'notices', 'source_status'],
        note: '手机端使用浙江大学官方只读来源；未执行任何教务写操作。',
      },
      warnings,
      refreshedDomains,
    };
  } finally {
    activeCookieJar = null;
    practiceCookieJar = null;
    practiceLoginPromise = null;
    zdbkSessionReady = false;
    campusTransport = 'direct';
    activeCampusCredentials = null;
    backgroundRunnerMode = false;
  }
}
