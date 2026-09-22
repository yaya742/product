import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Assertion,
  ClockPort,
  ContextReceipt,
  Dependency,
  EvidenceEvent,
  HostIdentity,
  ProcessingSpan,
  ProcessingStatus,
  ScopeData,
  ScopeHandle,
  Watermarks,
  WorkRecord,
} from '../../shared/harness';
import { HarnessError, assertionSchema, evidenceSchema, workSchema } from '../../shared/harness';
import { systemClock } from '../runtime/semantics';

type Row = Record<string, unknown>;
export interface PrivacyFence {
  id: string;
  epoch: number;
  objectIds: string[];
  sourceIds: string[];
  createdAt: string;
  kind: 'delete' | 'revoke';
  scope?: string;
  spans?: { eventId: string; contentVersion: number; start: number; end: number }[];
}
export type FaultInjector = (point: string) => void;
const parse = <T>(row: Row | undefined): T | undefined => (row ? JSON.parse(String(row.payload)) : undefined);
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',') || 'NULL';
const columns = `owner TEXT NOT NULL, workspace TEXT NOT NULL, subject TEXT NOT NULL, world TEXT NOT NULL,
 source TEXT NOT NULL, purpose TEXT NOT NULL, audience TEXT NOT NULL, sensitivity TEXT NOT NULL,
 retain TEXT NOT NULL, infer INTEGER NOT NULL, expires_at TEXT`;

