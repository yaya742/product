import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Store } from './store';

/** Account-backed campus data is kept distinct from legacy JSON imports. */
export const CAMPUS_ACCOUNT_SOURCE_ID = 'campus:zju-account';
export type CampusAuthStatus = 'needs_login' | 'credentials_saved' | 'verified' | 'failed';

export type CampusDomain =
  | 'schedule'
  | 'courses'
  | 'learning_courses'
  | 'exams'
  | 'assignments'
  | 'grades'
  | 'gpa'
  | 'gpa_semesters'
  | 'gpa_cumulative'
  | 'retakes'
  | 'practice'
  | 'sports'
  | 'projects'
  | 'activities'
  | 'reservations'
  | 'reservation_violations'
  | 'card'
  | 'transactions'
  | 'profile'
  | 'roles'
  | 'calendar_pending'
  | 'cancelled_classes'
  | 'holidays'
  | 'source_status';
export type CampusRefreshScope = 'academic' | 'domain';

export interface CampusReadArgs {
  domain: CampusDomain;
  courseId?: string;
  academicYear?: string;
  term?: '1' | '2';
  window?: string;
  from?: string;
  to?: string;
  at?: string;
  timeMode?: 'overlap' | 'starts' | 'contained';
  fields?: string[];
  filters?: string[];
  sort?: string;
  limit?: number;
  offset?: number;
  refresh?: boolean;
}
export interface CampusRefreshArgs {
  scope: CampusRefreshScope;
  domain?: CampusDomain;
  academicYear?: string;
  term?: '1' | '2';
}
export interface CampusConnectorState {
  configured: boolean;
  available: boolean;
  label: string;
  sourceKind?: 'zju_account';
  accessMode?: 'compatibility_local' | 'official';
  supportedDomains?: string[];
  authStatus?: CampusAuthStatus;
  lastVerifiedAt?: string;
  catalogued?: number;
  verified?: number;
  blocked?: number;
  credentialsConfigured?: boolean;
  reason?: string;
}

export interface CampusFullContextArgs {
  refresh?: boolean;
  includeSensitiveDomains?: boolean;
  academicYear?: string;
  term?: '1' | '2';
}

const DOMAIN_RESOURCE: Record<CampusDomain, string> = {
  schedule: 'classes',
  courses: 'courses',
  learning_courses: 'records',
  exams: 'exams',
  assignments: 'todos',
  grades: 'grades',
  gpa: 'gpa_overall',
  gpa_semesters: 'gpa_semesters',
  gpa_cumulative: 'gpa_cumulative',
  retakes: 'retakes',
  practice: 'practice_summary',
  sports: 'practice_summary',
  projects: 'projects',
  activities: 'activities',
  reservations: 'reservations',
  reservation_violations: 'reservation_violations',
  card: 'card_accounts',
  transactions: 'transactions',
  profile: 'student_profile',
  roles: 'roles',
  calendar_pending: 'calendar_pending',
  cancelled_classes: 'cancelled_classes',
  holidays: 'holidays',
  source_status: 'source_status',
};

const SUMMARY_FIELDS: Partial<Record<CampusDomain, string[]>> = {
  schedule: ['uid', 'summary', 'startTime', 'endTime', 'location', 'teacher', 'weekday', 'periods', 'half', 'weekPattern', 'rescheduled', 'time_precision'],
  courses: ['key', 'name', 'semester_id', 'credit', 'teachers', 'confirmed', 'online'],
  learning_courses: ['id', 'name', 'course_code', 'credit', 'semester_id', 'start_date', 'end_date', 'study_completeness'],
  exams: ['id', 'name', 'type', 'startTime', 'endTime', 'dateLabel', 'location', 'seat', 'time_precision'],
  assignments: ['id', 'name', 'course', 'deadline', 'status'],
  grades: ['id', 'name', 'semester_id', 'credit', 'original', 'fivePoint', 'gpaIncluded', 'gpa_exclusion_reason'],
  gpa_semesters: ['semester_id', 'gpa', 'gpa_credit_denominator', 'eligible_attempts', 'counted_attempts', 'excluded_attempts', 'complete'],
  gpa_cumulative: ['through_semester', 'gpa', 'gpa_credit_denominator', 'eligible_attempts', 'counted_attempts', 'complete'],
  retakes: ['course_key', 'course_code', 'name', 'attempts', 'selected', 'selection_policy'],
  projects: ['id', 'projectName', 'categoryName', 'score', 'statusLabel', 'approved', 'countsTowardTotal', 'activityStart', 'activityEnd'],
  activities: ['activity_id', 'course_id', 'name', 'type', 'starts_at', 'deadline', 'scores', 'completion'],
  reservations: ['nameMerge', 'startTime', 'endTime', 'statusName', 'record_semantics'],
  reservation_violations: ['nameMerge', 'date', 'statusName'],
  transactions: ['occurred_at', 'resume', 'tranamt', 'amount_unit'],
  card: ['db_balance', 'expdate', 'cardname'],
  profile: ['bmmc', 'xyzyxx', 'yhlx', 'student', 'teacher'],
  roles: ['mrjsmc', 'jsList', 'jsfl'],
  calendar_pending: ['original_date', 'reason', 'date', 'affected_session_uids'],
  cancelled_classes: ['session_uid', 'original_date', 'reason'],
};
const SAFE_MODEL_FIELDS = new Set([
  ...Object.values(SUMMARY_FIELDS).flat(),
  'date', 'dateLabel', 'title', 'name', 'status', 'source', 'updatedAt', 'fetched_at',
  'startTime', 'endTime', 'location', 'teacher', 'summary', 'deadline', 'credit', 'amount_unit',
]);

const DOMAIN_LABEL: Record<CampusDomain, string> = {
  schedule: '逐次课程',
  courses: '课程与教学班',
  learning_courses: '学在浙大课程',
  exams: '考试安排',
  assignments: '作业与待办',
  grades: '成绩记录',
  gpa: '绩点汇总',
  gpa_semesters: '分学期绩点',
  gpa_cumulative: '累计绩点',
  retakes: '重修记录',
  practice: '实践与体育相关记录',
  sports: '体育记录',
  projects: '实践项目',
  activities: '课程活动',
  reservations: '图书馆预约',
  reservation_violations: '预约违约记录',
  card: '校园卡账户',
  transactions: '校园卡流水',
  profile: '学生资料',
  roles: '校园账号角色',
  calendar_pending: '待公布补课日期',
  cancelled_classes: '停课与替代课次',
  holidays: '校历与假期',
  source_status: '数据连接状态',
};

