import { z } from 'zod';

export const objectId = z.string().min(1).max(160);
export const instant = z.string().datetime({ offset: true });
export const knowledgeStatus = z.enum([
  'fresh',
  'partial',
  'not_connected',
  'stale',
  'conflict',
  'not_queried',
  'not_found',
  'failed',
  'forbidden',
  'unsupported',
  'known_absent',
  'unknown',
]);
export type KnowledgeStatus = z.infer<typeof knowledgeStatus>;
export const typedValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('text'), value: z.string().max(4000) }).strict(),
  z.object({ type: z.literal('entity'), value: objectId }).strict(),
  z
    .object({
      type: z.literal('quantity'),
      value: z.number().finite(),
      unit: z.string().min(1).max(40),
      dimension: z.string().min(1).max(60),
    })
    .strict(),
  z.object({ type: z.literal('instant'), value: instant }).strict(),
  z.object({ type: z.literal('unknown'), reason: z.string().max(300) }).strict(),
]);
export type TypedValue = z.infer<typeof typedValue>;
export type Condition =
  | { op: 'all' | 'any'; terms: Condition[] }
  | { op: 'not'; term: Condition }
  | {
      op: 'compare';
      predicate: string;
      comparator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      value: TypedValue;
    }
  | { op: 'known'; predicate: string }
  | { op: 'unknown'; reason: string };
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.enum(['all', 'any']), terms: z.array(conditionSchema).max(32) }).strict(),
    z.object({ op: z.literal('not'), term: conditionSchema }).strict(),
    z
      .object({
        op: z.literal('compare'),
        predicate: objectId,
        comparator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
        value: typedValue,
      })
      .strict(),
    z.object({ op: z.literal('known'), predicate: objectId }).strict(),
    z.object({ op: z.literal('unknown'), reason: z.string().max(300) }).strict(),
  ]),
);
export const always: Condition = { op: 'all', terms: [] };
export type Truth = 'true' | 'false' | 'unknown';

export const locatorSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('text'),
        eventId: objectId,
        contentVersion: z.number().int().positive(),
        startCodePoint: z.number().int().nonnegative(),
        endCodePoint: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('file'),
        artifactId: objectId,
        version: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        paragraphId: objectId.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('image'),
        artifactId: objectId,
        version: z.number().int().positive(),
        region: z.tuple([
          z.number().min(0).max(1),
          z.number().min(0).max(1),
          z.number().positive().max(1),
          z.number().positive().max(1),
        ]),
        objectId: objectId.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('audio'),
        artifactId: objectId,
        version: z.number().int().positive(),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        transcriptVersion: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('structured'),
        snapshotId: objectId,
        jsonPointer: z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/),
        sourceRecordId: objectId,
      })
      .strict(),
  ])
  .superRefine((loc, ctx) => {
    if (loc.kind === 'text' && loc.endCodePoint <= loc.startCodePoint)
      ctx.addIssue({ code: 'custom', message: 'Empty/reversed span' });
    if (loc.kind === 'audio' && loc.endMs <= loc.startMs)
      ctx.addIssue({ code: 'custom', message: 'Reversed audio interval' });
    if (loc.kind === 'image' && (loc.region[0] + loc.region[2] > 1 || loc.region[1] + loc.region[3] > 1))
      ctx.addIssue({ code: 'custom', message: 'Region outside image' });
  });
export type EvidenceLocator = z.infer<typeof locatorSchema>;
export const labelSchema = z
  .object({
    purpose: z.string().min(1).max(80).default('personal_assistance'),
    audience: z.enum(['self', 'group', 'public']).default('self'),
    retention: z.enum(['purpose_scoped', 'history_no_inference', 'session_only']).default('purpose_scoped'),
    sensitivity: z.enum(['public', 'personal', 'restricted']).default('personal'),
    infer: z.boolean().default(true),
    expiresAt: instant.optional(),
  })
  .strict();
