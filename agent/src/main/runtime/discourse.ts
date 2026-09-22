export interface SpeechAct {
  startCodePoint: number;
  endCodePoint: number;
  subjectId: string;
  worldId: string;
  kind: 'assert' | 'correct' | 'hypothesize' | 'ask' | 'propose' | 'accept' | 'reject' | 'revoke' | 'quote';
  route: 'policy_restriction' | 'scenario' | 'memory_candidate' | 'work_state' | 'no_change';
  scope: 'turn' | 'episode' | 'long_term';
  ambiguous: boolean;
}
/** Quotes and fenced material may be analysed, but their commands do not change policy. */
export function authoredControls(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, '')
    .replace(/(?:他说|她说|材料写道|原文写道)[:：][^。；\n]*/g, '');
}
export function routeSpeechActs(
  text: string,
  selfId: string,
  subjectId: string,
  worldId: string,
  otherSubjectId = subjectId,
): SpeechAct[] {
  const points = Array.from(text),
    segments: { start: number; end: number }[] = [];
  let start = 0,
    quote = 0,
    code = false;
  for (let i = 0; i < points.length; i++) {
    if (points.slice(i, i + 3).join('') === '```') {
      code = !code;
      i += 2;
      continue;
    }
    if (['“', '「'].includes(points[i])) quote++;
    if (['”', '」'].includes(points[i])) quote = Math.max(0, quote - 1);
    if (!quote && !code && /[。！？；，,;\n]/.test(points[i])) {
      segments.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < points.length) segments.push({ start, end: points.length });
  return segments
    .filter((s) => s.end > s.start)
    .map((span) => {
      const clause = points.slice(span.start, span.end).join(''),
        quoted = /^\s*(?:>|“|「|```)|(?:他说|她说|材料写道|原文写道)[:：]/.test(clause);
      // A mixed turn must not inherit the first-mentioned subject.  The host
      // supplies an opaque other-subject id; this lexical cue only partitions
      // source spans and never grants access to that person's account.
      const refersToOther = /(?:替(?:我)?(?:室友|同学|朋友|他|她)|(?:室友|同学|朋友)的|\b他(?:的|会|要|没)|\b她(?:的|会|要|没)|代问)/.test(
        clause,
      );
      const refersToSelf = /(?:我|我的|本人)/.test(clause);
      const actor = quoted
        ? subjectId
        : subjectId.startsWith('fictional:') && !/现实中的我|我本人/.test(clause)
          ? subjectId
          : refersToOther && !refersToSelf
            ? otherSubjectId
            : refersToSelf
              ? selfId
              : subjectId;
      const hypothetical = /假设|假如|虚构|假想/.test(clause),
        world = hypothetical
          ? worldId === 'real'
            ? 'unbound-scenario'
            : worldId
          : /现实中|实际上/.test(clause)
            ? 'real'
            : worldId;
      const kind: SpeechAct['kind'] = quoted
        ? 'quote'
        : /撤回|撤销.*权限|不保存|不要记住/.test(clause)
          ? 'revoke'
          : hypothetical
            ? 'hypothesize'
            : /说错|更正|记错/.test(clause)
              ? 'correct'
              : /[？?]|怎么|哪一个|什么/.test(clause)
                ? 'ask'
                : /不参加|不接受|别再提醒/.test(clause)
                  ? 'reject'
                  : /行，就|选第二个|就这样/.test(clause)
                    ? 'accept'
                    : /准备|可以考虑|草拟/.test(clause)
                      ? 'propose'
                      : 'assert';
      return {
        startCodePoint: span.start,
        endCodePoint: span.end,
        subjectId: actor,
        worldId: world,
        kind,
        route:
          kind === 'revoke'
            ? 'policy_restriction'
            : kind === 'hypothesize'
              ? 'scenario'
              : kind === 'assert' || kind === 'correct'
                ? 'memory_candidate'
                : kind === 'propose' || kind === 'accept' || kind === 'reject'
                  ? 'work_state'
                  : 'no_change',
        scope: /今天|本轮|这次/.test(clause) ? 'turn' : 'episode',
        ambiguous: quoted || (kind === 'accept' && !/第[一二三\d]+个/.test(clause)),
      };
    });
}