// High-level resources are backed by the connector's selected normalized cache.
// Reading them gives the model a bounded index without mistaking endpoint
// samples or recurring periods for complete dated personal data.
const FULL_CONTEXT_DOMAINS: CampusDomain[] = [
  'schedule',
  'courses',
  'learning_courses',
  'exams',
  'assignments',
  'grades',
  'gpa',
  'gpa_semesters',
  'gpa_cumulative',
  'retakes',
  'practice',
  'projects',
  'reservations',
  'reservation_violations',
  'card',
  'transactions',
  'profile',
  'roles',
  'calendar_pending',
  'cancelled_classes',
  'holidays',
  'source_status',
];
const SENSITIVE_DOMAINS = new Set<CampusDomain>([
  'reservations',
  'reservation_violations',
  'card',
  'transactions',
  'profile',
  'roles',
]);
const DIRECT_REFRESH_DOMAINS = new Set<CampusDomain>([
  'reservations',
  'reservation_violations',
  'card',
  'transactions',
  'profile',
  'roles',
]);
const ACADEMIC_RESOURCES = new Set<CampusDomain>([
  'schedule',
  'courses',
  'exams',
  'assignments',
  'grades',
  'gpa',
  'gpa_semesters',
  'gpa_cumulative',
  'retakes',
  'practice',
  'sports',
  'projects',
  'calendar_pending',
  'cancelled_classes',
  'holidays',
  'source_status',
]);

// Campus data is account-backed and changes less frequently than a chat turn.
// Keep the encrypted snapshot usable for two days, then refresh in the
// background so the first question after the deadline is still responsive.
export const CAMPUS_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CAMPUS_AUTO_REFRESH_DISABLED = process.env.ZAICHANG_TEST === '1';

interface ConnectorManifest {
  schemaVersion?: number;
  id?: string;
  label?: string;
  protocolVersion?: number;
  accessMode?: 'compatibility_local' | 'official';
  entrypoint?: string;
  allowedHosts?: string[];
  supportedDomains?: string[];
}

function readManifest(root: string): ConnectorManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'connector.json'), 'utf8')) as ConnectorManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.protocolVersion !== 1 ||
      manifest.id !== 'zju-student-info' ||
      manifest.accessMode !== 'compatibility_local' ||
      manifest.entrypoint !== 'scripts/zju.py' ||
      !Array.isArray(manifest.allowedHosts) ||
      !manifest.allowedHosts.includes('zjuam.zju.edu.cn') ||
      !Array.isArray(manifest.supportedDomains) ||
      !manifest.supportedDomains.every((domain) => ['schedule', 'courses', 'exams', 'assignments', 'source_status'].includes(domain))
    ) return null;
    return manifest;
  } catch {
    return null;
  }
}

function safeRoot(candidate: string | null | undefined): string | null {
  if (!candidate?.trim()) return null;
  const root = path.resolve(candidate.trim());
  if (
    !existsSync(path.join(root, 'scripts', 'zju.py')) ||
    !existsSync(path.join(root, 'references', 'endpoints.json')) ||
    !existsSync(path.join(root, 'SKILL.md')) ||
    !existsSync(path.join(root, 'LICENSE')) ||
    !readManifest(root)
  )
    return null;
  return root;
}

// These are source-field names observed in the skill's authenticated responses.
// Keep ordinary course/exam IDs usable while blocking account, card and identity
// identifiers before anything reaches the model or UI transcript.
const SENSITIVE_FIELD = /^(?:password|passwd|token|ticket|cookie|authorization|synjones|secret|openid|unionid|accesskey|qrcode|qr_code|barcode|voucher|body_b64|student.?no|student.?id|card.?no|card_number|identity.?no|identity.?id|id.?card|phone|mobile|email|account|sno|xh|yhm|xm|zgh|custid|custmemberid|acctid|cardid|bankacc|cert|schcode|yktschoolcode)$/i;

function parseJson(output: string): any {
  const trimmed = output.trim();
  if (!trimmed) throw new Error('连接器没有返回结果。');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('连接器返回的不是有效 JSON。');
  }
}

function safeAuthErrorMessage(value: unknown): string {
  const message = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!message) return '浙大统一身份认证没有完成，请检查网络或登录信息。';
  return message.slice(0, 240);
}

function hostAuthError(error: unknown): { code: string; message: string } {
  const candidate = error as NodeJS.ErrnoException | undefined;
  if (candidate?.code === 'ENOENT')
    return { code: 'RUNTIME_MISSING', message: '本机没有找到校园连接器所需的 Python 运行环境。' };
  const message = error instanceof Error ? error.message : '';
  if (/时间上限|timed?\s*out|timeout/i.test(message))
    return { code: 'AUTH_TIMEOUT', message: '浙大统一身份认证响应超时，请检查网络后重试。' };
  if (/输出异常|有效 JSON|没有返回结果/.test(message))
    return { code: 'PROTOCOL_ERROR', message: '校园连接器返回异常，请重新启动在场后重试。' };
  return { code: 'AUTH_FAILED', message: '浙大统一身份认证没有完成，请检查网络或登录信息。' };
}

function modelRecords(domain: CampusDomain | undefined, records: any): any {
  const clean = sanitize(records);
  if (!Array.isArray(clean)) return clean;
  if (domain === 'practice' || domain === 'sports')
    return clean.map((record) => ({
      second_class_points: record.dektJf,
      third_class_points: record.dsktJf,
      fourth_class_points: record.dsiktJf,
      second_class_credits: record.dektXf,
      third_class_credits: record.dsktXf,
      fourth_class_credits: record.dsiktXf,
      second_class_level: record.dektDj,
      third_class_level: record.dsktDj,
      fourth_class_level: record.dsiktDj,
      second_class_passed: record.dektTg,
      third_class_passed: record.dsktTg,
      fourth_class_passed: record.dsiktTg,
      aesthetic_education_passed: record.myTg,
      labor_education_passed: record.lyTg,
      note: 'points and credits are different measures; null means not supplied by this record',
    }));
  if (domain === 'profile')
    return clean.map((record) => ({
      department: record.bmmc,
      academic_program: record.xyzyxx,
      user_type: record.yhlx,
      is_student: record.student,
      is_teacher: record.teacher,
    }));
  if (domain === 'roles')
    return clean.map((record) => ({
      default_role: record.mrjsmc,
      roles: record.jsList,
      role_category: record.jsfl,
    }));
  if (domain === 'card')
    return clean.map((record) => ({
      balance_raw: record.db_balance,
      balance_unit: 'unverified_source_unit',
      expires_on_raw: record.expdate,
      card_type_name: record.cardname,
    }));
  return clean;
}