export type PolicyLabel = z.infer<typeof labelSchema>;
export const personalLabel: PolicyLabel = labelSchema.parse({});
export interface HostIdentity {
  principalId: string;
  workspaceId: string;
  deviceId: string;
}
declare const scopeBrand: unique symbol;
export interface ScopeHandle {
  readonly id: string;
  readonly [scopeBrand]: true;
}
export interface ClockPort {
  now(): string;
  monotonicMs(): number;
}
export interface ScopeData extends HostIdentity {
  subjectId: string;
  worldId: string;
  sources: readonly string[];
  currentEventIds: readonly string[];
  purposes: readonly string[];
  audience: 'self' | 'group' | 'public';
  grants: readonly string[];
  privacyEpoch: number;
  policyRevision: number;
  retention: PolicyLabel['retention'];
  infer: boolean;
  expiresAt: string;
  child: boolean;
}
export interface ContextContract {
  enhancements?: { prefetch?: boolean; currentMatter?: boolean; repairRejudge?: boolean; closure?: boolean };
  id: string;
  revision: number;
  scope: ScopeHandle;
  subjectId: string;
  worldId: string;
  memoryMode: 'relevant' | 'current_sources_only' | 'session_only' | 'none';
  retention: PolicyLabel['retention'];
  audience: ScopeData['audience'];
  purpose: string;
  interactionMode: 'listen' | 'clarify' | 'analyze' | 'suggest_next' | 'tutor_hint' | 'direct_answer';
  actionMode: 'respond' | 'read' | 'propose';
  exploration: boolean;
  privacyEpoch: number;
  policyRevision: number;
  timeZone: string;
  now: string;
  budget: {
    maxTokens: number;
    maxRows: number;
    maxReadBytes: number;
    toolCalls: number;
    modelCalls: number;
    dependencyDepth: number;
  };
  excludedReasons: string[];
  temporalAmbiguities: string[];
  resolvedDates: string[];
  /**
   * A host-validated, editable interpretation of the authored turn.  It is
   * deliberately optional so older callers which construct ContextContract
   * literals continue to work.  This is descriptive routing data, never an
   * authorization token; all effects still require the ScopeHandle below.
   */
  interpretation?: InterpretationProposal;
}

/** Small, source-anchored intents used to keep mixed requests separate. */
export type RequestIntent =
  | 'listen'
  | 'reflect'
  | 'record_local'
  | 'retrieve'
  | 'plan'
  | 'hypothesis'
  | 'correction'
  | 'quote'
  | 'other';

export interface RequestFragment {
  id: string;
  startCodePoint: number;
  endCodePoint: number;
  text: string;
  subjectId: string;
  worldId: string;
  intents: RequestIntent[];
  readSources: ('history' | 'local' | 'capability')[];
  /** Participation posture is independent from effects (e.g. listen + record_local). */
  participation?: 'listen' | 'reflect' | 'analyze' | 'act';
  audience: 'self' | 'group' | 'public';
  constraints: string[];
  unresolvedReferences: string[];
  confidence: 'clear' | 'ambiguous';
}

export interface InterpretationProposal {
  fragments: RequestFragment[];
  hasListen: boolean;
  hasRetrieval: boolean;
  explicitLocalWrite: boolean;
  /** True only when an explicit local write is fully scoped to the real owner. */
  directLocalWrite: boolean;
}
export const requestFragmentSchema = z
  .object({
    id: objectId,
    startCodePoint: z.number().int().nonnegative(),
    endCodePoint: z.number().int().positive(),
    text: z.string().max(250000),
    subjectId: objectId,
    worldId: objectId,
    intents: z.array(
      z.enum(['listen', 'reflect', 'record_local', 'retrieve', 'plan', 'hypothesis', 'correction', 'quote', 'other']),
    ).max(9),
    readSources: z.array(z.enum(['history', 'local', 'capability'])).max(3),
    participation: z.enum(['listen', 'reflect', 'analyze', 'act']).optional(),
    audience: z.enum(['self', 'group', 'public']),
    constraints: z.array(z.string().max(300)).max(12),
    unresolvedReferences: z.array(z.string().max(80)).max(12),
    confidence: z.enum(['clear', 'ambiguous']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endCodePoint <= value.startCodePoint)
      ctx.addIssue({ code: 'custom', message: 'Empty/reversed request fragment' });
  });