/** Owns short synchronous SQLite transactions. No provider/model work is permitted inside write(). */
export class KernelRepository {
  readonly identity: HostIdentity;
  readonly clock: ClockPort;
  readonly databasePath: string;
  private validateScope?: (scope: ScopeHandle) => ScopeData;
  private transactionDepth = 0;
  private afterCommitCallbacks: (() => void)[] = [];
  fault?: FaultInjector;
  readonly transitions: { at: string; objectId: string; from?: string; to: string; revision?: number }[] = [];
  readonly access: { principalId: string; scopeId: string; purposes: readonly string[]; source: string; objectId: string; kind: string }[] = [];
  readonly conflicts: { objectId: string; expected: number; actual: number }[] = [];
  constructor(
    readonly db: DatabaseSync,
    file: string,
    clock: ClockPort = systemClock,
    identity?: HostIdentity,
  ) {
    this.databasePath = file;
    this.clock = clock;
    this.migrate();
    this.migrateCalendarVersions();
    this.db.exec(
      "INSERT INTO h_evidence_fts(h_evidence_fts,rank) VALUES('secure-delete',1); INSERT INTO h_assertion_fts(h_assertion_fts,rank) VALUES('secure-delete',1);",
    );
    this.identity = this.getMeta<HostIdentity>('identity') ||
      identity || { principalId: randomUUID(), workspaceId: randomUUID(), deviceId: randomUUID() };
    if (!this.getMeta('identity')) this.write(() => this.setMeta('identity', this.identity));
    this.applyRestorationFences();
  }
  bindPolicy(validate: (scope: ScopeHandle) => ScopeData) {
    this.validateScope = validate;
  }
  scope(scope: ScopeHandle): ScopeData {
    if (!this.validateScope) throw new HarnessError('policy_unavailable', '策略尚未初始化。');
    return this.validateScope(scope);
  }
  private migrate() {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (version > 5) throw new HarnessError('newer_schema', '资料来自更新版本，请使用相应版本打开。');
    if (version >= 4) return;
    if (version === 3) {
      this.migrateRoots();
      return;
    }
    if (version === 2) {
      this.migrateDomainVersions();
      return;
    }
    if (version === 1) {
      this.migratePorts();
      return;
    }
    // Backup is local, never exported. Fresh/empty test stores need no redundant backup.
    const count = Number(
      this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='messages'").get()
        ?.n || 0,
    );
    if (
      this.databasePath !== ':memory:' &&
      count &&
      Number(this.db.prepare('SELECT count(*) AS n FROM messages').get()?.n || 0)
    ) {
      const backup = this.databasePath + '.pre-harness-v1.sqlite';
      if (!fs.existsSync(backup)) this.db.prepare('VACUUM INTO ?').run(backup);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE h_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE h_migrations(id TEXT PRIMARY KEY,version INTEGER NOT NULL,applied_at TEXT NOT NULL,details TEXT NOT NULL);
        CREATE TABLE h_fences(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE h_evidence(id TEXT PRIMARY KEY,${columns},version INTEGER NOT NULL,seq INTEGER UNIQUE NOT NULL,
          received_at TEXT NOT NULL,status TEXT NOT NULL,content TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX h_evidence_scope ON h_evidence(owner,workspace,subject,world,source,status,seq);
        CREATE INDEX h_evidence_time ON h_evidence(owner,workspace,received_at);
        CREATE TABLE h_spans(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES h_evidence(id) ON DELETE CASCADE,
          content_version INTEGER NOT NULL,start_cp INTEGER NOT NULL,end_cp INTEGER NOT NULL,status TEXT NOT NULL,indexed INTEGER NOT NULL DEFAULT 0,
          UNIQUE(event_id,content_version,start_cp,end_cp));
        CREATE TABLE h_assertions(id TEXT PRIMARY KEY,${columns},revision INTEGER NOT NULL,predicate TEXT NOT NULL,
          kind TEXT NOT NULL,status TEXT NOT NULL,strength TEXT NOT NULL,valid_from TEXT,valid_to TEXT,text TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX h_assertions_scope ON h_assertions(owner,workspace,subject,world,source,status,predicate);
        CREATE INDEX h_assertions_time ON h_assertions(owner,workspace,valid_from,valid_to,status);
        CREATE TABLE h_assertion_versions(id TEXT NOT NULL REFERENCES h_assertions(id) ON DELETE CASCADE,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TABLE h_assertion_evidence(assertion_id TEXT NOT NULL REFERENCES h_assertions(id) ON DELETE CASCADE,event_id TEXT NOT NULL REFERENCES h_evidence(id) ON DELETE CASCADE,
          start_cp INTEGER,end_cp INTEGER,PRIMARY KEY(assertion_id,event_id));
        CREATE INDEX h_evidence_assertion_reverse ON h_assertion_evidence(event_id,assertion_id);
        CREATE TABLE h_proposals(id TEXT PRIMARY KEY,event_id TEXT,epoch INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT,payload TEXT NOT NULL);
        CREATE TABLE h_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,result TEXT NOT NULL);
        CREATE TABLE h_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,object_id TEXT NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
        CREATE INDEX h_outbox_pending ON h_outbox(status,created_at);
        CREATE TABLE h_dependencies(consumer_id TEXT NOT NULL,producer_id TEXT NOT NULL,producer_revision INTEGER NOT NULL,sensitivity TEXT NOT NULL,invalidation TEXT NOT NULL,
          PRIMARY KEY(consumer_id,producer_id));
        CREATE INDEX h_dependencies_reverse ON h_dependencies(producer_id,consumer_id);
        CREATE TABLE h_work(id TEXT PRIMARY KEY,${columns},kind TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX h_work_scope ON h_work(owner,workspace,subject,world,kind,status);
        CREATE TABLE h_worlds(id TEXT PRIMARY KEY,owner TEXT NOT NULL,workspace TEXT NOT NULL,subject TEXT NOT NULL,base_revision INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE h_domain(id TEXT NOT NULL,source TEXT NOT NULL,domain TEXT NOT NULL,institution TEXT NOT NULL,term TEXT NOT NULL,${columns.replace('source TEXT NOT NULL,', '')},
          revision INTEGER NOT NULL,status TEXT NOT NULL,evidence_id TEXT NOT NULL REFERENCES h_evidence(id),fetched_at TEXT NOT NULL,payload TEXT NOT NULL,
          PRIMARY KEY(id,source,domain,institution,term));
        CREATE INDEX h_domain_scope ON h_domain(owner,workspace,subject,world,domain,institution,term,status);
        CREATE TABLE h_sync(source TEXT NOT NULL,domain TEXT NOT NULL,institution TEXT NOT NULL,term TEXT NOT NULL,scope_key TEXT NOT NULL,status TEXT NOT NULL,cursor TEXT,payload TEXT NOT NULL,
          PRIMARY KEY(source,domain,institution,term,scope_key));
        CREATE TABLE h_actions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,workspace TEXT NOT NULL,subject TEXT NOT NULL,world TEXT NOT NULL,
          revision INTEGER NOT NULL,status TEXT NOT NULL,goal_id TEXT,source TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX h_actions_scope ON h_actions(owner,workspace,subject,world,status);
        CREATE TABLE h_approvals(id TEXT PRIMARY KEY,action_id TEXT NOT NULL REFERENCES h_actions(id) ON DELETE CASCADE,payload TEXT NOT NULL);
        CREATE TABLE h_attempts(id TEXT PRIMARY KEY,action_id TEXT NOT NULL REFERENCES h_actions(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,status TEXT NOT NULL,epoch INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX h_attempts_action ON h_attempts(action_id,status);
        CREATE TABLE h_receipts(id TEXT PRIMARY KEY,action_id TEXT NOT NULL REFERENCES h_actions(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL REFERENCES h_attempts(id),payload TEXT NOT NULL);
        CREATE TABLE h_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,object_id TEXT NOT NULL,goal_id TEXT,source TEXT NOT NULL,
          epoch INTEGER NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,fence INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
          dedup_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX h_jobs_due ON h_jobs(status,due_at,lease_until);
        CREATE TABLE h_deliveries(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES h_jobs(id) ON DELETE CASCADE,status TEXT NOT NULL,dedup_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE h_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,workspace TEXT NOT NULL,epoch INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE h_aliases(entity_id TEXT NOT NULL,alias TEXT NOT NULL,owner TEXT NOT NULL,workspace TEXT NOT NULL,institution TEXT NOT NULL,role TEXT NOT NULL,source TEXT NOT NULL,
          PRIMARY KEY(entity_id,alias,institution));
        CREATE INDEX h_alias_lookup ON h_aliases(owner,workspace,institution,alias);
        CREATE VIRTUAL TABLE h_evidence_fts USING fts5(id UNINDEXED,text,tokenize='trigram');
        CREATE VIRTUAL TABLE h_assertion_fts USING fts5(id UNINDEXED,text,tokenize='trigram');
        CREATE TABLE h_grams(kind TEXT NOT NULL,object_id TEXT NOT NULL,gram TEXT NOT NULL,PRIMARY KEY(kind,object_id,gram));
        CREATE INDEX h_grams_lookup ON h_grams(kind,gram,object_id);
        INSERT INTO h_meta VALUES('privacy_epoch','1'),('policy_revision','1'),('received_seq','0'),('sequence_base','0'),('domain_revision','0');
        PRAGMA user_version=1;
      `);
      this.db
        .prepare('INSERT INTO h_migrations VALUES(?,?,?,?)')
        .run(
          'harness-foundation-v1',
          1,
          this.clock.now(),
          JSON.stringify({ legacyPreserved: true, privacyBarrierRequiredForRollback: true }),
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.migratePorts();
  }
  private migratePorts() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE h_observations(id TEXT PRIMARY KEY,${columns},kind TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,evidence_id TEXT NOT NULL REFERENCES h_evidence(id),payload TEXT NOT NULL);
        CREATE INDEX h_observations_scope ON h_observations(owner,workspace,subject,world,kind,status,source);
        CREATE TABLE h_observation_versions(id TEXT NOT NULL REFERENCES h_observations(id) ON DELETE CASCADE,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
        CREATE TABLE h_sync_operations(device_id TEXT NOT NULL,operation_id TEXT NOT NULL,object_id TEXT NOT NULL,base_revision INTEGER NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(device_id,operation_id));
        CREATE TABLE h_watches(id TEXT PRIMARY KEY,owner TEXT NOT NULL,workspace TEXT NOT NULL,goal_id TEXT NOT NULL,status TEXT NOT NULL,epoch INTEGER NOT NULL,novelty_key TEXT,payload TEXT NOT NULL);
        CREATE INDEX h_watches_goal ON h_watches(goal_id,status);
        CREATE TABLE h_source_restrictions(event_id TEXT NOT NULL,predicate TEXT NOT NULL,operation TEXT NOT NULL,replacement_event_id TEXT,PRIMARY KEY(event_id,predicate));
        PRAGMA user_version=2;
      `);
      this.db.prepare('INSERT INTO h_migrations VALUES(?,?,?,?)').run(
        'extension-ports-v2',
        2,
        this.clock.now(),
        JSON.stringify({
          observations: 'versioned',
          sync: 'proposals_only',
          sourceRestrictions: 'no_plaintext',
        }),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.migrateDomainVersions();
  }
  private migrateDomainVersions() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .exec(`CREATE TABLE h_domain_versions(id TEXT NOT NULL,source TEXT NOT NULL,domain TEXT NOT NULL,institution TEXT NOT NULL,term TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,source,domain,institution,term,revision));
        INSERT INTO h_domain_versions SELECT id,source,domain,institution,term,revision,payload FROM h_domain;
        PRAGMA user_version=3;`);
      this.db
        .prepare('INSERT INTO h_migrations VALUES(?,?,?,?)')
        .run(
          'domain-versions-v3',
          3,
          this.clock.now(),
          JSON.stringify({ purpose: 'immutable bound scenario baselines' }),
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.migrateRoots();
  }
  private migrateRoots() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .exec(`CREATE TABLE h_evidence_roots(event_id TEXT NOT NULL REFERENCES h_evidence(id) ON DELETE CASCADE,root_id TEXT NOT NULL,PRIMARY KEY(event_id,root_id));
        CREATE INDEX h_evidence_root_reverse ON h_evidence_roots(root_id,event_id);
        INSERT INTO h_evidence_roots SELECT e.id,root.value FROM h_evidence e,json_each(e.payload,'$.roots') root;
        PRAGMA user_version=4;`);
      this.db
        .prepare('INSERT INTO h_migrations VALUES(?,?,?,?)')
        .run(
          'provenance-roots-v4',
          4,
          this.clock.now(),
          JSON.stringify({ purpose: 'reverse source-root deletion and derivation traversal' }),
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private migrateCalendarVersions() {
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) === 5) return;
    if (this.databasePath !== ':memory:' && Number(this.db.prepare('SELECT count(*) AS n FROM messages').get()?.n || 0)) {
      const backup = this.databasePath + '.pre-harness-v5.sqlite';
      if (!fs.existsSync(backup)) this.db.prepare('VACUUM INTO ?').run(backup);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE TABLE h_calendar_versions(id TEXT PRIMARY KEY,agenda_id TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(agenda_id,revision)); PRAGMA user_version=5;');
      this.db.prepare('INSERT INTO h_migrations VALUES(?,?,?,?)').run('calendar-provenance-v5', 5, this.clock.now(), JSON.stringify({ purpose: 'versioned local calendar provenance and safe compensation', rollback: 'pre-harness-v5 backup plus latest privacy fences' }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  calendarVersionId(id: string, revision: number) { return 'agenda-version:' + createHash('sha256').update(`${id}:${revision}`).digest('hex'); }
  registerCalendarVersion(handle: ScopeHandle, id: string, revision: number, producer?: string) {
    this.scope(handle);
    const versionId = this.calendarVersionId(id, revision);
    this.write(() => {
      this.db.prepare('INSERT OR IGNORE INTO h_calendar_versions VALUES(?,?,?)').run(versionId, id, revision);
      if (producer && this.db.prepare('SELECT id FROM h_actions WHERE id=?').get(producer)) this.addDependency(handle, { consumerId: versionId, producerId: producer, producerRevision: 0, sensitivity: 'privacy', invalidation: 'block' });
    });
    return versionId;
  }
  private clearMigrationBackups() {
    if (this.databasePath === ':memory:') return;
    const directory = path.dirname(this.databasePath), prefix = path.basename(this.databasePath) + '.pre-harness-v';
    for (const name of fs.readdirSync(directory)) if (name.startsWith(prefix) && /^\d+\.sqlite$/.test(name.slice(prefix.length))) fs.unlinkSync(path.join(directory, name));
  }
  write<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    this.afterCommitCallbacks = [];
    let result: T;
    try {
      result = fn();
      if (result && typeof result === 'object' && typeof (result as any).then === 'function')
        throw new HarnessError('async_transaction', '事务内不能调用异步服务。');
      this.fault?.('before_transaction_commit');
      this.db.exec('COMMIT');
    } catch (error) {
      this.afterCommitCallbacks = [];
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
    const callbacks = this.afterCommitCallbacks;
    this.afterCommitCallbacks = [];
    for (const callback of callbacks) callback();
    return result!;
  }
  afterCommit(callback: () => void) {
    if (this.transactionDepth) this.afterCommitCallbacks.push(callback);
    else callback();
  }
  getMeta<T>(key: string, fallback?: T): T {
    const row = this.db.prepare('SELECT value FROM h_meta WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : (fallback as T);
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO h_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  get epoch() {
    return this.getMeta<number>('privacy_epoch', 1);
  }
  get policyRevision() {
    return this.getMeta<number>('policy_revision', 1);
  }
  get domainRevision() {
    return this.getMeta<number>('domain_revision', 0);
  }
  filter(handle: ScopeHandle, alias = 'r'): { sql: string; params: SQLInputValue[] } {
    const s = this.scope(handle),
      prefix = alias + '.';
    const persistentSources = s.sources.filter((source) => source !== 'current');
    return {
      sql: `${prefix}owner=? AND ${prefix}workspace=? AND ${prefix}subject=? AND ${prefix}world=?
        AND (${prefix}source IN (${placeholders(persistentSources)}) ${s.currentEventIds.length ? `OR ${prefix}id IN (${placeholders(s.currentEventIds)})` : ''})
        AND ${prefix}purpose IN (${placeholders(s.purposes)})
        AND ${prefix}audience IN (${placeholders(s.audience === 'self' ? ['self', 'public'] : [s.audience, 'public'])})
        AND (${prefix}expires_at IS NULL OR julianday(${prefix}expires_at)>julianday(?))
        ${s.grants.includes('restricted:read') ? '' : `AND ${prefix}sensitivity!='restricted'`}`,
      params: [
        s.principalId,
        s.workspaceId,
        s.subjectId,
        s.worldId,
        ...persistentSources,
        ...s.currentEventIds,
        ...s.purposes,
        ...(s.audience === 'self' ? ['self', 'public'] : [s.audience, 'public']),
        this.clock.now(),
      ],
    };
  }
  private envelope(
    e: {
      ownerId: string;
      workspaceId: string;
      subjectId: string;
      worldId: string;
      label: EvidenceEvent['label'];
    },
    sourceId: string,
  ): SQLInputValue[] {
    return [
      e.ownerId,
      e.workspaceId,
      e.subjectId,
      e.worldId,
      sourceId,
      e.label.purpose,
      e.label.audience,
      e.label.sensitivity,
      e.label.retention,
      e.label.infer ? 1 : 0,
      e.label.expiresAt || null,
    ];
  }
  private recordAccess(handle: ScopeHandle, row: Row, kind: string) {
    const scope = this.scope(handle);
    this.access.push({
      principalId: scope.principalId,
      scopeId: handle.id,
      purposes: scope.purposes,
      source: scope.currentEventIds.includes(String(row.id)) ? 'current' : String(row.source),
      objectId: String(row.id),
      kind,
    });
  }
  hasFence(objectId: string, sourceId?: string): boolean {
    return this.fences().some(
      (f) =>
        f.kind === 'delete' &&
        (f.objectIds.includes(objectId) ||
          f.sourceIds.includes(objectId) ||
          (!!sourceId && f.sourceIds.includes(sourceId))),
    );
  }
  ingest(handle: ScopeHandle, input: Omit<EvidenceEvent, 'sequence'>): EvidenceEvent {
    const scope = this.scope(handle);
    if (scope.retention === 'session_only' || input.label.retention === 'session_only')
      throw new HarnessError('ephemeral_only', '本轮内容不会持久保存。');
    if (
      scope.principalId !== input.ownerId ||
      scope.workspaceId !== input.workspaceId ||
      scope.subjectId !== input.subjectId ||
      scope.worldId !== input.worldId
    )
      throw new HarnessError('scope_mismatch', '来源归属不匹配。');
    if (!scope.sources.includes(input.sourceId) && !scope.currentEventIds.includes(input.id))
      throw new HarnessError('source_forbidden', '未授权的来源。');
    if (input.label.sensitivity === 'restricted')
      throw new HarnessError('protection_unavailable', '当前整库未加密，受限资料只用于本轮。');
    if (this.hasFence(input.id, input.sourceId) || input.roots.some((root) => this.hasFence(root)))
      throw new HarnessError('deleted_source', '此旧来源已经被删除，不能重放。');
    const existing = this.db
      .prepare('SELECT payload FROM h_evidence WHERE id=? AND owner=? AND workspace=?')
      .get(input.id, scope.principalId, scope.workspaceId);
    if (existing) {
      const event = parse<EvidenceEvent>(existing)!;
      if (event.text !== input.text || event.contentVersion !== input.contentVersion)
        throw new HarnessError('event_conflict', '相同事件标识的原文不同。');
      return event;
    }
    const event = evidenceSchema.parse({ ...input, sequence: this.getMeta<number>('received_seq', 0) + 1 });
    this.write(() => {
      this.db
        .prepare('INSERT INTO h_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          event.id,
          ...this.envelope(event, event.sourceId),
          event.contentVersion,
          event.sequence,
          event.receivedAt,
          event.status,
          event.text,
          JSON.stringify(event),
        );
      for (const root of event.roots)
        this.db.prepare('INSERT INTO h_evidence_roots VALUES(?,?)').run(event.id, root);
      const points = Array.from(event.text);
      for (let start = 0; start < points.length; start += 1800) {
        const end = Math.min(points.length, start + 1800),
          spanId = event.id + ':' + event.contentVersion + ':' + start;
        this.db
          .prepare('INSERT INTO h_spans VALUES(?,?,?,?,?,?,0)')
          .run(
            spanId,
            event.id,
            event.contentVersion,
            start,
            end,
            event.label.infer && event.speaker === 'user' ? 'pending' : 'quote_or_hypothesis',
          );
      }
      this.setMeta('received_seq', event.sequence);
      this.outbox('extract', event.id);
      this.outbox('index_evidence', event.id);
    });
    this.afterCommit(() => this.fault?.('after_event_and_outbox_commit'));
    return event;
  }
  evidence(handle: ScopeHandle, id: string): EvidenceEvent | undefined {
    const f = this.filter(handle);
    const row = this.db
      .prepare(`SELECT r.* FROM h_evidence r WHERE ${f.sql} AND r.id=? AND r.status!='deleted'`)
      .get(...f.params, id);
    if (row) this.recordAccess(handle, row, 'evidence');
    return parse<EvidenceEvent>(row);
  }
  evidenceList(handle: ScopeHandle, limit = 100, after = 0): EvidenceEvent[] {
    const f = this.filter(handle);
    const rows = this.db
      .prepare(
        `SELECT r.* FROM h_evidence r WHERE ${f.sql} AND r.status!='deleted' AND r.seq>?
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id) ORDER BY r.seq DESC LIMIT ?`,
      )
      .all(...f.params, after, Math.min(500, limit));
    return rows.map((row) => {
      this.recordAccess(handle, row, 'evidence');
      return parse<EvidenceEvent>(row)!;
    });
  }
  sessionEvidence(handle: ScopeHandle, sessionId: string, limit = 4): EvidenceEvent[] {
    const f = this.filter(handle);
    const rows = this.db
      .prepare(
        `SELECT r.* FROM h_evidence r JOIN messages m ON m.id=r.id WHERE ${f.sql} AND m.session_id=? AND r.status!='deleted'
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id) ORDER BY r.seq DESC LIMIT ?`,
      )
      .all(...f.params, sessionId, Math.min(limit, 8));
    return rows.map((row) => {
      this.recordAccess(handle, row, 'session_reference');
      return parse<EvidenceEvent>(row)!;
    });
  }
  /** Select permitted transcript bodies in SQL, before they enter model memory. */
  conversationHistory(handle: ScopeHandle, sessionId: string, excludeIds: string[], limit = 12) {
    const s = this.scope(handle);
    if (!s.sources.includes('history:self') || s.audience !== 'self' || s.subjectId !== s.principalId || s.worldId !== 'real') return [];
    const f = this.filter(handle);
    const rows = this.db.prepare(`SELECT m.id,m.role,CASE WHEN m.role='user' THEN (SELECT content FROM h_evidence WHERE id=m.id) ELSE m.content END AS content,m.created_at FROM messages m
      WHERE m.session_id=? AND m.id NOT IN (SELECT value FROM json_each(?))
      AND json_extract(m.payload,'$.status')='done'
      AND ((m.role='user' AND EXISTS(SELECT 1 FROM h_evidence r WHERE r.id=m.id AND ${f.sql} AND r.status='active'
        AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id)))
        OR (m.role='assistant' AND json_extract(m.payload,'$.contextReceipt.privacyEpoch')=?
          AND json_extract(m.payload,'$.contextReceipt.policyRevision')=?
          AND json_type(m.payload,'$.contextReceipt.providedSourceIds')='array'
          AND NOT EXISTS(SELECT 1 FROM json_each(m.payload,'$.contextReceipt.providedSourceIds') src
            WHERE src.value NOT IN (SELECT value FROM json_each(?)))))
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?`).all(
      sessionId, JSON.stringify(excludeIds), ...f.params, s.privacyEpoch, s.policyRevision, JSON.stringify(s.sources), Math.min(24, limit),
    );
    for (const row of rows) this.recordAccess(handle, { ...row, source: 'history:self' }, 'conversation_history');
    return rows.reverse().map(row => ({ id: String(row.id), role: row.role as 'user' | 'assistant', content: String(row.content), createdAt: String(row.created_at) }));
  }
  pendingConstraints(handle: ScopeHandle, sessionId: string): EvidenceEvent[] {
    const f = this.filter(handle);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.* FROM h_evidence r JOIN messages m ON m.id=r.id WHERE ${f.sql} AND m.session_id=? AND r.status='active'
      AND EXISTS(SELECT 1 FROM h_spans p WHERE p.event_id=r.id AND p.status IN ('pending','failed','needs_context'))
      AND (r.content LIKE '%必须%' OR r.content LIKE '%未完成要求%' OR r.content LIKE '%截止%' OR r.content LIKE '%不接受%' OR r.content LIKE '%保留%')
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id) ORDER BY r.seq DESC LIMIT 50`,
      )
      .all(...f.params, sessionId);
    return rows.map((row) => {
      this.recordAccess(handle, row, 'pending_constraint');
      return parse<EvidenceEvent>(row)!;
    });
  }
  searchEvidence(handle: ScopeHandle, query: string, limit = 12): EvidenceEvent[] {
    const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
    if (!terms.length) return [];
    const f = this.filter(handle),
      patterns = terms.map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
    // Index misses and pending extraction never hide original evidence. SQL scope precedes the bounded result set.
    const rows = this.db
      .prepare(
        `SELECT r.* FROM h_evidence r WHERE ${f.sql} AND r.status!='deleted'
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id)
      ${terms.map(() => "AND lower(r.content) LIKE ? ESCAPE '\\'").join(' ')} ORDER BY r.seq DESC LIMIT ?`,
      )
      .all(...f.params, ...patterns, Math.min(limit, 50));
    return rows.map((row) => {
      this.recordAccess(handle, row, 'original_search');
      return parse<EvidenceEvent>(row)!;
    });
  }
  lexicalEvidence(handle: ScopeHandle, query: string, limit = 12): EvidenceEvent[] {
    const f = this.filter(handle),
      points = Array.from(query.normalize('NFKC').toLowerCase()),
      grams = [
        ...new Set(
          points
            .slice(0, -1)
            .map((p, i) => p + points[i + 1])
            .filter((g) => !/[\s，。？！、；：]/.test(g)),
        ),
      ].slice(0, 64);
    if (!grams.length) return this.searchEvidence(handle, query, limit);
    const rows = this.db
      .prepare(
        `WITH eligible AS MATERIALIZED(SELECT r.id FROM h_evidence r WHERE ${f.sql} AND r.status!='deleted'
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id))
      SELECT r.*,count(*) AS matches FROM eligible a JOIN h_evidence r ON r.id=a.id JOIN h_grams g ON g.object_id=r.id
      WHERE g.kind='evidence' AND g.gram IN (${placeholders(grams)}) GROUP BY r.id ORDER BY matches DESC,r.seq DESC LIMIT ?`,
      )
      .all(...f.params, ...grams, Math.min(limit, 50));
    // A paused or failed index must not make related original passages vanish.
    // Apply the identical SQL permission filter before matching unindexed text.
    const pendingRows = this.db.prepare(
      `WITH eligible AS MATERIALIZED(SELECT r.* FROM h_evidence r WHERE ${f.sql} AND r.status!='deleted'
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM h_grams g WHERE g.object_id=r.id AND g.kind='evidence'))
      SELECT r.*,(${grams.map(() => 'CASE WHEN instr(lower(r.content),?)>0 THEN 1 ELSE 0 END').join('+')}) AS matches
      FROM eligible r WHERE matches>0 ORDER BY matches DESC,r.seq DESC LIMIT ?`,
    ).all(...f.params, ...grams, Math.min(limit, 50));
    const combined = [...new Map([...rows, ...pendingRows].map(row => [row.id, row])).values()]
      .sort((a, b) => Number(b.matches) - Number(a.matches) || Number(b.seq) - Number(a.seq)).slice(0, Math.min(limit, 50));
    return combined.map((row) => {
      this.recordAccess(handle, row, 'lexical_search');
      return parse<EvidenceEvent>(row)!;
    });
  }
  lexicalAssertions(handle: ScopeHandle, query: string, limit = 24): Assertion[] {
    const f = this.filter(handle),
      points = Array.from(query.normalize('NFKC').toLowerCase()),
      grams = [
        ...new Set(
          points
            .slice(0, -1)
            .map((p, i) => p + points[i + 1])
            .filter((g) => !/[\s，。？！、；：]/.test(g)),
        ),
      ].slice(0, 64);
    if (!grams.length) return [];
    const rows = this.db
      .prepare(
        `WITH eligible AS MATERIALIZED(SELECT r.id FROM h_assertions r WHERE ${f.sql} AND r.status='active')
      SELECT a.id,count(*) AS matches FROM eligible a JOIN h_grams g ON g.object_id=a.id WHERE g.kind='assertion' AND g.gram IN (${placeholders(grams)}) GROUP BY a.id ORDER BY matches DESC LIMIT ?`,
      )
      .all(...f.params, ...grams, Math.min(limit, 50));
    return rows.map((row) => this.assertion(handle, String(row.id))).filter((a): a is Assertion => !!a);
  }
  spans(handle: ScopeHandle, eventId: string): ProcessingSpan[] {
    if (!this.evidence(handle, eventId)) return [];
    return this.db
      .prepare(
        'SELECT id,event_id AS eventId,content_version AS contentVersion,start_cp AS start,end_cp AS end,status,indexed FROM h_spans WHERE event_id=? ORDER BY start_cp',
      )
      .all(eventId)
      .map((r) => ({ ...r, indexed: !!r.indexed }) as unknown as ProcessingSpan);
  }
  markSpans(handle: ScopeHandle, eventId: string, status: ProcessingStatus, spanIds?: string[]) {
    if (!this.evidence(handle, eventId)) throw new HarnessError('source_forbidden', '不能处理此来源。');
    this.write(() => {
      this.db
        .prepare(
          `UPDATE h_spans SET status=? WHERE event_id=? ${spanIds?.length ? `AND id IN (${placeholders(spanIds)})` : ''}`,
        )
        .run(status, eventId, ...(spanIds || []));
      if (
        !this.db
          .prepare(
            "SELECT id FROM h_spans WHERE event_id=? AND status IN ('pending','failed','needs_context') LIMIT 1",
          )
          .get(eventId)
      )
        this.db
          .prepare("UPDATE h_outbox SET status='done' WHERE object_id=? AND kind='extract'")
          .run(eventId);
    });
  }
  watermarks(): Watermarks {
    const base = this.getMeta<number>('sequence_base', 0),
      received = this.getMeta<number>('received_seq', 0);
    const rows = this.db
      .prepare(
        `SELECT e.seq,e.status, count(s.id) AS total,
      sum(CASE WHEN s.status IN ('pending','failed','needs_context') THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN s.indexed=0 THEN 1 ELSE 0 END) AS unindexed
      FROM h_evidence e LEFT JOIN h_spans s ON s.event_id=e.id GROUP BY e.id ORDER BY e.seq`,
      )
      .all();
    const bySeq = new Map(rows.map((r) => [Number(r.seq), r]));
    let extracted = base,
      indexed = base;
    const extractionGaps: number[] = [],
      indexingGaps: number[] = [];
    for (let seq = base + 1; seq <= received; seq++) {
      const row = bySeq.get(seq),
        extractionDone = !!row && (row.status === 'deleted' || !Number(row.pending)),
        indexDone = !!row && (row.status === 'deleted' || !Number(row.unindexed));
      if (extractionDone && extracted === seq - 1) extracted = seq;
      if (indexDone && indexed === seq - 1) indexed = seq;
      if (!extractionDone) extractionGaps.push(seq);
      if (!indexDone) indexingGaps.push(seq);
    }
    return {
      received,
      extractedContiguous: extracted,
      indexedContiguous: indexed,
      extractionGaps,
      indexingGaps,
    };
  }
  indexEvidence(handle: ScopeHandle, id: string) {
    const event = this.evidence(handle, id);
    if (!event) return;
    this.fault?.('before_index_commit');
    this.write(() => {
      this.replaceIndex('evidence', id, event.text);
      this.db.prepare('UPDATE h_spans SET indexed=1 WHERE event_id=?').run(id);
      this.db
        .prepare("UPDATE h_outbox SET status='done' WHERE object_id=? AND kind='index_evidence'")
        .run(id);
    });
  }
  private replaceIndex(kind: 'evidence' | 'assertion', id: string, text: string) {
    this.db.prepare(`DELETE FROM h_${kind}_fts WHERE id=?`).run(id);
    this.db.prepare(`INSERT INTO h_${kind}_fts(id,text) VALUES(?,?)`).run(id, text);
    this.db.prepare('DELETE FROM h_grams WHERE kind=? AND object_id=?').run(kind, id);
    const points = Array.from(text.normalize('NFKC').toLowerCase()),
      grams = new Set<string>();
    for (let i = 0; i < points.length - 1; i++)
      if (!/\s/.test(points[i] + points[i + 1])) grams.add(points[i] + points[i + 1]);
    const insert = this.db.prepare('INSERT OR IGNORE INTO h_grams VALUES(?,?,?)');
    for (const gram of grams) insert.run(kind, id, gram);
  }
  assertions(
    handle: ScopeHandle,
    options: { statuses?: string[]; predicate?: string; strength?: string; limit?: number } = {},
  ): Assertion[] {
    const f = this.filter(handle),
      e = this.filter(handle, 'e'),
      statuses = options.statuses || ['active'];
    const rows = this.db
      .prepare(
        `SELECT r.* FROM h_assertions r WHERE ${f.sql} AND r.status IN (${placeholders(statuses)})
      ${options.predicate ? 'AND r.predicate=?' : ''}
      ${options.strength ? "AND json_extract(r.payload,'$.strength')=?" : ''}
      AND NOT EXISTS(SELECT 1 FROM h_assertion_evidence ae JOIN h_evidence e ON e.id=ae.event_id WHERE ae.assertion_id=r.id AND (NOT (${e.sql}) OR e.status='deleted'))
      ORDER BY r.revision DESC,r.rowid DESC LIMIT ?`,
      )
      .all(
        ...f.params,
        ...statuses,
        ...(options.predicate ? [options.predicate] : []),
        ...(options.strength ? [options.strength] : []),
        ...e.params,
        Math.min(options.limit || 200, 500),
      );
    return rows.map((row) => {
      this.recordAccess(handle, row, 'assertion');
      return parse<Assertion>(row)!;
    });
  }
  assertion(handle: ScopeHandle, id: string): Assertion | undefined {
    const f = this.filter(handle),
      e = this.filter(handle, 'e');
    const row = this.db
      .prepare(
        `SELECT r.* FROM h_assertions r WHERE ${f.sql} AND r.id=?
      AND NOT EXISTS(SELECT 1 FROM h_assertion_evidence ae JOIN h_evidence e ON e.id=ae.event_id WHERE ae.assertion_id=r.id AND (NOT (${e.sql}) OR e.status='deleted'))`,
      )
      .get(...f.params, id, ...e.params);
    if (row) this.recordAccess(handle, row, 'assertion');
    return parse<Assertion>(row);
  }
  saveAssertion(
    handle: ScopeHandle,
    input: Assertion,
    expectedRevision?: number,
    locators: { eventId: string; start: number; end: number }[] = [],
  ) {
    const s = this.scope(handle),
      value = assertionSchema.parse(input);
    if (
      value.ownerId !== s.principalId ||
      value.workspaceId !== s.workspaceId ||
      value.subjectId !== s.subjectId ||
      value.worldId !== s.worldId
    )
      throw new HarnessError('scope_mismatch', '理解的主体或世界不匹配。');
    if (!s.infer || s.retention !== 'purpose_scoped')
      throw new HarnessError('inference_forbidden', '这次资料不用于长期理解。');
    if (this.hasFence(value.id)) throw new HarnessError('deleted_object', '已删除的理解不能恢复。');
    for (const id of value.evidenceIds)
      if (!this.evidence(handle, id))
        throw new HarnessError('evidence_forbidden', '缺少有权使用的原始证据。');
    this.write(() => {
      const old = this.db.prepare('SELECT revision,status FROM h_assertions WHERE id=?').get(value.id);
      if (old && (expectedRevision === undefined || Number(old.revision) !== expectedRevision)) {
        this.conflicts.push({
          objectId: value.id,
          expected: expectedRevision || 0,
          actual: Number(old.revision),
        });
        throw new HarnessError('revision_conflict', '理解已被更新，请重读后合并。');
      }
      if (!old && expectedRevision !== undefined)
        throw new HarnessError('revision_conflict', '原理解已不存在。');
      this.db
        .prepare(
          `INSERT INTO h_assertions VALUES(${Array(21).fill('?').join(',')}) ON CONFLICT(id) DO UPDATE SET
        revision=excluded.revision,predicate=excluded.predicate,kind=excluded.kind,status=excluded.status,strength=excluded.strength,
        valid_from=excluded.valid_from,valid_to=excluded.valid_to,text=excluded.text,payload=excluded.payload,expires_at=excluded.expires_at`,
        )
        .run(
          value.id,
          ...this.envelope(value, 'profile:self'),
          value.revision,
          value.predicate,
          value.kind,
          value.status,
          value.strength,
          value.temporal.validFrom || null,
          value.temporal.validTo || null,
          value.text,
          JSON.stringify(value),
        );
      this.db
        .prepare('INSERT INTO h_assertion_versions VALUES(?,?,?)')
        .run(value.id, value.revision, JSON.stringify(value));
      const previousLocators = this.db
        .prepare('SELECT event_id,start_cp,end_cp FROM h_assertion_evidence WHERE assertion_id=?')
        .all(value.id);
      this.db.prepare('DELETE FROM h_assertion_evidence WHERE assertion_id=?').run(value.id);
      for (const id of value.evidenceIds) {
        const loc = locators.find((l) => l.eventId === id),
          previous = previousLocators.find((l) => l.event_id === id);
        this.db
          .prepare('INSERT INTO h_assertion_evidence VALUES(?,?,?,?)')
          .run(
            value.id,
            id,
            loc?.start ?? (previous?.start_cp as number) ?? null,
            loc?.end ?? (previous?.end_cp as number) ?? null,
          );
      }
      this.replaceIndex('assertion', value.id, value.text);
      this.outbox('assertion_changed', value.id);
      this.transitions.push({
        at: this.clock.now(),
        objectId: value.id,
        from: old ? String(old.status) : undefined,
        to: value.status,
        revision: value.revision,
      });
    });
  }
  operation<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT result FROM h_operations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.result)) : undefined;
  }
  completeOperation(id: string, kind: string, result: unknown) {
    this.db.prepare('INSERT INTO h_operations VALUES(?,?,?)').run(id, kind, JSON.stringify(result));
  }
  outbox(kind: string, objectId: string) {
    this.db
      .prepare('INSERT INTO h_outbox VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), kind, objectId, this.epoch, 'pending', this.clock.now());
  }
  pending(kind: string) {
    return this.db
      .prepare(
        "SELECT * FROM h_outbox WHERE kind=? AND status='pending' AND epoch=? ORDER BY rowid LIMIT 100",
      )
      .all(kind, this.epoch);
  }
  saveWork(handle: ScopeHandle, input: WorkRecord, expectedRevision?: number) {
    const s = this.scope(handle),
      work = workSchema.parse(input);
    if (
      work.ownerId !== s.principalId ||
      work.workspaceId !== s.workspaceId ||
      work.subjectId !== s.subjectId ||
      work.worldId !== s.worldId ||
      s.retention === 'session_only'
    )
      throw new HarnessError('scope_mismatch', '不能保存此事项。');
    for (const id of work.evidenceIds)
      if (!this.evidence(handle, id)) throw new HarnessError('evidence_forbidden', '事项证据不可用。');
    if (this.hasFence(work.id)) throw new HarnessError('deleted_object', '此事项已删除。');
    this.write(() => {
      const old = this.db.prepare('SELECT revision FROM h_work WHERE id=?').get(work.id);
      if (old && Number(old.revision) !== expectedRevision) {
        this.conflicts.push({
          objectId: work.id,
          expected: expectedRevision || 0,
          actual: Number(old.revision),
        });
        throw new HarnessError('revision_conflict', '事项已更新，请重读后修改。');
      }
      this.db
        .prepare(
          `INSERT INTO h_work VALUES(${Array(17).fill('?').join(',')}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,title=excluded.title,payload=excluded.payload`,
        )
        .run(
          work.id,
          ...this.envelope(work, 'work:self'),
          work.kind,
          work.revision,
          work.status,
          work.title,
          JSON.stringify(work),
        );
      this.outbox('work_changed', work.id);
    });
  }
  work(handle: ScopeHandle, kind?: WorkRecord['kind'], id?: string): WorkRecord[] {
    const f = this.filter(handle),
      e = this.filter(handle, 'e');
    const rows = this.db
      .prepare(
        `SELECT r.* FROM h_work r WHERE ${f.sql} ${kind ? 'AND r.kind=?' : ''} ${id ? 'AND r.id=?' : ''}
      AND NOT EXISTS(SELECT 1 FROM json_each(r.payload,'$.evidenceIds') ref WHERE NOT EXISTS(SELECT 1 FROM h_evidence e WHERE e.id=ref.value AND ${e.sql} AND e.status!='deleted'))
      ORDER BY r.rowid DESC LIMIT 200`,
      )
      .all(...f.params, ...(kind ? [kind] : []), ...(id ? [id] : []), ...e.params);
    return rows.map((r) => parse<WorkRecord>(r)!);
  }
  collaborationPage(handle: ScopeHandle, sessionId: string, query = '', offset = 0, limit = 8) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new HarnessError('invalid_page', '事项分页范围不合法。');
    const terms = [...new Set(query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean))];
    if (terms.length > 16) throw new HarnessError('invalid_query', '检索词过多，请缩小查询。');
    const f = this.filter(handle), e = this.filter(handle, 'e');
    const permitted = `WITH permitted AS MATERIALIZED(
      SELECT r.*,r.rowid AS work_order FROM h_work r WHERE ${f.sql}
      AND (json_extract(r.payload,'$.data.type') IN ('collaboration_frame','request_item') OR r.kind IN ('goal','plan','commitment'))
      AND NOT EXISTS(SELECT 1 FROM json_each(r.payload,'$.evidenceIds') ref WHERE NOT EXISTS(SELECT 1 FROM h_evidence e WHERE e.id=ref.value AND ${e.sql} AND e.status!='deleted'))
      ${terms.length ? '' : "AND (json_extract(r.payload,'$.data.sessionId')=? OR EXISTS(SELECT 1 FROM json_each(r.payload,'$.data.sessionIds') s WHERE s.value=?))"}
    ), matching AS (SELECT * FROM permitted r ${terms.length ? 'WHERE ' + terms.map(() => "instr(lower(r.title || ' ' || r.payload),?)>0").join(' AND ') : ''})`;
    const params = [...f.params, ...e.params, ...(terms.length ? terms : [sessionId, sessionId])];
    const total = Number(this.db.prepare(`${permitted} SELECT count(*) AS total FROM matching`).get(...params)?.total || 0);
    const rows = this.db.prepare(`${permitted} SELECT * FROM matching ORDER BY work_order DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    for (const row of rows) this.recordAccess(handle, row, 'collaboration_restore');
    return { items: rows.map(row => parse<WorkRecord>(row)!), total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }
  requestItems(handle: ScopeHandle, sessionId: string, openOnly = false): WorkRecord[] {
    const f = this.filter(handle), e = this.filter(handle, 'e');
    const rows = this.db.prepare(`SELECT r.* FROM h_work r WHERE ${f.sql} AND r.kind='task'
      AND json_extract(r.payload,'$.data.type')='request_item'
      AND (json_extract(r.payload,'$.data.sessionId')=? OR EXISTS(SELECT 1 FROM json_each(r.payload,'$.data.sessionIds') s WHERE s.value=?))
      ${openOnly ? "AND json_extract(r.payload,'$.data.state') NOT IN ('answered','succeeded','withdrawn','unfulfilled')" : ''}
      AND NOT EXISTS(SELECT 1 FROM json_each(r.payload,'$.evidenceIds') ref WHERE NOT EXISTS(SELECT 1 FROM h_evidence e WHERE e.id=ref.value AND ${e.sql} AND e.status!='deleted'))
      ORDER BY r.rowid DESC LIMIT 200`).all(...f.params, sessionId, sessionId, ...e.params);
    for (const row of rows) this.recordAccess(handle, row, 'current_requests');
    return rows.map(row => parse<WorkRecord>(row)!);
  }

  /**
   * Scoped episode projection for conversation-frame recovery.  Keeping this
   * on the repository makes the scope/deletion fence rules identical to all
   * other work reads; callers never need a second profile or user database.
   */
  conversationFrames(
    handle: ScopeHandle,
    options: { sessionId?: string; anchorKey?: string; includeClosed?: boolean; limit?: number } = {},
  ): WorkRecord[] {
    const records = this.work(handle, 'episode').filter((episode) => {
      if (!options.includeClosed && ['closed', 'cancelled', 'stale', 'blocked'].includes(episode.status))
        return false;
      if (options.sessionId) {
        const sessions = Array.isArray(episode.data.sessionIds)
          ? (episode.data.sessionIds as string[])
          : typeof episode.data.sessionId === 'string'
            ? [episode.data.sessionId]
            : [];
        if (!sessions.includes(options.sessionId)) return false;
      }
      if (options.anchorKey && episode.data.anchorKey !== options.anchorKey) return false;
      return true;
    });
    return records
      .sort((a, b) => Number(b.data.focusSequence || 0) - Number(a.data.focusSequence || 0))
      .slice(0, Math.min(options.limit || 32, 100));
  }
  currentMatter(handle: ScopeHandle, sessionId: string) {
    const f = this.filter(handle), e = this.filter(handle, 'e');
    const row = this.db.prepare(`SELECT r.id,r.title,r.revision,r.status,json_extract(r.payload,'$.data.question') AS question,json_extract(r.payload,'$.data.nextStep') AS next_step,json_extract(r.payload,'$.data.updatedAt') AS updated_at
      FROM h_work r WHERE ${f.sql} AND r.kind='episode' AND r.status='active'
      AND (json_extract(r.payload,'$.data.sessionId')=? OR EXISTS(SELECT 1 FROM json_each(r.payload,'$.data.sessionIds') s WHERE s.value=?))
      AND NOT EXISTS(SELECT 1 FROM json_each(r.payload,'$.evidenceIds') ref WHERE NOT EXISTS(SELECT 1 FROM h_evidence e WHERE e.id=ref.value AND ${e.sql} AND e.status!='deleted'))
      ORDER BY r.rowid DESC LIMIT 1`).get(...f.params, sessionId, sessionId, ...e.params);
    if (!row) return null;
    this.recordAccess(handle, { ...row, source: 'work:self' }, 'current_matter');
    return { id: String(row.id), title: String(row.title), revision: Number(row.revision), question: row.question || null, nextStep: row.next_step || null, updatedAt: row.updated_at || null, meaning: '可能相关的未结束话题；当前原话优先，不适用时忽略。' };
  }
  addDependency(handle: ScopeHandle, d: Dependency) {
    this.scope(handle);
    const cycle = this.db
      .prepare(
        `WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT producer_id FROM h_dependencies JOIN chain ON consumer_id=chain.id) SELECT id FROM chain WHERE id=?`,
      )
      .get(d.producerId, d.consumerId);
    if (cycle) throw new HarnessError('dependency_cycle', '依赖关系形成循环。');
    this.db
      .prepare(
        'INSERT INTO h_dependencies VALUES(?,?,?,?,?) ON CONFLICT(consumer_id,producer_id) DO UPDATE SET producer_revision=excluded.producer_revision,sensitivity=excluded.sensitivity,invalidation=excluded.invalidation',
      )
      .run(d.consumerId, d.producerId, d.producerRevision, d.sensitivity, d.invalidation);
  }
  dependencies(consumerId: string): Dependency[] {
    return this.db
      .prepare(
        'SELECT consumer_id AS consumerId,producer_id AS producerId,producer_revision AS producerRevision,sensitivity,invalidation FROM h_dependencies WHERE consumer_id=?',
      )
      .all(consumerId) as unknown as Dependency[];
  }
  invalidate(producerId: string, reason = 'dependency_changed'): string[] {
    return this.write(() => {
      const affected: string[] = [],
        queue = [producerId],
        seen = new Set<string>();
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 2000) throw new HarnessError('dependency_budget', '依赖展开超出上限，暂停本轮更新。');
        for (const row of this.db.prepare('SELECT * FROM h_dependencies WHERE producer_id=?').all(id)) {
          const consumer = String(row.consumer_id);
          affected.push(consumer);
          queue.push(consumer);
          const world = parse<any>(this.db.prepare('SELECT payload FROM h_worlds WHERE id=?').get(consumer));
          if (world) {
            world.status = 'stale';
            world.invalidationReason = reason;
            this.db
              .prepare("UPDATE h_worlds SET status='stale',payload=? WHERE id=?")
              .run(JSON.stringify(world), consumer);
          }
          const work = parse<WorkRecord>(
            this.db.prepare('SELECT payload FROM h_work WHERE id=?').get(consumer),
          );
          if (work) {
            work.status = row.invalidation === 'block' ? 'blocked' : 'stale';
            work.revision++;
            work.data = { ...work.data, invalidationReason: reason };
            this.db
              .prepare('UPDATE h_work SET status=?,revision=?,payload=? WHERE id=?')
              .run(work.status, work.revision, JSON.stringify(work), consumer);
          }
          const action = parse<any>(
            this.db.prepare('SELECT payload FROM h_actions WHERE id=?').get(consumer),
          );
          if (action) {
            action.status = ['dispatching', 'outcome_unknown', 'reconciling', 'succeeded'].includes(
              action.status,
            )
              ? 'cancel_requested'
              : 'cancelled';
            action.reason = reason;
            this.db
              .prepare('UPDATE h_actions SET status=?,payload=? WHERE id=?')
              .run(action.status, JSON.stringify(action), consumer);
          }
          this.db
            .prepare(
              "UPDATE h_jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE object_id=? OR id=?",
            )
            .run(consumer, consumer);
          this.db.prepare('DELETE FROM h_runs WHERE id=?').run(consumer);
        }
      }
      return [...new Set(affected)];
    });
  }
  saveReceipt(handle: ScopeHandle, receipt: ContextReceipt) {
    const s = this.scope(handle);
    if (s.retention === 'session_only') return;
    this.write(() =>
      this.db
        .prepare(
          'INSERT INTO h_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,epoch=excluded.epoch',
        )
        .run(receipt.runId, s.principalId, s.workspaceId, this.epoch, JSON.stringify(receipt)),
    );
  }
  fences(): PrivacyFence[] {
    return this.db
      .prepare('SELECT payload FROM h_fences ORDER BY epoch')
      .all()
      .map((r) => parse<PrivacyFence>(r)!);
  }
  private fenceFile() {
    return this.databasePath === ':memory:' ? undefined : this.databasePath + '.privacy-fences.json';
  }
  private replacePolicyFile(file: string, payload: unknown) {
    const temp = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flush: true });
    // Windows indexers may briefly hold the destination. Keep the old complete
    // barrier intact and retry the atomic rename, never delete it first.
    for (let attempt = 0; ; attempt++) {
      try {
        this.fault?.('before_privacy_rename');
        fs.renameSync(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  }
  persistPolicyState() {
    const file = this.fenceFile();
    if (!file) return;
    const payload = {
      version: 1,
      minimumEpoch: this.epoch,
      policyRevision: this.policyRevision,
      fences: this.fences(),
      authorizations: {
        grants: this.getMeta<string[]>('grants', []),
        revoked: this.getMeta<string[]>('revoked', []),
      },
    };
    this.replacePolicyFile(file, payload);
  }
  establishFence(input: Omit<PrivacyFence, 'id' | 'epoch' | 'createdAt'>): PrivacyFence {
    const fence: PrivacyFence = {
      ...input,
      id: randomUUID(),
      epoch: this.epoch + 1,
      createdAt: this.clock.now(),
    };
    const file = this.fenceFile();
    if (file) {
      const fences = [...this.fences(), fence],
        grants = this.getMeta<string[] | undefined>('grants'),
        revoked = this.getMeta<string[]>('revoked', []);
      const authorizations = grants
        ? {
            grants: input.kind === 'revoke' ? grants.filter((g) => g !== input.scope) : grants,
            revoked:
              input.kind === 'revoke' && input.scope ? [...new Set([...revoked, input.scope])] : revoked,
          }
        : undefined;
      this.replacePolicyFile(file, {
        version: 1,
        minimumEpoch: fence.epoch,
        policyRevision: this.policyRevision + 1,
        fences,
        authorizations,
      });
    }
    this.write(() => {
      this.db.prepare('INSERT INTO h_fences VALUES(?,?,?)').run(fence.id, fence.epoch, JSON.stringify(fence));
      this.setMeta('privacy_epoch', fence.epoch);
      this.setMeta('policy_revision', this.policyRevision + 1);
      this.db
        .prepare("UPDATE h_outbox SET status='cancelled' WHERE epoch<? AND status='pending'")
        .run(fence.epoch);
      this.db
        .prepare(
          "UPDATE h_jobs SET status=CASE WHEN status='leased' THEN 'unknown' ELSE 'paused_privacy' END,fence=fence+1,lease_until=NULL WHERE epoch<? AND status IN ('queued','leased')",
        )
        .run(fence.epoch);
      this.db.prepare('DELETE FROM h_runs').run();
    });
    return fence;
  }
  revalidatePrivacyJobs() {
    this.write(() => {
      for (const row of this.db.prepare("SELECT * FROM h_jobs WHERE status='paused_privacy'").all()) {
        const action = this.db.prepare('SELECT status FROM h_actions WHERE id=?').get(String(row.object_id));
        const goal = row.goal_id
          ? this.db.prepare('SELECT status FROM h_work WHERE id=?').get(String(row.goal_id))
          : undefined;
        const invalid =
          this.hasFence(String(row.object_id), String(row.source)) ||
          (action &&
            ['cancelled', 'cancel_requested', 'cancellation_confirmed', 'cannot_cancel'].includes(
              String(action.status),
            )) ||
          (row.goal_id && goal?.status !== 'active');
        this.db
          .prepare('UPDATE h_jobs SET status=?,epoch=? WHERE id=?')
          .run(invalid ? 'cancelled' : 'queued', this.epoch, String(row.id));
      }
    });
  }
  private applyRestorationFences() {
    const file = this.fenceFile();
    if (!file || !fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number;
      minimumEpoch?: number;
      policyRevision?: number;
      fences: PrivacyFence[];
      authorizations?: { grants: string[]; revoked: string[] };
    };
    if (data.version !== 1 || !Array.isArray(data.fences))
      throw new HarnessError('invalid_privacy_barrier', '隐私恢复屏障损坏，暂不打开资料。');
    for (const fence of data.fences) {
      this.write(() => {
        this.db
          .prepare('INSERT OR IGNORE INTO h_fences VALUES(?,?,?)')
          .run(fence.id, fence.epoch, JSON.stringify(fence));
        this.setMeta('privacy_epoch', Math.max(this.epoch, fence.epoch));
      });
      if (fence.kind === 'delete') this.cleanupFence(fence);
      if (fence.kind === 'revoke' && fence.scope) {
        const revoked = this.getMeta<string[]>('revoked', []);
        this.setMeta('revoked', [...new Set([...revoked, fence.scope])]);
      }
    }
    this.setMeta('privacy_epoch', Math.max(this.epoch, data.minimumEpoch || 1));
    this.setMeta('policy_revision', Math.max(this.policyRevision, data.policyRevision || 1));
    if (data.authorizations) {
      this.setMeta('grants', data.authorizations.grants);
      this.setMeta('revoked', data.authorizations.revoked);
    }
    this.setMeta('restoration_fence_applied', true);
  }
  cleanupFence(fence: PrivacyFence) {
    if (fence.kind !== 'delete') return;
    // The marker commits with the cleanup. Restored older snapshots lack it and must
    // replay the fence; an already-clean database must preserve later independent work.
    if (this.getMeta('cleaned_fence:' + fence.id, false)) {
      this.clearMigrationBackups();
      return;
    }
    this.write(() => {
      const eventIds = new Set<string>(
        fence.sourceIds.flatMap((source) =>
          this.db
            .prepare(
              "SELECT id FROM h_evidence WHERE source=? OR id=? OR json_extract(payload,'$.locator.artifactId')=?",
            )
            .all(source, source, source)
            .map((r) => String(r.id)),
        ),
      );
      const affected = new Set<string>(),
        redactedSources = new Set<string>();
      for (const span of fence.spans || []) {
        const event = parse<EvidenceEvent>(
          this.db.prepare('SELECT payload FROM h_evidence WHERE id=?').get(span.eventId),
        );
        const legacy = this.db.prepare('SELECT content FROM messages WHERE id=?').get(span.eventId);
        const original = event?.text ?? (legacy ? String(legacy.content) : undefined);
        if (original === undefined) continue;
        const chars = Array.from(original);
        for (let i = span.start; i < Math.min(span.end, chars.length); i++) chars[i] = '█';
        const text = chars.join('');
        if (event) {
          event.text = text;
          event.status = 'redacted';
          this.db
            .prepare('UPDATE h_evidence SET content=?,status=?,payload=? WHERE id=?')
            .run(text, event.status, JSON.stringify(event), event.id);
          this.replaceIndex('evidence', event.id, text);
          redactedSources.add(event.id);
        }
        this.redactLegacyMessage(span.eventId, text);
      }
      for (const id of fence.objectIds) {
        if (this.db.prepare('SELECT id FROM h_evidence WHERE id=?').get(id)) eventIds.add(id);
        const refs = this.db
          .prepare('SELECT event_id,start_cp,end_cp FROM h_assertion_evidence WHERE assertion_id=?')
          .all(id);
        for (const ref of refs) {
          const eid = String(ref.event_id),
            event = parse<EvidenceEvent>(
              this.db.prepare('SELECT payload FROM h_evidence WHERE id=?').get(eid),
            );
          if (!event) continue;
          if (ref.start_cp === null || ref.end_cp === null) {
            eventIds.add(eid);
            continue;
          }
          const chars = Array.from(event.text);
          for (let i = Number(ref.start_cp); i < Number(ref.end_cp); i++) chars[i] = '█';
          event.text = chars.join('');
          event.status = 'redacted';
          this.db
            .prepare('UPDATE h_evidence SET content=?,status=?,payload=? WHERE id=?')
            .run(event.text, event.status, JSON.stringify(event), eid);
          this.replaceIndex('evidence', eid, event.text);
          this.redactLegacyMessage(eid, event.text);
          redactedSources.add(eid);
          this.db.prepare("UPDATE h_spans SET status='no_personal_fact',indexed=1 WHERE event_id=?").run(eid);
        }
        this.removeAssertion(id);
        for (const dependent of this.invalidate(id, 'source_deleted')) affected.add(dependent);
        this.db.prepare('DELETE FROM h_work WHERE id=?').run(id);
      }
      const roots = [...eventIds, ...redactedSources, ...fence.sourceIds],
        visited = new Set<string>();
      while (roots.length) {
        const root = roots.shift()!;
        if (visited.has(root)) continue;
        visited.add(root);
        for (const row of this.db
          .prepare('SELECT event_id FROM h_evidence_roots WHERE root_id=?')
          .all(root)) {
          const id = String(row.event_id);
          if (id === root || redactedSources.has(id)) continue;
          if (!eventIds.has(id)) {
            eventIds.add(id);
            roots.push(id);
          }
        }
      }
      for (const id of redactedSources)
        for (const dependent of this.invalidate(id, 'source_redacted')) affected.add(dependent);
      for (const id of eventIds) {
        for (const observation of this.db
          .prepare('SELECT id FROM h_observations WHERE evidence_id=?')
          .all(id))
          this.db.prepare('DELETE FROM h_observations WHERE id=?').run(String(observation.id));
        this.db.prepare('DELETE FROM h_domain WHERE evidence_id=?').run(id);
        const dependents = this.db
          .prepare('SELECT assertion_id FROM h_assertion_evidence WHERE event_id=?')
          .all(id);
        for (const dep of dependents) {
          const aid = String(dep.assertion_id);
          const assertion = parse<Assertion>(
            this.db.prepare('SELECT payload FROM h_assertions WHERE id=?').get(aid),
          );
          if (!assertion) continue;
          const remaining = assertion.evidenceIds.filter((e) => e !== id && !eventIds.has(e));
          if (!remaining.length) this.removeAssertion(aid);
          else {
            assertion.evidenceIds = remaining;
            assertion.status = 'candidate';
            assertion.verification = 'pending';
            assertion.text = '来源已变更，等待从保留证据重新核验';
            assertion.value = { type: 'unknown', reason: 'source_deleted' };
            assertion.revision++;
            this.db
              .prepare('UPDATE h_assertions SET status=?,text=?,payload=?,revision=? WHERE id=?')
              .run(assertion.status, assertion.text, JSON.stringify(assertion), assertion.revision, aid);
            this.db.prepare('DELETE FROM h_assertion_versions WHERE id=?').run(aid);
            this.db
              .prepare('DELETE FROM h_assertion_evidence WHERE assertion_id=? AND event_id=?')
              .run(aid, id);
            this.replaceIndex('assertion', aid, assertion.text);
          }
          for (const dependent of this.invalidate(aid, 'source_deleted')) affected.add(dependent);
        }
        const event = parse<EvidenceEvent>(
          this.db.prepare('SELECT payload FROM h_evidence WHERE id=?').get(id),
        );
        if (event) {
          if (event.parentEventId) {
            const parent = parse<EvidenceEvent>(
              this.db.prepare('SELECT payload FROM h_evidence WHERE id=?').get(event.parentEventId),
            );
            if (parent) {
              if (event.locator?.kind === 'text') {
                const chars = Array.from(parent.text);
                for (
                  let i = event.locator.startCodePoint;
                  i < Math.min(event.locator.endCodePoint, chars.length);
                  i++
                )
                  chars[i] = '█';
                parent.text = chars.join('');
                parent.status = 'redacted';
                this.db
                  .prepare('UPDATE h_evidence SET content=?,status=?,payload=? WHERE id=?')
                  .run(parent.text, parent.status, JSON.stringify(parent), parent.id);
                this.replaceIndex('evidence', parent.id, parent.text);
              }
              this.redactLegacyMessage(
                parent.id,
                parent.text + (event.kind === 'file_import' ? '\n[附件内容已删除]' : ''),
              );
            }
          }
          event.text = '';
          event.status = 'deleted';
          this.db
            .prepare("UPDATE h_evidence SET content='',status='deleted',payload=? WHERE id=?")
            .run(JSON.stringify(event), id);
        }
        this.db.prepare('DELETE FROM h_evidence_fts WHERE id=?').run(id);
        this.db.prepare("DELETE FROM h_grams WHERE kind='evidence' AND object_id=?").run(id);
        this.db.prepare('DELETE FROM h_spans WHERE event_id=?').run(id);
        this.redactLegacyMessage(id, '[这段内容已删除]');
        for (const dependent of this.invalidate(id, 'source_deleted')) affected.add(dependent);
      }
      for (const id of [...eventIds, ...redactedSources]) {
        this.db.prepare("DELETE FROM h_domain_versions WHERE json_extract(payload,'$.evidenceId')=?").run(id);
        for (const row of this.db
          .prepare(
            "SELECT id FROM h_work WHERE EXISTS(SELECT 1 FROM json_each(h_work.payload,'$.evidenceIds') e WHERE e.value=?)",
          )
          .all(id))
          affected.add(String(row.id));
      }
      for (const id of affected) {
        const calendar = this.db.prepare('SELECT agenda_id,revision FROM h_calendar_versions WHERE id=?').get(id);
        if (calendar) {
          this.db.prepare("DELETE FROM agenda WHERE id=? AND COALESCE(json_extract(payload,'$.revision'),1)=?").run(String(calendar.agenda_id), Number(calendar.revision));
          this.db.prepare('DELETE FROM h_calendar_versions WHERE id=?').run(id);
        }
        const outputRow = this.db
          .prepare("SELECT payload FROM messages WHERE id=? AND role='assistant'")
          .get(id);
        if (outputRow) {
          const output = this.clearedMessage(JSON.parse(String(outputRow.payload)), '[相关来源已更改，这段旧回复已停止使用]');
          this.db
            .prepare('UPDATE messages SET content=?,payload=? WHERE id=?')
            .run(output.content, JSON.stringify(output), id);
        }
        const worldRow = this.db.prepare('SELECT payload FROM h_worlds WHERE id=?').get(id);
        if (worldRow) {
          const world = JSON.parse(String(worldRow.payload));
          world.status = 'stale';
          world.assumptions = {};
          world.baseline = [];
          world.domainRefs = [];
          world.evidenceIds = [];
          this.db
            .prepare("UPDATE h_worlds SET status='stale',payload=? WHERE id=?")
            .run(JSON.stringify(world), id);
        }
        const work = parse<WorkRecord>(this.db.prepare('SELECT payload FROM h_work WHERE id=?').get(id));
        if (work) {
          work.status = 'stale';
          work.title = '相关来源已删除，等待重新核对';
          work.data = { invalidationReason: 'source_deleted', requiresRebuild: true };
          work.evidenceIds = work.evidenceIds.filter((e) => !eventIds.has(e));
          this.db
            .prepare('UPDATE h_work SET status=?,title=?,payload=? WHERE id=?')
            .run(work.status, work.title, JSON.stringify(work), id);
        }
        const action = parse<any>(this.db.prepare('SELECT payload FROM h_actions WHERE id=?').get(id));
        if (action) {
          action.arguments = {};
          delete action.compensation;
          action.audience = 'redacted';
          action.reason = 'source_deleted_details_removed';
          this.db.prepare('UPDATE h_actions SET payload=? WHERE id=?').run(JSON.stringify(action), id);
          this.db.prepare('DELETE FROM agenda WHERE id=?').run(id);
        }
      }
      // Derived views are cheap and are rebuilt only from surviving sources; never keep old textual summaries.
      this.db
        .prepare("DELETE FROM h_work WHERE kind IN ('experience','hypothesis','feedback') AND status='stale'")
        .run();
      this.db.prepare('DELETE FROM h_proposals').run();
      this.db.prepare('DELETE FROM h_operations').run();
      this.db.prepare('DELETE FROM h_runs').run();
      this.db
        .prepare("UPDATE h_jobs SET payload='{}',status='cancelled',fence=fence+1 WHERE status='cancelled'")
        .run();
      this.db.prepare("DELETE FROM h_outbox WHERE status='cancelled'").run();
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get())
        this.db.prepare("UPDATE sessions SET summary='',summary_count=0").run();
      this.setMeta('cleaned_fence:' + fence.id, true);
    });
    this.clearMigrationBackups();
    this.revalidatePrivacyJobs();
  }
  private removeAssertion(id: string) {
    this.db.prepare('DELETE FROM h_assertion_fts WHERE id=?').run(id);
    this.db.prepare("DELETE FROM h_grams WHERE kind='assertion' AND object_id=?").run(id);
    this.db.prepare('DELETE FROM h_assertions WHERE id=?').run(id);
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE name='memories'").get())
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
  }
  private clearedMessage(message: Record<string, any>, content: string) {
    // Retain only structural fields. New semantic payloads (drafts, images,
    // alternate response text, future extensions) must not escape deletion.
    return { id: message.id, sessionId: message.sessionId, role: message.role, createdAt: message.createdAt,
      status: message.status === 'running' ? 'cancelled' : message.status, retention: message.retention,
      content, steps: [], obligations: [], actions: [] };
  }
  private redactLegacyMessage(id: string, content: string) {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get()) return;
    const row = this.db.prepare('SELECT payload,session_id FROM messages WHERE id=?').get(id);
    if (!row) return;
    const message = this.clearedMessage(JSON.parse(String(row.payload)), content);
    this.db
      .prepare('UPDATE messages SET content=?,payload=? WHERE id=?')
      .run(content, JSON.stringify(message), id);
    // Assistant messages may repeat the erased source without a precise locator. Redact that derived session conservatively.
    for (const output of this.db
      .prepare("SELECT id,payload FROM messages WHERE session_id=? AND role='assistant'")
      .all(row.session_id as string)) {
      const m = this.clearedMessage(JSON.parse(String(output.payload)), '[相关来源已更改，这段旧回复已停止使用]');
      this.db
        .prepare('UPDATE messages SET content=?,payload=? WHERE id=?')
        .run(m.content, JSON.stringify(m), output.id as string);
    }
    this.db
      .prepare("UPDATE sessions SET title='已整理的对话',summary='',summary_count=0 WHERE id=?")
      .run(row.session_id as string);
    this.db.prepare('DELETE FROM meta WHERE key=?').run('draft:' + row.session_id);
  }
  checkpointPrivacy() {
    if (this.databasePath !== ':memory:') {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }
}