function stopProcess(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function compactResult(result: any, domain?: CampusDomain): any {
  if (!result || typeof result !== 'object') return result;
  const output: any = {
    status: result.status,
    fetched_at: result.fetched_at,
    source:
      result.source && typeof result.source === 'object'
        ? { service: result.source.service, evidence: result.source.evidence }
        : result.source,
    validation: result.validation,
    query: result.query,
    returned: result.returned,
    server_returned_count: result.server_returned_count,
    pagination: result.pagination,
    changes: result.changes,
    completeness: result.completeness,
    issues: result.issues,
    empty_result: result.empty_result,
    note: result.note,
    error: result.error,
    retrieved_at: result.retrieved_at,
    stale: result.stale,
    freshness: result.freshness,
    resource: result.resource,
    operation: result.operation,
    evaluated_at: result.evaluated_at,
    time_interval: result.time_interval,
    total_matches: result.total_matches,
    offset: result.offset,
    next_offset: result.next_offset,
    unknown_time_records: result.unknown_time_records,
    coverage: result.coverage,
    metric_quality: result.metric_quality,
    measurement_notes: result.measurement_notes,
    credential_redactions: result.credential_redactions,
    nested_values_truncated: result.nested_values_truncated,
    schema_version: result.schema_version,
    semester_id: result.semester_id,
    counts: result.counts,
    preserved_resources: result.preserved_resources,
    grade_attempts: result.grade_attempts,
    practice_projects: result.practice_projects,
    data_quality: result.data_quality,
    schedule_coverage: result.schedule_coverage,
    sections: result.sections,
    raw_data_preserved: result.raw_data_preserved,
    normalization_error_type: result.normalization_error_type,
    message: result.message,
    requested: result.requested,
    executed: result.executed,
  };
  if ('records' in result) output.records = modelRecords(domain, result.records);
  if ('results' in result) output.results = sanitize(result.results);
  if ('result' in result) output.result = sanitize(result.result);
  if (domain === 'source_status' && result.resources) output.resources = result.resources;
  if ('normalized' in result) output.normalized = sanitize(result.normalized);
  if ('bundle_id' in result) output.bundle_id = result.bundle_id;
  const safeOutput = sanitize(output);
  let serialized = JSON.stringify(safeOutput);
  if (serialized.length <= 56000) return safeOutput;
  if (safeOutput.normalized) delete safeOutput.normalized;
  if (Array.isArray(safeOutput.results)) safeOutput.results = safeOutput.results.slice(0, 8);
  if (Array.isArray(safeOutput.records)) {
    safeOutput.records = safeOutput.records.slice(0, 12);
  }
  safeOutput.truncated_for_model = true;
  safeOutput.note = '连接器只在本机保留规范化缓存；本次只返回有界摘要。请缩小时间范围或字段后继续。';
  serialized = JSON.stringify(safeOutput);
  if (serialized.length > 56000 && Array.isArray(safeOutput.results)) safeOutput.results = safeOutput.results.slice(0, 3);
  return safeOutput;
}

function sanitize(value: any, key = '', depth = 0): any {
  if (depth > 12) return '[depth limit]';
  if (SENSITIVE_FIELD.test(key) || /(身份证|学号|手机号|邮箱)/.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value
      .replace(/(token|ticket|code|synjones-auth|password)=[^&\s"<>]+/gi, '$1=[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k, depth + 1)]));
  return value;
}

export class ZjuAdapter {
  private authInFlight?: Promise<any>;
  private academicInFlight = new Map<string, Promise<any>>();
  private academicBundles = new Map<string, string>();
  private learningBundles = new Map<string, string>();
  private resolvedPython?: string;

  constructor(
    private store: Store,
    private testPorts: { credentialsConfigured?: () => boolean; python?: string } = {},
  ) {}

  private discoveredRoot(): string | null {
    const stored = safeRoot(this.store.meta<string | null>('zju_source_root', null));
    if (stored) return stored;
    const explicit = safeRoot(process.env.ZAICHANG_ZJU_SOURCE);
    if (explicit) return explicit;
    // The installed skill is the source of truth.  Discover it for both dev and
    // packaged Electron runs so the user does not have to manually import files
    // or browse to an implementation directory on every machine start.
    // Test profiles are intentionally isolated from the real account.
    if (process.env.ZAICHANG_TEST === '1') return null;
    const candidates = [
      path.join(homedir(), '.codex', 'skills', 'zju-student-info'),
      process.env.CODEX_HOME
        ? path.join(path.resolve(process.env.CODEX_HOME), 'skills', 'zju-student-info')
        : '',
      path.resolve(process.cwd(), 'integrations', 'zju-student-info'),
      process.resourcesPath
        ? path.join(process.resourcesPath, 'integrations', 'zju-student-info')
        : '',
    ];
    for (const candidate of candidates) {
      const discovered = safeRoot(candidate);
      if (discovered) return discovered;
    }
    return null;
  }

  private root(): string | null {
    return this.store.meta<boolean>('zju_source_disabled', false) ? null : this.discoveredRoot();
  }

  connectInstalled(): CampusConnectorState {
    this.store.putMeta('zju_source_disabled', false);
    const root = this.discoveredRoot();
    if (!root) {
      this.store.putMeta('zju_source_disabled', true);
      throw new Error('还没有找到浙大个人信息技能，请先安装或选择技能目录。');
    }
    return this.describe();
  }

  describe(): CampusConnectorState {
    const root = this.root();
    if (!root)
      return {
        configured: false,
        available: false,
        label: '浙大校园账号',
        sourceKind: 'zju_account',
        accessMode: 'compatibility_local',
        supportedDomains: ['schedule', 'courses', 'exams', 'assignments', 'source_status'],
        authStatus: 'needs_login',
        credentialsConfigured: false,
        reason: '还没有找到浙大个人信息技能。可以安装技能，或在连接设置中选择它。',
      };
    try {
      const verificationPath = path.join(root, 'references', 'verification-latest.json');
      const manifest = readManifest(root);
      const verification = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : null;
      const credentialsConfigured = this.credentialsConfigured();
      const verifiedMtime = this.store.meta<number | null>('zju_verified_credentials_mtime', null);
      const currentMtime = this.credentialsMtime();
      const mtimeMatches = this.testPorts.credentialsConfigured
        ? true
        : verifiedMtime !== null &&
          verifiedMtime !== undefined &&
          currentMtime !== undefined &&
          verifiedMtime === currentMtime;
      const lastVerifiedAt = mtimeMatches
        ? this.store.meta<string | null>('zju_last_verified_at', null) || undefined
        : undefined;
      const lastAuthError = this.store.meta<string | null>('zju_last_auth_error', null);
      const lastAuthErrorMessage = this.store.meta<string | null>('zju_last_auth_error_message', null);
      const authStatus: CampusAuthStatus = !credentialsConfigured
        ? 'needs_login'
        : lastVerifiedAt
          ? 'verified'
          : lastAuthError
            ? 'failed'
            : 'credentials_saved';
      return {
        configured: true,
        available: true,
        label: '浙大校园账号',
        sourceKind: 'zju_account',
        accessMode: manifest?.accessMode || 'compatibility_local',
        supportedDomains: manifest?.supportedDomains,
        authStatus,
        lastVerifiedAt,
        catalogued: Number(verification?.total_catalogued || 0) || undefined,
        verified: Number(verification?.passed || 0) || undefined,
        blocked: Number(verification?.blocked || 0) || undefined,
        credentialsConfigured,
        reason: credentialsConfigured
          ? authStatus === 'verified'
            ? undefined
            : authStatus === 'failed'
              ? safeAuthErrorMessage(
                  lastAuthErrorMessage ||
                    (lastAuthError === 'INTERNAL_ERROR'
                      ? '校园连接器上次运行异常，请重新验证。'
                      : '登录信息已保存，但最近一次登录校验没有完成。'),
                )
              : '登录信息已保存，第一次读取时会用浙大统一身份认证校验。'
          : '还没有在本机保存浙大统一身份认证信息。',
      };
    } catch {
      return {
        configured: true,
        available: true,
        label: '浙大校园账号',
        sourceKind: 'zju_account',
        accessMode: 'compatibility_local',
        supportedDomains: ['schedule', 'courses', 'exams', 'assignments', 'source_status'],
        authStatus: this.credentialsConfigured() ? 'credentials_saved' : 'needs_login',
        credentialsConfigured: this.credentialsConfigured(),
        reason: '技能目录可用，但连接状态摘要暂时不可读。',
      };
    }
  }

  private credentialsConfigured(): boolean {
    if (this.testPorts.credentialsConfigured) return this.testPorts.credentialsConfigured();
    const base = process.env.LOCALAPPDATA;
    return !!base && existsSync(path.join(base, 'CodexZjuStudentInfo', 'credentials.dpapi'));
  }

  private credentialsMtime(): number | undefined {
    if (this.testPorts.credentialsConfigured) return undefined;
    const base = process.env.LOCALAPPDATA;
    if (!base) return undefined;
    try {
      return statSync(path.join(base, 'CodexZjuStudentInfo', 'credentials.dpapi')).mtimeMs;
    } catch {
      return undefined;
    }
  }

  configure(root: string): CampusConnectorState {
    const safe = safeRoot(root);
    if (!safe) throw new Error('所选目录不是可识别的浙大个人信息连接器。');
    this.store.putMeta('zju_source_root', safe);
    this.store.putMeta('zju_source_disabled', false);
    this.store.putMeta('zju_last_verified_at', null);
    this.store.putMeta('zju_last_auth_error', null);
    this.store.putMeta('zju_last_auth_error_message', null);
    this.store.putMeta('zju_verified_credentials_mtime', null);
    return this.describe();
  }

  disconnect() {
    this.store.putMeta('zju_source_root', null);
    this.store.putMeta('zju_source_disabled', true);
    this.store.putMeta('zju_last_verified_at', null);
    this.store.putMeta('zju_last_auth_error', null);
    this.store.putMeta('zju_last_auth_error_message', null);
    this.store.putMeta('zju_verified_credentials_mtime', null);
    this.learningBundles.clear();
    this.academicBundles.clear();
  }

  async configureCredentials(): Promise<void> {
    const root = this.root();
    if (!root) throw new Error('请先选择浙大个人信息连接器目录。');
    const python = this.pythonCommand();
    const child = spawn(python, [path.join(root, 'scripts', 'zju.py'), 'credentials', 'set'], {
      cwd: root,
      env: this.childEnv(),
      windowsHide: false,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stopProcess(child); reject(new Error('凭据窗口等待超时。')); }, 180_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('凭据未保存。')); });
    });
    this.store.putMeta('zju_last_verified_at', null);
    this.store.putMeta('zju_last_auth_error', null);
    this.store.putMeta('zju_last_auth_error_message', null);
    this.store.putMeta('zju_verified_credentials_mtime', null);
    this.learningBundles.clear();
    this.academicBundles.clear();
  }

  async forgetCredentials(signal: AbortSignal = new AbortController().signal) {
    const wasDisabled = this.store.meta<boolean>('zju_source_disabled', false);
    if (wasDisabled) this.store.putMeta('zju_source_disabled', false);
    try {
      if (!this.root()) return { status: 'unavailable', reason: '没有找到浙大个人信息技能。' };
      const result = await this.run(['credentials', 'forget'], signal, 20_000);
      if (result?.status === 'ok') {
        this.store.putMeta('zju_last_verified_at', null);
        this.store.putMeta('zju_last_auth_error', null);
        this.store.putMeta('zju_last_auth_error_message', null);
        this.store.putMeta('zju_verified_credentials_mtime', null);
        this.learningBundles.clear();
        this.academicBundles.clear();
      }
      return result;
    } finally {
      if (wasDisabled) this.store.putMeta('zju_source_disabled', true);
    }
  }

  /** Verify the saved account through the skill's SSO flow without returning credentials. */
  async verifyAccount(signal: AbortSignal = new AbortController().signal) {
    const connector = this.describe();
    if (!connector.available)
      return { status: 'unavailable', connector, reason: connector.reason };
    if (!connector.credentialsConfigured)
      return { status: 'auth_required', connector, reason: '请先在本机保存浙大统一身份认证信息。' };
    try {
      const result = await this.run(['auth'], signal, 75_000);
      if (result?.status === 'ok') {
        this.store.putMeta('zju_last_verified_at', new Date().toISOString());
        this.store.putMeta('zju_last_auth_error', null);
        this.store.putMeta('zju_last_auth_error_message', null);
        this.store.putMeta('zju_verified_credentials_mtime', this.credentialsMtime() ?? null);
        return { ...result, connector: this.describe(), authentication: 'zju_sso_verified' };
      }
      this.store.putMeta('zju_last_auth_error', String(result?.error?.code || 'AUTH_FAILED').slice(0, 80));
      this.store.putMeta(
        'zju_last_auth_error_message',
        safeAuthErrorMessage(result?.error?.message || result?.reason),
      );
      return { ...result, connector: this.describe() };
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = hostAuthError(error);
      this.store.putMeta('zju_last_auth_error', failure.code);
      this.store.putMeta('zju_last_auth_error_message', failure.message);
      return {
        status: 'error',
        connector: this.describe(),
        error: failure,
      };
    }
  }

  private async ensureAuthenticated(signal: AbortSignal) {
    const connector = this.describe();
    if (!connector.credentialsConfigured)
      return { status: 'auth_required', reason: '请先在本机保存浙大统一身份认证信息。' };
    const verifiedAt = connector.lastVerifiedAt ? Date.parse(connector.lastVerifiedAt) : NaN;
    // The connector reads an encrypted local snapshot for ordinary queries.
    // Repeating the SSO handshake every ten minutes made cached campus
    // questions unnecessarily slow.  Credentials changes invalidate this
    // timestamp through describe(), so a two-day reuse window is bounded.
    if (Number.isFinite(verifiedAt) && Date.now() - verifiedAt < CAMPUS_CACHE_MAX_AGE_MS)
      return { status: 'ok', authenticated_at: connector.lastVerifiedAt };
    if (!this.authInFlight) {
      this.authInFlight = this.verifyAccount(signal).finally(() => {
        this.authInFlight = undefined;
      });
    }
    return this.authInFlight;
  }

  private childEnv() {
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } as Record<string, string | undefined>;
    // The connector never needs model/API secrets. Do not inherit them into a
    // third-party Python process even though the skill itself does not print env.
    for (const key of [
      'ZAICHANG_PROJECT_DEEPSEEK_KEY',
      'ZAICHANG_TEST_DEEPSEEK_KEY',
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
    ]) delete env[key];
    return env;
  }

  async run(args: string[], signal: AbortSignal, timeoutMs = 45_000): Promise<any> {
    const root = this.root();
    if (!root) return { status: 'unavailable', reason: '浙大个人信息连接器尚未配置。', connector: this.describe() };
    const allowedCommands = new Set(['auth', 'academic', 'history', 'quick', 'credentials']);
    if (!args[0] || !allowedCommands.has(args[0]))
      return { status: 'error', error: { code: 'COMMAND_NOT_ALLOWED', message: '连接器命令不在宿主允许范围内。' }, connector: this.describe() };
    const python = this.pythonCommand();
    const script = path.join(root, 'scripts', 'zju.py');
    const child = spawn(python, [script, ...args], {
      cwd: root,
      env: this.childEnv(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => { stopProcess(child); finish(() => reject(new Error('校园连接器超过本轮时间上限，已停止。'))); }, timeoutMs);
      const abort = () => { clearTimeout(timer); stopProcess(child); finish(() => reject(signal.reason || new DOMException('已停止', 'AbortError'))); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 1_200_000) abort(); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 4000); });
      child.on('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); finish(() => reject(error)); });
      child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); finish(() => resolve({ code, stdout, stderr })); });
    });
    let parsed: any;
    try { parsed = parseJson(output.stdout); } catch { throw new Error('校园连接器输出异常，请检查其本地 Python 环境。'); }
    if (output.code !== 0 && parsed.status !== 'partial') {
      const error = parsed.error || { code: 'CONNECTOR_ERROR', message: '校园连接器没有完成请求。' };
      return { status: 'error', error, stderr: output.stderr.slice(0, 500), connector: this.describe() };
    }
    return parsed;
  }

  private pythonCommand() {
    if (this.resolvedPython) return this.resolvedPython;
    if (this.testPorts.python) return this.testPorts.python;
    const configured = process.env.ZAICHANG_PYTHON?.trim();
    if (configured) return configured;
    const bundledRoots = [
      process.env.ZAICHANG_RUNTIME_ROOT,
      process.resourcesPath ? path.join(process.resourcesPath, 'hermes-runtime') : '',
    ].filter(Boolean) as string[];
    for (const bundledRoot of bundledRoots) {
      const bundled = path.join(bundledRoot, '.runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
      if (existsSync(bundled)) return (this.resolvedPython = bundled);
    }
    // The normal Windows launcher is `python`; fall back to `py` for machines
    // where only the launcher is registered. This probe never receives data.
    for (const candidate of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
      const probe = spawnSync(candidate, ['--version'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3000,
      });
      if (probe.status === 0) return (this.resolvedPython = candidate);
    }
    return (this.resolvedPython = process.platform === 'win32' ? 'python' : 'python3');
  }

  private async bootstrapAcademic(
    signal: AbortSignal,
    academicYear = this.defaultAcademicYear(),
    term: '1' | '2' = this.defaultTerm(),
  ) {
    const key = `${academicYear}:${term}`;
    let pending = this.academicInFlight.get(key);
    if (!pending) {
      pending = this.run(
        ['academic', '--year', academicYear, '--term', term],
        signal,
        85_000,
      ).finally(() => {
        this.academicInFlight.delete(key);
      });
      this.academicInFlight.set(key, pending);
    }
    const result = await pending;
    if (result?.bundle_id) this.academicBundles.set(`${academicYear}:${term}`, String(result.bundle_id));
    return result;
  }

  private cacheFreshness(fetchedAt: unknown, now = Date.now()) {
    const timestamp = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : NaN;
    if (!Number.isFinite(timestamp)) {
      return {
        stale: true,
        fetchedAt: undefined,
        ageMs: undefined,
        maxAgeMs: CAMPUS_CACHE_MAX_AGE_MS,
        reason: 'snapshot_timestamp_missing',
      };
    }
    const ageMs = Math.max(0, now - timestamp);
    return {
      stale: ageMs >= CAMPUS_CACHE_MAX_AGE_MS,
      fetchedAt: new Date(timestamp).toISOString(),
      ageMs,
      maxAgeMs: CAMPUS_CACHE_MAX_AGE_MS,
      refreshDueAt: new Date(timestamp + CAMPUS_CACHE_MAX_AGE_MS).toISOString(),
    };
  }

  private queueAcademicRefresh(academicYear: string, term: '1' | '2') {
    if (CAMPUS_AUTO_REFRESH_DISABLED) return;
    const key = `${academicYear}:${term}`;
    if (this.academicInFlight.has(key)) return;
    // Do not make the foreground campus lookup wait for a network refresh.
    // The in-flight map also coalesces repeated stale reads into one request.
    queueMicrotask(() => {
      if (this.academicInFlight.has(key)) return;
      const controller = new AbortController();
      void this.bootstrapAcademic(controller.signal, academicYear, term).catch(() => undefined);
    });
  }

  private async resolveAcademicBundle(
    signal: AbortSignal,
    academicYear = this.defaultAcademicYear(),
    term: '1' | '2' = this.defaultTerm(),
  ): Promise<string | undefined> {
    const key = `${academicYear}:${term}`;
    const cached = this.academicBundles.get(key);
    if (cached) return cached;
    const history = await this.run(['history', '--limit', '100'], signal, 20_000);
    const wanted = `${academicYear}-${term}`;
    const item = (Array.isArray(history?.items) ? history.items : []).find(
      (entry: any) => entry?.kind === 'academic' && String(entry.semester_id || '') === wanted,
    );
    if (item?.bundle_id) {
      this.academicBundles.set(key, String(item.bundle_id));
      const freshness = this.cacheFreshness(item.fetched_at);
      if (freshness.stale) this.queueAcademicRefresh(academicYear, term);
      return String(item.bundle_id);
    }
    const synced = await this.bootstrapAcademic(signal, academicYear, term);
    if (synced?.bundle_id) return String(synced.bundle_id);
    return undefined;
  }

  /**
   * Refresh the current academic snapshot only when its two-day cache window
   * has elapsed.  This is used by the desktop background timer; it never
   * deletes or replaces the previous snapshot when the refresh fails.
   */
  async refreshIfDue(signal: AbortSignal = new AbortController().signal) {
    const connector = this.describe();
    if (!connector.available || !connector.credentialsConfigured)
      return { status: 'skipped', reason: connector.reason || '校园账号尚未配置。' };
    const academicYear = this.defaultAcademicYear();
    const term = this.defaultTerm();
    const history = await this.run(['history', '--limit', '100'], signal, 20_000);
    const wanted = `${academicYear}-${term}`;
    const item = (Array.isArray(history?.items) ? history.items : []).find(
      (entry: any) => entry?.kind === 'academic' && String(entry.semester_id || '') === wanted,
    );
    if (!item?.bundle_id)
      return { status: 'skipped', reason: '当前学期还没有校园资料快照。' };
    const freshness = this.cacheFreshness(item.fetched_at);
    if (!freshness.stale) return { status: 'cached', bundle_id: String(item.bundle_id), freshness };
    try {
      const authenticated = await this.ensureAuthenticated(signal);
      if (authenticated?.status !== 'ok')
        return { status: 'partial', reason: '后台刷新前的浙大统一身份认证没有完成。', freshness };
      const result = await this.bootstrapAcademic(signal, academicYear, term);
      return { ...result, freshness: this.cacheFreshness(result?.fetched_at) };
    } catch (error) {
      return {
        status: 'partial',
        reason: error instanceof Error ? error.message : '后台刷新未完成，继续使用上次校园资料。',
        freshness,
      };
    }
  }

  async capabilities(signal: AbortSignal) {
    const root = this.root();
    if (!root) return { status: 'unavailable', reason: '浙大个人信息连接器尚未配置。', connector: this.describe() };
    try {
      const registry = JSON.parse(readFileSync(path.join(root, 'references', 'endpoints.json'), 'utf8'));
      const endpoints = Array.isArray(registry.endpoints) ? registry.endpoints : [];
      const counts = endpoints.reduce((acc: Record<string, number>, item: any) => { const key = String(item.status || 'unknown'); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
      return { status: this.credentialsConfigured() ? 'ok' : 'auth_required', connector: this.describe(), resources: counts, catalogued: endpoints.length, note: '只读本地连接器目录，没有读取个人记录。' };
    } catch {
      return { status: 'error', connector: this.describe(), reason: '无法读取连接器目录。' };
    }
  }

  async fullContext(args: CampusFullContextArgs, signal: AbortSignal) {
    const connector = this.describe();
    if (!connector.available) return { status: 'unavailable', connector, reason: connector.reason };
    if (!connector.credentialsConfigured)
      return { status: 'auth_required', connector, reason: '请先在本机保存浙大统一身份认证信息。' };
    const authenticated = await this.ensureAuthenticated(signal);
    if (authenticated?.status !== 'ok')
      return {
        status: authenticated?.status === 'auth_required' ? 'auth_required' : 'failed',
        connector: this.describe(),
        reason: '浙大统一身份认证没有完成，本次没有读取个人资料。',
      };
    const started = Date.now();
    const batches: any[] = [];
    // Broker capabilities are bounded to 90 seconds. Cached quick queries are
    // normally much faster; a refresh still gets the whole bounded window.
    const budgetMs = 88_000;
    const deadline = Date.now() + budgetMs;
    const fullSignal = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
    const supported = new Set<CampusDomain>((connector.supportedDomains || []).filter((domain): domain is CampusDomain =>
      FULL_CONTEXT_DOMAINS.includes(domain as CampusDomain),
    ));
    const domains = FULL_CONTEXT_DOMAINS.filter((domain) => supported.has(domain) && (args.includeSensitiveDomains === true || !SENSITIVE_DOMAINS.has(domain)));
    const expectedScopes: string[] = [...(args.refresh ? ['academic'] : []), ...domains];
    let budgetExhausted = false;
    // Academic sync is a single normalized operation. It is only refreshed when the model
    // has an explicit freshness reason; the default path reads the existing encrypted bundle.
    if (args.refresh) {
      try {
        const academic = await this.bootstrapAcademic(
          fullSignal,
          args.academicYear || this.defaultAcademicYear(),
          args.term || this.defaultTerm(),
        );
        batches.push({ scope: 'academic', data: compactResult(academic) });
      } catch (error) {
        if (signal.aborted) throw error;
        batches.push({ scope: 'academic', data: { status: 'partial', error: error instanceof Error ? error.message : '学业资料读取未完成' } });
      }
    }
    // A small bounded fan-out keeps the overview responsive without opening a
    // request storm against the school systems. Results are reassembled in the
    // stable domain order so the model sees one predictable index.
    for (let offset = 0; offset < domains.length; offset += 3) {
      if (signal.aborted) throw signal.reason;
      if (fullSignal.aborted || Date.now() >= deadline) { budgetExhausted = true; break; }
      const chunk = domains.slice(offset, offset + 3);
      const results = await Promise.all(chunk.map(async (domain) => {
        try {
          const shouldRefresh = !!args.refresh && DIRECT_REFRESH_DOMAINS.has(domain);
          const readResult = await this.read(
            {
              domain,
              refresh: shouldRefresh,
              limit: 4,
              academicYear: args.academicYear,
              term: args.term,
            },
            fullSignal,
          );
          return { scope: domain, data: compactResult(readResult.data, domain) };
        } catch (error) {
          if (signal.aborted) throw error;
          return { scope: domain, data: { status: 'error', error: error instanceof Error ? error.message : '领域读取失败' } };
        }
      }));
      batches.push(...results);
      if (fullSignal.aborted || Date.now() >= deadline) { budgetExhausted = true; break; }
    }
    const completedScopes = batches.flatMap(batch => {
      const status = String(batch.data?.status || 'ok');
      return ['ok', 'partial'].includes(status)
        ? (Array.isArray(batch.scope) ? batch.scope : [batch.scope])
        : [];
    });
    const missingScopes = expectedScopes.filter(scope => !completedScopes.includes(scope));
    const incompleteScopes = batches.flatMap(batch => {
      const status = String(batch.data?.status || 'ok');
      return status === 'partial' || batch.data?.stale === true || batch.data?.coverage?.complete === false
        ? (Array.isArray(batch.scope) ? batch.scope : [batch.scope])
        : [];
    });
    const batchStatuses = batches.map(batch => String(batch.data?.status || batch.data?.data?.status || 'ok'));
    const hasIncomplete = batches.some(batch => batch.data?.stale === true || batch.data?.freshness?.stale === true || batch.data?.completeness?.complete === false || batch.data?.coverage?.complete === false || batch.data?.data_quality?.all_requested_sources_complete === false);
    const status = budgetExhausted || missingScopes.length || hasIncomplete || batchStatuses.some(s => ['error', 'auth_required', 'unavailable'].includes(s))
      ? 'partial'
      : batchStatuses.includes('partial') ? 'partial' : 'ok';
    return {
      status,
      connector,
      refreshed: !!args.refresh,
      elapsedMs: Date.now() - started,
      missingScopes,
      incompleteScopes,
      budgetExhausted,
      expectedScopes,
      source: 'zju-student-info selected normalized datasets via quick/academic',
      origin: 'zju_account',
      authenticatedAt: this.describe().lastVerifiedAt,
      batches,
      cachePolicy: {
        maxAgeMs: CAMPUS_CACHE_MAX_AGE_MS,
        refreshInterval: '48h',
        staleWhileRevalidate: true,
        failedRefreshKeepsPrevious: true,
      },
      note: '这是本人浙大账号产生的已接入只读数据域索引；模型只收到每个分域的必要摘要，原始响应没有写入本机缓存。课表目前保留星期与节次，尚未把校历和调停课展开为逐次日期。预约、签到、支付和修改资料均未执行。',
    };
  }

  private defaultAcademicYear(): string {
    const now = new Date();
    const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    return `${start}-${start + 1}`;
  }

  private defaultTerm(): '1' | '2' {
    const month = new Date().getMonth();
    return month >= 7 || month === 0 ? '1' : '2';
  }

  async read(args: CampusReadArgs, signal: AbortSignal) {
    const connector = this.describe();
    if (!connector.available)
      return {
        domain: args.domain,
        label: DOMAIN_LABEL[args.domain],
        cached: !args.refresh,
        connector,
        data: { status: 'unavailable', reason: connector.reason, origin: 'zju_account' },
      };
    if (!connector.credentialsConfigured)
      return {
        domain: args.domain,
        label: DOMAIN_LABEL[args.domain],
        cached: !args.refresh,
        connector,
        data: { status: 'auth_required', reason: '请先在本机保存浙大统一身份认证信息。', origin: 'zju_account' },
      };
    const authenticated = await this.ensureAuthenticated(signal);
    if (authenticated?.status !== 'ok')
      return {
        domain: args.domain,
        label: DOMAIN_LABEL[args.domain],
        cached: !args.refresh,
        connector: this.describe(),
        data: {
          status: authenticated?.status === 'auth_required' ? 'auth_required' : 'failed',
          reason: '浙大统一身份认证没有完成，本次没有读取个人资料。',
          origin: 'zju_account',
        },
      };
    const resource = DOMAIN_RESOURCE[args.domain];
    if (!resource) throw new Error('该校园资料类别暂未接入。');
    const academicYear = args.academicYear || this.defaultAcademicYear();
    const term = args.term || this.defaultTerm();
    let academicBundle: string | undefined;
    if (ACADEMIC_RESOURCES.has(args.domain)) {
      if (args.refresh) {
        const refreshed = await this.bootstrapAcademic(signal, academicYear, term);
        academicBundle = refreshed?.bundle_id ? String(refreshed.bundle_id) : undefined;
      } else {
        academicBundle = await this.resolveAcademicBundle(signal, academicYear, term);
      }
      if (!academicBundle)
        return {
          domain: args.domain,
          label: DOMAIN_LABEL[args.domain],
          cached: !args.refresh,
          connector: this.describe(),
          data: {
            status: 'partial',
            reason: `还没有找到 ${academicYear}-${term} 的账号学业资料。`,
            origin: 'zju_account',
          },
        };
    }
    let learningBundle: string | undefined;
    if (args.domain === 'activities') {
      if (!args.courseId || !/^\d{1,32}$/.test(args.courseId))
        return {
          domain: args.domain,
          label: DOMAIN_LABEL[args.domain],
          cached: false,
          connector: this.describe(),
          data: {
            status: 'partial',
            error: {
              code: 'COURSE_ID_REQUIRED',
              message: '先读取“学在浙大课程”并选定一门课，才能读取这门课的活动和完成情况。',
            },
            origin: 'zju_account',
          },
        };
      learningBundle = !args.refresh ? this.learningBundles.get(args.courseId) : undefined;
      if (!learningBundle) {
        const learned = await this.run(['learning', '--course-id', args.courseId], signal, 85_000);
        if (!['ok', 'partial'].includes(String(learned?.status)) || !learned?.bundle_id)
          return {
            domain: args.domain,
            label: DOMAIN_LABEL[args.domain],
            cached: false,
            connector: this.describe(),
            data: { ...compactResult(learned, args.domain), origin: 'zju_account' },
          };
        learningBundle = String(learned.bundle_id);
        this.learningBundles.set(args.courseId, learningBundle);
      }
      const activityPage = await this.run(
        [
          'read',
          '--bundle',
          learningBundle,
          '--pointer',
          '/normalized/activities',
          '--offset',
          String(Math.max(0, args.offset || 0)),
          '--limit',
          String(Math.min(50, Math.max(1, args.limit || 8))),
        ],
        signal,
        35_000,
      );
      const activityRecords = Array.isArray(activityPage?.data) ? activityPage.data : [];
      const activityResult = {
        status: activityPage?.status === 'ok' ? 'ok' : activityPage?.status || 'partial',
        resource: 'activities',
        records: activityRecords,
        total_matches: activityPage?.total_items,
        offset: activityPage?.offset,
        next_offset: activityPage?.next_offset,
        coverage: { complete: activityPage?.status === 'ok', scope: `owned course ${args.courseId}` },
        evaluated_at: new Date().toISOString(),
        credential_redactions: activityPage?.credential_redactions,
        nested_values_truncated: false,
      };
      const compactActivities = compactResult(activityResult, args.domain);
      return {
        domain: args.domain,
        label: DOMAIN_LABEL[args.domain],
        cached: !args.refresh,
        connector: this.describe(),
        data: {
          ...(compactActivities && typeof compactActivities === 'object'
            ? compactActivities
            : { result: compactActivities }),
          origin: 'zju_account',
          authenticated_at: this.describe().lastVerifiedAt,
          course_id: args.courseId,
        },
      };
    }
    const cli = ['quick', resource];
    if (academicBundle) cli.push('--bundle', academicBundle);
    if (args.domain === 'learning_courses') cli.push('--endpoint', 'courses.list');
    if (learningBundle) cli.push('--bundle', learningBundle);
    if (args.window) cli.push('--window', args.window);
    if (args.from) cli.push('--from', args.from);
    if (args.to) cli.push('--to', args.to);
    if (args.at) cli.push('--at', args.at);
    if (args.timeMode) cli.push('--time-mode', args.timeMode);
    const blockedFields = (args.fields || []).filter(field => SENSITIVE_FIELD.test(field) || /(身份证|学号|手机号|邮箱)/.test(field));
    if (blockedFields.length) throw new Error('为保护本人身份信息，该字段不能作为模型读取字段。');
    const unsupportedFields = (args.fields || []).filter(field => !SAFE_MODEL_FIELDS.has(field));
    if (unsupportedFields.length) throw new Error('该字段不在安全摘要范围内，请缩小到工具提供的可读字段。');
    const fields = args.fields?.length ? args.fields : SUMMARY_FIELDS[args.domain];
    if (fields?.length) cli.push('--fields', fields.join(','));
    for (const filter of args.filters || []) cli.push('--filter', filter);
    if (args.sort) cli.push('--sort', args.sort);
    cli.push('--limit', String(Math.min(50, Math.max(1, args.limit || 8))));
    cli.push('--offset', String(Math.max(0, args.offset || 0)));
    if (args.refresh && !ACADEMIC_RESOURCES.has(args.domain)) cli.push('--refresh');
    let result = await this.run(cli, signal, args.refresh ? 85_000 : 35_000);
    // A newly connected account may not have an academic bundle yet. Build it
    // once through the authenticated skill, then retry the narrow query. This
    // keeps the first user question useful without falling back to an import.
    if (
      result?.status === 'error' &&
      result?.error?.code === 'DATASET_REQUIRED' &&
      ACADEMIC_RESOURCES.has(args.domain) &&
      !args.refresh
    ) {
      const bootstrap = await this.bootstrapAcademic(signal, academicYear, term);
      if (bootstrap?.status === 'ok' || bootstrap?.status === 'partial') result = await this.run(cli, signal, 35_000);
    }
    const compact = compactResult(result, args.domain);
    const observedAt = result?.fetched_at || result?.evaluated_at || result?.retrieved_at;
    const freshness = this.cacheFreshness(observedAt);
    return {
      domain: args.domain,
      label: DOMAIN_LABEL[args.domain],
      cached: !args.refresh,
      connector: this.describe(),
      data: {
        ...(compact && typeof compact === 'object' ? compact : { result: compact }),
        origin: 'zju_account',
        authenticated_at: this.describe().lastVerifiedAt,
        freshness: {
          ...freshness,
          policy: 'two_day_snapshot',
          refreshScheduled: !args.refresh && freshness.stale && !CAMPUS_AUTO_REFRESH_DISABLED,
        },
      },
    };
  }

  async refresh(args: CampusRefreshArgs, signal: AbortSignal) {
    const connector = this.describe();
    if (!connector.available) return { scope: args.scope, label: '校园资料同步', connector, data: { status: 'unavailable', reason: connector.reason } };
    if (!connector.credentialsConfigured) return { scope: args.scope, label: '校园资料同步', connector, data: { status: 'auth_required', reason: '请先在资料面板设置本机校园账号。' } };
    if (args.scope === 'academic') {
      const academicYear = args.academicYear || this.defaultAcademicYear();
      if (!/^20\d{2}-20\d{2}$/.test(academicYear)) throw new Error('同步学业资料需要形如 2026-2027 的学年。');
      const term = args.term || this.defaultTerm();
      const result = await this.bootstrapAcademic(signal, academicYear, term);
      return { scope: args.scope, label: '学业资料同步', connector: this.describe(), data: compactResult(result) };
    }
    if (!args.domain || args.domain === 'source_status') throw new Error('按领域同步时需要指定具体领域。');
    const result = await this.read({ domain: args.domain, refresh: true, limit: 20 }, signal);
    return { ...result, scope: args.scope, label: `${DOMAIN_LABEL[args.domain]}同步` };
  }

  /**
   * Return only busy intervals for a public/group availability draft. Course
   * titles, teachers and every other private field are intentionally discarded
   * before the projection leaves this adapter.
   */
  async availability(from: string | undefined, to: string | undefined, signal: AbortSignal) {
    const start = from || new Date().toISOString();
    const end = to || new Date(Date.parse(start) + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.read(
      { domain: 'schedule', from: start, to: end, timeMode: 'overlap', limit: 50 },
      signal,
    );
    const data: any = result.data || {};
    const intervals = (Array.isArray(data.records) ? data.records : [])
      .filter((record: any) => typeof record?.startTime === 'string' && typeof record?.endTime === 'string')
      .map((record: any) => ({ start: record.startTime, end: record.endTime }));
    const complete = data.coverage?.complete === true;
    return {
      participant: '本人',
      busyIntervals: intervals,
      status: complete ? 'fresh' : 'unknown',
      sourceId: CAMPUS_ACCOUNT_SOURCE_ID,
      fetchedAt: data.authenticated_at || data.fetched_at,
      coverage: { complete, scope: '[本人浙大账号的忙闲投影]', until: end },
      window: { from: start, to: end },
      meaning: '这些时段确定忙，绝不是可约时间；只能用于排除，不能原样写成有空。',
      reason: complete ? undefined : '课表范围或调课信息不完整，不能把空白时段当成确定有空。',
    };
  }
}