export const interpretationProposalSchema = z
  .object({
    fragments: z.array(requestFragmentSchema).max(64),
    hasListen: z.boolean(),
    hasRetrieval: z.boolean(),
    explicitLocalWrite: z.boolean(),
    directLocalWrite: z.boolean(),
  })
  .strict();
export const evidenceSchema = z
  .object({
    id: objectId,
    ownerId: objectId,
    workspaceId: objectId,
    subjectId: objectId,
    worldId: objectId,
    sourceId: objectId,
    contentVersion: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    text: z.string().max(250000),
    speaker: z.enum(['user', 'assistant', 'external']),
    kind: z.enum(['user_message', 'user_control', 'file_import', 'tool_result', 'external_observation']),
    authority: z.enum([
      'user_statement',
      'source_record',
      'quotation',
      'model_derivative',
      'legacy_unverified',
    ]),
    roots: z.array(objectId).min(1).max(64),
    label: labelSchema,
    receivedAt: instant,
    parentEventId: objectId.optional(),
    sessionId: objectId.optional(),
    fileName: z.string().max(260).optional(),
    interpretationTimeZone: z.string().max(100).optional(),
    locator: locatorSchema.optional(),
    status: z.enum(['active', 'redacted', 'deleted']).default('active'),
  })
  .strict();
export type EvidenceEvent = z.infer<typeof evidenceSchema>;
export const temporalSchema = z
  .object({
    validFrom: instant.optional(),
    validTo: instant.optional(),
    precision: z.enum(['instant', 'day', 'interval', 'unresolved']),
    recordedFrom: instant,
    recordedTo: instant.optional(),
    unresolvedExpression: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (t) => !t.validFrom || !t.validTo || Date.parse(t.validTo) > Date.parse(t.validFrom),
    'Invalid validity interval',
  );
export const assertionSchema = z
  .object({
    id: objectId,
    ownerId: objectId,
    workspaceId: objectId,
    subjectId: objectId,
    worldId: objectId,
    revision: z.number().int().positive(),
    predicate: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/),
    value: typedValue,
    text: z.string().min(1).max(4000),
    kind: z.enum([
      'explicit_fact',
      'explicit_preference',
      'current_state',
      'inferred_hypothesis',
      'legacy_unverified',
    ]),
    strength: z.enum(['hard', 'soft', 'unconfirmed']),
    conditions: conditionSchema,
    exceptionIds: z.array(objectId).max(64),
    temporal: temporalSchema,
    status: z.enum(['candidate', 'active', 'disputed', 'superseded', 'expired', 'retracted', 'inactive']),
    evidenceIds: z.array(objectId).max(64),
    label: labelSchema,
    verification: z.enum(['verified', 'pending', 'unverified']),
  })
  .strict();
export type Assertion = z.infer<typeof assertionSchema>;
export const changeSchema = z
  .object({
    operation: z.enum([
      'ADD',
      'SUPPORT',
      'REFINE',
      'ADD_EXCEPTION',
      'SUPERSEDE',
      'CORRECT',
      'DISPUTE',
      'EXPIRE',
      'RETRACT',
    ]),
    targetId: objectId.optional(),
    expectedRevision: z.number().int().positive().optional(),
    eventId: objectId,
    sourceQuote: z.string().min(1).max(12000),
    predicate: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/),
    value: typedValue,
    text: z.string().min(1).max(4000),
    kind: z.enum(['explicit_fact', 'explicit_preference', 'current_state', 'inferred_hypothesis']),
    strength: z.enum(['hard', 'soft', 'unconfirmed']),
    conditions: conditionSchema,
    validFrom: instant.optional(),
    validTo: instant.optional(),
    unresolvedTime: z.string().max(200).optional(),
    subject: z.enum(['self', 'source_subject', 'other', 'fictional']).default('source_subject'),
    world: z.enum(['source_world', 'hypothetical']).default('source_world'),
    idempotencyKey: objectId,
  })
  .strict();
