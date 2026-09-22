import { randomUUID } from 'node:crypto';
import type { Action } from '../../shared/types';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from '../runtime/policy';
import { HarnessError } from '../../shared/harness';
import { expandAgenda } from './calendar';
import { dateInZone } from '../runtime/semantics';

export interface AttentionPolicy {
  quietWindows: [string, string][];
  timeZone: string;
  maxPerDay: number;
  cooldownMs: number;
  enabled: boolean;
}
export interface DeliveryPort {
  capabilities: {
    submitted: boolean;
    delivered: boolean;
    seen: boolean;
    stableId: boolean;
    closedApp: boolean;
  };
  submit(
    input: { id: string; title: string; body: string },
    signal: AbortSignal,
  ): Promise<{ status: 'submitted_to_os' | 'provider_delivered' | 'seen' | 'unknown'; externalId?: string }>;
  cancel?(id: string): Promise<void>;
}
interface Job {
  id: string;
  object_id: string;
  goal_id: string | null;
  epoch: number;
  due_at: string;
  status: string;
  lease_until: string | null;
  fence: number;
  attempts: number;
  dedup_key: string;
  payload: string;
}
export class ReminderRuntime {
  port?: DeliveryPort;
  private recurringRefresh = new Map<string, string>();
  readonly submitted: { id: string; status: string }[] = [];
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
  ) {}
  attention(): AttentionPolicy {
    return this.repo.getMeta<AttentionPolicy>('attention', {
      quietWindows: [['22:00', '08:00']],
      timeZone: 'Asia/Shanghai',
      maxPerDay: 3,
      cooldownMs: 600000,
      enabled: false,
    });
  }
  configure(value: Partial<AttentionPolicy>) {
    const next = { ...this.attention(), ...value };
    if (
      !Number.isInteger(next.maxPerDay) ||
      next.maxPerDay < 0 ||
      next.maxPerDay > 20 ||
      !Number.isFinite(next.cooldownMs) ||
      next.cooldownMs < 0 ||
      next.quietWindows.some((pair) => pair.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)))
    )
      throw new HarnessError('attention_policy', '提醒设置不合法。');
    new Intl.DateTimeFormat('en', { timeZone: next.timeZone });
    this.repo.write(() => this.repo.setMeta('attention', next));
  }
  schedule(action: Action, goalId?: string, expiresAt?: string, options: { restore?: boolean } = {}) {
    const requestedAt = action.remindAt || (action.kind === 'reminder' || !action.kind ? action.startsAt : undefined);
    if (!requestedAt || action.done) return;
    if (goalId && this.repo.db.prepare('SELECT status FROM h_work WHERE id=?').get(goalId)?.status !== 'active') { this.cancel(action.id); return; }
    const now = this.repo.clock.now();
    const recurring = action.kind === 'reminder' && !!action.recurrence;
    const horizon = recurring ? expandAgenda([action], new Date(Date.parse(now) - 3600000).toISOString(), new Date(Date.parse(now) + 90 * 86400000).toISOString(), action.timeZone || this.attention().timeZone) : undefined;
    const times = horizon ? horizon.items.map(item => item.startsAt).filter((at): at is string => typeof at === 'string') : [requestedAt];
    const keys = times.map(at => action.id + ':' + new Date(at).toISOString());
    this.repo.write(() => {
      this.repo.db.prepare(`UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE object_id=? AND status IN ('queued','leased') AND dedup_key NOT IN (SELECT value FROM json_each(?))`).run(action.id, JSON.stringify(keys));
      for (const time of times) {
        const startsAt = new Date(time).toISOString(), key = action.id + ':' + startsAt, id = randomUUID();
        const payload = JSON.stringify({ title: action.title, startsAt, expiresAt: expiresAt || (recurring ? new Date(Date.parse(startsAt) + 3600000).toISOString() : undefined), recurring });
        this.repo.db.prepare('INSERT OR IGNORE INTO h_jobs(id,kind,object_id,goal_id,source,epoch,due_at,status,dedup_key,payload) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, 'reminder', action.id, goalId || null, 'local-agenda', this.repo.epoch, startsAt, 'queued', key, payload);
        if (options.restore) this.repo.db.prepare(`UPDATE h_jobs SET status='queued',fence=fence+1,lease_until=NULL WHERE dedup_key=? AND status='cancelled' AND NOT EXISTS(SELECT 1 FROM h_deliveries d WHERE d.job_id=h_jobs.id AND d.status IN ('submitted_to_os','provider_delivered','seen'))`).run(key);
        this.repo.db.prepare("UPDATE h_jobs SET payload=? WHERE dedup_key=? AND status='queued'").run(payload, key);
        const jobId = String(this.repo.db.prepare('SELECT id FROM h_jobs WHERE dedup_key=?').get(key)!.id);
        const handle = this.policy.hostScope();
        this.repo.addDependency(handle, { consumerId: jobId, producerId: this.repo.calendarVersionId(action.id, action.revision || 1), producerRevision: 1, sensitivity: 'hard', invalidation: 'block' });
        if (goalId) this.repo.addDependency(handle, { consumerId: jobId, producerId: goalId, producerRevision: 1, sensitivity: 'hard', invalidation: 'block' });
      }
    });
    if (recurring) this.recurringRefresh.set(action.id, `${this.repo.epoch}:${action.revision || 1}:${dateInZone(now, action.timeZone || this.attention().timeZone)}`);
  }
  private maintainRecurring() {
    const rows = this.repo.db.prepare(`SELECT g.payload FROM agenda g LEFT JOIN h_actions a ON a.id=COALESCE(json_extract(g.payload,'$.effectActionId'),g.id) LEFT JOIN h_work goal ON goal.id=json_extract(g.payload,'$.goalId')
      WHERE json_extract(g.payload,'$.kind')='reminder' AND json_type(g.payload,'$.recurrence')='object' AND COALESCE(json_extract(g.payload,'$.done'),0)=0
      AND (a.id IS NULL OR a.status='succeeded') AND (json_extract(g.payload,'$.goalId') IS NULL OR goal.status='active') LIMIT 500`).all();
    for (const row of rows) {
      const action = JSON.parse(String(row.payload)) as Action;
      if (this.repo.hasFence(action.id, 'local-agenda')) continue;
      const key = `${this.repo.epoch}:${action.revision || 1}:${dateInZone(this.repo.clock.now(), action.timeZone || this.attention().timeZone)}`;
      if (this.recurringRefresh.get(action.id) !== key) this.schedule(action, action.goalId);
    }
  }
  cancel(actionId: string) {
    const jobs = this.repo.db.prepare('SELECT id FROM h_jobs WHERE object_id=?').all(actionId);
    this.repo.write(() =>
      this.repo.db
        .prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE object_id=?")
        .run(actionId),
    );
    this.repo.afterCommit(() => { for (const job of jobs) void this.port?.cancel?.(String(job.id)); });
  }
  private quiet() {
    const policy = this.attention(),
      time = new Intl.DateTimeFormat('en-GB', {
        timeZone: policy.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(this.repo.clock.now()));
    return policy.quietWindows.some(([from, to]) =>
      from <= to ? time >= from && time < to : time >= from || time < to,
    );
  }
  recover() {
    this.repo.write(() => {
      const now = this.repo.clock.now();
      for (const row of this.repo.db
        .prepare("SELECT * FROM h_jobs WHERE status='leased' AND lease_until<=?")
        .all(now)) {
        const delivery = this.repo.db
          .prepare('SELECT status FROM h_deliveries WHERE job_id=?')
          .get(String(row.id));
        // A lease expiring after OS submission cannot safely be blindly re-delivered on platforms without stable IDs.
        this.repo.db
          .prepare('UPDATE h_jobs SET status=?,fence=fence+1,lease_until=NULL WHERE id=?')
          .run(delivery ? 'unknown' : 'queued', String(row.id));
      }
    });
  }
  private lease(): Job | undefined {
    return this.repo.write(() => {
      const row = this.repo.db
        .prepare(
          "SELECT * FROM h_jobs WHERE status='queued' AND due_at<=? AND epoch=? ORDER BY due_at LIMIT 1",
        )
        .get(this.repo.clock.now(), this.repo.epoch) as unknown as Job | undefined;
      if (!row) return;
      const payload = JSON.parse(row.payload);
      if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.parse(this.repo.clock.now())) {
        this.repo.db.prepare("UPDATE h_jobs SET status='expired',fence=fence+1 WHERE id=?").run(row.id);
        return;
      }
      if (row.goal_id) {
        const goal = this.repo.db.prepare('SELECT status FROM h_work WHERE id=?').get(row.goal_id);
        if (!goal || goal.status !== 'active') {
          this.repo.db.prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE id=?").run(row.id);
          return;
        }
      }
      const leaseUntil = new Date(Date.parse(this.repo.clock.now()) + 60000).toISOString();
      this.repo.db
        .prepare(
          "UPDATE h_jobs SET status='leased',lease_until=?,fence=fence+1,attempts=attempts+1 WHERE id=? AND status='queued'",
        )
        .run(leaseUntil, row.id);
      return {
        ...row,
        status: 'leased',
        fence: row.fence + 1,
        attempts: row.attempts + 1,
        lease_until: leaseUntil,
      };
    });
  }
  async runDue(signal: AbortSignal = new AbortController().signal) {
    this.recover();
    this.maintainRecurring();
    const policy = this.attention();
    if (!policy.enabled || this.quiet() || !this.port?.capabilities.submitted) return;
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: policy.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(this.repo.clock.now()));
    const usage = this.repo.getMeta<{ date: string; count: number; lastAt?: string }>('attention_usage', {
      date,
      count: 0,
    });
    if (usage.date !== date) {
      usage.date = date;
      usage.count = 0;
      usage.lastAt = undefined;
    }
    if (
      usage.count >= policy.maxPerDay ||
      (usage.lastAt && Date.parse(this.repo.clock.now()) - Date.parse(usage.lastAt) < policy.cooldownMs)
    )
      return;
    // On resume, collapse old reminders into one review request; do not dump ten overdue notifications.
    const overdue = this.repo.db
      .prepare("SELECT id FROM h_jobs WHERE kind='reminder' AND status='queued' AND due_at<? AND epoch=?")
      .all(new Date(Date.parse(this.repo.clock.now()) - 3600000).toISOString(), this.repo.epoch);
    if (overdue.length > 1)
      this.repo.write(() => {
        for (const row of overdue.slice(1))
          this.repo.db.prepare("UPDATE h_jobs SET status='collapsed' WHERE id=?").run(String(row.id));
        this.repo.setMeta('catchup_summary_count', 1);
        this.repo.db
          .prepare('UPDATE h_jobs SET payload=? WHERE id=?')
          .run(
            JSON.stringify({ title: '之前留出的时间已过去，打开后可一起整理', catchup: true }),
            String(overdue[0].id),
          );
      });
    const job = this.lease();
    if (!job) return;
    const deliveryId = randomUUID();
    try {
      signal.throwIfAborted();
      const current = this.repo.db.prepare('SELECT fence,status,epoch FROM h_jobs WHERE id=?').get(job.id);
      if (
        current?.status !== 'leased' ||
        Number(current.fence) !== job.fence ||
        Number(current.epoch) !== this.repo.epoch
      )
        return;
      const payload = JSON.parse(job.payload);
      // Persist submission intent before touching the OS. Crash recovery treats an unresolved intent as unknown.
      this.repo.write(() =>
        this.repo.db
          .prepare('INSERT INTO h_deliveries VALUES(?,?,?,?,?)')
          .run(
            deliveryId,
            job.id,
            'unknown',
            job.dedup_key,
            JSON.stringify({ submittedAt: this.repo.clock.now(), fence: job.fence }),
          ),
      );
      const result = await this.port.submit(
        { id: job.id, title: '在场 · 到你留出的时间了', body: payload.title },
        signal,
      );
      this.repo.fault?.('after_notification_submit');
      if (
        (result.status === 'seen' && !this.port.capabilities.seen) ||
        (result.status === 'provider_delivered' && !this.port.capabilities.delivered)
      )
        throw new HarnessError('unsupported_receipt', '平台不能提供这种送达证明。');
      this.repo.write(() => {
        const latest = this.repo.db.prepare('SELECT fence,epoch,status FROM h_jobs WHERE id=?').get(job.id);
        if (
          latest?.status !== 'leased' ||
          Number(latest.fence) !== job.fence ||
          Number(latest.epoch) !== this.repo.epoch
        )
          return;
        this.repo.db
          .prepare('UPDATE h_deliveries SET status=?,payload=? WHERE id=?')
          .run(
            result.status,
            JSON.stringify({ ...result, submittedAt: this.repo.clock.now(), fence: job.fence }),
            deliveryId,
          );
        this.repo.db
          .prepare("UPDATE h_jobs SET status='done',lease_until=NULL WHERE id=? AND fence=?")
          .run(job.id, job.fence);
        this.repo.setMeta('attention_usage', { date, count: usage.count + 1, lastAt: this.repo.clock.now() });
      });
      this.submitted.push({ id: job.id, status: result.status });
    } catch (error) {
      this.repo.write(() =>
        this.repo.db
          .prepare(
            "UPDATE h_jobs SET status='unknown',lease_until=NULL WHERE id=? AND fence=? AND status='leased'",
          )
          .run(job.id, job.fence),
      );
      if (signal.aborted) throw error;
    }
  }
  capabilities() {
    return {
      closedAppReminders: false,
      delivery: this.port?.capabilities || {
        submitted: false,
        delivered: false,
        seen: false,
        stableId: false,
        closedApp: false,
      },
      duplicateRisk: !this.port?.capabilities.stableId,
    };
  }
}
