import { z } from 'zod';
import { DEEPSEEK_MODEL } from './types';
import { calendarFieldsSchema } from './calendar';
const timestamp = z.string().datetime({ offset: true });
const event = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(160),
    startsAt: timestamp,
    endsAt: timestamp,
    location: z.string().max(200),
    status: z.enum(['scheduled', 'cancelled']),
    source: z.string().max(500),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), '结束时间必须晚于开始时间');
export const campusSchema = z.object({
  source: z.string().min(1).max(200),
  updatedAt: timestamp,
  schedule: z.array(event).max(5000).default([]),
  exams: z.array(event).max(500).default([]),
  sports: z
    .object({
      completed: z.number().int().min(0),
      required: z.number().int().min(0),
      deadline: timestamp,
      ruleSource: z.string().min(1).max(500),
    })
    .optional(),
  places: z
    .array(
      z.object({
        name: z.string().max(120),
        description: z.string().max(1500),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
      }),
    )
    .max(2000)
    .default([]),
  rules: z
    .array(
      z.object({ title: z.string().max(160), content: z.string().max(3000), source: z.string().max(500) }),
    )
    .max(200)
    .default([]),
});
export const actionSchema = z.object({
  effectActionId: z.string().max(160).optional(),
  ...calendarFieldsSchema.shape,
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(160),
  detail: z.string().max(1500),
  startsAt: timestamp.optional(),
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  saved: z.boolean().optional(),
  done: z.boolean().optional(),
  demo: z.boolean().optional(),
  revision: z.number().int().positive().optional(),
  approvalDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  coverage: z.enum(['verified', 'conditional', 'not_feasible']).optional(),
  missingNeeds: z.array(z.string().max(160)).max(64).optional(),
});
export const settingsSchema = z
  .object({
    model: z.literal(DEEPSEEK_MODEL).optional(),
    mode: z.enum(['demo', 'deepseek']).optional(),
    memoryEnabled: z.boolean().optional(),
    weatherEnabled: z.boolean().optional(),
    weatherUseLocation: z.boolean().optional(),
    remindersEnabled: z.boolean().optional(),
    timeZone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    guidance: z.string().max(4000).optional(),
    apiKey: z.string().trim().min(8).max(512).optional(),
  })
  .strict();
export function terms(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}