export type MemoryChange = z.infer<typeof changeSchema>;
export type ProcessingStatus =
  | 'pending'
  | 'candidate_emitted'
  | 'ephemeral_only'
  | 'quote_or_hypothesis'
  | 'no_personal_fact'
  | 'needs_context'
  | 'failed';
export interface ProcessingSpan {
  id: string;
  eventId: string;
  contentVersion: number;
  start: number;
  end: number;
  status: ProcessingStatus;
  indexed: boolean;
}
export interface Watermarks {
  received: number;
  extractedContiguous: number;
  indexedContiguous: number;
  extractionGaps: number[];
  indexingGaps: number[];
}
export const needSchema = z
  .object({
    id: objectId,
    key: objectId,
    importance: z.enum(['must', 'conditional', 'optional']),
    capability: objectId.optional(),
    args: z.record(z.string(), z.json()).default({}),
    condition: conditionSchema.default(always),
    mode: z.enum(['all', 'any']).default('all'),
    childIds: z.array(objectId).max(32).default([]),
  })
  .strict();
export type Need = z.infer<typeof needSchema>;
export interface NeedResult {
  id: string;
  key: string;
  capability?: string;
  status: KnowledgeStatus;
  evidenceIds: string[];
  reason?: string;
  value?: unknown;
  fetchedAt?: string;
  coverage?: unknown;
}
export interface EvidenceBundle {
  id: string;
  assertionIds: string[];
  evidenceIds: string[];
  text: string;
  estimatedTokens: number;
  hard: boolean;
  coverage: 'complete' | 'conditional' | 'blocked';
}
/** Non-secret provider facts captured with a context receipt. */
export interface ProviderReceipt {
  providerId: string;
  endpoint: string;
  /** Every endpoint actually attempted after the receipt was created. */
  observedEndpoints?: string[];
  model: string;
  protocol: string;
  protocolVersion: string;
  capabilities: {
    thinking: boolean;
    reasoningContent: boolean;
    toolCalls: boolean;
    toolContinuation: boolean;
    strictTools: boolean;
    structuredOutput: boolean;
    modalities: string[];
    toolDialect: string;
    opaqueState: string;
  };
  limits: {
    /** Host/request ceiling for generated output. */
    maxOutputTokens: number;
    /** Only present when verified from provider metadata or an isolated probe. */
    contextTokens?: number;
    /** The host context budget used for this receipt. */
    hostContextTokens: number;
  };
  requestModes?: {
    thinking: 'enabled' | 'disabled' | 'mixed';
    strict: boolean | 'mixed';
    tools: boolean;
  };
}
export interface ContextReceipt {
  mechanismUses?: { prefetch: number; currentMatter: number; repairRejudge: number; closure: number };
  engine?: { name: string; commit: string; adapterSha256: string; python: string };
  delegations?: { id: string; parentId: string; title: string; status: 'queued' | 'running' | 'produced' | 'consumed' | 'failed' | 'cancelled'; sources?: string[]; currentEvidenceIds?: string[]; modelCalls: number; responses: number; toolCalls: number }[];
  modelUsage?: { phase: string; inputTokens: number | null; outputTokens: number | null; usdMin: number | null; usdMax: number | null }[];
  id: string;
  runId: string;
  contractRevision: number;
  policyRevision: number;
  privacyEpoch: number;
  watermarks: Watermarks;
  providedEvidenceIds: string[];
  providedSourceIds?: string[];
  providedObjectVersions: { id: string; revision: number; kind?: 'evidence' | 'assertion' | 'work' }[];
  needResults: { key: string; status: KnowledgeStatus }[];
  excludedReasonCounts: Record<string, number>;
  /** Full, non-secret provider/protocol facts for this run. */
  provider?: ProviderReceipt;
  /** Compatibility label; derived from the selected protocol, never a model default. */
  providerVersion: string;
  toolAttempts: { id: string; capability: string; status: string; version: string }[];
  coverage: 'complete_for_candidate' | 'conditional' | 'blocked';
  budget: { estimatedTokens: number; readBytes: number; outputLimitAdjustments?: { requested: number; applied: number; actor: 'main' | 'child' }[] };
}
export interface DelegatedTask {
  title: string;
  instruction: string;
  sources?: string[];
  currentEvidenceIds?: string[];
}
export interface ContextPack {
  contract: ContextContract;
  bundles: EvidenceBundle[];
  assertions: Assertion[];
  evidence: EvidenceEvent[];
  needs: NeedResult[];
  receipt: ContextReceipt;
  data: Record<string, unknown>;
  currentText: string;
}
/**
 * A bounded, audience-specific brief for public/group drafting.
 *
 * This is deliberately not the authored request: it carries only the facts
 * the user elected to release and the constraints needed to write the draft.
 * The public model must never need the private source event to understand the
 * requested communication.
 */
