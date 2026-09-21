import { performance } from 'node:perf_hooks';
import type { ClockPort, Condition, Truth, TypedValue } from '../../shared/harness';
import { HarnessError } from '../../shared/harness';

export const systemClock: ClockPort = {
  now: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};
export function evaluateCondition(
  condition: Condition,
  facts: Readonly<Record<string, TypedValue>>,
  depth = 0,
): Truth {
  if (depth > 16) throw new HarnessError('condition_depth', '条件展开超出上限。');
  if (condition.op === 'unknown') return 'unknown';
  if (condition.op === 'known')
    return Object.hasOwn(facts, condition.predicate) && facts[condition.predicate].type !== 'unknown'
      ? 'true'
      : 'unknown';
  if (condition.op === 'not') {
    const v = evaluateCondition(condition.term, facts, depth + 1);
    return v === 'unknown' ? v : v === 'true' ? 'false' : 'true';
  }
  if (condition.op === 'all' || condition.op === 'any') {
    const values = condition.terms.map((t) => evaluateCondition(t, facts, depth + 1));
    if (condition.op === 'all')
      return values.includes('false') ? 'false' : values.includes('unknown') ? 'unknown' : 'true';
    return values.includes('true') ? 'true' : values.includes('unknown') ? 'unknown' : 'false';
  }
  if (condition.op !== 'compare') return 'unknown';
  const a = Object.hasOwn(facts, condition.predicate) ? facts[condition.predicate] : undefined,
    b = condition.value;
  if (!a || a.type === 'unknown' || b.type === 'unknown' || a.type !== b.type) return 'unknown';
  if (a.type === 'quantity' && b.type === 'quantity' && (a.unit !== b.unit || a.dimension !== b.dimension))
    return 'unknown';
  const av = a.type === 'instant' ? Date.parse(a.value) : a.value,
    bv = b.type === 'instant' ? Date.parse(b.value) : b.value;
  const result =
    condition.comparator === 'eq'
      ? av === bv
      : condition.comparator === 'ne'
        ? av !== bv
        : condition.comparator === 'lt'
          ? av < bv
          : condition.comparator === 'lte'
            ? av <= bv
            : condition.comparator === 'gt'
              ? av > bv
              : av >= bv;
  return result ? 'true' : 'false';
}
export function dateInZone(now: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}
export function addDate(date: string, days: number): string {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Enumerate possible offsets, then round-trip against the named zone. Zero/two matches require confirmation (DST). */
export function resolveLocalTime(
  local: string,
  timeZone: string,
): { instants: string[]; status: 'resolved' | 'nonexistent' | 'ambiguous' } {
  const match = local.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new HarnessError('invalid_local_time', '时间格式无法解析。');
  const wanted = local.length === 16 ? local + ':00' : local;
  const naive = Date.parse(wanted + 'Z');
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const matches: string[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = new Date(naive + offset * 60000);
    if (formatter.format(candidate).replace(' ', 'T') === wanted) matches.push(candidate.toISOString());
  }
  return {
    instants: matches,
    status: matches.length === 1 ? 'resolved' : matches.length ? 'ambiguous' : 'nonexistent',
  };
}
export function dayBounds(date: string, zone: string): { from: string; to: string } {
  const from = resolveLocalTime(date + 'T00:00:00', zone),
    to = resolveLocalTime(addDate(date, 1) + 'T00:00:00', zone);
  if (from.status !== 'resolved' || to.status !== 'resolved')
    throw new HarnessError('ambiguous_date', '日期边界需要确认。');
  return { from: from.instants[0], to: to.instants[0] };
}
export function codePointSlice(text: string, start: number, end: number) {
  return Array.from(text).slice(start, end).join('');
}
export function locateQuote(text: string, quote: string) {
  const offset = text.indexOf(quote);
  if (offset < 0) throw new HarnessError('unsupported_evidence', '原文不支持这条理解。');
  const start = Array.from(text.slice(0, offset)).length;
  return { start, end: start + Array.from(quote).length };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
