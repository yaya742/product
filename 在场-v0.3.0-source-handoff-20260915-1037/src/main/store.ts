import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  DEEPSEEK_MODEL,
  type Action,
  type Conversation,
  type Memory,
  type Message,
  type Settings,
  type State,
} from '../shared/types';
import { terms } from '../shared/schemas';
import { KernelRepository } from './storage/repository';
import { RuntimeCoordinator } from './runtime/coordinator';
import type { ClockPort, HostIdentity } from '../shared/harness';
import { redactExport } from './runtime/redaction';
import { assertTestStoreFile } from './testBoundary';
import type { PluginManagerOptions } from './plugins/manager';

export class Store {
  db: DatabaseSync;
  readonly kernel: KernelRepository;
  readonly runtime: RuntimeCoordinator;
  constructor(
    path: string,
    options: { clock?: ClockPort; identity?: HostIdentity; pluginRoot?: string; pluginRunnerPath?: string } = {},
  ) {
    assertTestStoreFile(path);
    this.db = new DatabaseSync(path);
    const hadHistoryIndex = !!this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', summary_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, quote TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agenda (id TEXT PRIMARY KEY, payload TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES(new.rowid, new.content); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content) VALUES('delete', old.rowid, old.content); END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content) VALUES('delete', old.rowid, old.content); INSERT INTO messages_fts(rowid,content) VALUES(new.rowid,new.content); END;`);
    if (!hadHistoryIndex) this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    this.kernel = new KernelRepository(this.db, path, options.clock, options.identity);
    const pluginOptions: PluginManagerOptions = {
      root: options.pluginRoot,
      runnerPath: options.pluginRunnerPath,
    };
    this.runtime = new RuntimeCoordinator(this, this.kernel, pluginOptions);
    for (const row of this.db.prepare('SELECT payload FROM messages').all()) {
      const message = JSON.parse(String(row.payload)) as Message;
      if (message.status === 'running') {
        message.status = 'cancelled';
        message.content ||= '上次的处理已中断，可以重新发送。';
        message.steps = message.steps.map((s) =>
          s.status === 'running' ? { ...s, status: 'cancelled' } : s,
        );
        message.obligations = message.obligations.map((o) =>
          o.status === 'pending' || o.status === 'running' ? { ...o, status: 'blocked' } : o,
        );
        this.putMessage(message);
      }
    }
  }
  meta<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }
  putMeta(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  settings(): Settings {
    return {
      ...DEFAULT_SETTINGS,
      ...this.meta<Partial<Settings>>('settings', {}),
      model: DEEPSEEK_MODEL,
      hasKey: false,
    };
  }
  saveSettings(value: Partial<Settings>) {
    if (this.runtime) {
      const previous = this.settings();
      if (value.memoryEnabled === false && previous.memoryEnabled) this.runtime.policy.signalBarrier();
      if (value.remindersEnabled !== undefined)
        this.runtime.reminders.configure({ enabled: value.remindersEnabled });
      if (value.timeZone !== undefined) this.runtime.reminders.configure({ timeZone: value.timeZone });
    }
    this.putMeta('settings', { ...this.settings(), ...value, model: DEEPSEEK_MODEL, hasKey: false });
  }
  session(id?: string, title = '新的对话'): string {
    if (id && this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) return id;
    const newId = id || randomUUID();
    this.db
      .prepare('INSERT INTO sessions(id,title,updated_at) VALUES (?,?,?)')
      .run(newId, title.slice(0, 36), new Date().toISOString());
    return newId;
  }
  conversations(): Conversation[] {
    return this.db
      .prepare('SELECT id,title,updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC')
      .all() as unknown as Conversation[];
  }
  messages(id: string): Message[] {
    return this.db
      .prepare('SELECT payload FROM messages WHERE session_id=? ORDER BY created_at, rowid')
      .all(id)
      .map((r) => JSON.parse(String(r.payload)));
  }
  putMessage(m: Message) {
    if (m.retention === 'session_only') return;
    if (
      this.runtime &&
      m.role === 'user' &&
      !this.db.prepare('SELECT id FROM h_evidence WHERE id=?').get(m.id)
    ) {
      const run = this.runtime.begin(m.content, m.id, m.sessionId, new AbortController().signal);
      if (run.ephemeral) return;
    }
    this.kernel.write(() => {
      this.db
        .prepare(
          'INSERT INTO messages VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,payload=excluded.payload',
        )
        .run(m.id, m.sessionId, m.role, m.content, m.createdAt, JSON.stringify(m));
      this.db
        .prepare('UPDATE sessions SET updated_at=? WHERE id=?')
        .run(new Date().toISOString(), m.sessionId);
      if (m.role === 'assistant' && m.contextReceipt) {
        const scope = this.runtime.policy.hostScope();
        for (const source of new Set([
          ...m.contextReceipt.providedEvidenceIds,
          ...(m.contextReceipt.providedSourceIds || []),
          ...(m.releaseArtifacts || []).flatMap(artifact => artifact.sourceMessageIds || [artifact.sourceMessageId]),
        ]))
          this.kernel.addDependency(scope, {
            consumerId: m.id,
            producerId: source,
            producerRevision: 0,
            sensitivity: 'privacy',
            invalidation: 'block',
          });
      }
    });
  }
  summary(id: string): { text: string; count: number } {
    const r = this.db.prepare('SELECT summary,summary_count FROM sessions WHERE id=?').get(id);
    return { text: String(r?.summary || ''), count: Number(r?.summary_count || 0) };
  }
  saveSummary(id: string, text: string, count: number) {
    this.db.prepare('UPDATE sessions SET summary=?,summary_count=? WHERE id=?').run(text, count, id);
  }
  search(query: string, excludeId = '') {
    const words = terms(query);
    if (!words.length) return [];
    const sql = `SELECT m.id,m.session_id AS sessionId,m.role,m.content,m.created_at AS createdAt,s.title FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id != ?`;
    if (words.every((w) => [...w].length >= 3)) {
      const match = words.map((w) => '"' + w.replaceAll('"', '""') + '"').join(' AND ');
      return this.db
        .prepare(
          sql +
            ' AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY m.created_at DESC LIMIT 6',
        )
        .all(excludeId, match)
        .map((r) => ({ ...r, content: String(r.content).slice(0, 1600) }));
    }
    const patterns = words.map((w) => '%' + w.replace(/[\\%_]/g, '\\$&') + '%');
    return this.db
      .prepare(
        sql +
          words.map(() => " AND lower(m.content) LIKE ? ESCAPE '\\'").join('') +
          ' ORDER BY m.created_at DESC LIMIT 6',
      )
      .all(excludeId, ...patterns)
      .map((r) => ({ ...r, content: String(r.content).slice(0, 1600) }));
  }
  memories(): Memory[] {
    return this.runtime.memories();
  }
  saveMemory(text: string, quote = '你在记忆面板中填写', id?: string): Memory {
    return this.runtime.saveMemoryControl(text, id);
  }
  deleteMemory(id: string) {
    this.runtime.memory.forget([id]);
  }
  agenda(): Action[] {
    return this.db
      .prepare('SELECT payload FROM agenda ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  saveAction(item: Action) {
    this.writeAgendaProjection(item);
    this.runtime.reminders.schedule(item);
  }
  writeAgendaProjection(item: Action) {
    const offeredRow = this.db
      .prepare(
        "SELECT a.value FROM messages m,json_each(m.payload,'$.actions') a WHERE json_extract(a.value,'$.id')=? ORDER BY m.rowid DESC LIMIT 1",
      )
      .get(item.id);
    const offered = offeredRow ? (JSON.parse(String(offeredRow.value)) as Action) : undefined;
    const priorRow = this.db.prepare('SELECT payload FROM agenda WHERE id=?').get(item.id);
    const prior = priorRow ? (JSON.parse(String(priorRow.payload)) as Action) : undefined;
    const projection = {
      ...item,
      coverage: offered?.coverage || prior?.coverage || item.coverage,
      missingNeeds: offered?.missingNeeds || prior?.missingNeeds || item.missingNeeds,
      saved: true,
    };
    this.db
      .prepare(
        'INSERT INTO agenda(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(item.id, JSON.stringify(projection));
    if (this.runtime) this.kernel.registerCalendarVersion(this.runtime.policy.hostScope(), item.id, item.revision || 1, item.effectActionId || item.id);
  }
  deleteAction(id: string) {
    this.runtime.reminders.cancel(id);
    this.db.prepare('DELETE FROM agenda WHERE id=?').run(id);
  }
  due(now: number): Action[] {
    return this.db
      .prepare('SELECT payload FROM agenda WHERE notified=0')
      .all()
      .map((r) => JSON.parse(String(r.payload)) as Action)
      .filter(
        (a) =>
          !a.done && a.startsAt && Date.parse(a.startsAt) <= now && Date.parse(a.startsAt) > now - 3600_000,
      );
  }
  markNotified(id: string) {
    this.db.prepare('UPDATE agenda SET notified=1 WHERE id=?').run(id);
  }
  deleteSession(id: string) {
    const sourceIds = this.db
      .prepare('SELECT id FROM messages WHERE session_id=?')
      .all(id)
      .map((r) => String(r.id));
    if (sourceIds.length) this.runtime.memory.forget([], sourceIds);
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    this.db.prepare('DELETE FROM meta WHERE key=?').run('draft:' + id);
  }
  clear() {
    const ids = this.db
      .prepare('SELECT id FROM h_evidence')
      .all()
      .map((r) => String(r.id));
    const objects = this.db
      .prepare('SELECT id FROM h_assertions UNION SELECT id FROM h_work')
      .all()
      .map((r) => String(r.id));
    const fence = this.kernel.establishFence({ kind: 'delete', objectIds: objects, sourceIds: ids });
    this.runtime.policy.signalBarrier();
    this.kernel.cleanupFence(fence);
    this.kernel.write(() => {
      for (const table of [
        'h_receipts',
        'h_attempts',
        'h_approvals',
        'h_actions',
        'h_deliveries',
        'h_jobs',
        'h_domain_versions',
        'h_calendar_versions',
        'h_domain',
        'h_sync',
        'h_observation_versions',
        'h_observations',
        'h_evidence_roots',
        'h_assertion_evidence',
        'h_assertion_versions',
        'h_assertions',
        'h_spans',
        'h_evidence',
        'h_work',
        'h_worlds',
        'h_aliases',
        'h_dependencies',
        'h_outbox',
        'h_operations',
        'h_runs',
        'h_proposals',
        'h_grams',
        'h_watches',
        'h_source_restrictions',
        'h_sync_operations',
      ])
        this.db.exec('DELETE FROM ' + table);
      this.db.exec('DELETE FROM h_evidence_fts; DELETE FROM h_assertion_fts;');
      this.db
        .prepare(
          "DELETE FROM h_meta WHERE key NOT IN ('identity','privacy_epoch','policy_revision','registered_sources','legacy_migrated')",
        )
        .run();
      this.kernel.setMeta('received_seq', 0);
      this.kernel.setMeta('sequence_base', 0);
    });
    this.db.exec(
      'BEGIN; DELETE FROM messages; DELETE FROM sessions; DELETE FROM memories; DELETE FROM agenda; DELETE FROM meta; COMMIT; VACUUM;',
    );
    this.runtime.interfaces.restore();
  }
  state(hasKey: boolean): State {
    return {
      privacyEpoch: this.kernel.epoch,
      policyRevision: this.kernel.policyRevision,
      settings: { ...this.settings(), hasKey },
      conversations: this.conversations(),
      memories: this.memories(),
      agenda: this.agenda(),
      interfaces: this.runtime.interfaces.list(),
      plugins: this.runtime.plugins.list(),
    };
  }
  export() {
    const { principalId, workspaceId } = this.kernel.identity;
    const owned = (table: string, extra = '') =>
      this.db
        .prepare(`SELECT payload FROM ${table} WHERE owner=? AND workspace=? ${extra}`)
        .all(principalId, workspaceId)
        .map((r) => JSON.parse(String(r.payload)));
    const labelFilter = "AND retain!='session_only' AND sensitivity!='restricted'";
    return redactExport({
      version: 1,
      manifest: {
        schema_version: '1',
        at_rest_encrypted: false,
        privacy_epoch: this.kernel.epoch,
        excluded: ['credentials', 'deleted_content', 'ephemeral_content', 'opaque_model_state'],
      },
      exportedAt: new Date().toISOString(),
      settings: this.settings(),
      sessions: this.conversations().map((s) => ({ ...s, messages: this.messages(s.id) })),
      drafts: Object.fromEntries(
        this.db
          .prepare("SELECT key,value FROM meta WHERE key LIKE 'draft:%'")
          .all()
          .map((r) => [String(r.key).slice(6), JSON.parse(String(r.value))]),
      ),
      memories: this.memories(),
      agenda: this.agenda(),
      evidence: owned('h_evidence', labelFilter + " AND status!='deleted'"),
      assertions: owned('h_assertions', labelFilter),
      work: owned('h_work', labelFilter),
      worlds: owned('h_worlds'),
      actions: owned('h_actions'),
      domainRecords: owned('h_domain', labelFilter + " AND status!='known_absent'"),
      privacyFences: this.kernel.fences(),
    });
  }
  close() {
    void this.runtime.plugins.close();
    if (this.db.isOpen) this.db.close();
  }
}
