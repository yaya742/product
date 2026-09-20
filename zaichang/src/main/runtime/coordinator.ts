import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store';
import type { Action, Memory, Obligation, Step } from '../../shared/types';
import type { ToolSpec, ProviderMetadata } from '../provider';
import {
  always,
  candidateSchema,
  conditionSchema,
  changeSchema,
  HarnessError,
  needSchema,
  personalLabel,
  type ContextPack,
  type EvidenceEvent,
  type MemoryChange,
  releaseSpecSchema,
  type ReleaseSpec,
  type ScopeHandle,
  type DelegatedTask,
} from '../../shared/harness';
import { KernelRepository } from '../storage/repository';
import { PolicyKernel, type IngressDecision, type InputControls } from './policy';
import { ContextCompiler } from './context';
import { CollaborationService, collaborationInput } from './collaboration';
import { WorkService } from './work';
import { MemoryService } from '../memory/service';
import { DomainService } from '../storage/domains';
import { CapabilityBroker, type CapabilityResult } from '../capabilities/broker';
import { registerBuiltins, localActionInput, type BuiltinConnections } from '../capabilities/builtin';
import { prepareWeatherPluginInput } from '../plugins/weather-adapter';
import { InterfaceManager } from '../interfaces/manager';
import { PluginManager, type PluginManagerOptions } from '../plugins/manager';
import { ActionRuntime } from '../actions/runtime';
import { normalizeCalendarInput } from '../actions/calendar';
import { LocalCalendarService } from '../actions/local-calendar';
import { localCalendarChangeSchema } from '../../shared/calendar';
import campusMethod from '../../../prompts/campus-tools.md';
import mapMethod from '../../../prompts/map-tools.md';
import { availableIntervals } from '../actions/availability';
import { ReminderRuntime } from '../actions/reminders';
import { releaseRequestSchema, type ReleaseRequest } from './release-composer';
import { canonical, dateInZone, dayBounds, codePointSlice, resolveLocalTime } from './semantics';
import type { ImageAttachment } from '../../shared/types';
import type { WeatherCard } from '../../shared/weather-v1';
import {
  ObservationPort,
  SyncPort,
  RulePackPort,
  WatchPort,
  StorageProtectionPort,
  EntityPort,
} from '../capabilities/ports';

export interface RunSession {
  releaseArtifacts?: import('../../shared/types').ReleaseArtifact[];
  dependencyNotices?: unknown[];
  methodNotes?: string[];
  budgetOwner?: RunSession;
  privacyResult?: { text: string; operation: string };
  observations?: { tool: string; result: unknown; toolCallId?: string }[];
  controlUsages?: import('../provider').Completion['usage'][];
  ingress: IngressDecision;
  events: EvidenceEvent[];
  pack?: ContextPack;
  sessionId: string;
  ephemeral: boolean;
  episodeId?: string;
  toolCalls: number;
  modelCalls: number;
  signal: AbortSignal;
  image?: ImageAttachment;
}
export interface RuntimeCallbacks {
  prepareRelease?: (request: ReleaseRequest) => Promise<unknown>;
  verifyPrivacyControl?: (request: unknown) => Promise<{ approved: boolean; reason: string }>;
  verifyReadPurpose?: (request: unknown) => Promise<{ allowed: boolean; reason: string }>;
  verifyLocalDelegation?: (action: unknown) => Promise<import('./action-delegation').DelegationVerdict>;
  step: (step: Step) => void;
  plan: (items: Obligation[]) => void;
  action: (item: Action) => void;
  changed: () => void;
  mapCard?: (card: import('../../shared/map-v2').MapCard) => void;
  weatherCard?: (card: WeatherCard) => void;
  delegate: (tasks: DelegatedTask[]) => Promise<unknown>;
}

function weatherCardFromResult(result: CapabilityResult): WeatherCard | undefined {
  if (result.status !== 'fresh' || !result.data || typeof result.data !== 'object') return undefined;
  const data = result.data as Record<string, unknown>;
  const current = data.current;
  const forecast = data.forecast;
  if (
    typeof data.location !== 'string' ||
    typeof data.timeZone !== 'string' ||
    !current || typeof current !== 'object' ||
    !forecast || typeof forecast !== 'object' ||
    !Array.isArray((forecast as Record<string, unknown>).time)
  )
    return undefined;
  return {
    schemaVersion: 'weather-card/v1',
    kind: 'weather',
    status: 'fresh',
    location: data.location,
    timeZone: data.timeZone,
    current: current as WeatherCard['current'],
    forecast: forecast as WeatherCard['forecast'],
    source: result.sourceId,
    fetchedAt: result.fetchedAt || new Date().toISOString(),
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === 'string') : [],
  };
}
const campusDomains = [
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
  'sports',
  'projects',
  'activities',
  'reservations',
  'reservation_violations',
  'card',
  'transactions',
  'profile',
  'roles',
  'calendar_pending',
  'cancelled_classes',
  'holidays',
  'notices',
  'source_status',
] as const;
const campusOverviewRequest = (text: string) =>
  /(?:全部|所有|完整).{0,10}(?:校园|浙大|学校|学生|个人).{0,6}(?:资料|信息)|(?:校园|浙大|学校|学生).{0,10}(?:资料|信息).{0,6}(?:总览|全部|所有|完整)|我的.{0,4}(?:全部|所有|完整).{0,4}个人信息/.test(
    text,
  );
