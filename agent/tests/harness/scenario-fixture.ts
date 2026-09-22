import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { Fixture, supported, testDirectory, withHostReplies } from './support';
import { ScriptedSemanticClient, scriptedExtraction } from './scripted';
import { Harness } from '../../src/main/harness';
import { ToolRegistry } from '../../src/main/tools';
import { DeepSeekClient, type WireMessage } from '../../src/main/provider';
import {
  always,
  personalLabel,
  type Assertion,
  type EvidenceEvent,
  type MemoryChange,
  type ScopeHandle,
  type TypedValue,
} from '../../src/shared/harness';
import { dateInZone, dayBounds } from '../../src/main/runtime/semantics';
import type { InputControls } from '../../src/main/runtime/policy';
import type {
  CapabilityDefinition,
  CapabilityProvider,
  CapabilityResult,
} from '../../src/main/capabilities/broker';
import { ExternalSink } from './sink';

const noCallbacks = {
  step: () => {},
  plan: () => {},
  action: () => {},
  changed: () => {},
  delegate: async () => [],
};
const val = (value: any, predicate = ''): TypedValue =>
  typeof value === 'boolean'
    ? { type: 'boolean', value }
    : typeof value === 'number'
      ? {
          type: 'quantity',
          value,
          unit: predicate.includes('minutes') ? 'minutes' : 'count',
          dimension: predicate.includes('minutes') ? 'duration' : 'count',
        }
      : { type: 'text', value: String(value) };
