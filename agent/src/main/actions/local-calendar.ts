import type { Action } from '../../shared/types';
import type { EffectAction } from '../../shared/harness';
import { HarnessError } from '../../shared/harness';
import { localCalendarChangeSchema } from '../../shared/calendar';
import type { Store } from '../store';
import type { ReminderRuntime } from './reminders';
import { normalizeCalendarInput } from './calendar';
import { canonical } from '../runtime/semantics';

export interface LocalEffectResult { recordId: string; previous: Action | null; current: Action | null; applied: boolean }

/** Invoked inside ActionRuntime's transaction, after approval and preflight. */
export class LocalCalendarService {
  constructor(private store: Store, private reminders: ReminderRuntime) {}
  read(id: string): Action | undefined {
    const row = this.store.db.prepare('SELECT payload FROM agenda WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  apply(projection: Action, effect?: EffectAction): LocalEffectResult {
    if (!effect || effect.capability === 'local.agenda.save') {
      const previous = this.read(projection.id) || null;
      const current = { ...projection, effectActionId: effect?.id || projection.id };
      this.store.writeAgendaProjection(current);
      this.reminders.schedule(projection, effect?.goalId || projection.goalId);
      return { recordId: projection.id, previous, current, applied: true };
    }
    const args = localCalendarChangeSchema.parse(effect.arguments), previous = this.read(args.targetId);
    if (!previous) {
      if (args.operation === 'delete') return { recordId: args.targetId, previous: null, current: null, applied: false };
      throw new HarnessError('calendar_missing', '这个安排已经不存在，尚未修改。');
    }
    if ((previous.revision || 1) !== args.expectedRevision) throw new HarnessError('revision_conflict', '安排已在其他地方改变，请先读取当前版本。');
    if (args.operation === 'delete') {
      this.reminders.cancel(args.targetId);
      this.store.db.prepare('DELETE FROM agenda WHERE id=?').run(args.targetId);
      return { recordId: args.targetId, previous, current: null, applied: true };
    }
    let changed: Action;
    if (args.operation === 'change_occurrence') {
      if (!args.occurrenceDate || !previous.recurrence) throw new HarnessError('occurrence_missing', '单次修改需要指定系列和原发生日期。');
      if (Object.keys(args.changes || {}).some(key => !['startsAt', 'durationMinutes', 'detail'].includes(key)))
        throw new HarnessError('occurrence_fields', '单次例外只能改该次时间、时长或说明，不改变整个系列。');
      if (args.changes?.startsAt === null) throw new HarnessError('occurrence_time', '单次事件不能抹掉开始时刻；不再发生时请取消该实例。');
      const exception = { ...(previous.exceptions || []).find(item => item.onDate === args.occurrenceDate), onDate: args.occurrenceDate,
        ...(args.cancelled !== undefined ? { cancelled: args.cancelled } : {}), ...(args.changes || {}) };
      changed = { ...previous, exceptions: [...(previous.exceptions || []).filter(item => item.onDate !== args.occurrenceDate), exception] } as Action;
    } else {
      const value: Record<string, unknown> = { ...previous, ...args.changes };
      for (const [key, field] of Object.entries(value)) if (field === null) delete value[key];
      if (args.changes?.recurrence === null) delete value.exceptions;
      changed = value as unknown as Action;
    }
    changed = normalizeCalendarInput(changed, this.store.settings().timeZone || 'Asia/Shanghai');
    if (!previous.kind && !args.changes?.kind) delete changed.kind; // Keep the existing legacy reminder policy on edit.
    if (canonical(changed) === canonical(previous)) return { recordId: args.targetId, previous, current: previous, applied: false };
    changed.revision = (previous.revision || 1) + 1;
    changed.effectActionId = effect.id;
    changed.approvalDigest = effect.digest;
    this.store.writeAgendaProjection(changed);
    if (changed.done || !(changed.remindAt || ((changed.kind === 'reminder' || !changed.kind) && changed.startsAt))) this.reminders.cancel(args.targetId);
    else this.reminders.schedule(changed, changed.goalId, undefined, { restore: !!previous.done && !changed.done });
    return { recordId: args.targetId, previous, current: changed, applied: true };
  }
  undo(effect: EffectAction) {
    const undo = effect.compensation;
    if (!undo?.applied) return;
    const current = this.read(undo.targetId);
    if ((current?.revision || 0) !== undo.expectedRevision) throw new HarnessError('undo_conflict', '安排已再次变化，不能用旧撤销覆盖它。');
    this.reminders.cancel(undo.targetId);
    if (!undo.previous) this.store.db.prepare('DELETE FROM agenda WHERE id=?').run(undo.targetId);
    else {
      const restored = { ...undo.previous, revision: Math.max(Number(undo.previous.revision || 1), undo.expectedRevision) + 1 } as unknown as Action;
      this.store.writeAgendaProjection(restored);
      this.reminders.schedule(restored, restored.goalId, undefined, { restore: true });
    }
  }
}