const lookUpSchema = z
  .object({
    source: z.enum(['campus', 'history', 'weather', 'map', 'local', 'capability']),
    mode: z.enum(['overview', 'detail', 'refresh']).optional(),
    domain: z.enum(campusDomains).optional(),
    courseId: z.string().regex(/^\d{1,32}$/).optional(),
    query: z.string().max(100).optional(),
    days: z.number().int().min(1).max(7).optional(),
    location: z.enum(['current', 'Hangzhou']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    at: z.string().datetime({ offset: true }).optional(),
    window: z.string().max(40).optional(),
    timeMode: z.enum(['overlap', 'starts', 'contained']).optional(),
    fields: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/))
      .max(24)
      .optional(),
    filters: z.array(z.string().max(160)).max(6).optional(),
    sort: z.string().max(100).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
    academicYear: z
      .string()
      .regex(/^20\d{2}-20\d{2}$/)
      .optional(),
    term: z.enum(['1', '2']).optional(),
    includeSensitiveDomains: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    capability: z.string().max(100).optional(),
    describeOnly: z.boolean().optional(),
    arguments: z.record(z.string(), z.json()).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();
const workChangeSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('reference_option'), episodeId: z.string().max(160), id: z.string().max(160), expectedRevision: z.number().int().positive(), sourceQuote: z.string().min(1).max(1000) }).strict(),
  z
    .object({
      operation: z.literal('propose_options'),
      options: z
        .array(z.object({ title: z.string().min(1).max(120), rationale: z.string().max(600) }).strict())
        .min(2)
        .max(5),
    })
    .strict(),
  z
    .object({
      operation: z.literal('reject_option'),
      id: z.string().min(1).max(160),
      expectedRevision: z.number().int().positive(),
      sourceQuote: z.string().min(1).max(1000),
      validWhen: conditionSchema,
      permanent: z.boolean().default(false),
    })
    .strict(),
  z.object({ operation: z.literal('propose_plan'), candidate: candidateSchema }).strict(),
  z
    .object({
      operation: z.literal('checkpoint'),
      episodeId: z.string(),
      expectedRevision: z.number().int(),
      nextSmallQuestion: z.string().max(300),
      openQuestions: z.array(z.string().max(300)).max(5),
    })
    .strict(),
  z
    .object({
      operation: z.literal('propose_goal'),
      title: z.string().min(1).max(120),
      reason: z.string().max(600),
    })
    .strict(),
  z
    .object({
      operation: z.literal('propose_task'),
      title: z.string().min(1).max(160),
      kind: z.enum(['prepare_application', 'prepare_portfolio', 'todo']),
      sourceQuote: z.string().min(1).max(1000),
    })
    .strict(),
]);
type SpecDefinition = {
  name: string;
  description: string;
  schema: z.ZodType;
  grant?: string;
  mutates?: boolean;
};
function sanitizeReleaseText(value: string) {
  return value
    .replace(/(?:因为|由于|因|出于|没空的?原因|私人原因|家庭原因|不方便透露)[^\n。！？!?；;]*/g, '')
    .replace(/(?:别|不要|先别|不必|不)\s*(?:解释|提及|提|说)[^\n。！？!?；;]*/g, '')
    .replace(/(?:我有|我现在有|我今天有)\s*[^，。！？!?；;]{0,80}(?=给|发给|写给|回复|回|通知|告知)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,；;:：]\s*$/, '')
    .trim();
}
function splitReleaseFacts(value: string) {
  return value
    .split(/[、,，；;]\s*/)
    .map((part) =>
      part
        .replace(/^(?:只说|就说|可以说)\s*/, '')
        .replace(/\s+/g, ' ')
        .replace(/[，,；;:：]\s*$/, '')
        .trim(),
    )
    .filter((part) => !/^(?:语气|口吻|长度|简短|一段|详细|只草稿|先别发送|直接发送|发出去)/.test(part))
    .filter((part) => part.length > 0)
    .slice(0, 24);
}
function inferredReleaseFacts(value: string) {
  return value
    .split(/[、,，；;]\s*/)
    .map((part) => sanitizeReleaseText(part))
    .filter(
      (part) =>
        part.length > 0 &&
        !/^(?:语气|口吻|长度|简短|一段|详细|只草稿|先别发送|直接发送|发出去|不提|别提|不要提|礼貌|自然|正式|客气)/.test(part),
    )
    .slice(0, 24);
}
const specs: SpecDefinition[] = [
  {
    name: 'prepare_release', description: '为当前明确要求的对外沟通准备一份独立草稿，或核对所指稿件能否发送。写稿过程只接收获准披露的资料；宿主交付实际正文，你只需报告结果，不要重写或重复正文。其他本地登记、私人分析仍由你继续完成。若需忙闲，请先确定并传入from/to；使用旧稿可传真实priorArtifactId。没有接入任何邮件/消息发送通道。',
    schema: releaseRequestSchema, grant: 'evidence:read',
  },
  {
    name: 'availability_projection', description: '在本轮已允许协调本人忙闲时，按时间窗只读取忙碌区间；不读取或传给写稿过程任何私人日程标题、地点或原因。空数组是否证明空闲取决于覆盖说明。',
    schema: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).strict(),
  },
  {
    name: 'calculate_available_time', description: '根据已取得的忙碌区间和明确的准备/交通/切换成本，计算实际可用时段及上下界。未知结束时间用null，不猜一小时。只做给定参数的计算，不代表环境已核实。',
    schema: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), busy: z.array(z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }).nullable() }).strict()).max(500), transitionMinutes: z.object({ min: z.number().min(0).max(1440), max: z.number().min(0).max(1440) }).strict(), minimumBlockMinutes: z.number().min(0).max(1440) }).strict(),
  },
  {
    name: 'manage_goal', description: '按当前明确选择采用、暂停、恢复或取消一个已登记目标。先恢复事项取得ID和版本；暂停/取消会停止相关提醒，恢复不会自动重启旧提醒。',
    schema: z.object({ id: z.string().max(160), expectedRevision: z.number().int().positive(), operation: z.enum(['adopt', 'pause', 'resume', 'cancel']), sourceQuote: z.string().min(1).max(2000) }).strict(), grant: 'work:write', mutates: true,
  },
  {
    name: 'cancel_action',
    description: '按当前明确委托取消尚未提交的动作，或撤销已登记的本地可撤销动作。使用inspect_action给出的动作ID；撤销会检查目标版本，不能覆盖后来的改动。',
    schema: z.object({ id: z.string().max(160) }).strict(), mutates: true,
  },
  {
    name: 'change_local_action',
    description: '先读取本地安排取得稳定ID与revision，再按明确委托更新、删除或修改一个重复实例。change_occurrence只影响occurrenceDate对应的一次，其他周保留。提交前重验版本，返回真实回执和可撤销信息。',
    schema: localCalendarChangeSchema, grant: 'local:write', mutates: true,
  },
  {
    name: 'apply_privacy_control',
    description: '按用户明确要求停用理解、遗忘本机内容或撤回现有权限。先用原话和稳定对象ID核对范围；遗忘处理来源、派生、排队工作与旧备份恢复屏障，不能撤回已经外发的内容。',
    schema: z.object({ operation: z.enum(['stop_using', 'forget', 'revoke_permission']), ids: z.array(z.string().max(160)).max(24).optional(), permission: z.string().max(100).optional(), sourceQuote: z.string().min(1).max(3000) }).strict(),
    mutates: true,
  },
  {
    name: 'resolve_time',
    description: '把具体本地日期时间按 IANA 时区计算为真实时刻，区分正常、不存在和重复的夏令时时刻。不补缺失的日期、结束时间或学校规则。',
    schema: z.object({ local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/), timeZone: z.string().max(100).optional() }).strict(),
  },
  {
    name: 'search_context',
    description: '当前问题需要个人前情、条件或过去理由时，检索相关断言及其完整例外/原文，原文未提取也可找到。候选不是结论，可以改查询或继续回读；不适用的资料不要用于判断。',
    schema: z.object({ query: z.string().min(1).max(400), at: z.string().datetime({ offset: true }).optional(), offset: z.number().int().min(0).optional(), hardOffset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
    grant: 'evidence:read',
  },
  {
    name: 'restore_collaboration',
    description: '按需要恢复当前或跨会话事项、原话依据、暂定理解和未办请求。支持搜索和分页；结果只是候选，可继续回读原文。不为问候或简单答复强制使用。',
    schema: z.object({ query: z.string().max(400).optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
    grant: 'evidence:read',
  },
  {
    name: 'update_collaboration',
    description: '按需维护开放式共同理解或有原话证据的明确请求；分开已确认与暂定解释，记录待办结果、具体阻塞或纠正。不是每句话都建任务。模型不能自行把请求标为已回答或已办成，终态由宿主核查。',
    schema: collaborationInput, grant: 'work:write', mutates: true,
  },
  {
    name: 'look_up',
    description:
      '在本轮范围内查资料。source=capability且不填capability时搜索/分页能力目录，支持query、offset、limit；填写capability+describeOnly=true读取schema，填写arguments执行只读能力。campus具体查询须选domain，overview为明确的总览；未连接、无权限、部分覆盖均有实际状态。local读本地安排，history回查原文。不能指定他人身份或任意文件路径。',
    schema: lookUpSchema,
  },
  {
    name: 'read_understanding', description: '按稳定ID读取一条理解的完整条件、例外和来源指针。只是一份可核查理解，不自动代表当前事实；必要时继续分页读原文。',
    schema: z.object({ id: z.string().max(160) }).strict(), grant: 'evidence:read',
  },
  {
    name: 'read_evidence',
    description: '按来源 ID 分页打开有权使用的原文，offset/limit 按 Unicode 字符计数。长文返回覆盖与下一页，不把片段当全文；已停用来源仅作历史依据。',
    schema: z.object({ id: z.string().min(1).max(160), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20000).default(8000) }).strict(),
    grant: 'evidence:read',
  },
  {
    name: 'propose_memory_change',
    description:
      '需要立即纠正已有理解或用户明确要求记录时，提出有本轮原文定位的条件理解。普通陈述可先直接回应，后台会整理，不必等待长期保存才能使用当前原话。只是候选，代码和语义复核决定生效；主体/假设/期限不可混淆，绝不授予动作权限。',
    schema: changeSchema,
    grant: 'memory:write',
    mutates: true,
  },
  {
    name: 'remember_preference',
    description: '兼容入口：只提出用户本轮明确偏好。source_quote 须逐字来自本人原文，条件和期限一起保留。',
    schema: z.object({ text: z.string().min(1).max(140), source_quote: z.string().min(2).max(300) }).strict(),
    grant: 'memory:write',
    mutates: true,
  },
  {
    name: 'prepare_action',
    description: '登记或准备本地安排。明确委托、参数清楚且可撤销时宿主核验后直接保存；仅建议或歧义时不执行。未知结束时间省略durationMinutes，不默补时长。不发送、不预约，返回真实保存/草稿状态与撤销入口。',
    schema: localActionInput,
    grant: 'local:write',
    mutates: true,
  },
  {
    name: 'inspect_action',
    description: '查找当前范围内的动作与真实回执。省略id列出尚未确认结果的动作；指定id并reconcile核查未知结果，不能换标识盲目重发。',
    schema: z.object({ id: z.string().optional(), reconcile: z.boolean().default(false) }).strict(),
  },
  {
    name: 'update_work_state',
    description: '提出方案或目标，或保存事项检查点。方案补齐依赖并验证，不自动变成承诺。',
    schema: workChangeSchema,
    grant: 'work:write',
    mutates: true,
  },
  {
    name: 'set_plan',
    description: '只维护本轮最多五项处理步骤；不把步骤变成用户承诺，没有证据不能称完成。',
    schema: z
      .object({
        items: z
          .array(
            z
              .object({
                id: z.string().max(40),
                title: z.string().max(90),
                status: z.enum(['pending', 'running', 'done', 'blocked']),
              })
              .strict(),
          )
          .min(1)
          .max(5),
      })
      .strict(),
    mutates: true,
  },
  {
    name: 'delegate',
    description:
      '有限的独立只读调查。每个任务必须用sources声明需要的来源ID（能力目录给出sourceId），本轮原文或附件可用currentEvidenceIds指定；只能在父任务范围内。未声明来源时只能处理任务说明里的文字，不继承完整私人历史。取消联动，不能再委派或写入。',
    schema: z
      .object({
        tasks: z
          .array(z.object({ title: z.string().max(60), instruction: z.string().min(10).max(1200), sources: z.array(z.string().max(160)).max(12).optional(), currentEvidenceIds: z.array(z.string().max(160)).max(8).optional() }).strict())
          .min(1)
          .max(3),
      })
      .strict(),
    mutates: false,
  },
];

// DeepSeek's ordinary tool endpoint accepts a bounded object schema but does
// not accept the recursive oneOf/$defs emitted by Zod for work changes. Local
// Zod validation remains authoritative after the call; this model-facing
// dialect only keeps the operation and the bounded fields discoverable.
const modelWorkChangeParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['propose_options', 'reference_option', 'reject_option', 'propose_plan', 'checkpoint', 'propose_goal', 'propose_task'] },
    options: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, rationale: { type: 'string' } }, required: ['title', 'rationale'], additionalProperties: false } },
    id: { type: 'string' },
    expectedRevision: { type: 'integer' },
    sourceQuote: { type: 'string' },
    validWhen: { type: 'object', additionalProperties: true },
    permanent: { type: 'boolean' },
    candidate: { type: 'object', additionalProperties: true },
    episodeId: { type: 'string' },
    nextSmallQuestion: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    title: { type: 'string' },
    reason: { type: 'string' },
    kind: { type: 'string', enum: ['prepare_application', 'prepare_portfolio', 'todo'] },
  },
  required: ['operation'],
  additionalProperties: false,
};
const modelMemoryChangeParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['ADD', 'SUPPORT', 'REFINE', 'ADD_EXCEPTION', 'SUPERSEDE', 'CORRECT', 'DISPUTE', 'EXPIRE', 'RETRACT'] },
    targetId: { type: 'string' },
    expectedRevision: { type: 'integer' },
    eventId: { type: 'string' },
    sourceQuote: { type: 'string' },
    predicate: { type: 'string' },
    value: { type: 'object', description: '带类型的开放断言值。必须包含type和value，例如 {"type":"boolean","value":false} 或 {"type":"text","value":"原意"}；数值量必须带unit和dimension。', properties: { type: { type: 'string', enum: ['text', 'boolean', 'quantity', 'entity', 'instant', 'unknown'] }, value: {}, unit: { type: 'string' }, dimension: { type: 'string' }, reason: { type: 'string' } }, required: ['type'], additionalProperties: false },
    text: { type: 'string' },
    kind: { type: 'string', enum: ['explicit_fact', 'explicit_preference', 'current_state', 'inferred_hypothesis'] },
    strength: { type: 'string', enum: ['hard', 'soft', 'unconfirmed'] },
    conditions: { type: 'object', description: '条件表达式必须有op。无附加条件用 {"op":"all","terms":[]}；比较用 {"op":"compare","predicate":"...","comparator":"eq","value":{"type":"text","value":"..."}}。组合项的terms保留完整子条件，不用自由文本替代结构。', properties: { op: { type: 'string', enum: ['all', 'any', 'not', 'compare', 'known', 'unknown'] }, terms: { type: 'array', items: { type: 'object', additionalProperties: true } }, term: { type: 'object', additionalProperties: true }, predicate: { type: 'string' }, comparator: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: 'object', additionalProperties: true }, reason: { type: 'string' } }, required: ['op'], additionalProperties: false },
    validFrom: { type: 'string', description: '有效区间起点，含时区的完整ISO时间（含时分秒），不是单独日期。未知则省略并用unresolvedTime说明。' },
    validTo: { type: 'string', description: '有依据的有效区间终点，含时区的完整ISO时间，必须晚于validFrom；条件性结束不能擅自换算为当天零点。未知则省略，用unresolvedTime保留原有条件。' },
    unresolvedTime: { type: 'string', description: '期限/生效点尚不确定时保留原话中的条件和未知；无需为了长期整理编出精确日期。这样的候选不直接当成已核实的长期事实。' },
    subject: { type: 'string', enum: ['self', 'source_subject', 'other', 'fictional'] },
    world: { type: 'string', enum: ['source_world', 'hypothetical'], description: 'source_world表示沿用宿主原文的现实/假设归属，不是名为source_world的新世界。' },
    idempotencyKey: { type: 'string' },
  },
  required: ['operation', 'eventId', 'sourceQuote', 'predicate', 'value', 'text', 'kind', 'strength', 'conditions', 'idempotencyKey'],
  additionalProperties: false,
};
const modelMapRouteParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    from: { type: 'object', additionalProperties: true },
    to: { type: 'object', additionalProperties: true },
    avoidStairs: { type: 'boolean' },
    version: { type: 'string' },
  },
  required: [],
  additionalProperties: false,
};
const modelParameterOverrides: Record<string, Record<string, unknown>> = {
  delegate: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: { title: { type: 'string' }, instruction: { type: 'string', minLength: 10, maxLength: 1200 }, sources: { type: 'array', items: { type: 'string' }, description: '实际需要的sourceId；不读取任何来源时传空数组。' }, currentEvidenceIds: { type: 'array', items: { type: 'string' }, description: '确需读取的本轮原话/附件ID；不默认共享整条用户消息。' } }, required: ['title', 'instruction', 'sources'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
  update_work_state: modelWorkChangeParameters,
  propose_memory_change: modelMemoryChangeParameters,
  map_route: modelMapRouteParameters,
};
export class RuntimeCoordinator {
  readonly policy: PolicyKernel;
  readonly memory: MemoryService;
  readonly domains: DomainService;
  readonly work: WorkService;
  readonly broker: CapabilityBroker;
  readonly interfaces: InterfaceManager;
  readonly plugins: PluginManager;
  readonly context: ContextCompiler;
  readonly actions: ActionRuntime;
  readonly calendar: LocalCalendarService;
  readonly collaboration: CollaborationService;
  readonly reminders: ReminderRuntime;
  readonly connections: BuiltinConnections;
  readonly observations: ObservationPort;
  readonly sync: SyncPort;
  readonly rulePacks: RulePackPort;
  readonly watches: WatchPort;
  readonly storageProtection = new StorageProtectionPort();
  readonly entities: EntityPort;
  lastSession?: RunSession;
  private ephemeralEvents = new Map<string, EvidenceEvent>();
  private modelBoundary?: { client: { invalidateBoundary?: () => void }; fingerprint: string };
  constructor(
    readonly store: Store,
    readonly repo: KernelRepository,
    pluginOptions: PluginManagerOptions = {},
  ) {
    this.policy = new PolicyKernel(repo);
    this.memory = new MemoryService(repo, this.policy);
    this.domains = new DomainService(repo, this.policy);
    this.work = new WorkService(repo, this.policy);
    this.broker = new CapabilityBroker(this.policy);
    this.domains.onChanged = () => this.work.staleWorlds();
    this.connections = {};
    registerBuiltins(this.broker, this.policy, repo, this.domains, this.connections);
    this.plugins = new PluginManager(this.broker, pluginOptions);
    this.interfaces = new InterfaceManager(
      this.broker,
      () => store.meta<Record<string, boolean>>('interface_states', {}),
      (states) => store.putMeta('interface_states', states),
      (id) => {
        const snapshot = this.broker.providerSnapshots().find(item => item.id === id);
        return snapshot?.trust === 'untrusted_disabled' ? false : true;
      },
    );
    this.interfaces.restore();
    this.context = new ContextCompiler(repo, this.policy, this.broker, this.domains, this.work);
    this.reminders = new ReminderRuntime(repo, this.policy);
    this.calendar = new LocalCalendarService(store, this.reminders);
    this.actions = new ActionRuntime(repo, this.policy, this.broker, (a, effect) => this.calendar.apply(a, effect), effect => this.calendar.undo(effect));
    this.collaboration = new CollaborationService(repo, this.work, this.actions);
    this.observations = new ObservationPort(repo, this.policy, this.work, this.domains);
    this.sync = new SyncPort(repo, this.policy, this.work);
    this.rulePacks = new RulePackPort(repo, this.policy, this.domains);
    this.watches = new WatchPort(repo, this.policy, this.reminders);
    this.entities = new EntityPort(repo, this.policy);
    this.memory.migrateLegacy();
    const legacyCampus = store.meta<import('../../shared/types').CampusSnapshot | null>('campus', null);
    if (legacyCampus && !repo.getMeta('campus_import_metadata')) this.domains.importSnapshot(legacyCampus);
    this.policy.onBarrier(() => {
      this.ephemeralEvents.clear();
      this.modelBoundary?.client.invalidateBoundary?.();
      this.modelBoundary = undefined;
      if (this.lastSession) {
        this.lastSession.observations = [];
        this.lastSession.pack = undefined;
        this.lastSession.events = [];
        this.lastSession.ingress = {
          ...this.lastSession.ingress,
          text: '',
          authoredText: '',
          corrections: [],
          attachment: undefined,
        };
      }
    });
    this.resumePendingIndices();
    this.restoreConversationProjection();
  }
  restoreConversationProjection() {
    const rows = this.repo.db
      .prepare(
        `SELECT e.payload FROM h_evidence e WHERE e.owner=? AND e.workspace=? AND e.status!='deleted'
      AND json_extract(e.payload,'$.kind')='user_message' AND json_extract(e.payload,'$.parentEventId') IS NULL AND json_extract(e.payload,'$.sessionId') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=e.id) ORDER BY e.seq`,
      )
      .all(this.repo.identity.principalId, this.repo.identity.workspaceId);
    this.repo.write(() => {
      for (const row of rows) {
        const event = JSON.parse(String(row.payload)) as EvidenceEvent;
        if (event.label.retention === 'session_only') continue;
        const sessionId = this.store.session(event.sessionId, event.text.split('\n')[0]);
        const attachments = this.repo.db
          .prepare(
            "SELECT payload FROM h_evidence WHERE json_extract(payload,'$.parentEventId')=? AND json_extract(payload,'$.kind')='file_import' AND status!='deleted'",
          )
          .all(event.id)
          .map((row) => JSON.parse(String(row.payload)) as EvidenceEvent);
        const content =
          event.text +
          attachments
            .map((e) => '\n\n[用户附上的文字资料：' + (e.fileName || '已保存附件') + ']\n' + e.text)
            .join('');
        const message = {
          id: event.id,
          sessionId,
          role: 'user' as const,
          content,
          createdAt: event.receivedAt,
          status: 'done' as const,
          steps: [],
          obligations: [],
          actions: [],
          retention: event.label.retention,
        };
        this.store.putMessage(message);
        this.store.putMessage({
          ...message,
          id: event.id + ':interrupted',
          role: 'assistant',
          content: '上次处理在开始时中断，输入已完整保留。可以重新发送。',
          status: 'cancelled',
        });
      }
    });
    this.repo.setMeta('restored_conversation_count', rows.length);
  }
  resumePendingIndices() {
    for (const job of this.repo.pending('index_evidence')) {
      const row = this.repo.db
        .prepare(
          'SELECT subject,world,source,purpose,audience,retain FROM h_evidence WHERE id=? AND owner=? AND workspace=? AND status!=?',
        )
        .get(
          String(job.object_id),
          this.repo.identity.principalId,
          this.repo.identity.workspaceId,
          'deleted',
        );
      if (!row) continue;
      const scope = this.policy.hostScope({
        subjectId: String(row.subject),
        worldId: String(row.world),
        sources: [String(row.source)],
        currentEventIds: [String(job.object_id)],
        purposes: [String(row.purpose)],
        audience: row.audience as any,
        infer: false,
      });
      this.repo.indexEvidence(scope, String(job.object_id));
    }
  }
  bindModel(
    contract: RunSession['ingress']['contract'],
    client: {
      invalidateBoundary?: () => void;
      providerMetadata?: (options?: { strict?: boolean; thinking?: 'enabled' | 'disabled' }) => ProviderMetadata;
    },
  ) {
    const s = this.policy.validate(contract.scope),
      fingerprint = canonical({
        runId: contract.id,
        subject: s.subjectId,
        world: s.worldId,
        sources: s.sources,
        purpose: s.purposes,
        audience: s.audience,
        epoch: s.privacyEpoch,
        revision: s.policyRevision,
      });
    if (this.modelBoundary?.client !== client || this.modelBoundary.fingerprint !== fingerprint) {
      this.modelBoundary?.client.invalidateBoundary?.();
      client.invalidateBoundary?.();
    }
    this.context.setProviderMetadata(client.providerMetadata?.());
    this.modelBoundary = { client, fingerprint };
  }
  connect(value: Partial<BuiltinConnections>) {
    Object.assign(this.connections, value);
  }
  begin(
    content: string,
    eventId: string,
    sessionId: string,
    signal: AbortSignal,
    controls: InputControls = {},
  ): RunSession {
    const ingress = this.policy.ingress(content, eventId, this.store.settings(), controls),
      contract = ingress.contract,
      s = this.policy.validate(contract.scope),
      ephemeral = contract.retention === 'session_only';
    if (ingress.attachment && !ephemeral) this.policy.registerSource('file:' + ingress.attachment.id);
    const makeEvent = (id: string, text: string, file = false): EvidenceEvent => ({
      id,
      ownerId: s.principalId,
      workspaceId: s.workspaceId,
      subjectId: s.subjectId,
      worldId: s.worldId,
      sourceId: file ? 'file:' + id : 'history:self',
      contentVersion: 1,
      sequence: 0,
      text,
      speaker: file ? 'external' : 'user',
      kind: file ? 'file_import' : 'user_message',
      authority: file ? 'quotation' : 'user_statement',
      roots: [id],
      sessionId,
      interpretationTimeZone: contract.timeZone,
      label: {
        ...personalLabel,
        purpose: contract.purpose,
        audience: ingress.replyToOwner ? 'self' : contract.audience,
        retention: contract.retention,
        infer: !file && s.infer,
      },
      receivedAt: contract.now,
      status: 'active',
      ...(file
        ? {
            fileName: ingress.attachment!.name,
            parentEventId: eventId,
            locator: { kind: 'file' as const, artifactId: id, version: 1 },
          }
        : {}),
    });
    const events = [
      makeEvent(eventId, ingress.authoredText),
      ...(ingress.attachment ? [makeEvent(ingress.attachment.id, ingress.attachment.text, true)] : []),
    ];
    // The user's original may contain private preparation for a public draft.
    // Store/index only these current originals under a private origin label;
    // this does not widen the owner agent's explicit UI source/read scope.
    const originScope = ingress.replyToOwner && contract.audience !== 'self'
      ? this.policy.hostScope({ sources: ['current'], currentEventIds: events.map(event => event.id), subjectId: s.subjectId, worldId: s.worldId, audience: 'self', purposes: [contract.purpose], grants: [...s.grants], retention: contract.retention, infer: false })
      : contract.scope;
    if (ephemeral) {
      for (const event of events) this.ephemeralEvents.set(event.id, event);
    } else
      this.repo.write(() => {
        for (let i = 0; i < events.length; i++) {
          events[i] = this.repo.ingest(originScope, events[i]);
          if (!this.memory.paused) this.repo.indexEvidence(originScope, events[i].id);
        }
      });
    // Mixed input may contain a separate, explicit statement about the owner. Keep its own subject-bound evidence,
    // sharing the same provenance root, rather than applying it to the person being helped.
    if (!ephemeral && contract.retention === 'purpose_scoped' && this.store.settings().memoryEnabled) {
      const points = Array.from(ingress.authoredText);
      for (const [index, act] of ingress.speechActs.entries())
        if (
          act.subjectId === s.principalId &&
          act.subjectId !== s.subjectId &&
          act.worldId === 'real' &&
          ['assert', 'correct'].includes(act.kind)
        ) {
          const id = eventId + ':owner-' + index,
            text = points.slice(act.startCodePoint, act.endCodePoint).join('');
          const scope = this.policy.hostScope({
            sources: ['history:self', 'profile:self'],
            currentEventIds: [id],
            subjectId: s.principalId,
            worldId: 'real',
            purposes: [contract.purpose],
            retention: contract.retention,
            infer: true,
          });
          this.repo.ingest(scope, {
            id,
            ownerId: s.principalId,
            workspaceId: s.workspaceId,
            subjectId: s.principalId,
            worldId: 'real',
            sourceId: 'history:self',
            contentVersion: 1,
            text,
            speaker: 'user',
            kind: 'user_message',
            authority: 'user_statement',
            roots: [eventId],
            parentEventId: eventId,
            label: { ...personalLabel, purpose: contract.purpose },
            receivedAt: contract.now,
            status: 'active',
            locator: {
              kind: 'text',
              eventId,
              contentVersion: 1,
              startCodePoint: act.startCodePoint,
              endCodePoint: act.endCodePoint,
            },
          });
          this.repo.indexEvidence(scope, id);
        }
    }
    if (ingress.scenario && !ephemeral) {
      const baseline = this.policy.hostScope({
        sources: s.sources,
        purposes: s.purposes,
        subjectId: s.subjectId,
      });
      this.work.createWorld(baseline, contract.worldId, { quotedAssumption: ingress.authoredText }, [
        eventId,
      ]);
    }
    const session: RunSession = {
      ingress,
      events,
      sessionId,
      ephemeral,
      signal,
      toolCalls: 0,
      modelCalls: 0,
    };
    this.lastSession = session;
    return session;
  }
  async compile(session: RunSession, acquire = false) {
    session.pack = await this.context.compile(
      session.ingress,
      session.events,
      session.signal,
      [],
      acquire,
      session.sessionId,
    );
    if (session.ingress.contract.audience !== 'self' && !session.ingress.replyToOwner) {
      session.pack.data.releaseSpec = this.releaseSpec(session, session.ingress.releaseBrief?.useAvailability
        ? { status: 'not_queried', required: 'availability_projection', meaning: '先读取明确时间窗的忙闲，再起草；不能猜测可约时间。' } : {});
      session.pack.currentText = this.generationInput(session);
      session.pack.evidence = [];
      session.pack.receipt.providedEvidenceIds = [];
      session.pack.receipt.providedObjectVersions = [];
      this.repo.saveReceipt(session.ingress.contract.scope, session.pack.receipt);
    }
    return session.pack;
  }
  /** Build the minimum audience-specific brief without carrying the authored request. */
  releaseSpec(session: RunSession, projection: Record<string, unknown> = {}): ReleaseSpec {
    const brief = session.ingress.releaseBrief;
    return releaseSpecSchema.parse({
      id: 'release:' + session.ingress.contract.id,
      recipient: brief?.recipient || '指定受众', purpose: brief?.purpose || '沟通目的尚未确认',
      allowedFacts: brief?.allowedFacts || [], allowedProjection: { ...structuredClone(projection), ...(session.ingress.priorReleasedDraft ? { priorReleasedDraft: session.ingress.priorReleasedDraft } : {}), priorDraft: { status: session.ingress.priorReleasedDraft ? 'provided' : 'not_provided', meaning: '只有priorReleasedDraft提供的实际文本与版本能支持既有草稿状态；未提供不等于已确认存在或已保留。可以依据当前允许事实生成新草稿。' }, delivery: { status: 'not_connected', meaning: '本产品尚未接通邮件或对外消息发送通道。请求发送时明确尚未发送；重复确认不能补上缺失通道，不能编造既有草稿的存在或保留状态。' } },
      tone: brief?.tone || '自然', length: 'medium',
      prohibitedCategories: ['private_original', 'private_reason', 'unapproved_derived_information'],
      mode: brief?.requestedOperation === 'send' ? 'send' : 'draft', materialVersions: session.ingress.priorReleasedDraft ? [{ id: session.ingress.priorReleasedDraft.id, revision: 1 }] : [], authorization: brief?.requestedOperation === 'send' ? 'projection_only' : brief ? 'explicit_draft' : 'projection_only',
    });
  }
  generationInput(session: RunSession) {
    if (session.ingress.replyToOwner || session.ingress.contract.audience === 'self')
      return (
        session.ingress.authoredText +
        (session.ingress.attachment
          ? '\n\n' + JSON.stringify({ attached_data: session.ingress.attachment })
          : '')
      );
    const spec = (session.pack?.data.releaseSpec as ReleaseSpec | undefined) || this.releaseSpec(session);
    if (spec.mode === 'draft') return '依据下面允许披露的事实、目的和语气，直接写出便于复制的草稿正文。可保留必要的姓名占位符；不增加未经委托的承诺或私人事实。用户目前只要草稿，不需要解释发送通道、历史检索或内部核验过程，也不要对未提供的旧稿状态作断言。\n' + JSON.stringify(spec);
    return '只根据以下最小披露资料处理沟通请求。mode=send表示用户已明确请求发送，须说明实际通道和结果，不要再次问是否要发送；无法发送时交代缺口。既有草稿状态以priorDraft为准，不能将未提供的草稿说成已保留或已确认存在。不得读取或猜测私人原始请求，也不得把私人原文带入草稿。\n' + JSON.stringify(spec);
  }
  async processCurrent(session: RunSession) {
    if (session.ephemeral) return;
    for (const event of session.events)
      await this.memory.process(session.ingress.contract.scope, event.id, session.signal);
  }
  toolSpecs(session: RunSession, child = false): ToolSpec[] {
    const contract = session.ingress.contract,
      s = this.policy.validate(contract.scope);
    const available: SpecDefinition[] = [...specs];
    if (this.connections.map && s.sources.includes('map:local')) {
      const place = z.object({ kind: z.enum(['place', 'node']), id: z.string().min(1).max(100) }).strict();
      available.push(
        {
          name: 'map_overview',
          description: '查看已装配地图的范围与数据说明。',
          schema: z.object({}).strict(),
          grant: 'map:read',
        },
        {
          name: 'map_search',
          description: '在现有地图检索地点，使用返回的稳定地点 ID。',
          schema: z
            .object({ query: z.string().min(1).max(100), limit: z.number().int().min(1).max(10).optional() })
            .strict(),
          grant: 'map:read',
        },
        {
          name: 'map_route',
          description: '计算现有步行网络上的路线并展示地图卡；未知入口、起点和不可达会明确返回。',
          schema: z
            .object({
              from: z.union([place, z.object({ kind: z.literal('current') }).strict()]).optional(),
              to: place.optional(),
              avoidStairs: z.boolean().optional(),
              version: z.string().optional(),
            })
            .strict(),
          grant: 'map:read',
        },
        {
          name: 'map_location_status',
          description: '读取定位能力状态，不启动定位。',
          schema: z.object({}).strict(),
          grant: 'map:read',
        },
      );
    }
    return available
      .filter(
        (d) =>
          (!child || (!d.mutates && d.name !== 'inspect_action' && d.name !== 'delegate' && d.name !== 'prepare_release')) &&
          (!d.grant || s.grants.includes(d.grant)) &&
          (d.name !== 'inspect_action' ||
            (s.sources.includes('local-agenda') && contract.audience === 'self')) &&
          (!session.ephemeral || !d.mutates || ['set_plan', 'apply_privacy_control', 'cancel_action', 'prepare_action', 'change_local_action'].includes(d.name)) &&
          (!this.memory.paused || !['propose_memory_change', 'remember_preference'].includes(d.name)) &&
          ((d.name !== 'propose_memory_change' && d.name !== 'remember_preference') || s.infer),
      )
      .map((d) => {
        const { $schema: _, ...parameters } = modelParameterOverrides[d.name] || z.toJSONSchema(d.schema);
        return { type: 'function', function: { name: d.name, description: d.description, parameters } };
      });
  }
  async executeTool(
    session: RunSession,
    name: string,
    raw: unknown,
    callbacks: RuntimeCallbacks,
    child = false,
  ): Promise<unknown> {
    const contract = session.ingress.contract,
      handle = contract.scope;
    session.signal.throwIfAborted();
    this.policy.validate(handle);
    const budgetOwner = session.budgetOwner || session;
    if (++budgetOwner.toolCalls > contract.budget.toolCalls)
      throw new HarnessError('tool_budget', '本轮工具调用达到上限。');
    if (budgetOwner !== session) session.toolCalls++;
    const aliases: Record<string, string> = {
      search_history: 'look_up',
      query_campus: 'look_up',
      get_weather: 'look_up',
      propose_action: 'prepare_action',
    };
    if (name in aliases) {
      raw =
        name === 'search_history'
          ? { source: 'history', ...(raw as object) }
          : name === 'query_campus'
            ? {
                source: 'campus',
                domain: (raw as any).kind,
                from: (raw as any).from,
                to: (raw as any).to,
                query: (raw as any).query,
              }
            : name === 'get_weather'
              ? { source: 'weather', ...(raw as object) }
              : raw;
      name = aliases[name];
    }
    if (name.startsWith('map_')) {
      if (session.ingress.requiresReadPurpose && name === 'map_route' && (raw as any)?.from?.kind === 'current') {
        const verdict = await callbacks.verifyReadPurpose?.({ data: 'current_user_location', arguments: raw });
        if (!verdict?.allowed) return { status: 'forbidden', reason: verdict?.reason || '当前问题尚未允许使用本人的位置。' };
      }
      const mapping: Record<string, string> = {
          map_overview: 'map.overview',
          map_search: 'map.search',
          map_route: 'map.route',
          map_location_status: 'map.location_status',
        },
        capability = mapping[name];
      if (!capability) throw new HarnessError('tool_unavailable', '地图工具不可用。');
      const result = await this.broker.invoke(handle, capability, raw, session.signal);
      if (session.pack) this.context.recordTool(session.pack, result, capability);
      if (capability === 'map.route' && result.data)
        callbacks.mapCard?.({ kind: 'route', route: result.data as any });
      return this.withMethodNotes(session, capability, result);
    }
    const allowed = this.toolSpecs(session, child).some((s) => s.function.name === name);
    if (!allowed) throw new HarnessError('tool_forbidden', '该工具当前不可用或未授权。');
    const definition = specs.find((d) => d.name === name)!,
      args = definition.schema.parse(raw) as any;
    if (name === 'prepare_release') {
      if (!session.ingress.authoredText.includes(args.sourceQuote)) throw new HarnessError('unsupported_evidence', '写稿请求需要当前用户原话依据。');
      if (!callbacks.prepareRelease) throw new HarnessError('release_unavailable', '当前没有接通独立写稿步骤。');
      return callbacks.prepareRelease(args);
    }
    if (name === 'apply_privacy_control') {
      if (!session.ingress.authoredText.includes(args.sourceQuote)) throw new HarnessError('unsupported_evidence', '这项控制需要当前原话。');
      const scope = this.policy.validate(handle);
      if (scope.subjectId !== scope.principalId || scope.worldId !== 'real' || scope.audience !== 'self') throw new HarnessError('forbidden', '当前范围不能改动本人的资料权限。');
      const targets = (args.ids || []).map((id: string) => {
        const assertion = this.repo.assertion(handle, id), evidence = assertion ? undefined : this.repo.evidence(handle, id);
        if (!assertion && !evidence) throw new HarnessError('target_missing', '找不到当前可控制的内容，请先定位对象。');
        return { id, type: assertion ? 'understanding' : 'evidence', text: assertion?.text || evidence?.text };
      });
      if (args.operation !== 'revoke_permission' && !targets.length) throw new HarnessError('target_missing', '还没有选定要控制的内容。');
      if (args.operation === 'revoke_permission' && (!args.permission || ![...this.policy.grants(), ...this.policy.revoked()].includes(args.permission))) throw new HarnessError('permission_unknown', '没有这项已登记权限。');
      const verdict = await callbacks.verifyPrivacyControl?.({ operation: args.operation, targets, permission: args.permission });
      if (!verdict?.approved) return { applied: false, status: 'needs_confirmation', reason: verdict?.reason || '这次控制范围还未核清。' };
      this.policy.validate(handle); session.signal.throwIfAborted();
      if (args.operation === 'revoke_permission') this.policy.revoke(args.permission);
      else if (args.operation === 'stop_using') {
        if (targets.some((target: any) => target.type !== 'understanding')) throw new HarnessError('target_type', '停用需要选择一条具体理解；原文遗忘是另一项操作。');
        for (const target of targets) this.memory.deactivate(target.id);
      } else {
        const event = session.events[0];
        const spans = [];
        for (let from = 0; event && from < event.text.length;) {
          const index = event.text.indexOf(args.sourceQuote, from);
          if (index < 0) break;
          const start = Array.from(event.text.slice(0, index)).length;
          spans.push({ eventId: event.id, contentVersion: event.contentVersion, start, end: start + Array.from(args.sourceQuote).length });
          from = index + args.sourceQuote.length;
        }
        this.memory.forget(targets.map((target: any) => target.id), [], spans);
      }
      session.privacyResult = { operation: args.operation, text: args.operation === 'forget' ? '已停止使用并清理本机相关内容。旧任务不能把它带回来；已经外发的内容和外部备份不在这次清理范围内。' : args.operation === 'stop_using' ? '这项理解已停用，之后不会再据此给建议。原文仍保留，需要时可以查看。' : '这项权限已撤回，相关读取和未执行的工作已停止。' };
      return { applied: true, status: 'applied', epoch: this.repo.epoch };
    }
    if (name === 'resolve_time') return { ...resolveLocalTime(args.local.length === 16 ? args.local + ':00' : args.local, args.timeZone || contract.timeZone), local: args.local, timeZone: args.timeZone || contract.timeZone };
    if (name === 'calculate_available_time') return availableIntervals(args);
    if (name === 'availability_projection') {
      const parent = this.policy.validate(handle), sources = (session.ingress.projectionSources || []).filter(source => (!parent.child || parent.sources.includes(source)) && (source === 'local-agenda' ? this.policy.grants().includes('evidence:read') : this.policy.grants().includes('campus:read')));
      if (parent.subjectId !== parent.principalId || parent.worldId !== 'real' || !sources.length) return { status: 'forbidden', reason: '本轮没有允许读取本人忙闲用于这次沟通。' };
      if (Date.parse(args.to) <= Date.parse(args.from) || Date.parse(args.to) - Date.parse(args.from) > 31 * 86400000) throw new HarnessError('time_window', '忙闲查询需明确时间窗，单次最多31天。');
      if (session.ingress.requiresReadPurpose) { const verdict = await callbacks.verifyReadPurpose?.({ data: 'own_availability_only', ...args }); if (!verdict?.allowed) return { status: 'forbidden', reason: verdict?.reason || '没有核清使用本人忙闲的目的。' }; }
      const scope = this.policy.hostScope({ sources, grants: ['availability:share'], purposes: ['personal_assistance'], infer: false });
      const account = this.connections.campus;
      if (account?.describe().configured && !account.describe().available && sources.includes('campus:zju-account')) return { status: 'not_connected', reason: '校园连接当前不可用，不能确认其忙闲。' };
      let result: Record<string, any>;
      if (account?.describe().configured && sources.includes('campus:zju-account')) {
        const remote = await account.availability(args.from, args.to, session.signal);
        const localScope = this.policy.hostScope({ sources: sources.filter(source => source === 'local-agenda'), grants: ['availability:share'], purposes: ['personal_assistance'], infer: false });
        const local = this.domains.availability(localScope, args.from, args.to);
        result = { ...remote, sourceIds: ['campus:zju-account', ...local.sourceIds], busyIntervals: [...(remote.busyIntervals || []), ...local.busyIntervals], localIssues: local.issues,
          status: remote.status === 'fresh' && !local.issues.length ? 'fresh' : 'partial', meaning: '仅含当前校园与本地记录中的忙碌区间，不含任何私人标题或原因。' };
      } else result = this.domains.availability(scope, args.from, args.to);
      const unknown = [...(result.issues || []), ...(result.localIssues || [])].filter(issue => issue?.status === 'unknown_end' && typeof issue.start === 'string');
      const gaps = availableIntervals({ from: args.from, to: args.to, busy: [...(result.busyIntervals || []), ...unknown.map(issue => ({ start: issue.start, end: null }))], transitionMinutes: { min: 0, max: 0 }, minimumBlockMinutes: 0 });
      result = { ...result, availableWindows: gaps.windows.map(window => ({ start: window.start, end: window.end })), unknownEnds: gaps.unknownEnds, timeZone: contract.timeZone,
        calculationMeaning: '只计算查询窗口扣除已知忙碌区间后的余段；未知结束时间保守占用到窗口末端，不替代来源覆盖或其他可行性条件。' };
      if (session.pack) session.pack.data.availabilityProjection = result;
      return result;
    }
    if (session.ingress.requiresReadPurpose && (['restore_collaboration', 'search_context', 'read_understanding', 'inspect_action'].includes(name) || (name === 'read_evidence' && !session.events.some(event => event.id === args.id)))) {
      const verdict = await callbacks.verifyReadPurpose?.({ tool: name, arguments: args, data: 'personal_history_or_work' });
      if (!verdict?.allowed) return { status: 'forbidden', reason: verdict?.reason || '本轮尚未核清读取这项本人资料的用途。' };
    }
    if (name === 'restore_collaboration') {
      const restored = this.collaboration.restore(handle, session.sessionId, args.query, args.offset, args.limit);
      this.context.recordObjects(session.pack, [...restored.items, ...restored.relatedOptions], 'work');
      const frames = restored.items.filter(item => item.data.type === 'collaboration_frame');
      const matter = frames.length === 1 ? frames[0] : undefined;
      const prefetch = matter && session.pack && contract.memoryMode === 'relevant' && contract.enhancements?.prefetch !== false
        ? this.context.prefetch(session.pack, `${matter.title} ${String(matter.data.question || '')} ${session.ingress.authoredText}`.slice(0, 1000)) : undefined;
      if (prefetch && session.pack?.receipt.mechanismUses) session.pack.receipt.mechanismUses.prefetch++;
      return { ...restored, ...(prefetch ? { contextualCandidates: prefetch } : {}) };
    }
    if (name === 'search_context') return this.context.prefetch(session.pack || await this.compile(session), args.query, args.at, args.offset, args.limit, args.hardOffset);
    if (name === 'read_understanding') {
      const assertion = this.repo.assertion(handle, args.id);
      if (!assertion) return { status: 'not_found', reason: '当前范围内没有这条理解。' };
      const exceptions = assertion.exceptionIds.map(id => this.repo.assertion(handle, id)).filter(Boolean);
      this.context.recordObjects(session.pack, [assertion, ...exceptions.filter((value): value is NonNullable<typeof value> => !!value)], 'assertion');
      return { status: assertion.status, assertion, exceptions, sourceIds: assertion.evidenceIds, meaning: '须结合本轮原话、生效时间和条件判断，不能把停用或待核验内容当当前事实。' };
    }
    if (name === 'update_collaboration') {
      const record = this.collaboration.update(handle, session.sessionId, args);
      if (record.kind === 'episode') session.episodeId = record.id;
      this.context.recordObjects(session.pack, [record], 'work');
      return record;
    }
    if (name === 'look_up') return this.lookUp(session, args, callbacks);
    if (name === 'manage_goal') {
      if (!session.ingress.authoredText.includes(args.sourceQuote)) throw new HarnessError('unsupported_evidence', '目标控制需要本轮原话。');
      const goal = this.repo.work(handle, 'goal', args.id)[0];
      if (!goal) throw new HarnessError('goal_missing', '没有找到当前可控制的目标。');
      const verdict = await callbacks.verifyLocalDelegation?.({ operation: args.operation, target: { id: goal.id, title: goal.title, status: goal.status }, scope: 'local_goal_only' });
      if (verdict?.decision !== 'execute_local') return { applied: false, status: 'needs_confirmation', reason: verdict?.reason || '需要确认具体目标。' };
      return this.repo.write(() => {
        const current = this.repo.work(handle, 'goal', args.id)[0];
        if (!current || current.revision !== args.expectedRevision) throw new HarnessError('revision_conflict', '目标刚刚改变，请先读取当前状态。');
        if (args.operation === 'pause' || args.operation === 'cancel') {
          this.work.cancelGoal(handle, current.id);
          if (args.operation === 'pause') { const cancelled = this.repo.work(handle, 'goal', args.id)[0]; this.work.update(handle, cancelled.id, cancelled.revision, { status: 'paused' }); }
        } else this.work.update(handle, current.id, current.revision, { status: 'active' });
        return { applied: true, goal: this.repo.work(handle, 'goal', args.id)[0], oldRemindersReenabled: false };
      });
    }
    if (name === 'cancel_action') {
      const action = this.actions.get(handle, args.id);
      if (!action) return { status: 'not_found', reason: '没有找到当前范围内的动作。' };
      const verdict = await callbacks.verifyLocalDelegation?.({ operation: 'cancel', current: { id: action.id, capability: action.capability, status: action.status, arguments: action.arguments } });
      if (verdict?.decision !== 'execute_local') return { status: 'needs_confirmation', reason: verdict?.reason || '需要核对具体取消对象。' };
      if (action.effect !== 'local_write' && !['proposed', 'awaiting_approval', 'approved'].includes(action.status)) return { status: 'outcome_unknown', reason: '外部动作已经派发，需要原服务的具体撤销流程；尚未撤回外部后果。' };
      const result = await this.actions.cancel(handle, action.id, session.signal);
      callbacks.changed();
      return { status: result?.status, actionId: action.id, localOnly: action.effect === 'local_write' };
    }
    if (name === 'change_local_action') {
      if (contract.worldId !== 'real' || contract.actionMode === 'respond') return { applied: false, status: 'draft_only', reason: '本轮只比较，不改动实际安排。' };
      if (!this.policy.validate(handle).sources.includes('local-agenda')) throw new HarnessError('forbidden', '本轮不能读取或修改本地安排。');
      const prior = this.calendar.read(args.targetId);
      if (!prior) return { applied: false, status: 'known_absent', sourceId: 'local-agenda', coverage: { complete: true, objectId: args.targetId }, reason: '这个本地对象已不存在。' };
      const verdict = await callbacks.verifyLocalDelegation?.({ ...args, current: { id: prior.id, title: prior.title, startsAt: prior.startsAt, allDayDate: prior.allDayDate, durationMinutes: prior.durationMinutes, recurrence: prior.recurrence, revision: prior.revision || 1 } });
      if (verdict?.decision !== 'execute_local') return { applied: false, status: 'needs_confirmation', reason: verdict?.reason || '还未核清具体修改。', missing: verdict?.missing || [] };
      const effectScope = session.ephemeral ? this.policy.localEffectScope(handle) : handle;
      const executed = await this.actions.directLocal(effectScope, {
        id: 'change:' + createHash('sha256').update(canonical({ eventId: session.events[0]?.id, args })).digest('hex'),
        capability: 'local.agenda.change', arguments: args, authorized: true,
        dependencies: [
          ...session.events.map(event => ({ consumerId: 'pending', producerId: event.id, producerRevision: event.contentVersion, sensitivity: 'privacy' as const, invalidation: 'block' as const })),
          { consumerId: 'pending', producerId: this.repo.registerCalendarVersion(handle, prior.id, prior.revision || 1, prior.effectActionId || prior.id), producerRevision: 0, sensitivity: 'privacy' as const, invalidation: 'block' as const },
        ],
      }, session.signal);
      const current = this.calendar.read(args.targetId);
      if (current && executed.action.compensation?.applied) callbacks.action(current);
      callbacks.changed();
      return { applied: executed.action.compensation?.applied === true, status: executed.receipt.status, actionId: executed.action.id,
        item: current || null, receipt: executed.receipt, undo: executed.action.compensation?.applied ? { actionId: executed.action.id } : null };
    }
    if (name === 'read_evidence') {
      const ephemeral = this.ephemeralEvents.get(args.id);
      const event = ephemeral && this.policy.validate(handle).currentEventIds.includes(args.id) ? ephemeral : this.repo.evidence(handle, args.id);
      if (
        !event ||
        (!session.events.some((e) => e.id === event.id) && event.label.audience !== contract.audience)
      )
        throw new HarnessError('evidence_forbidden', '这条原文不在本轮允许范围内。');
      if (session.pack && !session.pack.receipt.providedEvidenceIds.includes(event.id)) {
        session.pack.receipt.providedEvidenceIds.push(event.id);
        this.repo.saveReceipt(handle, session.pack.receipt);
      }
      return {
        id: event.id,
        version: event.contentVersion,
        text: codePointSlice(event.text, args.offset, Math.min(Array.from(event.text).length, args.offset + args.limit)),
        coverage: { start: args.offset, end: Math.min(Array.from(event.text).length, args.offset + args.limit), total: Array.from(event.text).length, complete: args.offset === 0 && args.limit >= Array.from(event.text).length },
        nextOffset: args.offset + args.limit < Array.from(event.text).length ? args.offset + args.limit : null,
        use: this.repo.db.prepare('SELECT 1 FROM h_source_restrictions WHERE event_id=? LIMIT 1').get(event.id) ? 'historical_only' : 'source_evidence',
        authority: event.authority,
        receivedAt: event.receivedAt,
        subjectId: event.subjectId,
        worldId: event.worldId,
        locator: event.locator,
      };
    }
    if (name === 'remember_preference' || name === 'propose_memory_change') {
      let change: unknown = args;
      if (name === 'remember_preference') {
        const event = session.events[0],
          date = /今天/.test(args.source_quote)
            ? dayBounds(dateInZone(contract.now, contract.timeZone), contract.timeZone)
            : undefined;
        change = {
          operation: 'ADD',
          eventId: event.id,
          sourceQuote: args.source_quote,
          predicate: 'preference.explicit',
          text: args.text,
          value: { type: 'text', value: args.text },
          kind: date ? 'current_state' : 'explicit_preference',
          strength: 'soft',
          conditions: always,
          validFrom: date?.from,
          validTo: date?.to,
          idempotencyKey: createHash('sha256')
            .update(event.id + args.source_quote)
            .digest('hex'),
        };
      }
      const parsed = changeSchema.parse(change);
      if (!session.events.some((e) => e.id === parsed.eventId))
        throw new HarnessError('event_not_current', '记忆提案须指向本轮原文。');
      const value = await this.memory.propose(handle, parsed, session.signal);
      callbacks.changed();
      return {
        status: value.status === 'active' ? 'saved' : 'candidate_proposed',
        id: value.id,
        revision: value.revision,
        verification: value.verification,
        ...(value.status !== 'active' ? { meaning: '这只是待核验候选，尚未成为有效长期理解。当前原话仍可直接用于本轮回应；不要为了完成内部整理而向用户索取当前任务不需要的时间或确认。' } : {}),
      };
    }
    if (name === 'prepare_action') {
      Object.assign(args, normalizeCalendarInput(args, contract.timeZone));
      if (contract.temporalAmbiguities.length)
        return {
          prepared: false,
          saved: false,
          status: 'needs_confirmation',
          reason: '你给的本地时间不存在或有歧义，尚未创建提醒；请先选择一个有效时间。',
          temporalAmbiguities: contract.temporalAmbiguities,
        };
      if (contract.worldId !== 'real' || contract.actionMode === 'respond') {
        const draft = { ...args, id: randomUUID(), saved: false };
        callbacks.action(draft);
        return {
          prepared: true,
          saved: false,
          status: 'draft_only',
          item: draft,
          note: '仅比较草稿；尚未获得保存或执行授权。',
        };
      }
      const pack = session.pack || (await this.compile(session));
      const verdict = await callbacks.verifyLocalDelegation?.(args);
      if (verdict?.decision === 'not_requested' || verdict?.decision === 'needs_clarification')
        return { prepared: false, saved: false, status: verdict.decision, reason: verdict.reason, missing: verdict.missing };
      if (session.ephemeral && verdict?.decision !== 'execute_local') return { prepared: false, saved: false, status: 'draft_only', reason: '这轮不保留聊天；只有已经核实的具体本地委托才会保存业务结果。' };
      const dependencies = [
        ...pack.receipt.providedObjectVersions.filter(value => value.kind === 'work' || value.kind === 'assertion').map(value => ({ consumerId: 'pending', producerId: value.id, producerRevision: value.revision, sensitivity: 'hard' as const, invalidation: 'block' as const })),
        ...[...new Set([...pack.receipt.providedEvidenceIds, ...(pack.receipt.providedSourceIds || [])])].map(
          (id) => ({
            consumerId: 'pending',
            producerId: id,
            producerRevision: 0,
            sensitivity: 'privacy' as const,
            invalidation: 'block' as const,
          }),
        ),
        ...session.events.map((e) => ({
          consumerId: 'pending',
          producerId: e.id,
          producerRevision: session.ephemeral ? 0 : e.contentVersion,
          sensitivity: session.ephemeral ? 'privacy' as const : 'hard' as const,
          invalidation: 'block' as const,
        })),
        ...pack.assertions.map((a) => ({
          consumerId: 'pending',
          producerId: a.id,
          producerRevision: a.revision,
          sensitivity: a.strength === 'hard' ? ('hard' as const) : ('soft' as const),
          invalidation: 'revalidate' as const,
        })),
      ];
      const directLocal = verdict?.decision === 'execute_local';
      if (directLocal) {
        const effectScope = session.ephemeral ? this.policy.localEffectScope(handle) : handle;
        if (!args.createNew) {
          const candidates = this.repo.db.prepare(`SELECT payload FROM agenda WHERE json_extract(payload,'$.title')=?
            AND COALESCE(json_extract(payload,'$.done'),0)=0
            AND ((json_extract(payload,'$.startsAt') IS NULL AND ? IS NULL) OR julianday(json_extract(payload,'$.startsAt'))=julianday(?))
            AND COALESCE(json_extract(payload,'$.allDayDate'),'')=COALESCE(?,'') LIMIT 50`).all(args.title, args.startsAt || null, args.startsAt || null, args.allDayDate || null)
            .map(row => JSON.parse(String(row.payload)) as Action)
            .filter(item => {
              const normalized = normalizeCalendarInput(item, contract.timeZone);
              return normalized.kind === args.kind && canonical(normalized.recurrence || null) === canonical(args.recurrence || null);
            });
          if (candidates.length === 1) {
            const existing = candidates[0];
            if (existing.durationMinutes !== args.durationMinutes) return { saved: false, status: 'conflict', existing: { id: existing.id, revision: existing.revision || 1, title: existing.title, startsAt: existing.startsAt, durationMinutes: existing.durationMinutes }, reason: '已有同名同时的安排，但时长不同；应核对是否修改原对象，未再创建副本。' };
            return { prepared: false, saved: true, status: 'observed_existing', alreadyPresent: true,
              item: { id: existing.id, title: existing.title, startsAt: existing.startsAt, allDayDate: existing.allDayDate, durationMinutes: existing.durationMinutes, revision: existing.revision || 1 },
              observedAt: this.repo.clock.now(), sourceId: 'local-agenda', meaning: '已核查本地原对象，没有新建副本，也没有新的撤销操作。' };
          }
          if (candidates.length > 1) return { saved: false, status: 'conflict', reason: '已存在多个同名同时间的安排，需要先区分目标，尚未新增。' };
        }
        const executed = await this.actions.directLocal(
          effectScope,
          {
            id:
              'direct:' +
              createHash('sha256')
                .update(
                  canonical({
                    eventId: session.events[0]?.id || contract.id,
                    capability: 'local.agenda.save',
                    arguments: args,
                  }),
                )
                .digest('hex'),
            capability: 'local.agenda.save',
            arguments: args,
            goalId: args.goalId,
            dependencies,
            // The separate host check verified the current delegation and exact parameters;
            // the acting model cannot supply this approval in its tool arguments.
            authorized: true,
          },
          session.signal,
        );
        const item = {
          ...args,
          id: executed.action.id,
          saved: true,
          revision: executed.action.revision,
          approvalDigest: executed.action.digest,
          coverage: 'verified' as const,
          missingNeeds: [],
        };
        callbacks.action(item);
        callbacks.changed();
        return {
          prepared: true,
          saved: true,
          executionTier: 'direct_local',
          status: executed.receipt.status,
          item,
          receipt: {
            id: executed.receipt.id,
            status: executed.receipt.status,
            localStatus: executed.receipt.localStatus,
            observedAt: executed.receipt.observedAt,
          },
          notification: this.notificationStatus(item),
          undo: { actionId: executed.action.id, operation: 'cancel_local_action' },
        };
      }
      const prepared = this.actions.prepare(handle, {
        capability: 'local.agenda.save',
        arguments: args,
        goalId: args.goalId,
        dependencies,
      });
      const item = {
        ...args,
        id: prepared.id,
        saved: false,
        revision: prepared.revision,
        approvalDigest: prepared.digest,
        coverage: 'conditional' as const,
        missingNeeds: verdict?.missing || [],
      };
      callbacks.action(item);
      return { prepared: true, saved: false, status: 'awaiting_approval', item };
    }
    if (name === 'set_plan') {
      const items = (args.items as Obligation[]).map((i) => ({
        ...i,
        status:
          i.status === 'done' &&
          !this.broker.invocations.some((v) => v.scopeId === handle.id && v.status === 'fresh')
            ? ('blocked' as const)
            : i.status,
      }));
      callbacks.plan(items);
      return { ok: true, scope: 'run_steps_only' };
    }
    if (name === 'delegate') {
      for (const task of args.tasks) this.childScope(session, task);
      return callbacks.delegate(args.tasks);
    }
    if (name === 'inspect_action') {
      if (!args.id) return { actions: this.actions.list(handle).filter(action => !['succeeded', 'cancelled', 'cancellation_confirmed'].includes(action.status)).slice(0, 20).map(action => ({ id: action.id, capability: action.capability, status: action.status, arguments: action.arguments, revision: action.revision })) };
      return args.reconcile ? this.actions.reconcile(handle, args.id, session.signal) : { action: this.actions.get(handle, args.id), receipts: this.actions.receipts(handle, args.id) };
    }
    if (name === 'update_work_state') {
      const recordDerivation = (id: string) => {
        for (const source of new Set([
          ...(session.pack?.receipt.providedEvidenceIds || session.events.map((e) => e.id)),
          ...(session.pack?.receipt.providedSourceIds || []),
        ]))
          this.repo.addDependency(handle, {
            consumerId: id,
            producerId: source,
            producerRevision: 0,
            sensitivity: 'privacy',
            invalidation: 'revalidate',
          });
      };
      const mutate = <T extends { id: string }>(write: () => T): T =>
        this.repo.write(() => {
          const item = write();
          recordDerivation(item.id);
          return item;
        });
      if (args.operation === 'propose_options') {
        if (!session.episodeId) session.episodeId = this.work.create(handle, 'episode', session.ingress.authoredText.slice(0, 120), {
          type: 'collaboration_frame', sessionId: session.sessionId, sessionIds: [session.sessionId],
          question: session.ingress.authoredText, confirmedFacts: [], decisions: [], tentativeUnderstanding: [],
          participation: [], rejectedOptions: [], nextStep: null,
        }, { status: 'active', evidenceIds: session.events.map(e => e.id) }).id;
        const options = args.options.map((option: { title: string; rationale: string }) => ({
          id: randomUUID(),
          title: option.title,
          data: { rationale: option.rationale },
        }));
        this.repo.write(() => {
          this.work.addOptions(
            handle,
            session.episodeId!,
            options,
            options.map((o: { id: string }) => o.id),
          );
          for (const option of options) recordDerivation(option.id);
          recordDerivation(session.episodeId!);
        });
        return {
          options: options.map((o: { id: string; title: string }, index: number) => ({
            id: o.id,
            ordinal: index + 1,
            title: o.title,
          })),
          status: 'proposals_only',
          episodeId: session.episodeId,
          instruction: '按返回顺序呈现；后续第二个等引用使用稳定选项。',
        };
      }
      if (args.operation === 'reference_option') {
        if (!session.ingress.authoredText.includes(args.sourceQuote)) throw new HarnessError('unsupported_evidence', '指代需要对应本轮原话。');
        const episode = this.repo.work(handle, 'episode', args.episodeId)[0];
        const option = this.repo.work(handle, 'option', args.id)[0];
        if (!episode || !option || !(episode.data.optionIds as string[] || []).includes(option.id) || ['rejected', 'cancelled', 'stale', 'blocked'].includes(option.status))
          throw new HarnessError('option_missing', '该选项已改变或不属于这个事项，需要重新核对。');
        const updated = this.work.update(handle, episode.id, args.expectedRevision, { data: { ...episode.data, referencedOptionId: option.id, lastSessionId: session.sessionId, sessionIds: [...new Set([...(episode.data.sessionIds as string[] || []), session.sessionId])] } });
        session.episodeId = episode.id;
        if (session.pack) session.pack.data.workState = [updated, option];
        return { episode: updated, option, meaning: '已定位继续讨论的选项；这不批准任何实际行动。' };
      }
      if (args.operation === 'reject_option') {
        if (!session.ingress.authoredText.includes(args.sourceQuote))
          throw new HarnessError('unsupported_evidence', '拒绝理由需要本轮原话。');
        const old = this.repo.work(handle, 'option', args.id)[0];
        if (!old) throw new HarnessError('option_missing', '选项不存在。');
        return mutate(() =>
          this.work.update(handle, old.id, args.expectedRevision, {
            status: 'rejected',
            data: {
              ...old.data,
              rejection: { reason: args.sourceQuote, validWhen: args.validWhen, permanent: args.permanent },
              rejectionStillApplicable: true,
            },
          }),
        );
      }
      if (args.operation === 'checkpoint') {
        const old = this.repo.work(handle, 'episode', args.episodeId)[0];
        return mutate(() =>
          this.work.update(handle, args.episodeId, args.expectedRevision, {
            data: {
              ...old?.data,
              nextSmallQuestion: args.nextSmallQuestion,
              openQuestions: args.openQuestions,
            },
          }),
        );
      }
      if (args.operation === 'propose_goal')
        return mutate(() =>
          this.work.create(
            handle,
            'goal',
            args.title,
            { reason: args.reason, sessionId: session.sessionId, sessionIds: [session.sessionId] },
            { status: 'proposed', evidenceIds: [session.events[0].id] },
          ),
        );
      if (args.operation === 'propose_task') {
        if (!session.ingress.authoredText.includes(args.sourceQuote))
          throw new HarnessError('unsupported_evidence', '任务提议缺少本轮原话。');
        return mutate(() =>
          this.work.create(
            handle,
            'task',
            args.title,
            { kind: args.kind, proposed: true },
            { status: 'draft', evidenceIds: [session.events[0].id] },
          ),
        );
      }
      const pack = session.pack || (await this.compile(session));
      await this.context.expand(pack, this.work.introducedNeeds(args.candidate), session.signal);
      const plan = this.work.validatePlan(
        contract,
        args.candidate,
        pack.needs,
        pack.assertions,
        pack.data.currentFacts as any,
      );
      mutate(() => this.work.savePlan(contract, plan, [session.events[0].id]));
      return plan;
    }
    throw new HarnessError('tool_unavailable', '工具尚未实现。');
  }
  private async lookUp(session: RunSession, args: z.infer<typeof lookUpSchema>, callbacks: RuntimeCallbacks) {
    const sensitive: Record<string, string> = { grades: 'grades', retakes: 'grades', gpa: 'gpa', gpa_semesters: 'gpa', gpa_cumulative: 'gpa', reservations: 'reservations', reservation_violations: 'reservations', card: 'card', transactions: 'transactions', profile: 'profile', roles: 'profile' };
    const handle = session.ingress.contract.scope,
      call = async (capability: string, input: unknown) => {
        const domain = (input as { domain?: string } | undefined)?.domain;
        const purposeGrant = ['campus.lookup', 'campus.imported_lookup'].includes(capability) && domain && sensitive[domain]
          ? 'campus:' + sensitive[domain] + ':read' : undefined;
        let readHandle = handle;
        if (purposeGrant || session.ingress.requiresReadPurpose) {
          const verdict = await callbacks.verifyReadPurpose?.({ capability: this.broker.describe(capability), arguments: input });
          if (!verdict?.allowed) return { status: 'forbidden' as const, sourceId: this.broker.describe(capability)?.sourceId || 'unknown', simulated: false, reason: verdict?.reason || '本轮尚未核清这些资料的用途。' };
          if (purposeGrant) readHandle = this.policy.campusPurposeScope(handle, purposeGrant);
        }

        const result = await this.broker.invoke(readHandle, capability, input, session.signal, {
          refresh: args.mode === 'refresh' || args.refresh,
          maxCalls: session.ingress.contract.budget.toolCalls,
        });
        if (session.pack) this.context.recordTool(session.pack, result, capability, readHandle.id);
        if (capability === 'weather.lookup') {
          const card = weatherCardFromResult(result);
          if (card) callbacks.weatherCard?.(card);
        }
        const available = (result.data as { available?: boolean } | undefined)?.available;
        if (result.status === 'fresh' && typeof available === 'boolean' && this.policy.can(handle, 'work:write')) {
          const updated = this.work.revalidateRejections(handle, { ['capability:' + capability]: { type: 'boolean', value: available } });
          const definition = this.broker.describe(capability);
          for (const option of updated) {
            this.work.update(handle, option.id, option.revision, { data: { ...option.data,
              rejectionCheckExpiresAt: result.expiresAt || new Date(Date.parse(this.repo.clock.now()) + 300000).toISOString(), checkedCapabilities: [capability],
            } });
            for (const grant of definition?.requiredScopes || []) this.repo.addDependency(handle, { consumerId: option.id, producerId: 'grant:' + grant, producerRevision: session.ingress.contract.policyRevision, sensitivity: 'privacy', invalidation: 'block' });
          }
        }
        return this.withMethodNotes(session, capability, result);
      };
    const accountConfigured = this.connections.campus?.describe().configured === true;
    const campusReadCapability = accountConfigured
      ? 'campus.lookup'
      : this.broker.describe('campus.imported_lookup')
        ? 'campus.imported_lookup'
        : 'campus.lookup';
    if (args.source === 'history') return call('evidence.search', { query: args.query || '' });
    if (args.source === 'weather') {
      const capability = 'weather.lookup';
      if (!this.broker.describe(capability))
        return {
          status: 'unsupported' as const,
          sourceId: 'plugin:weather',
          reason: '天气插件尚未安装或未提供 weather.lookup 能力。请在接口管理器中安装并启用天气插件。',
          simulated: false,
        };
      const input: Record<string, unknown> = {
        days: args.days || 3,
        location: args.location || (this.store.settings().weatherUseLocation ? 'current' : 'Hangzhou'),
      };
      if (input.location === 'current') {
        const prepared = await prepareWeatherPluginInput(input as any, {
          policy: this.policy,
          scope: handle,
          connections: this.connections,
          signal: session.signal,
          sourceId: this.broker.describe(capability)?.sourceId,
        });
        if ('result' in prepared) return prepared.result;
        return call(capability, prepared.input);
      }
      return call(capability, input);
    }
    if (args.source === 'map') return call('map.search', { query: args.query || '' });
    if (args.source === 'local') return call('local.agenda.read', { query: args.query, from: args.from, to: args.to, timeZone: session.ingress.contract.timeZone });
    if (args.source === 'capability') {
      if (!args.capability) return this.broker.catalog(handle, args.query, args.offset, args.limit);
      if (args.describeOnly) return this.broker.detail(handle, args.capability);
      const description = this.broker.describe(args.capability);
      if (description && description.effect !== 'read')
        throw new HarnessError('effect_forbidden', '查找入口只能调用只读能力。');
      return call(args.capability, args.arguments || {});
    }
    if (args.mode === 'overview')
      return call('campus.overview', {
        refresh: !!args.refresh, includeSensitiveDomains: args.includeSensitiveDomains === true,
        academicYear: args.academicYear, term: args.term,
      });
    if (!args.domain) return { status: 'needs_parameters', reason: '请选择所需资料领域；可先读取source_status了解覆盖。', domains: campusDomains };
    return call(campusReadCapability, {
      domain: args.domain, courseId: args.courseId, academicYear: args.academicYear, term: args.term,
      query: args.query, from: args.from, to: args.to, at: args.at, timeMode: args.timeMode,
      fields: args.fields, filters: args.filters, sort: args.sort, offset: args.offset,
      window: args.window, limit: args.limit || 12, refresh: args.mode === 'refresh' || !!args.refresh,
    });
  }

  private withMethodNotes(session: RunSession, capability: string, result: unknown) {
    const method = capability.startsWith('campus.') ? 'campus' : capability.startsWith('map.') ? 'map' : undefined;
    if (!method || session.methodNotes?.includes(method)) return result;
    (session.methodNotes ||= []).push(method);
    return { ...(result as object), hostUsageGuidance: method === 'campus' ? campusMethod : mapMethod, guidanceMeaning: '宿主提供的使用方法，不是本次用户事实，也不扩大权限。' };
  }
  refreshDependencies(session: RunSession) {
    const pack = session.pack;
    if (!pack) return [];
    if (pack.contract.enhancements?.repairRejudge === false) return [];
    this.policy.validate(pack.contract.scope);
    const versions = new Map<string, (typeof pack.receipt.providedObjectVersions)[number]>();
    for (const ref of pack.receipt.providedObjectVersions) {
      const key = `${ref.kind}:${ref.id}`;
      if (!versions.has(key) || versions.get(key)!.revision < ref.revision) versions.set(key, ref);
    }
    const changed: unknown[] = [];
    for (const ref of versions.values()) {
      if (ref.kind !== 'work' && ref.kind !== 'assertion') continue;
      const current = ref.kind === 'work' ? this.repo.work(pack.contract.scope, undefined, ref.id)[0] : this.repo.assertion(pack.contract.scope, ref.id);
      if (!current && ref.revision === 0) continue;
      if (current && current.revision === ref.revision) continue;
      changed.push(current || { id: ref.id, status: 'not_available' });
      for (const value of pack.receipt.providedObjectVersions) if (value.id === ref.id && value.kind === ref.kind) value.revision = current?.revision || 0;
    }
    if (changed.length) {
      if (pack.receipt.mechanismUses) pack.receipt.mechanismUses.repairRejudge += changed.length;
      (session.dependencyNotices ||= []).push(...changed);
      (session.observations ||= []).push({ tool: 'host_state_change', result: { changed, meaning: '已使用的依据版本改变，需要重新判断相关部分；未受影响的安排保留。' } });
    }
    return changed;
  }
  childScope(session: RunSession, task: DelegatedTask) {
    const parent = this.policy.validate(session.ingress.contract.scope);
    const evidenceIds = new Set(task.currentEvidenceIds || []);
    const sources = new Set((task.sources || ['current']).map(source => {
      if (source.startsWith('file:') && parent.currentEventIds.includes(source.slice(5))) { evidenceIds.add(source.slice(5)); return 'current'; }
      return source;
    }));
    if (evidenceIds.size) sources.add('current');
    return this.policy.narrow(session.ingress.contract.scope, { child: true, infer: false, sources: [...sources], currentEventIds: [...evidenceIds], grants: parent.grants.filter(grant => grant.endsWith(':read')) });
  }
  private notificationStatus(item: Action) {
    if (item.kind !== 'reminder' && !item.remindAt) return undefined;
    const channel = this.reminders.port?.capabilities;
    const queued = !!this.repo.db.prepare("SELECT id FROM h_jobs WHERE object_id=? AND status IN ('queued','leased') LIMIT 1").get(item.id);
    const goalActive = !item.goalId || this.repo.db.prepare('SELECT status FROM h_work WHERE id=?').get(item.goalId)?.status === 'active';
    return { registered: queued, enabled: this.reminders.attention().enabled, channelAvailable: !!channel?.submitted,
      appClosedSupported: channel?.closedApp === true, delivered: false, seen: false,
      meaning: !goalActive ? '相关目标未启用，提醒保持暂停。' : !this.reminders.attention().enabled ? '提醒已登记，但通知未开启，不能承诺届时发出。' : !channel?.submitted ? '已登记时间，但没有可用通知渠道，不能承诺提醒。' : channel.closedApp ? '由已接入的后台渠道派发；尚未送达。' : '只在应用运行时尝试通知；应用关闭不会保证提醒，派发也不等于已读。' };
  }

  finish(session: RunSession) {
    if (session.ephemeral) {
      session.observations = [];
      for (const e of session.events) this.ephemeralEvents.delete(e.id);
      session.events = [];
      session.ingress = {
        ...session.ingress,
        text: '',
        authoredText: '',
        corrections: [],
        attachment: undefined,
      };
      if (session.pack) {
        session.pack.evidence = [];
        session.pack.currentText = '';
        session.pack.data = {};
      }
    }
    if (session.pack) {
      try {
        this.repo.saveReceipt(session.ingress.contract.scope, session.pack.receipt);
      } catch {}
    }
  }
  saveMemoryControl(text: string, id?: string) {
    return this.memory.saveControl(text, id);
  }
  memories(): Memory[] {
    return this.memory.views();
  }
  async acceptLocal(item: Action) {
    const handle = this.policy.hostScope();
    const existing = this.calendar.read(item.id);
    if (existing) {
      if (item.revision !== undefined && item.revision !== (existing.revision || 1)) throw new HarnessError('revision_conflict', '这项安排已改变，请先查看当前版本。');
      if (canonical(localArgs(existing)) === canonical(localArgs(item)) && !!existing.done === !!item.done) return this.actions.receipts(handle, existing.effectActionId || existing.id).at(-1);
      return this.changeLocalFromUI(item, 'update');
    }
    let action = this.actions.get(handle, item.id);
    if (
      action &&
      ['cancelled', 'cancel_requested', 'cancellation_confirmed', 'cannot_cancel'].includes(action.status)
    )
      throw new HarnessError('stale_action', '这项建议的依据已变化，请重新生成或选择当前方案。');
    if (action && item.revision !== undefined && item.revision !== action.revision)
      throw new HarnessError('revision_conflict', '你看到的动作版本已更新，请重新查看后确认。');
    if (action && item.approvalDigest !== undefined && item.approvalDigest !== action.digest)
      throw new HarnessError('approval_mismatch', '待确认内容已经变化，请重新查看。');
    if (!action) {
      // Only a genuine offered card or an existing local record can enter the legacy compatibility path.
      const offered = this.store.db
        .prepare("SELECT payload FROM messages WHERE role='assistant'")
        .all()
        .some((r) => (JSON.parse(String(r.payload)).actions || []).some((a: Action) => a.id === item.id));
      if (!offered) throw new HarnessError('unknown_action', '请从当前建议卡确认具体安排。');
      action = this.actions.prepare(handle, {
        id: item.id,
        capability: 'local.agenda.save',
        arguments: localArgs(item),
      });
    } else if (canonical(action.arguments) !== canonical(localArgs(item)))
      action = this.actions.revise(handle, action.id, action.revision, localArgs(item));
    const approval = this.actions.approve(handle, action.id, action.digest, action.revision);
    const receipt = await this.actions.execute(handle, action.id, approval.id);
    if (item.done) {
      this.store.writeAgendaProjection({ ...item, saved: true, done: true });
      this.reminders.cancel(item.id);
    }
    return receipt;
  }
  async changeLocalFromUI(item: Action, operation: 'update' | 'delete') {
    const scope = this.policy.hostScope(), existing = this.calendar.read(item.id);
    if (!existing) throw new HarnessError('calendar_missing', '这个安排已不存在。');
    if (item.revision !== undefined && item.revision !== (existing.revision || 1)) throw new HarnessError('revision_conflict', '安排已更新，不能覆盖新版本。');
    const { createNew: _createNew, demo: _demo, ...fields } = localArgs(item);
    const executed = await this.actions.directLocal(scope, { capability: 'local.agenda.change', arguments: {
      operation, targetId: item.id, expectedRevision: existing.revision || 1,
      ...(operation === 'update' ? { changes: { ...fields, done: !!item.done } } : {}),
    }, dependencies: [{ consumerId: 'pending', producerId: this.repo.registerCalendarVersion(scope, item.id, existing.revision || 1, existing.effectActionId || existing.id), producerRevision: 0, sensitivity: 'privacy', invalidation: 'block' }], authorized: true });
    return executed.receipt;
  }
}
function localArgs(item: Action) {
  return {
    title: item.title,
    detail: item.detail,
    ...(item.startsAt ? { startsAt: item.startsAt } : {}),
    ...(item.durationMinutes ? { durationMinutes: item.durationMinutes } : {}),
    ...(item.demo ? { demo: true } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.timeZone ? { timeZone: item.timeZone } : {}),
    ...(item.allDayDate ? { allDayDate: item.allDayDate } : {}),
    ...(item.recurrence ? { recurrence: item.recurrence } : {}),
    ...(item.exceptions ? { exceptions: item.exceptions } : {}),
    ...(item.remindAt ? { remindAt: item.remindAt } : {}),
    ...(item.createNew ? { createNew: true } : {}),
    ...(item.goalId ? { goalId: item.goalId } : {}),
  };
}
