import { createHash } from 'node:crypto';
import {
  domainDeltaSchema,
  HarnessError,
  personalLabel,
  type DomainDelta,
  type DomainRecord,
  type ScopeHandle,
} from '../../shared/harness';
import type { KernelRepository } from './repository';
import type { PolicyKernel } from '../runtime/policy';
import { canonical } from '../runtime/semantics';
import { expandAgenda } from '../actions/calendar';
import type { Action } from '../../shared/types';

export class DomainService {
  onChanged?: () => void;
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
  ) {}
  apply(handle: ScopeHandle, raw: unknown) {
    const scope = this.policy.validate(handle),
      delta = domainDeltaSchema.parse(raw);
    if (!scope.sources.includes(delta.sourceId))
      throw new HarnessError('source_forbidden', '这个来源未获授权。');
    if (scope.retention === 'session_only')
      throw new HarnessError('retention_forbidden', '这次读取不保存到本地资料。');
    if (delta.completeness === 'complete' && delta.errors.length)
      throw new HarnessError('incomplete_sync', '含错误的抓取不能声明完整覆盖。');
    for (const record of delta.upserts) {
      const e = this.repo.evidence(handle, record.evidenceId);
      if (!e || e.sourceId !== delta.sourceId)
        throw new HarnessError('evidence_mismatch', '分域更新缺少同一来源的证据。');
    }
    const fingerprint = createHash('sha256').update(canonical(delta)).digest('hex');
    if (this.repo.operation('domain:' + fingerprint)) return { status: 'duplicate' };
    this.repo.write(() => {
      // Failed/partial deltas retain unaffected domains and do not use absence as a tombstone.
      for (const key of delta.scopeKeys) {
        const old = this.repo.db
          .prepare(
            'SELECT cursor FROM h_sync WHERE source=? AND domain=? AND institution=? AND term=? AND scope_key=?',
          )
          .get(delta.sourceId, delta.domain, delta.institutionId, delta.termId, key);
        if (delta.fromCursor !== undefined && old?.cursor !== delta.fromCursor)
          throw new HarnessError('cursor_conflict', '同步游标已变化，需要重新读取。');
        this.repo.db
          .prepare(
            'INSERT INTO h_sync VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,domain,institution,term,scope_key) DO UPDATE SET status=excluded.status,cursor=excluded.cursor,payload=excluded.payload',
          )
          .run(
            delta.sourceId,
            delta.domain,
            delta.institutionId,
            delta.termId,
            key,
            delta.completeness,
            delta.completeness === 'failed' ? String(old?.cursor || '') : delta.toCursor || null,
            JSON.stringify({
              fetchedAt: delta.fetchedAt,
              observedAt: delta.observedAt,
              errors: delta.errors,
              scopeKeys: delta.scopeKeys,
              completeness: delta.completeness,
            }),
          );
      }
      if (delta.completeness === 'failed') {
        this.repo.completeOperation('domain:' + fingerprint, 'domain_failed', {});
        return;
      }
      for (const record of delta.upserts) {
        const e = this.repo.evidence(handle, record.evidenceId)!;
        const old = this.repo.db
          .prepare(
            'SELECT revision,payload FROM h_domain WHERE id=? AND source=? AND domain=? AND institution=? AND term=?',
          )
          .get(record.recordId, delta.sourceId, delta.domain, delta.institutionId, delta.termId);
        const revision = Number(old?.revision || 0) + 1;
        const previous = old ? (JSON.parse(String(old.payload)) as DomainRecord) : undefined;
        const value: DomainRecord = {
          id: record.recordId,
          sourceId: delta.sourceId,
          domain: delta.domain,
          institutionId: delta.institutionId,
          termId: delta.termId,
          revision,
          evidenceId: record.evidenceId,
          value: { ...previous?.value, ...record.value },
          status: delta.completeness === 'complete' ? 'fresh' : 'unknown',
          fetchedAt: delta.fetchedAt,
        };
        this.repo.db
          .prepare(
            `INSERT INTO h_domain VALUES(${Array(20).fill('?').join(',')}) ON CONFLICT(id,source,domain,institution,term) DO UPDATE SET
          revision=excluded.revision,status=excluded.status,evidence_id=excluded.evidence_id,fetched_at=excluded.fetched_at,payload=excluded.payload`,
          )
          .run(
            record.recordId,
            delta.sourceId,
            delta.domain,
            delta.institutionId,
            delta.termId,
            scope.principalId,
            scope.workspaceId,
            scope.subjectId,
            scope.worldId,
            e.label.purpose,
            e.label.audience,
            e.label.sensitivity,
            e.label.retention,
            e.label.infer ? 1 : 0,
            e.label.expiresAt || null,
            revision,
            value.status,
            record.evidenceId,
            delta.fetchedAt,
            JSON.stringify(value),
          );
        this.repo.db
          .prepare('INSERT INTO h_domain_versions VALUES(?,?,?,?,?,?,?)')
          .run(
            record.recordId,
            delta.sourceId,
            delta.domain,
            delta.institutionId,
            delta.termId,
            revision,
            JSON.stringify(value),
          );
        this.repo.invalidate('domain:' + delta.domain + ':' + record.recordId, 'domain_changed');
      }
      const removals = new Set(delta.tombstones);
      if (delta.completeness === 'complete') {
        const scoped = this.repo.db
          .prepare(
            'SELECT id,payload FROM h_domain WHERE source=? AND domain=? AND institution=? AND term=? AND owner=? AND workspace=? AND subject=? AND world=?',
          )
          .all(
            delta.sourceId,
            delta.domain,
            delta.institutionId,
            delta.termId,
            scope.principalId,
            scope.workspaceId,
            scope.subjectId,
            scope.worldId,
          );
        const present = new Set(delta.upserts.map((u) => u.recordId));
        for (const row of scoped) {
          const record = JSON.parse(String(row.payload)) as DomainRecord;
          const key = String(record.value.scopeKey || 'all');
          if (delta.scopeKeys.includes(key) && !present.has(String(row.id))) removals.add(String(row.id));
        }
      }
      for (const id of removals) {
        this.repo.db
          .prepare(
            "UPDATE h_domain SET status='known_absent' WHERE id=? AND source=? AND domain=? AND institution=? AND term=? AND owner=? AND workspace=? AND subject=? AND world=?",
          )
          .run(
            id,
            delta.sourceId,
            delta.domain,
            delta.institutionId,
            delta.termId,
            scope.principalId,
            scope.workspaceId,
            scope.subjectId,
            scope.worldId,
          );
        this.repo.invalidate('domain:' + delta.domain + ':' + id, 'domain_removed');
      }
      this.repo.setMeta('domain_revision', this.repo.domainRevision + 1);
      this.repo.completeOperation('domain:' + fingerprint, 'domain_delta', { domain: delta.domain });
      this.repo.outbox('domain_changed', delta.domain);
    });
    this.onChanged?.();
    return { status: delta.completeness };
  }
  read(
    handle: ScopeHandle,
    domain: string,
    options: {
      institutionId?: string;
      termId?: string;
      id?: string;
      from?: string;
      to?: string;
      query?: string;
      limit?: number;
    } = {},
  ): DomainRecord[] {
    const f = this.repo.filter(handle);
    const rows = this.repo.db
      .prepare(
        `SELECT r.* FROM h_domain r WHERE ${f.sql} AND r.domain=? AND r.status!='known_absent'
      ${options.institutionId ? 'AND r.institution=?' : ''} ${options.termId ? 'AND r.term=?' : ''} ${options.id ? 'AND r.id=?' : ''}
      ${options.from ? "AND (json_extract(r.payload,'$.value.endsAt') IS NULL OR julianday(json_extract(r.payload,'$.value.endsAt'))>julianday(?))" : ''}
      ${options.to ? "AND (json_extract(r.payload,'$.value.startsAt') IS NULL OR julianday(json_extract(r.payload,'$.value.startsAt'))<julianday(?))" : ''}
      ${options.query ? "AND r.payload LIKE ? ESCAPE '\\'" : ''} ORDER BY r.rowid DESC LIMIT ?`,
      )
      .all(
        ...f.params,
        domain,
        ...(options.institutionId ? [options.institutionId] : []),
        ...(options.termId ? [options.termId] : []),
        ...(options.id ? [options.id] : []),
        ...(options.from ? [options.from] : []),
        ...(options.to ? [options.to] : []),
        ...(options.query ? ['%' + options.query.replace(/[\\%_]/g, '\\$&') + '%'] : []),
        Math.min(options.limit || 500, 6000),
      );
    return rows.map((row) => {
      this.repo.access.push({
        principalId: this.repo.identity.principalId,
        scopeId: handle.id,
        purposes: this.policy.validate(handle).purposes,
        source: String(row.source),
        objectId: String(row.id),
        kind: 'domain',
      });
      return { ...JSON.parse(String(row.payload)), status: String(row.status) } as DomainRecord;
    });
  }
  resolve(
    handle: ScopeHandle,
    domain: string,
    options: {
      institutionId?: string;
      termId?: string;
      id?: string;
      from?: string;
      to?: string;
      query?: string;
      limit?: number;
    } = {},
  ) {
    const records = this.read(handle, domain, options),
      byId = new Map<string, DomainRecord[]>();
    for (const record of records) {
      const key = [record.institutionId, record.termId, record.id].join(':');
      byId.set(key, [...(byId.get(key) || []), record]);
    }
    const conflicts = [...byId.values()].filter(
      (group) => new Set(group.map((r) => canonical(r.value))).size > 1,
    );
    return {
      status: conflicts.length
        ? 'conflict'
        : records.length
          ? records.some((r) => r.status === 'unknown')
            ? 'unknown'
            : 'fresh'
          : 'not_found',
      records,
      conflicts,
    };
  }
  /** Select only busy interval columns in SQLite, before any model receives calendar data. Private titles never enter this projection. */
  availability(handle: ScopeHandle, from?: string, to?: string) {
    const s = this.policy.validate(handle);
    if (!s.grants.includes('availability:share')) throw new HarnessError('projection_forbidden', '尚未允许共享忙闲时段。');
    const windowFrom = from || this.repo.clock.now(), windowTo = to || new Date(Date.parse(windowFrom) + 7 * 86400000).toISOString();
    const intervals: { start: string; end: string }[] = [];
    const issues: unknown[] = [];
    if (s.sources.includes('local-agenda')) {
      const local = this.repo.db.prepare(`SELECT json_extract(g.payload,'$.startsAt') AS start,json_extract(g.payload,'$.durationMinutes') AS duration,
        json_extract(g.payload,'$.kind') AS kind,json_extract(g.payload,'$.timeZone') AS zone,json_extract(g.payload,'$.allDayDate') AS all_day,
        json_extract(g.payload,'$.recurrence') AS recurrence,
        (SELECT json_group_array(json_object('onDate',json_extract(x.value,'$.onDate'),'startsAt',json_extract(x.value,'$.startsAt'),'durationMinutes',json_extract(x.value,'$.durationMinutes'),'cancelled',json_extract(x.value,'$.cancelled'))) FROM json_each(g.payload,'$.exceptions') x) AS exceptions
        FROM agenda g WHERE COALESCE(json_extract(g.payload,'$.done'),0)=0 AND (json_extract(g.payload,'$.kind') IS NULL OR json_extract(g.payload,'$.kind') IN ('event','time_block'))`).all();
      const entries = local.map((row, index) => ({ id: 'busy-' + index, title: '', detail: '', kind: row.kind || 'event',
        ...(row.start ? { startsAt: row.start } : {}), ...(row.duration ? { durationMinutes: row.duration } : {}),
        timeZone: row.zone || 'Asia/Shanghai', ...(row.all_day ? { allDayDate: row.all_day } : {}),
        ...(row.recurrence ? { recurrence: JSON.parse(String(row.recurrence)) } : {}), ...(row.exceptions ? { exceptions: JSON.parse(String(row.exceptions)) } : {}),
      })) as Action[];
      const expanded = expandAgenda(entries, windowFrom, windowTo, 'Asia/Shanghai');
      for (const item of expanded.items) {
        const bounds = item.dateBounds as { from: string; to: string } | undefined;
        if (bounds) intervals.push({ start: bounds.from, end: bounds.to });
        else if (typeof item.startsAt === 'string' && typeof item.endsAt === 'string') intervals.push({ start: item.startsAt, end: item.endsAt });
        else if (item.startsAt) issues.push({ status: 'unknown_end', start: item.startsAt });
      }
      issues.push(...expanded.issues);
      this.repo.access.push({ principalId: s.principalId, scopeId: handle.id, purposes: s.purposes, source: 'local-agenda', objectId: 'busy-window', kind: 'availability_projection' });
    }
    const unique = [...new Map(intervals.map(interval => [interval.start + ':' + interval.end, interval])).values()];
    const uncertain = issues.length > 0;
    return { participant: '本人', sourceIds: s.sources.filter(source => source === 'local-agenda'), busyIntervals: unique, issues, status: uncertain ? 'partial' : unique.length ? 'fresh' : 'known_absent',
      meaning: '这些是忙碌区间，不是有空区间；范围仅为当前保留的本地安排。',
      coverage: { completeForRetainedRecords: !uncertain, externalCoverageConfirmed: false }, window: { from: windowFrom, to: windowTo } };
  }
}