const allStatuses = ['active', 'candidate', 'disputed', 'superseded', 'expired', 'retracted', 'inactive'];
export class ScenarioFixture {
  f = new Fixture();
  client: ScriptedSemanticClient;
  harness: Harness;
  sessionId = 'acceptance-thread';
  controls: InputControls = {};
  events: any[] = [];
  toolResults: any[] = [];
  snapshots = new Map<string, any>();
  toolFixtures = new Map<string, any>();
  injectedCandidates: any[] = [];
  pending = new Map<string, { scope: ScopeHandle; change: MemoryChange }>();
  backups = new Map<string, string>();
  offline: any[] = [];
  private captures: any[][] = [];
  private forgetRequestIndex = 0;
  private initialEpoch = 1;
  private rollbackEpoch?: number;
  private sink?: ExternalSink;
  private sinkInspect = true;
  private externalName = 'test.external.book';
  private externalGrant = 'external:book';
  private pausedDispatch?: { release: () => void; done: Promise<any> };
  private stopped?: Promise<void>;
  private releaseChild?: () => void;
  activeDelegates = 0;
  private recipeCandidates = new Map<string, any>();
  private entities: Record<string, string> = {};
  private firstActionId?: string;
  exportResult: any;
  scanOccurrences = 0;
  retrieval: any[] = [];
  paired: any;
  protocolRoundtrip = false;
  private protocolCanary?: string;
  mapOpened = false;
  appClosed = false;
  private lastReadDomain?: string;
  private providerVersion = 'scripted-v1';
  private seededProtocol?: {
    client: DeepSeekClient;
    completion: import('../../src/main/provider').Completion;
  };
  constructor(
    readonly initial: any,
    readonly fixtureCatalog: any,
  ) {
    this.entities = initial.entities && !Array.isArray(initial.entities) ? initial.entities : {};
    this.client = new ScriptedSemanticClient(this.entities);
    this.harness = this.makeHarness();
  }
  private makeHarness() {
    return new Harness(
      this.f.store,
      () => 'synthetic-fixture-key',
      (event) => this.events.push(structuredClone(event)),
      () => this.client,
    );
  }
  async initialize() {
    this.f.store.saveSettings({ mode: 'deepseek', weatherEnabled: true });
    this.initialEpoch = this.f.repo.epoch;
    const domain = this.fixtureCatalog.domain_records;
    this.f.store.runtime.domains.importSnapshot(
      {
        source: 'synthetic-official',
        updatedAt: this.f.clock.now(),
        schedule: domain.schedule.map((c: any) => ({
          id: c.id,
          title: '合成课程',
          startsAt: c.starts_at,
          endsAt: c.ends_at,
          location: c.room,
          status: 'scheduled',
          source: c.source,
        })),
        exams: [],
        sports: {
          completed: domain.official_sports.completed,
          required: domain.official_sports.required,
          deadline: domain.official_sports.deadline,
          ruleSource: 'synthetic-official',
        },
        places: [],
        rules: [],
      },
      undefined,
      'campus:local',
      'test:A',
      '2026-fall',
    );
    this.f.repo.setMeta('campus_import_metadata', {
      ...this.f.repo.getMeta<any>('campus_import_metadata'),
      cohort: 'synthetic',
    });
    this.f.repo.setMeta('recurring_template', domain.recurring_template);
    this.f.store.session(this.sessionId, '合成连续事项');
    for (const source of this.initial.policy_overrides?.initial_allowed_sources || [])
      this.f.policy.registerSource(source);
    for (const grant of this.initial.policy_overrides?.initial_grants || []) this.f.policy.grant(grant);
    if (Array.isArray(this.initial.entities)) this.seedEntities(this.initial.entities);
    else if (Object.keys(this.entities).length)
      this.seedEntities(
        Object.entries(this.entities).map(([label, id]) => ({
          id,
          label,
          aliases: [label],
          institution: 'test:A',
        })),
      );
    this.installScriptedProviders();
    for (const history of this.initial.history || [])
      await this.seedHistory(history.id, history.text, history.speaker);
    if (this.initial.watermarks) this.seedWatermarks(this.initial.watermarks);
    this.resetAccess();
  }
  resetAccess() {
    this.f.repo.access.length = 0;
  }
  private bindExtractor() {
    this.f.memory.extractor = async (event, span) =>
      scriptedExtraction(
        {
          event: { id: event.id, text: span.text },
          clock: { now: this.f.clock.now(), timeZone: this.controls.timeZone || 'Asia/Shanghai' },
          relatedAssertions: this.f.repo.assertions(this.f.scope(), { statuses: ['active', 'candidate'] }),
        },
        this.entities,
      ) as any;
    this.f.memory.reviewer = async () => supported;
  }
  async seedHistory(id: string, text: string, speaker = 'user') {
    this.f.store.putMessage({
      id,
      sessionId: this.sessionId,
      role: speaker === 'assistant' ? 'assistant' : 'user',
      content: text,
      createdAt: this.f.clock.now(),
      status: 'done',
      steps: [],
      obligations: [],
      actions: [],
    });
    if (speaker === 'user') {
      this.bindExtractor();
      await this.f.memory.process(this.f.scope(), id);
    }
  }
  async userTurn(text: string) {
    this.resetAccess();
    if (/替室友/.test(text)) this.controls.subjectId = 'roommate-b';
    // Explicit offline model proposal; production does not infer this route.
    if (/不参加|别再提醒/.test(text)) {
      const goals = this.f.repo.work(this.f.scope(), 'goal').filter(goal => goal.status === 'active');
      if (goals.length === 1) this.client.injected.push({ name: 'manage_goal', args: { id: goals[0].id, expectedRevision: goals[0].revision, operation: 'cancel', sourceQuote: text } });
    }
    const result = this.harness.start(this.sessionId, text, this.controls);
    this.sessionId = result.sessionId;
    await this.harness.idle();
    this.captureTools();
  }
  private captureTools() {
    const seen = new Set(this.toolResults.map((r) => r.id));
    for (const request of this.client.requests)
      for (const message of request)
        if (message.role === 'tool' && !seen.has(message.tool_call_id)) {
          seen.add(message.tool_call_id);
          try {
            this.toolResults.push({ id: message.tool_call_id, ...JSON.parse(message.content || '{}') });
          } catch {}
        }
  }
  private installScriptedProviders() {
    const broker = this.f.store.runtime.broker;
    for (const id of ['campus-read', 'spatial', 'weather']) broker.unregister(id);
    const definition = (name: string, input: z.ZodType, scopes: string[]): CapabilityDefinition => ({
      name,
      version: 'fixture-v1',
      input,
      output: z.json(),
      effect: 'read',
      requiredScopes: scopes,
      subjects: ['self', 'other', 'fictional'],
      worlds: ['real', 'scenario'],
      timeoutMs: 1000,
      maxBytes: 100000,
      supportsIdempotency: false,
      supportsInspect: false,
      supportsCancel: false,
    });
    const register = (
      id: string,
      sourceId: string,
      definitions: CapabilityDefinition[],
      invoke: CapabilityProvider['invoke'],
    ) =>
      broker.register(
        {
          manifest: {
            id,
            version: '1',
            trust: 'bundled_reviewed',
            sourceId,
            capabilities: definitions,
            egressHosts: [],
            platforms: ['*'],
            simulated: true,
            offline: 'read_cache',
            license: 'synthetic source fixture',
          },
          invoke,
        },
        { reviewed: true, source: 'acceptance fixture' },
      );
    const envelope = (sourceId: string, raw: any): CapabilityResult => {
      const status = raw?.status === 'available' || raw?.status === 'ok' ? 'fresh' : raw?.status || 'unknown';
      return {
        status,
        data: raw,
        sourceId,
        simulated: true,
        fetchedAt: this.f.clock.now(),
        expiresAt: new Date(Date.parse(this.f.clock.now()) + 60000).toISOString(),
        coverage: {
          complete: raw?.coverage?.complete ?? status === 'fresh',
          scope: 'synthetic fixture',
          until: raw?.coverage_end,
        },
        reason: raw?.reason,
      };
    };
    register(
      'scripted-campus',
      'campus:local',
      [
        definition(
          'campus.lookup',
          z
            .object({
              domain: z.string(),
              query: z.string().optional(),
              from: z.string().optional(),
              to: z.string().optional(),
              window: z.string().optional(),
              limit: z.number().optional(),
              refresh: z.boolean().optional(),
            })
            .strict(),
          ['campus:read'],
        ),
      ],
      (_name, args, ctx) => {
        const configured = this.toolFixtures.get('campus.' + args.domain);
        if (configured) return envelope('campus:local', configured);
        const result = this.f.store.runtime.domains.resolve(ctx.scope, args.domain, {
          institutionId: 'test:A',
          termId: '2026-fall',
        });
        return {
          status: result.status as any,
          sourceId: 'campus:local',
          simulated: true,
          data: {
            domain: args.domain,
            records: result.records.map((r) => r.value),
            conflicts: result.conflicts.map((g) => ({
              id: g[0].id,
              fields: [...new Set(g.flatMap((r) => Object.keys(r.value)))].filter(
                (key) => new Set(g.map((r) => JSON.stringify(r.value[key]))).size > 1,
              ),
            })),
          },
          fetchedAt: this.f.clock.now(),
          coverage: { complete: true, scope: args.domain },
        };
      },
    );
    register(
      'scripted-spatial',
      'map:local',
      [
        definition('map.location_status', z.object({}).strict(), ['map:read']),
        definition('map.place', z.object({}).strict(), ['map:read']),
        definition('map.route', z.record(z.string(), z.json()), ['map:read']),
        definition('map.search', z.record(z.string(), z.json()), ['map:read']),
      ],
      (name) => {
        const raw = this.toolFixtures.get(name === 'map.location_status' ? 'location' : name) || {
          status: 'unknown',
          reason: 'missing_synthetic_spatial_evidence',
        };
        return envelope('map:local', raw);
      },
    );
    register(
      'scripted-weather',
      'plugin:weather',
      [
        definition(
          'weather.lookup',
          z.object({ days: z.number().optional(), location: z.string().optional() }).strict(),
          ['weather:read'],
        ),
      ],
      () =>
        envelope(
          'plugin:weather',
          this.toolFixtures.get('weather') || { status: 'unknown', reason: 'no_synthetic_forecast' },
        ),
    );
    register(
      'scripted-optional',
      'optional:fixture',
      [
        definition('finance.available', z.object({}).strict(), []),
        definition('place.food_service', z.object({}).strict(), []),
        definition('learning.independent_performance', z.object({}).strict(), []),
      ],
      (name) =>
        envelope(
          'optional:fixture',
          this.toolFixtures.get(name === 'place.food_service' ? 'place.hours' : name) || {
            status: name === 'learning.independent_performance' ? 'unknown' : 'unsupported',
          },
        ),
    );
  }
  private seedWatermarks(w: any) {
    const base = Math.min(w.extracted_contiguous, w.indexed_contiguous);
    this.f.repo.setMeta('sequence_base', base);
    this.f.repo.setMeta('received_seq', base);
    for (let seq = base + 1; seq <= w.received; seq++) {
      const e = this.f.ingest('合成处理队列 ' + seq, 'wm-' + seq);
      if (seq <= w.extracted_contiguous) this.f.repo.markSpans(this.f.scope(), e.id, 'no_personal_fact');
      if (seq <= w.indexed_contiguous) this.f.repo.indexEvidence(this.f.scope(), e.id);
    }
  }
  private seedEntities(entities: any[]) {
    this.f.store.runtime.entities.register(
      this.f.scope(),
      entities.map((e) => ({
        id: e.id,
        aliases: e.aliases || [e.label],
        institutionId: e.institution || 'test:A',
        role: e.role,
        sourceId: e.role ? 'history:self' : 'map:local',
      })),
    );
  }
  private async seedAssertion(raw: any) {
    const id = raw.id || randomUUID(),
      text = raw.text || '受控历史断言：' + raw.predicate + ' = ' + String(raw.value),
      e = this.f.ingest(text, 'seed:' + id),
      s = this.f.scope(),
      identity = this.f.repo.identity;
    const assertion: Assertion = {
      id,
      ownerId: identity.principalId,
      workspaceId: identity.workspaceId,
      subjectId: raw.subject || identity.principalId,
      worldId: raw.world || 'real',
      revision: raw.revision || 1,
      predicate: raw.predicate,
      value: raw.value?.type ? raw.value : val(raw.value, raw.predicate),
      text,
      kind: raw.kind || 'explicit_fact',
      strength: raw.strength || 'soft',
      conditions: raw.conditions || always,
      exceptionIds: [],
      temporal: {
        recordedFrom: this.f.clock.now(),
        precision: 'instant',
        validFrom: raw.validFrom,
        validTo: raw.validTo,
      },
      status: raw.status || 'active',
      evidenceIds: [e.id],
      label: { ...personalLabel },
      verification: 'verified',
    };
    this.f.repo.saveAssertion(s, assertion, undefined, [
      { eventId: e.id, start: 0, end: Array.from(text).length },
    ]);
    return assertion;
  }
  private ensureGoal(id: string) {
    return (
      this.f.repo.work(this.f.scope(), 'goal').find((g) => g.id === id) ||
      this.f.store.runtime.work.create(this.f.scope(), 'goal', '合成目标', {}, { id, status: 'active' })
    );
  }
  private localAction(id = randomUUID(), title = '合成本地安排', goalId?: string) {
    const s = this.f.scope();
    const action = this.f.store.runtime.actions.prepare(s, {
      id,
      capability: 'local.agenda.save',
      arguments: { title, detail: '合成可审阅内容' },
      goalId,
    });
    this.firstActionId = action.id;
    return action;
  }
  private async external(capability: string, recipient?: string) {
    this.sink ||= await new ExternalSink().start();
    this.sinkInspect = !capability.includes('no-inspect');
    this.externalName = capability;
    this.externalGrant = capability.includes('send') ? 'external:send' : 'external:book';
    this.registerExternal();
    this.f.policy.grant(this.externalGrant);
    return {
      capability,
      arguments: { title: '合成外部动作', ...(recipient ? { recipient } : {}) },
      audience: recipient || 'self',
    };
  }
  private registerExternal() {
    if (!this.sink) return;
    const b = this.f.store.runtime.broker;
    b.unregister('controlled-external-sink');
    const provider = this.sink.provider(this.sinkInspect),
      definition = provider.manifest.capabilities[0];
    definition.name = this.externalName;
    definition.requiredScopes = [this.externalGrant];
    definition.input = z.object({ title: z.string(), recipient: z.string().optional() }).strict();
    b.register(provider, { reviewed: true, source: 'local HTTP fault sink' });
  }
  private async restart() {
    this.captures.push(...this.client.requests);
    this.client.requests.length = 0;
    this.f = this.f.restart();
    this.installScriptedProviders();
    this.registerExternal();
    this.harness = this.makeHarness();
  }
  async step(step: any) {
    const r = this.f.store.runtime;
    switch (step.op) {
      case 'user_turn':
        return this.userTurn(step.text);
      case 'user_turn_long':
        return this.userTurn(step.prefix_repeat.repeat(step.repeat_count) + step.tail);
      case 'assistant_message':
        return this.seedHistory(step.id, step.text, 'assistant');
      case 'attach':
        this.controls.attachment = { id: step.artifact_id, name: step.artifact_id + '.txt', text: step.text };
        return;
      case 'checkpoint':
        this.snapshots.set(step.name, structuredClone(await this.diagnostics()));
        return;
      case 'advance_clock':
        this.f.clock.set(step.to);
        return;
      case 'set_clock':
        this.f.clock.set(step.now);
        this.controls.timeZone = step.interpretation_timezone;
        return;
      case 'set_budget':
        this.controls.budget = { maxTokens: step.max_context_tokens };
        return;
      case 'pause_workers':
        this.f.memory.paused = true;
        return;
      case 'seed_event_sequences':
        for (const seq of step.sequences)
          if (!this.f.repo.db.prepare('SELECT id FROM h_evidence WHERE seq=?').get(seq))
            this.f.ingest('合成事件 ' + seq, 'wm-' + seq);
        return;
      case 'complete_processing':
        for (const seq of step.sequences) {
          const row = this.f.repo.db.prepare('SELECT id FROM h_evidence WHERE seq=?').get(seq);
          if (!row) throw new Error('Missing sequence ' + seq);
          if (step.stage === 'extraction')
            this.f.repo.markSpans(this.f.scope(), String(row.id), 'no_personal_fact');
          else this.f.repo.indexEvidence(this.f.scope(), String(row.id));
        }
        return;
      case 'fail_processing': {
        const row = this.f.repo.db.prepare('SELECT id FROM h_evidence WHERE seq=?').get(step.sequence);
        if (!row) throw new Error('Missing sequence');
        this.f.repo.markSpans(this.f.scope(), String(row.id), 'failed');
        return;
      }
      case 'inspect_watermarks':
        return this.f.repo.watermarks();
      case 'ingest_event':
        this.f.ingest(step.text, step.event_id);
        return;
      case 'drain_workers':
        this.f.memory.paused = false;
        this.bindExtractor();
        return this.f.memory.drain();
      case 'seed_assertion':
        return this.seedAssertion(step.assertion);
      case 'parallel_proposals': {
        const source = this.f.ingest('两个合成修改提案：' + step.values.join('、'));
        await Promise.all(
          step.values.map((value: number) =>
            this.f.memory
              .propose(
                this.f.scope(),
                this.f.change(source, {
                  operation: 'CORRECT',
                  targetId: step.target_id,
                  expectedRevision: step.expected_revision,
                  value: { type: 'quantity', value, unit: 'minutes', dimension: 'duration' },
                }),
                undefined,
                { review: supported },
              )
              .catch(() => {}),
          ),
        );
        return;
      }
      case 'inject_fault':
        this.f.repo.fault = (point) => {
          if (point === step.point) throw new Error('Injected process crash point ' + point);
        };
        return;
      case 'restart':
        return this.restart();
      case 'finish_session': {
        const run = r.lastSession;
        if (run) r.finish(run);
        return;
      }
      case 'scan_persistent_artifacts': {
        this.f.repo.checkpointPrivacy();
        const walk = (dir: string): string[] =>
          fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
        this.scanOccurrences = walk(this.f.dir).filter((file) =>
          fs.readFileSync(file).includes(Buffer.from(step.canary)),
        ).length;
        return;
      }
      case 'create_profile_view': {
        const s = this.f.scope(),
          assertions = this.f.repo.assertions(s);
        const view = r.work.create(
          s,
          'experience',
          '派生理解视图',
          { summary: assertions.map((a) => a.text).join('\n') },
          { status: 'derived', evidenceIds: assertions.flatMap((a) => a.evidenceIds) },
        );
        for (const a of assertions)
          this.f.repo.addDependency(s, {
            consumerId: view.id,
            producerId: a.id,
            producerRevision: a.revision,
            sensitivity: 'privacy',
            invalidation: 'recompute',
          });
        this.f.store.saveSummary(this.sessionId, assertions.map((a) => a.text).join('\n'), assertions.length);
        return;
      }
      case 'forget': {
        const s = this.f.scope(),
          assertions = this.f.repo.assertions(s, { statuses: allStatuses }),
          ids = assertions
            .filter(
              (a) =>
                a.id === step.target ||
                a.predicate === step.target ||
                a.text.includes(step.target) ||
                JSON.stringify(a.value).includes(step.target),
            )
            .map((a) => a.id);
        const pending = [...this.pending.values()]
          .filter((p) => p.change.predicate === step.target)
          .map((p) => p.change.eventId);
        r.memory.forget(ids, ids.length ? [] : pending.length ? pending : [step.target]);
        this.forgetRequestIndex = this.allRequests().length;
        return;
      }
      case 'reprocess_old_sources':
        this.bindExtractor();
        for (const e of this.f.repo.evidenceList(this.f.scope(), 500))
          await this.f.memory.process(this.f.scope(), e.id);
        return;
      case 'search':
        this.retrieval = this.f.repo
          .searchEvidence(this.f.scope(), step.query)
          .map((e) => ({ evidence_id: e.id, text: e.text }));
        return;
      case 'seed_pending_proposal': {
        const e = this.f.ingest('合成待处理原文：' + step.value, step.id + ':source');
        this.pending.set(step.id, {
          scope: this.f.scope(),
          change: this.f.change(e, {
            predicate: step.predicate,
            value: val(step.value),
            kind: 'explicit_fact',
          }),
        });
        return;
      }
      case 'commit_pending_proposal': {
        const pending = this.pending.get(step.id);
        if (!pending) throw new Error('Missing pending proposal');
        await this.f.memory
          .propose(pending.scope, pending.change, undefined, { review: supported })
          .catch(() => {});
        return;
      }
      case 'backup': {
        const file = path.join(this.f.dir, step.id + '.backup.sqlite');
        this.f.repo.db.prepare('VACUUM INTO ?').run(file);
        this.backups.set(step.id, file);
        return;
      }
      case 'restore_isolated_backup': {
        const backup = this.backups.get(step.id);
        if (!backup) throw new Error('Missing backup');
        this.f.close();
        fs.copyFileSync(backup, this.f.file);
        this.f = new Fixture(this.f.dir, this.f.clock);
        this.installScriptedProviders();
        this.harness = this.makeHarness();
        return;
      }
      case 'activate_restored_store':
        return this.f.repo.getMeta('restoration_fence_applied');
      case 'deactivate': {
        const a = this.f.repo
          .assertions(this.f.scope())
          .find((a) => a.id === step.target || a.predicate === step.target);
        if (!a) throw new Error('Missing deactivate target');
        r.memory.deactivate(a.id);
        return;
      }
      case 'seed_evidence': {
        const e = this.f.ingest(step.text, step.id);
        if (step.extract !== false) {
          this.bindExtractor();
          await this.f.memory.process(this.f.scope(), e.id);
        }
        return;
      }
      case 'seed_entities':
        this.seedEntities(step.entities);
        return;
      case 'set_tool_result': {
        this.toolFixtures.set(step.capability, step.result);
        const capability = step.capability === 'weather' ? 'weather.lookup' : step.capability === 'location' ? 'map.location_status' : step.capability.startsWith('campus.') ? 'campus.lookup' : step.capability;
        if (r.broker.describe(capability)?.effect === 'read') this.client.injected.push({ name: 'look_up', args: { source: 'capability', capability, arguments: capability === 'campus.lookup' ? { domain: step.capability.slice(7) } : {} } });
        return;
      }
      case 'seed_many_hard_constraints':
        for (let i = 0; i < step.count; i++)
          await this.seedAssertion({
            predicate: 'constraint.hard_' + i,
            value: '合成硬限制 ' + i + ' ' + '条件'.repeat(30),
            strength: 'hard',
          });
        return;
      case 'inject_candidate':
        this.injectedCandidates.push({
          ...step.candidate,
          title: step.candidate.id,
          needs: [],
          dependencies: [],
          resourceCapabilities: [],
          preservesUnstructuredTime: false,
          rationale: '受控模型候选',
        });
        return;
      case 'continue_run': {
        let run = r.lastSession;
        if (!run) {
          run = r.begin(
            '继续核对已提出的调用',
            randomUUID(),
            this.sessionId,
            new AbortController().signal,
            this.controls,
          );
          await r.compile(run);
        }
        for (const candidate of this.injectedCandidates.splice(0)) {
          await r
            .executeTool(run, 'update_work_state', { operation: 'propose_plan', candidate }, noCallbacks)
            .catch((error) => this.toolResults.push({ error: String(error) }));
        }
        while (this.client.injected.length) {
          const call = this.client.injected.shift()!;
          const registry = new ToolRegistry({
            store: this.f.store,
            signal: run.signal,
            userText: run.ingress.authoredText,
            currentUserId: run.events[0].id,
            child: false,
            runtimeSession: run,
            ...noCallbacks,
          });
          this.toolResults.push(JSON.parse(await registry.execute(call.name, JSON.stringify(call.args))));
        }
        return;
      }
      case 'domain_delta':
        return this.applyDelta(step);
      case 'domain_update':
        return this.applyDelta({
          domain: step.domain === 'course' ? 'schedule' : step.domain,
          completeness: 'partial',
          upserts: [{ id: step.record_id, ...(step.ends_at ? { endsAt: step.ends_at } : {}) }],
          tombstones: [],
        });
      case 'read_domain':
        this.lastReadDomain = step.domain;
        return r.domains.read(this.f.scope(), step.domain, { institutionId: 'test:A', termId: '2026-fall' });
      case 'seed_domain_conflict':
        for (const record of step.records)
          await this.applyDelta({
            domain: 'schedule',
            source: record.source,
            completeness: 'partial',
            upserts: [{ id: step.record_id, ...record }],
            tombstones: [],
          });
        return;
      case 'seed_verified_notice': {
        const source = 'notice:synthetic';
        this.f.policy.registerSource(source);
        const s = this.f.scope();
        r.observations.ingest(
          s,
          {
            id: step.id,
            sourceId: source,
            kind: 'notice',
            version: 1,
            locator: {
              kind: 'structured',
              snapshotId: step.id,
              jsonPointer: '/change',
              sourceRecordId: step.occurrence_id,
            },
            text: JSON.stringify(step.change),
            label: personalLabel,
            quality: 'verified',
            data: { occurrenceId: step.occurrence_id },
          },
          { verifiedSource: true },
        );
        r.observations.reviewNotice(
          s,
          step.id,
          {
            domain: 'schedule',
            recordId: step.occurrence_id,
            institutionId: 'test:A',
            termId: '2026-fall',
            value: { ...step.change, occurrence_id: step.occurrence_id },
          },
          { verified: true },
        );
        return;
      }
      case 'complete_local_action': {
        const a = this.localAction(step.id, '合成本地跑步');
        const s = this.f.scope(),
          approval = r.actions.approve(s, a.id, a.digest, a.revision);
        await r.actions.execute(s, a.id, approval.id);
        this.f.store.writeAgendaProjection({
          ...this.f.store.agenda().find((x) => x.id === a.id)!,
          done: true,
        });
        r.reminders.cancel(a.id);
        return;
      }
      case 'approve_local_plan': {
        const offered = this.f.store
          .messages(this.sessionId)
          .flatMap((m) => m.actions)
          .at(-1);
        if (!offered) throw new Error('No actual offered draft');
        return r.acceptLocal(offered);
      }
      case 'seed_action':
        return this.localAction(step.id);
      case 'seed_approved_action': {
        const input = await this.external(step.capability, step.recipient),
          a = r.actions.prepare(this.f.scope(), { ...input, id: step.id });
        r.actions.approve(this.f.scope(), a.id, a.digest, a.revision);
        this.firstActionId = a.id;
        return;
      }
      case 'execute': {
        const approval = this.latestApproval(step.action_id);
        await r.actions
          .execute(this.f.scope(), step.action_id, approval.id)
          .catch((error) => this.toolResults.push({ error: String(error) }));
        return;
      }
      case 'parallel_approve': {
        const a = r.actions.get(this.f.scope(), step.action_id)!;
        await Promise.all(
          Array.from({ length: step.clicks }, () => {
            const s = this.f.scope(),
              approval = r.actions.approve(s, a.id, a.digest, a.revision);
            return r.actions.execute(s, a.id, approval.id);
          }),
        );
        return;
      }
      case 'mutate_action': {
        const a = r.actions.get(this.f.scope(), step.id)!;
        return r.actions.revise(
          this.f.scope(),
          a.id,
          a.revision,
          { ...a.arguments, recipient: step.recipient },
          step.recipient,
        );
      }
      case 'sink_fault':
        if (!this.sink) throw new Error('No sink');
        this.sink.mode = step.mode;
        return;
      case 'reconcile':
        return r.actions.reconcile(this.f.scope(), step.action_id);
      case 'pause_at': {
        if (!this.firstActionId) throw new Error('No approved action');
        let release!: () => void;
        r.actions.beforeDispatch = () =>
          new Promise<void>((resolve) => {
            release = resolve;
          });
        const id = this.firstActionId,
          approval = this.latestApproval(id);
        const done = r.actions.execute(this.f.scope(), id, approval.id).catch(() => {});
        this.pausedDispatch = { release: () => release(), done };
        return;
      }
      case 'resume':
        if (this.pausedDispatch) {
          this.pausedDispatch.release();
          await this.pausedDispatch.done;
        }
        return;
      case 'revoke_scope':
        this.f.policy.revoke(step.scope);
        return;
      case 'seed_goal': {
        const goal = this.ensureGoal(step.id);
        for (const id of step.prepared_actions || []) this.localAction(id, '合成准备', goal.id);
        for (const id of step.watches || [])
          r.reminders.schedule(
            { id, title: '合成目标提醒', detail: '', startsAt: '2026-09-15T06:00:00Z' },
            goal.id,
          );
        return;
      }
      case 'cancel_goal':
        return r.work.cancelGoal(this.f.scope(), step.id);
      case 'set_attention_policy':
        r.reminders.configure({ enabled: true, quietWindows: [step.quiet_window] });
        return;
      case 'seed_due_notifications': {
        this.ensureGoal(step.goal_id);
        r.reminders.configure({ enabled: true });
        this.installDelivery();
        for (let i = 0; i < step.count; i++)
          r.reminders.schedule(
            { id: step.id + '-' + i, title: '合成提醒', detail: '', startsAt: this.f.clock.now() },
            step.goal_id,
          );
        return;
      }
      case 'set_delivery_capabilities':
        this.installDelivery(step.supports_delivered, step.supports_seen);
        return;
      case 'run_due_jobs':
        return r.reminders.runDue();
      case 'resume_application':
        r.reminders.recover();
        return;
      case 'close_application':
        this.appClosed = true;
        return;
      case 'seed_private_calendar':
        return this.applyDelta({
          domain: 'schedule',
          completeness: 'partial',
          upserts: [{ id: step.id, title: step.title, startsAt: step.busy[0], endsAt: step.busy[1] }],
        });
      case 'seed_group_proposal': {
        const s = this.f.scope(),
          record = r.work.create(
            s,
            'commitment',
            '合成共同约定',
            { participants: step.participants, confirmations: {} },
            { id: step.id, status: 'proposed' },
          );
        for (const participant of step.confirmed) {
          const e = this.f.ingest('合成参与者 ' + participant + ' 明确确认', step.id + ':' + participant);
          r.work.participation(s, record.id, participant, 'confirmed', e.id);
        }
        return;
      }
      case 'seed_group_task':
        return r.work.create(
          this.f.scope(),
          'task',
          '合成共同材料',
          { owner: step.owner, acceptedForSubmission: step.accepted_for_submission },
          { id: step.id, status: step.status },
        );
      case 'seed_experience':
        return r.work.create(
          this.f.scope(),
          'experience',
          '未核验经验',
          { text: step.text, trusted: step.trusted },
          { id: step.id, status: 'candidate' },
        );
      case 'propose_tool_call':
        this.client.injected.push({ name: step.name, args: step.arguments });
        return;
      case 'seed_learning_observation':
        return this.seedObservation(step.id, 'learning', {
          taskRef: step.task,
          skillRefs: [],
          assistance: step.assistance,
          exposedRefs: [],
          independentSteps: step.independent_steps,
          comparability: 'unknown',
          occurredAt: this.f.clock.now(),
        });
      case 'seed_learning_task': {
        this.f.policy.registerSource('learning:private');
        const s = this.f.policy.hostScope({ sources: ['learning:private'], purposes: ['tutoring_private'] });
        this.f.repo.ingest(s, {
          id: step.task + ':answer',
          ownerId: this.f.repo.identity.principalId,
          workspaceId: this.f.repo.identity.workspaceId,
          subjectId: this.f.repo.identity.principalId,
          worldId: 'real',
          sourceId: 'learning:private',
          contentVersion: 1,
          text: step.private_answer,
          speaker: 'external',
          kind: 'file_import',
          authority: 'quotation',
          roots: [step.task],
          label: { ...personalLabel, purpose: 'tutoring_private', infer: false },
          receivedAt: this.f.clock.now(),
          status: 'active',
        });
        return;
      }
      case 'seed_rejected_option':
        return r.work.create(
          this.f.scope(),
          'option',
          '合成候选 ' + step.id,
          {
            rejection: {
              reason: step.reason,
              permanent: step.valid_when.scope === 'until_user_changes',
              validWhen: step.valid_when.capability
                ? {
                    op: 'compare',
                    predicate: 'capability:' + step.valid_when.capability,
                    comparator: 'eq',
                    value: { type: 'boolean', value: step.valid_when.available },
                  }
                : always,
            },
            rejectionStillApplicable: true,
          },
          { id: step.id, status: 'rejected' },
        );
      case 'register_extension':
        return this.registerExtension(step);
      case 'invoke_extension': {
        const result = await r.broker.invoke(
          this.f.scope(),
          step.capability || 'project-compute',
          {},
          new AbortController().signal,
        );
        this.toolResults.push(result);
        return;
      }
      case 'seed_option_windows':
        for (const option of step.options)
          r.work.create(
            this.f.scope(),
            'window',
            option.id,
            { optionId: option.id, deadline: option.deadline, sharedPrep: option.shared_prep },
            { id: option.id, status: 'open' },
          );
        return;
      case 'seed_recommendation':
        return this.seedObservation(step.id, 'feedback', {
          recommendationId: step.id,
          exposure: 'shown',
          response: step.accepted ? 'accepted' : 'not_observed',
          missingness: step.outcome,
          contextRevision: 1,
        });
      case 'seed_rule_packs':
        for (const pack of step.packs) {
          const source = 'rules:synthetic';
          this.f.policy.registerSource(source);
          r.rulePacks.register(
            this.f.scope(),
            {
              id: pack.institution + ':' + pack.term,
              institutionId: pack.institution,
              termId: pack.term,
              cohortScope: ['synthetic'],
              validFrom: '2026-01-01T00:00:00Z',
              validTo: '2027-01-01T00:00:00Z',
              sourceId: source,
              sourceRevision: '1',
              rules: [
                { id: 'requirement', predicate: 'sports.required', value: { requirement: pack.requirement } },
              ],
            },
            { approved: true },
          );
        }
        return;
      case 'save_offline_operation':
        this.offline.push({
          deviceId: step.device,
          operationId: step.id,
          objectId: step.goal,
          baseRevision: step.base_revision,
          policyEpoch: step.privacy_epoch,
          causalReferences: [],
          createdAt: this.f.clock.now(),
          delta: { operation: 'edit_work', status: 'active' },
        });
        return;
      case 'advance_privacy_epoch':
        this.f.repo.establishFence({
          kind: 'revoke',
          scope: 'synthetic:epoch',
          objectIds: [],
          sourceIds: [],
        });
        return;
      case 'replay_offline_operations':
        for (const op of this.offline)
          r.sync.submit(this.f.scope(), r.sync.registerTrustedDevice(op.deviceId, false), op);
        return;
      case 'seed_provider_state': {
        this.protocolCanary = step.content;
        const client = new DeepSeekClient(
          'synthetic',
          'deepseek-flash',
          (async () =>
            new Response(
              'data: ' +
                JSON.stringify({
                  choices: [
                    {
                      delta: {
                        reasoning_content: step.content,
                        tool_calls: [
                          { index: 0, id: 'seeded-call', function: { name: 'read', arguments: '{}' } },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                }) +
                '\n\ndata: [DONE]\n\n',
            )) as typeof fetch,
        );
        const contract = this.f.policy.ingress(
          '受控协议状态',
          'seed-protocol',
          this.f.store.settings(),
        ).contract;
        r.bindModel(contract, client);
        const completion = await client.complete(
          [{ role: 'user', content: '受控协议状态' }],
          [
            {
              type: 'function',
              function: {
                name: 'read',
                description: 'synthetic',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          new AbortController().signal,
          undefined,
          { thinking: 'enabled' },
        );
        if (client.assistantMessage(completion).reasoning_content !== step.content)
          throw new Error('Protocol fixture did not establish opaque state');
        this.seededProtocol = { client, completion };
        return;
      }
      case 'seed_episode':
        return r.work.create(
          this.f.scope(),
          'episode',
          '合成未完成事项',
          { sessionId: this.sessionId, nextSmallQuestion: step.next_question, optionIds: [] },
          { id: step.id, status: 'active' },
        );
      case 'narrow_contract':
        this.controls.sources = step.allowed_sources;
        return;
      case 'switch_provider':
        this.captures.push(...this.client.requests);
        this.client = new ScriptedSemanticClient(this.entities);
        this.providerVersion = step.to;
        this.harness = this.makeHarness();
        return;
      case 'paired_replay':
        return this.pair(step);
      case 'seed_restricted_observation': {
        const source = 'health:self';
        this.f.policy.registerSource(source);
        r.observations.ingest(this.f.scope(), {
          id: step.id,
          sourceId: source,
          kind: 'wellness',
          version: 1,
          locator: {
            kind: 'structured',
            snapshotId: 'synthetic-device',
            jsonPointer: '/sample',
            sourceRecordId: step.id,
          },
          text: step.content,
          label: { ...personalLabel, sensitivity: 'restricted' },
          quality: 'unverified',
          data: {
            measureType: 'synthetic',
            sourceDevice: 'synthetic-device',
            observationWindow: [
              this.f.clock.now(),
              new Date(Date.parse(this.f.clock.now()) + 3600000).toISOString(),
            ],
            quality: 'missing',
          },
        });
        return;
      }
      case 'seed_private_note': {
        const source = 'note:private';
        this.f.policy.registerSource(source);
        const s = this.f.policy.hostScope({ sources: [source], purposes: [step.purpose] });
        this.f.repo.ingest(s, {
          id: step.id,
          ownerId: this.f.repo.identity.principalId,
          workspaceId: this.f.repo.identity.workspaceId,
          subjectId: this.f.repo.identity.principalId,
          worldId: 'real',
          sourceId: source,
          contentVersion: 1,
          text: step.text,
          speaker: 'user',
          kind: 'user_message',
          authority: 'user_statement',
          roots: [step.id],
          label: { ...personalLabel, purpose: step.purpose, infer: false },
          receivedAt: this.f.clock.now(),
          status: 'active',
        });
        return;
      }
      case 'seed_secret':
        this.f.store.putMeta('synthetic_secret', step.value);
        return;
      case 'request_export':
        this.exportResult = this.f.store.export();
        return;
      case 'provider_fault':
        this.client.fail = true;
        return;
      case 'open_map': {
        const out = path.join(
          process.env.ZAICHANG_CASE_REPORT || 'artifacts/harness/scenario-details',
          'native-map-' + randomUUID(),
        );
        const run = spawnSync(
          process.execPath,
          ['tests/harness/desktop-entry.mjs', '--report-dir', out, '--model-failure'],
          { encoding: 'utf8', env: process.env, windowsHide: true, timeout: 45000 },
        );
        if (run.status !== 0)
          throw new Error('Actual Electron map-after-model-failure test failed: ' + run.stderr.slice(-1000));
        this.mapOpened =
          JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).ui.map_opened === true;
        return;
      }
      case 'provider_script':
        return this.installProtocolScript(step.opaque_text);
      case 'start_readonly_delegate':
        return this.startDelegate(step);
      case 'cancel_parent_run':
        this.stopped = this.harness.stop();
        return;
      case 'release_source':
        this.releaseChild?.();
        await this.stopped;
        return;
      case 'derive_restatements': {
        const root = this.f.repo.evidence(this.f.scope(), step.root_id)!;
        for (let i = 0; i < step.count; i++)
          this.f.ingest(root.text, 'restatement:' + i, {
            speaker: 'assistant',
            authority: 'model_derivative',
            roots: root.roots,
          });
        return;
      }
      case 'seed_media_options': {
        const episode = r.work.episode(this.f.scope(), this.sessionId, '合成媒体选项', [])!;
        r.work.addOptions(
          this.f.scope(),
          episode.id,
          step.options.map((o: any) => ({
            id: o.id,
            title: o.id,
            data: { artifactId: step.artifact_id, artifactVersion: step.version, region: o.region },
          })),
          step.options.map((o: any) => o.id),
        );
        return;
      }
      case 'seed_options': {
        const episode = r.work.episode(this.f.scope(), this.sessionId, '合成待选方案', [])!;
        r.work.addOptions(
          this.f.scope(),
          episode.id,
          step.options.map((o: any) => ({ id: o.id, title: o.summary, data: { effect: o.effect } })),
        );
        return;
      }
      case 'reorder_options': {
        const episode = this.f.repo
          .work(this.f.scope(), 'episode')
          .find((e) => (e.data.optionIds as any[])?.length)!;
        r.work.update(this.f.scope(), episode.id, episode.revision, {
          data: { ...episode.data, optionIds: step.order },
        });
        return;
      }
      case 'seed_scenario':
        return r.work.createWorld(this.f.scope(), step.id, step.assumptions || {});
      case 'seed_audio_transcript':
        this.f.policy.registerSource('media:synthetic');
        return r.observations.ingest(this.f.scope(), {
          id: step.artifact_id,
          sourceId: 'media:synthetic',
          kind: 'media',
          version: step.version,
          locator: {
            kind: 'audio',
            artifactId: step.artifact_id,
            version: step.version,
            startMs: step.segment_ms[0],
            endMs: step.segment_ms[1],
            transcriptVersion: step.version,
          },
          text: step.text,
          label: personalLabel,
          quality: 'unverified',
          data: {},
        });
      case 'correct_transcript':
        return r.observations.correctTranscript(this.f.scope(), step.artifact_id, step.version, step.text);
      case 'propose_assertion': {
        const a = step.assertion,
          e = this.f.repo.evidence(this.f.scope(), a.evidence_id)!;
        this.pending.set('verify', {
          scope: this.f.scope(),
          change: this.f.change(e, { predicate: a.predicate, value: val(a.value) }),
        });
        return;
      }
      case 'verify_and_commit': {
        const p = this.pending.get('verify')!;
        const source = this.f.repo.evidence(p.scope, p.change.eventId)!;
        const supportedByFixture = scriptedExtraction({ event: source, clock: { now: this.f.clock.now(), timeZone: this.controls.timeZone || 'Asia/Shanghai' } }, this.entities).changes.some(change => change.predicate === p.change.predicate);
        await this.f.memory.propose(p.scope, p.change, undefined, { review: { ...supported, supported: supportedByFixture, reason: 'Offline semantic fixture independently rejects a candidate not supported by its source. No real-model accuracy claim.' } }).catch(() => {});
        return;
      }
      case 'seed_legacy_store':
        return this.legacy(step);
      case 'migrate':
        this.f = new Fixture(this.f.dir, this.f.clock);
        this.installScriptedProviders();
        this.harness = this.makeHarness();
        return;
      case 'delete_source_only':
        return r.memory.forget([], [step.source_id]);
      case 'rebuild_derived_views':
        return this.step({ op: 'create_profile_view' });
      case 'seed_recipe_candidate':
        this.recipeCandidates.set(step.id, {
          id: step.id,
          version: '1',
          triggers: ['synthetic'],
          needs: [],
          capabilities: [step.requests_scope],
          status: 'candidate',
        });
        return;
      case 'try_activate_recipe':
        try {
          r.broker.registerRecipe(this.recipeCandidates.get(step.id), { approved: false, reviewer: '' });
        } catch (error) {
          this.toolResults.push({ error: String(error) });
        }
        return;
      case 'rollback_recipe': {
        this.rollbackEpoch = this.f.repo.epoch;
        if (!r.broker.recipeList().some((recipe) => recipe.id === step.to))
          r.broker.registerRecipe(
            { id: step.to, version: '1', status: 'reviewed', triggers: [], capabilities: [], needs: [] },
            { approved: true, reviewer: 'controlled baseline' },
          );
        r.broker.rollbackRecipe(step.to, '1');
        return;
      }
      default:
        throw new Error('Unimplemented acceptance operation: ' + step.op);
    }
  }
  private latestApproval(id: string) {
    const row = this.f.repo.db
      .prepare('SELECT payload FROM h_approvals WHERE action_id=? ORDER BY rowid DESC LIMIT 1')
      .get(id);
    if (!row) throw new Error('Missing actual approval');
    return JSON.parse(String(row.payload));
  }
  private async applyDelta(step: any) {
    const source = step.source || 'campus:local';
    this.f.policy.registerSource(source);
    const e = this.f.ingest(JSON.stringify(step.upserts || []), 'delta:' + randomUUID(), {
      speaker: 'external',
      kind: 'external_observation',
      authority: 'source_record',
      sourceId: source,
      label: { ...personalLabel, infer: false },
    });
    return this.f.store.runtime.domains.apply(this.f.scope(), {
      sourceId: source,
      domain: step.domain,
      institutionId: 'test:A',
      termId: '2026-fall',
      scopeKeys: ['all'],
      completeness: step.completeness || 'partial',
      upserts: (step.upserts || []).map((v: any) => ({ recordId: v.id, value: v, evidenceId: e.id })),
      tombstones: step.tombstones || [],
      fetchedAt: this.f.clock.now(),
      errors: [],
    });
  }
  private installDelivery(delivered = false, seen = false) {
    this.f.store.runtime.reminders.port = {
      capabilities: { submitted: true, delivered, seen, stableId: false, closedApp: false },
      submit: async () => ({ status: 'submitted_to_os' }),
    };
  }
  private seedObservation(id: string, kind: 'learning' | 'feedback', data: any) {
    const source = 'observation:synthetic';
    this.f.policy.registerSource(source);
    return this.f.store.runtime.observations.ingest(this.f.scope(), {
      id,
      sourceId: source,
      kind,
      version: 1,
      locator: { kind: 'structured', snapshotId: id, jsonPointer: '/observation', sourceRecordId: id },
      text: '合成' + kind + '观察',
      label: personalLabel,
      quality: 'unverified',
      data,
    });
  }
  private registerExtension(step: any) {
    const capability = step.capability || 'project-compute',
      malicious = step.attempted_effect === 'external_write',
      sourceId = 'extension:' + step.id;
    const provider: CapabilityProvider = {
      manifest: {
        id: step.id,
        version: '1',
        trust: malicious ? 'untrusted_disabled' : 'bundled_reviewed',
        sourceId,
        capabilities: [
          {
            name: capability,
            version: '1',
            input: z.object({}).strict(),
            output: z.object({ available: z.boolean(), affordances: z.array(z.string()) }).strict(),
            effect: 'read',
            requiredScopes: ['device:read'],
            subjects: ['self'],
            worlds: ['real', 'scenario'],
            timeoutMs: 1000,
            maxBytes: 4000,
            supportsIdempotency: false,
            supportsInspect: false,
            supportsCancel: false,
          },
        ],
        egressHosts: [],
        platforms: ['*'],
        simulated: true,
        offline: 'unsupported',
        license: 'synthetic extension',
      },
      invoke: () => ({
        status: 'fresh',
        sourceId,
        data: { available: step.available === true, affordances: step.available ? [capability] : [] },
        simulated: true,
      }),
    };
    try {
      this.f.store.runtime.broker.register(provider, { reviewed: !malicious, source: 'controlled fixture' });
      this.f.policy.grant('device:read');
      this.f.store.runtime.broker.registerRecipe(
        {
          id: 'recipe:' + step.id,
          version: '1',
          triggers: ['借到', '新设备'],
          status: 'reviewed',
          capabilities: [capability],
          needs: [
            {
              id: 'need:' + capability,
              key: 'resource.' + capability,
              importance: 'must',
              capability,
              args: {},
              condition: always,
              mode: 'all',
              childIds: [],
            },
          ],
        },
        { approved: true, reviewer: 'controlled fixture' },
      );
      this.client.injected.push({ name: 'look_up', args: { source: 'capability', capability, arguments: {} } });
    } catch (error) {
      this.toolResults.push({ error: String(error), code: 'unreviewed_provider' });
    }
  }
  private async pair(step: any) {
    const snapshots = [];
    for (let index = 0; index < 2; index++) {
      const fixture = new ScenarioFixture({ history: [] }, this.fixtureCatalog);
      try {
        await fixture.initialize();
        if (step.change.private_preference) {
          await fixture.seedAssertion({
            predicate: 'private.unrelated',
            value: index ? 'different' : 'original',
          });
          fixture.controls.attachment = {
            id: 'current-file',
            name: '当前附件',
            text: '仅介绍打印开放时间。',
          };
        }
        if (step.change.today_transport) {
          const date = dayBounds(dateInZone(fixture.f.clock.now(), 'Asia/Shanghai'), 'Asia/Shanghai');
          await fixture.seedAssertion({
            predicate: 'transport.current',
            value: step.change.today_transport[index],
            kind: 'current_state',
            validFrom: date.from,
            validTo: date.to,
          });
        }
        await fixture.userTurn(step.request);
        const pack = fixture.f.store.runtime.lastSession!.pack!;
        snapshots.push({
          sources: [...new Set(fixture.f.repo.access.map((a) => a.source))].sort(),
          actions: fixture.f.store.agenda().map((a) => ({ title: a.title, detail: a.detail })),
          transport: pack.assertions.find((a) => a.predicate === 'transport.current')?.value,
          violations: fixture.f.repo
            .work(fixture.f.scope(), 'plan')
            .flatMap((p) => (p.data.violations as any[]) || []),
        });
      } finally {
        await fixture.close();
      }
    }
    this.paired = {
      snapshots,
      noninterference: {
        source_set_equal: JSON.stringify(snapshots[0].sources) === JSON.stringify(snapshots[1].sources),
        action_set_equal: JSON.stringify(snapshots[0].actions) === JSON.stringify(snapshots[1].actions),
      },
      personalization: {
        transport_applied_correctly: step.change.today_transport
          ? snapshots.every((s, i) => (s.transport as any)?.value === step.change.today_transport[i])
          : false,
        constraints_preserved: snapshots.every((s) => s.violations.length === 0),
      },
    };
  }
  private installProtocolScript(opaque: string) {
    const self = this;
    let rootRound = 0;
    const client = new DeepSeekClient('synthetic', 'deepseek-flash', (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      self.captures.push(structuredClone(payload.messages));
      let content = '',
        tool: any;
      if (payload.messages[0].content.includes('[harness:extract'))
        content = JSON.stringify({ status: 'no_personal_fact', changes: [] });
      else if (++rootRound === 1)
        tool = {
          index: 0,
          id: 'opaque-tool',
          type: 'function',
          function: { name: 'look_up', arguments: JSON.stringify({ source: 'history', query: '测试资料' }) },
        };
      else {
        content = '受控协议回复。';
        self.protocolRoundtrip = payload.messages.some(
          (m: any) => m.role === 'assistant' && m.reasoning_content === opaque,
        );
      }
      const values = [
        {
          choices: [
            {
              delta: { reasoning_content: opaque, ...(tool ? { tool_calls: [tool] } : { content }) },
              finish_reason: tool ? 'tool_calls' : 'stop',
            },
          ],
        },
      ];
      return new Response(
        values.map((v) => 'data: ' + JSON.stringify(v) + '\n\n').join('') + 'data: [DONE]\n\n',
      );
    }) as typeof fetch);
    const complete = client.complete.bind(client);
    client.complete = (messages, tools, signal, onText, options) =>
      complete(messages, tools, signal, onText, { ...options, thinking: 'enabled' });
    this.harness = new Harness(
      this.f.store,
      () => 'synthetic',
      (e) => this.events.push(structuredClone(e)),
      () => withHostReplies(client),
    );
  }
  private async startDelegate(step: any) {
    const original = this.client.complete.bind(this.client),
      self = this;
    this.client.complete = async (messages, tools, signal, onText) => {
      if (messages[0]?.content?.includes('这是独立只读取证任务')) {
        self.activeDelegates++;
        try {
          await new Promise<void>((resolve, reject) => {
            self.releaseChild = resolve;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return { content: '受控只读子任务返回。', tool_calls: [] };
        } finally {
          self.activeDelegates--;
        }
      }
      return original(messages, tools, signal, onText);
    };
    this.client.injected.push({
      name: 'delegate',
      args: { tasks: [{ title: '只读测试', instruction: step.blocked_on }] },
    });
    this.harness.start(this.sessionId, '进行一个受控只读调查。');
    for (let i = 0; i < 400 && this.activeDelegates === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (!this.activeDelegates) throw new Error('Delegate did not start');
  }
  private legacy(step: any) {
    this.f.close();
    const dir = testDirectory('legacy-case'),
      file = path.join(dir, 'test.sqlite'),
      db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE memories(id TEXT PRIMARY KEY,text TEXT NOT NULL,quote TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',summary_count INTEGER NOT NULL DEFAULT 0); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);",
    );
    for (const memory of step.memories)
      db.prepare('INSERT INTO memories VALUES(?,?,?,?)').run(
        randomUUID(),
        memory.text,
        memory.quote,
        memory.createdAt,
      );
    db.close();
    this.f.dir = dir;
    this.f.file = file;
  }
  private allRequests() {
    return [...this.captures, ...this.client.requests];
  }
  async diagnostics(): Promise<any> {
    this.captureTools();
    const f = this.f,
      r = f.store.runtime,
      accessSnapshot = [...f.repo.access],
      s = f.scope(),
      pack = r.lastSession?.pack,
      now = Date.parse(f.clock.now());
    const assertions = f.repo.assertions(s, { statuses: allStatuses, limit: 500 }),
      active = assertions.filter(
        (a) =>
          a.status === 'active' &&
          (!a.temporal.validFrom || Date.parse(a.temporal.validFrom) <= now) &&
          (!a.temporal.validTo || Date.parse(a.temporal.validTo) > now),
      );
    const project = (a: Assertion) => ({
      id: a.id,
      predicate: a.predicate,
      value: 'value' in a.value ? a.value.value : undefined,
      ...(a.value.type === 'quantity' ? { unit: a.value.unit } : {}),
      subject: a.subjectId,
      world: a.worldId,
      status: a.status,
      verification: a.verification,
      condition:
        a.conditions.op === 'compare' && 'value' in a.conditions.value ? a.conditions.value.value : undefined,
      valid_date: a.temporal.validFrom ? dateInZone(a.temporal.validFrom, 'Asia/Shanghai') : undefined,
    });
    const work = f.repo.work(s),
      plans = work.filter((w) => w.kind === 'plan'),
      options = work.filter((w) => w.kind === 'option'),
      actions = r.actions.list(s),
      attempts = f.repo.db.prepare('SELECT * FROM h_attempts').all(),
      receipts = actions.flatMap((a) => r.actions.receipts(s, a.id));
    const currentFacts = (pack?.data.currentFacts as Record<string, TypedValue>) || {},
      current = Object.entries(currentFacts).map(([predicate, value]) => ({
        predicate,
        value: 'value' in value ? value.value : undefined,
        valid_date: pack ? dateInZone(pack.contract.now, pack.contract.timeZone) : undefined,
      }));
    const contextAssertions = (pack?.assertions || []).map(project),
      contextFacts = [...contextAssertions, ...current];
    const candidates = [
      ...plans.map((p) => ({
        id: p.id,
        ...p.data,
        feasibility: p.status,
        preserves_unstructured_time: p.data.preservesUnstructuredTime,
        dependencies_complete: Array.isArray(p.data.unresolvedNeeds) && p.data.unresolvedNeeds.length === 0,
      })),
      ...options.map((p) => ({
        id: p.id,
        ...p.data,
        rejection_still_applicable: p.data.rejectionStillApplicable,
        feasibility: p.status,
      })),
    ];
    const domain = (name: string) =>
      r.domains
        .read(s, name, { institutionId: 'test:A', termId: '2026-fall' })
        .map((x) => ({ id: x.id, ...x.value }));
    const conflicts = r.domains.resolve(s, 'schedule', {
      institutionId: 'test:A',
      termId: '2026-fall',
    }).conflicts;
    const sources = f.repo.evidenceList(s, 500),
      roots = new Set(
        active.flatMap((a) => a.evidenceIds.flatMap((id) => f.repo.evidence(s, id)?.roots || [])),
      );
    const messages = this.events.filter((e) => e.type === 'message').map((e) => e.message),
      latest = messages.at(-1),
      body = messages.map((m) => m.content).join('\n');
    const requests = this.allRequests(),
      tools = this.toolResults;
    const statusCodes = [
      ...new Set([
        ...(latest?.status === 'error' ? ['model_unavailable'] : []),
        ...tools.flatMap((t) => [t.reason, t.data?.reason].filter(Boolean)),
        ...(pack?.needs || []).map((n) => n.reason).filter(Boolean),
      ]),
    ];
    const watermarks = f.repo.watermarks(),
      rules = (pack?.data.institutionRules as any)?.records || [];
    const observations = r.observations.list(s, 'feedback'),
      learning = r.observations.list(s, 'learning'),
      media = r.observations.list(s, 'media');
    const group = work.find((w) => w.kind === 'commitment' && Array.isArray(w.data.participants));
    const allConfirmed = group
      ? (group.data.participants as string[]).every(
          (p) => (group.data.confirmations as any)?.[p]?.status === 'confirmed',
        )
      : false;
    const approvals = actions.map((a) => {
      let approval: any;
      try {
        approval = this.latestApproval(a.id);
      } catch {}
      return {
        ...a,
        approval_valid:
          !!approval &&
          approval.actionDigest === a.digest &&
          approval.actionRevision === a.revision &&
          approval.privacyEpoch === f.repo.epoch,
      };
    });
    let visibleTools: string[] = [];
    try { if (r.lastSession) visibleTools = r.toolSpecs(r.lastSession).map(tool => tool.function.name); } catch { /* A revoked run correctly has no usable tools. */ }
    const result = {
      currentInputBoundary: r.lastSession ? { preserved: r.lastSession.events.some(event => event.text === r.lastSession!.ingress.authoredText), semanticFragments: r.lastSession.ingress.interpretation.fragments, visibleTools } : null,
      memory: {
        active: active.map(project),
        history: assertions.map(project),
        legacy: assertions.filter((a) => a.kind === 'legacy_unverified').map(project),
        independent_root_count: roots.size,
        rejected_proposals: f.memory.rejected,
        resurrected_count: active.filter((a) => a.evidenceIds.some((id) => f.repo.hasFence(id))).length,
        late_cancelled_child_commits: Number(
          f.repo.db
            .prepare(
              "SELECT count(*) AS n FROM h_proposals WHERE status='committed' AND json_extract(payload,'$.actor')='delegate'",
            )
            .get()?.n,
        ),
      },
      context: {
        subject: pack?.contract.subjectId,
        interaction_mode: pack?.contract.interactionMode,
        exploration_mode: pack?.contract.exploration,
        facts: [
          ...contextFacts,
          ...rules.map((rule: any) => ({
            ...rule.value,
            institution: rule.institutionId,
            term: rule.termId,
          })),
        ],
        current_exceptions: [
          ...contextAssertions.filter((a) => a.predicate.includes('today_allowed')),
          ...current.filter((a) => a.predicate.includes('today_allowed')),
        ],
        applied_constraints: contextFacts,
        current_state: [
          ...contextFacts.map((a) =>
            a.predicate === 'transport.current'
              ? { transport: a.value }
              : a.predicate === 'current.energy'
                ? { energy: a.value, valid_date: a.valid_date }
                : a.predicate === 'current.accommodation'
                  ? { accommodation: a.value }
                  : {},
          ),
        ],
        current_navigation_facts: contextAssertions.filter((a) => a.predicate.startsWith('residence.')),
        evidence_ids: pack?.receipt.providedEvidenceIds || [],
        resolved_entities: ((pack?.data.resolvedEntities as any[]) || [])
          .filter((e) => e.status === 'resolved')
          .map((e) => ({ ...e, entity_id: e.entityId })),
        applied_place_names: media.flatMap((m) =>
          Object.keys(this.entities).filter((label) => m.text.includes(label)),
        ),
        need_keys: pack?.needs.map((n) => n.key) || [],
        needs: pack?.needs.map((n) => ({ key: n.key, status: n.status })) || [],
        coverage: pack?.receipt.coverage,
        resolved_dates: pack?.contract.resolvedDates || [],
        temporal_ambiguities: pack?.contract.temporalAmbiguities || [],
        allowed_purposes: pack ? [pack.contract.purpose] : [],
        protected_interaction_rules: pack?.data.protectedInteractionRules || [],
        interaction_constraints: Object.values(currentFacts)
          .filter((v) => v.type === 'text')
          .map((v) => (v as any).value),
      },
      domain: {
        schedule: domain('schedule'),
        official_sports: domain('sports')[0],
        self_reported_requirements: active
          .filter((a) => a.predicate === 'sports.user_reported_requirement')
          .map(project),
        updates: f.repo.db
          .prepare("SELECT kind AS operation FROM h_operations WHERE kind IN ('CORRECT','SUPERSEDE')")
          .all(),
        conflicts,
        sync_status: this.lastReadDomain
          ? f.repo.db
              .prepare('SELECT status FROM h_sync WHERE domain=? ORDER BY rowid DESC LIMIT 1')
              .get(this.lastReadDomain)?.status
          : f.repo.db.prepare('SELECT status FROM h_sync ORDER BY rowid DESC LIMIT 1').get()?.status,
        self_reports: active
          .filter((a) => a.predicate === 'activity.run_self_reported_done')
          .map((a) => ({
            activity: 'run',
            status: a.value.type === 'boolean' && a.value.value ? 'reported_done' : 'unknown',
          })),
        schedule_overrides: domain('schedule').filter((r: any) => r.occurrence_id),
        recurring_template: f.repo.getMeta('recurring_template'),
        approvals: domain('approvals'),
      },
      work: {
        tasks: [
          ...work.filter((w) => w.kind === 'task').map((w) => ({ id: w.id, status: w.status, ...w.data })),
          ...active.filter((a) => a.predicate.startsWith('deadline.')).map(project),
        ],
        deadlines: active
          .filter((a) => a.predicate.startsWith('deadline.'))
          .map((a) => ({
            ...project(a),
            value: a.value.type === 'instant' ? formatShanghai(a.value.value) : undefined,
          })),
        episode_ids: work.filter((w) => w.kind === 'episode').map((w) => w.id),
        unresolved_references: work
          .filter((w) => w.kind === 'episode')
          .flatMap((w) => (w.data.unresolvedReferences as any[]) || []),
        referenced_option_ids: work
          .filter((w) => w.kind === 'episode')
          .map((w) => w.data.referencedOptionId)
          .filter(Boolean),
      },
      worlds: { scenarios: r.work.worlds(s) },
      retrieval: {
        results: this.retrieval.length
          ? this.retrieval
          : [...(pack?.evidence || []), ...((pack?.data.retrievedContext as { originals?: EvidenceEvent[] } | undefined)?.originals || [])]
              .filter((e) => !r.lastSession?.events.some((current) => current.id === e.id))
              .map((e) => ({ evidence_id: e.id, text: e.text })),
      },
      planning: {
        candidates,
        executable_candidates: candidates.filter((p: any) => p.feasibility === 'verified'),
        new_plans: plans,
        criteria: pack?.data.criteria || [],
        exact_origin_routes: tools.filter(
          (t) => t.capability === 'map.route' && t.status === 'fresh' && t.data?.origin?.kind === 'current',
        ),
        exact_future_weather_claims: messages.filter(
          (m) => m.role === 'assistant' && /(?:确定|保证).{0,12}(?:可跑|天气|下雨)/.test(m.content),
        ),
        verified_food_options: candidates.filter(
          (p: any) => p.activity === 'food' && p.feasibility === 'verified',
        ),
        forced_commitments: work.filter(
          (w) =>
            w.kind === 'commitment' &&
            w.status === 'accepted' &&
            !w.evidenceIds.length &&
            !w.data.confirmations,
        ),
      },
      commitments: {
        accepted: work.filter((w) => w.kind === 'commitment' && w.status === 'accepted'),
        selected_paths: work.filter((w) => w.kind === 'option' && w.status === 'accepted'),
        group_all_confirmed: allConfirmed,
        submission_ready: work.some((w) => w.kind === 'task' && w.data.acceptedForSubmission === true),
      },
      actions: {
        records: approvals,
        dispatched: attempts,
        external_dispatched: attempts.filter((at) =>
          actions.some((a) => a.id === at.action_id && a.effect === 'external_write'),
        ),
        accepted_local: f.store.agenda(),
        logical_local_writes: f.store.agenda().length,
      },
      receipts: {
        latest: receipts.length
          ? { ...receipts.at(-1), status: receipts.at(-1)?.localStatus || receipts.at(-1)?.status }
          : {},
      },
      access: {
        read_sources: [...new Set(accessSnapshot.map((a) => a.source))],
        read_principals: [...new Set(accessSnapshot.map((a) => a.principalId))],
        unregistered_path_reads: accessSnapshot.filter((a) => a.kind === 'unregistered_path').length,
      },
      provider: {
        request_texts: requests,
        request_texts_after_forget: requests.slice(this.forgetRequestIndex),
        outbound_draft_request_texts: requests.filter((req) =>
          JSON.stringify(req).includes('outbound_draft'),
        ),
        reader_request_texts: requests,
        reused_invalid_state_count: this.protocolCanary
          ? requests.filter((req) => JSON.stringify(req).includes(this.protocolCanary!)).length +
            Number(
              !!this.seededProtocol?.client.assistantMessage(this.seededProtocol.completion)
                .reasoning_content,
            )
          : 0,
        protocol_roundtrip_valid: this.protocolRoundtrip,
      },
      policy: {
        new_grants: f.policy
          .grants()
          .filter((g) => g.startsWith('external:') || g.startsWith('share:'))
          .map((scope) => ({ scope })),
      },
      tool: {
        invocations: r.broker.invocations.map((i) => ({
          capability: i.capability,
          domain: i.capability.startsWith('campus')
            ? 'campus'
            : i.capability.includes('location')
              ? 'location'
              : undefined,
          status: i.status,
        })),
        rejections: [...r.broker.rejections, ...tools.filter((t) => t.error)],
        route_results: tools.filter((t) => t.capability === 'map.route').map((t) => t.data),
      },
      runtime: {
        watermarks: {
          received: watermarks.received,
          extracted_contiguous: watermarks.extractedContiguous,
          indexed_contiguous: watermarks.indexedContiguous,
          extraction_gaps: watermarks.extractionGaps,
        },
        duplicate_logical_writes: f.repo.db
          .prepare(
            'SELECT event_id FROM h_assertion_evidence GROUP BY assertion_id,event_id HAVING count(*)>1',
          )
          .all().length,
        version_conflicts: f.repo.conflicts,
        silent_overwrites: f.repo.db
          .prepare('SELECT id FROM h_assertion_versions GROUP BY id,revision HAVING count(*)>1')
          .all().length,
        logical_event_count: Number(
          f.repo.db
            .prepare(
              "SELECT count(*) AS n FROM h_evidence WHERE json_extract(payload,'$.kind')='user_message' AND json_extract(payload,'$.speaker')='user'",
            )
            .get()?.n,
        ),
        rejected_stale_epoch_commits: f.memory.staleCommits,
        unprocessed_spans_without_status: Number(
          f.repo.db.prepare("SELECT count(*) AS n FROM h_spans WHERE status IS NULL OR status=''").get()?.n,
        ),
        coordinator_provider_name_special_cases: Number(
          fs.readFileSync('src/main/runtime/coordinator.ts', 'utf8').includes('BorrowedDeviceProvider'),
        ),
        active_delegates: this.activeDelegates,
      },
      jobs: {
        active_goal_ids: f.repo.db
          .prepare(
            "SELECT DISTINCT goal_id FROM h_jobs WHERE status IN ('queued','leased') AND goal_id IS NOT NULL",
          )
          .all()
          .map((x) => x.goal_id),
        payloads: f.repo.db.prepare('SELECT payload FROM h_jobs').all(),
      },
      notifications: {
        submitted: r.reminders.submitted,
        records: f.repo.db.prepare('SELECT status,payload FROM h_deliveries').all(),
        catchup_summary_count: f.repo.getMeta('catchup_summary_count', 0),
      },
      experiences: {
        reasons: active
          .filter((a) => a.predicate === 'experience.explicit_reason')
          .map((a) => (a.value as any).value),
        outcomes: observations.map((o) => ({
          recommendation_id: o.data.recommendationId,
          status: o.data.missingness,
        })),
      },
      learning: {
        mastery_claims: learning.map((o) => ({
          task: o.data.taskRef,
          independent_mastery: r.observations.learningProjection(s, o.data.taskRef).mastery === 'established',
        })),
        causal_success_claims: observations.filter(
          (o) => r.observations.feedbackProjection(s, o.id).causalSuccess === 'established',
        ),
      },
      ui: {
        answers: messages.filter((m) => m.role === 'assistant').map((m) => m.content),
        outbound_drafts:
          pack?.contract.audience !== 'self'
            ? messages.filter((m) => m.role === 'assistant').map((m) => m.content)
            : [],
        status_codes: statusCodes,
        capabilities: [
          { name: 'closed_app_reminders', available: r.reminders.capabilities().closedAppReminders },
        ],
        unsupported_numeric_balance_claims: messages.filter(
          (m) =>
            m.role === 'assistant' &&
            /(?:还能用|可用余额|可用金额).{0,6}\d+(?:\.\d+)?元/.test(m.content) &&
            pack?.needs.some((n) => n.key === 'financial_coverage' && n.status === 'unsupported'),
        ),
        clarification_question_count: (latest?.content.match(/[？?]/g) || []).length,
        unlabelled_demo_answers: messages.filter(
          (m) => m.demo === false && m.content.includes('这是一个可以修改的示例'),
        ),
        map_opened: this.mapOpened,
      },
      evidence: {
        user_sources: sources.filter((e) => e.speaker === 'user'),
        active_source_ids: sources.map((e) => e.id),
        locators: media.map((m) => ({
          artifact_id: m.locator.artifactId,
          start_ms: m.locator.startMs,
          end_ms: m.locator.endMs,
        })),
        fabricated_event_count: assertions
          .flatMap((a) => a.evidenceIds)
          .filter((id) => !f.repo.db.prepare('SELECT id FROM h_evidence WHERE id=?').get(id)).length,
      },
      privacy: {
        restoration_fence_applied: f.repo.getMeta('restoration_fence_applied', false),
        fence_lost_on_recipe_rollback: this.rollbackEpoch !== undefined && f.repo.epoch < this.rollbackEpoch,
      },
      filesystem: { canary_occurrences: this.scanOccurrences },
      sink: {
        requests: this.sink?.requests || [],
        side_effect_count: this.sink?.effects.size || 0,
        dispatch_count: this.sink?.requests.filter((req) => req.method === 'POST').length || 0,
      },
      sync: { rejected_stale_operations: r.sync.rejected.filter((o) => o.code === 'stale_epoch') },
      exports: { content: this.exportResult, manifest: this.exportResult?.manifest },
      recipes: {
        active_ids: r.broker.recipeList().map((recipe) => recipe.id),
        auto_approved: r.broker.recipeList().filter((recipe) => recipe.status !== 'reviewed'),
      },
      metrics: this.paired
        ? { noninterference: this.paired.noninterference, personalization: this.paired.personalization }
        : {},
    };
    f.repo.access.length = 0;
    f.repo.access.push(...accessSnapshot);
    return result;
  }
  async close() {
    await this.harness.stop();
    this.f.close();
    await this.sink?.close();
  }
}
function formatShanghai(value: string) {
  const date = new Date(Date.parse(value) + 8 * 3600000);
  return date.toISOString().replace('.000Z', '+08:00');
}