export const releaseSpecSchema = z
  .object({
    id: objectId,
    recipient: z.string().min(1).max(160),
    purpose: z.string().min(1).max(300),
    allowedFacts: z.array(z.string().min(1).max(600)).max(24),
    allowedProjection: z.record(z.string(), z.json()).default({}),
    tone: z.string().max(120).default('自然、礼貌'),
    length: z.enum(['short', 'medium', 'long']).default('short'),
    prohibitedCategories: z.array(z.string().max(120)).max(24).default([]),
    mode: z.enum(['draft', 'send']).default('draft'),
    materialVersions: z.array(z.object({ id: objectId, revision: z.number().int().positive() }).strict()).max(64).default([]),
    authorization: z.enum(['explicit_draft', 'explicit_send', 'projection_only']).default('projection_only'),
  })
  .strict();
export type ReleaseSpec = z.infer<typeof releaseSpecSchema>;
export const dependencySchema = z
  .object({
    consumerId: objectId,
    producerId: objectId,
    producerRevision: z.number().int().nonnegative(),
    sensitivity: z.enum(['hard', 'soft', 'privacy']),
    invalidation: z.enum(['block', 'revalidate', 'recompute', 'expire']),
  })
  .strict();
export type Dependency = z.infer<typeof dependencySchema>;
export const actionStatusSchema = z.enum([
  'proposed',
  'awaiting_approval',
  'approved',
  'dispatching',
  'succeeded',
  'failed_confirmed',
  'outcome_unknown',
  'reconciling',
  'unresolved',
  'cancelled',
  'cancel_requested',
  'cancellation_confirmed',
  'cancellation_unknown',
  'cannot_cancel',
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;
export const effectSchema = z
  .object({
    id: objectId,
    ownerId: objectId,
    workspaceId: objectId,
    subjectId: objectId,
    worldId: objectId,
    revision: z.number().int().positive(),
    capability: objectId,
    arguments: z.record(z.string(), z.json()),
    compensation: z.object({ targetId: objectId, expectedRevision: z.number().int().nonnegative(), previous: z.record(z.string(), z.json()).nullable(), applied: z.boolean() }).strict().optional(),
    audience: objectId,
    status: actionStatusSchema,
    digest: z.string(),
    idempotencyKey: objectId,
    dependencies: z.array(dependencySchema).max(128),
    validUntil: instant,
    policyRevision: z.number().int().positive(),
    privacyEpoch: z.number().int().positive(),
    effect: z.enum(['local_write', 'external_write']),
    executionTier: z.enum(['direct_local', 'approval_required']).default('approval_required'),
    sourceId: objectId,
    goalId: objectId.optional(),
    reason: z.string().max(300).optional(),
    simulated: z.boolean().default(false),
  })
  .strict();
export type EffectAction = z.infer<typeof effectSchema>;
export interface Approval {
  id: string;
  actionId: string;
  actionDigest: string;
  actionRevision: number;
  principalId: string;
  policyRevision: number;
  privacyEpoch: number;
  expiresAt: string;
  used: boolean;
}
export interface EffectReceipt {
  id: string;
  actionId: string;
  attemptId: string;
  sourceId: string;
  status: 'confirmed_success' | 'confirmed_failure' | 'accepted_not_confirmed' | 'unknown';
  externalRecordId?: string;
  observedAt: string;
  localStatus?: 'local_saved';
  reason?: string;
}
export const workSchema = z
  .object({
    id: objectId,
    kind: z.enum([
      'episode',
      'goal',
      'plan',
      'option',
      'commitment',
      'task',
      'experience',
      'hypothesis',
      'learning',
      'window',
      'feedback',
      'recipe_candidate',
    ]),
    ownerId: objectId,
    workspaceId: objectId,
    subjectId: objectId,
    worldId: objectId,
    revision: z.number().int().positive(),
    status: z.string().min(1).max(50),
    title: z.string().max(400),
    evidenceIds: z.array(objectId).max(128),
    label: labelSchema,
    data: z.record(z.string(), z.json()),
  })
  .strict();
export type WorkRecord = z.infer<typeof workSchema>;
export const candidateSchema = z
  .object({
    id: objectId,
    title: z.string().min(1).max(300),
    activity: z.string().max(80),
    location: z.string().max(120).optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    needs: z.array(needSchema).max(32).default([]),
    dependencies: z.array(dependencySchema).max(128).default([]),
    resourceCapabilities: z.array(objectId).max(16).default([]),
    preservesUnstructuredTime: z.boolean().default(false),
    rationale: z.string().max(1200),
  })
  .strict();
export type PlanCandidate = z.infer<typeof candidateSchema>;
export const domainDeltaSchema = z
  .object({
    sourceId: objectId,
    domain: z.string().min(1).max(80),
    institutionId: objectId,
    termId: objectId,
    scopeKeys: z.array(objectId).min(1).max(100),
    completeness: z.enum(['complete', 'partial', 'failed']),
    sourceRevision: z.string().max(100).optional(),
    fromCursor: z.string().max(200).optional(),
    toCursor: z.string().max(200).optional(),
    upserts: z
      .array(
        z
          .object({ recordId: objectId, value: z.record(z.string(), z.json()), evidenceId: objectId })
          .strict(),
      )
      .max(6000),
    tombstones: z.array(objectId).max(6000),
    fetchedAt: instant,
    observedAt: instant.optional(),
    errors: z.array(z.string().max(400)).max(100),
  })
  .strict();
export type DomainDelta = z.infer<typeof domainDeltaSchema>;
export interface DomainRecord {
  id: string;
  domain: string;
  sourceId: string;
  institutionId: string;
  termId: string;
  revision: number;
  evidenceId: string;
  value: Record<string, unknown>;
  status: KnowledgeStatus;
  fetchedAt: string;
}
export interface MemoryView {
  id: string;
  text: string;
  quote: string;
  createdAt: string;
  status: Assertion['status'];
  kind: Assertion['kind'];
  revision: number;
  verification: Assertion['verification'];
  conditions: string;
  validFrom?: string;
  validTo?: string;
  evidenceIds: string[];
}
export class HarnessError extends Error {
  constructor(
    public code: string,
    message: string,
    public retry: 'never' | 'read' | 'reconcile' = 'never',
    /** Model-facing diagnostic; callers must not promote it to a UI status. */
    public diagnostic?: { rejectedDimensions: string[]; explanation: string },
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
