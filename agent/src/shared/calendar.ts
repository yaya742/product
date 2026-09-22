import { z } from 'zod';

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '日期不存在');
export const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(52).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('0=周日，1=周一，…，6=周六'),
  count: z.number().int().min(1).max(1000).optional(),
  untilDate: calendarDate.optional(),
}).strict();
export const occurrenceExceptionSchema = z.object({
  onDate: calendarDate,
  cancelled: z.boolean().optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  detail: z.string().max(1500).optional(),
}).strict();
export const calendarFieldsSchema = z.object({
  goalId: z.string().max(160).optional(),
  createNew: z.boolean().optional().describe('只有用户明确需要一个重复副本时才为true；重试或再次确认不使用。'),
  kind: z.enum(['event', 'todo', 'deadline', 'reminder', 'time_block']).optional(),
  timeZone: z.string().max(100).optional(),
  allDayDate: calendarDate.optional(),
  recurrence: recurrenceSchema.optional(),
  exceptions: z.array(occurrenceExceptionSchema).max(100).optional(),
  remindAt: z.string().datetime({ offset: true }).optional(),
});
export type CalendarFields = z.infer<typeof calendarFieldsSchema>;
export const localCalendarChangeSchema = z.object({
  operation: z.enum(['update', 'delete', 'change_occurrence']),
  targetId: z.string().min(1).max(160),
  expectedRevision: z.number().int().positive(),
  occurrenceDate: calendarDate.optional(),
  cancelled: z.boolean().optional(),
  changes: z.object({
    ...calendarFieldsSchema.omit({ createNew: true }).shape,
    title: z.string().min(1).max(160).optional(), detail: z.string().max(1500).optional(),
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
    allDayDate: calendarDate.nullable().optional(), recurrence: recurrenceSchema.nullable().optional(),
    remindAt: z.string().datetime({ offset: true }).nullable().optional(), done: z.boolean().optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.operation === 'update' && !Object.keys(value.changes || {}).length) ctx.addIssue({ code: 'custom', message: '更新需要具体变更字段。' });
  if (value.operation === 'delete' && (value.changes || value.occurrenceDate || value.cancelled !== undefined)) ctx.addIssue({ code: 'custom', message: '删除不接受额外字段变更。' });
  if (value.operation === 'change_occurrence' && (!value.occurrenceDate || (!Object.keys(value.changes || {}).length && value.cancelled === undefined))) ctx.addIssue({ code: 'custom', message: '单次例外需要发生日期和具体变更。' });
});
