import { randomUUID } from 'node:crypto';
import {
  always,
  candidateSchema,
  HarnessError,
  type Assertion,
  type ContextContract,
  type Dependency,
  type Need,
  type NeedResult,
  type PlanCandidate,
  type ScopeHandle,
  type TypedValue,
  type WorkRecord,
} from '../../shared/harness';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from './policy';
import { canonical, evaluateCondition } from './semantics';

/**
 * The small, durable part of the shared conversation frame.  It deliberately
 * lives on an episode WorkRecord rather than in a user/profile table: an
 * episode can therefore be resumed across sessions while remaining subject,
 * workspace and scope-bound by the existing repository envelope.
 */
export interface ConversationFrame {
  episodeId: string;
  sessionIds: string[];
  anchorKey: string;
  anchorTerms: string[];
  optionIds: string[];
  displayedOptionIds: string[];
  referencedOptionId?: string;
  parentEpisodeId?: string;
  focusSequence: number;
  unresolvedReferences: string[];
}

const referencePattern = /第[一二三四五六七八九十\d]+个|第二个|第三个|刚才那个|刚刚那个|之前那个|继续(?:比较|一下|刚才那个)?|回到|回来|那个方案|这个方案/;
const genericAnchorWords = new Set(
  Array.from(
    '给我两个三个几个下一步选项方案建议比较一下继续刚才刚刚那个之前这这次今天现在如何怎样可以就这样帮我请问'.split(''),
  ),
);

function anchorTerms(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(referencePattern, ' ')
    .replace(/[，。！？、；：,.!?;:/\\|()[\]{}<>"'“”‘’\s]+/g, ' ');
  const terms = new Set<string>();
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    // Latin words/numbers are already useful semantic anchors.  For Chinese,
    // retain bounded bi-grams, dropping the discourse-only characters above.
    if (/^[a-z0-9_-]+$/i.test(token)) {
      if (token.length > 1 && !genericAnchorWords.has(token)) terms.add(token);
      continue;
    }
    const chars = Array.from(token).filter((c) => !genericAnchorWords.has(c));
    for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i] + chars[i + 1]);
    if (chars.length >= 3) terms.add(chars.slice(0, 4).join(''));
  }
  return [...terms].slice(0, 24);
}

function anchorScore(text: string, terms: string[] = []): number {
  const query = new Set(anchorTerms(text));
  if (!query.size || !terms.length) return 0;
  let score = 0;
  for (const term of query) if (terms.includes(term)) score++;
  return score;
}

function isReference(text: string) {
  return referencePattern.test(text);
}

export interface ValidatedPlan extends PlanCandidate {
  feasibility: 'verified' | 'conditional' | 'not_feasible';
  unresolvedNeeds: string[];
  violations: string[];
  rejectionStillApplicable?: boolean;
  changeCost: string;
}
export class WorkService {
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
  ) {}
  create(
    handle: ScopeHandle,
    kind: WorkRecord['kind'],
    title: string,
    data: WorkRecord['data'] = {},
    options: { id?: string; status?: string; evidenceIds?: string[] } = {},
  ): WorkRecord {
    const s = this.policy.require(handle, 'work:write');
    const record: WorkRecord = {
      id: options.id || randomUUID(),
      kind,
      ownerId: s.principalId,
      workspaceId: s.workspaceId,
      subjectId: s.subjectId,
      worldId: s.worldId,
      revision: 1,
      status: options.status || 'proposed',
      title,
      evidenceIds: options.evidenceIds || [],
      label: {
        purpose: s.purposes[0],
        audience: s.audience,
        retention: s.retention,
        sensitivity: 'personal',
        infer: false,
      },
      data: { ...data, recordedAt: this.repo.clock.now(), updatedAt: this.repo.clock.now() },
    };
    this.repo.saveWork(handle, record);
    return record;
  }
  update(
    handle: ScopeHandle,
    id: string,
    revision: number,
    changes: Partial<Pick<WorkRecord, 'status' | 'title' | 'data' | 'evidenceIds'>>,
  ): WorkRecord {
    this.policy.require(handle, 'work:write');
    const old = this.repo.work(handle, undefined, id)[0];
    if (!old) throw new HarnessError('work_missing', '事项不存在或不可读取。');
    const next = { ...old, ...changes, data: { ...(changes.data || old.data), recordedAt: old.data.recordedAt || this.repo.clock.now(), updatedAt: this.repo.clock.now() }, revision: old.revision + 1 };
    this.repo.saveWork(handle, next, revision);
    return next;
  }

  /** Return the durable frame projection used by callers that need to render
   * or inspect focus without depending on the full WorkRecord payload. */
  frame(handle: ScopeHandle, episodeId: string): ConversationFrame | undefined {
    const episode = this.repo.work(handle, 'episode', episodeId)[0];
    if (!episode) return undefined;
    const data = episode.data;
    return {
      episodeId: episode.id,
      sessionIds: Array.isArray(data.sessionIds)
        ? (data.sessionIds as string[])
        : typeof data.sessionId === 'string'
          ? [data.sessionId]
          : [],
      anchorKey: String(data.anchorKey || ''),
      anchorTerms: Array.isArray(data.anchorTerms) ? (data.anchorTerms as string[]) : anchorTerms(episode.title),
      optionIds: Array.isArray(data.optionIds) ? (data.optionIds as string[]) : [],
      displayedOptionIds: Array.isArray(data.lastDisplayedOptionIds)
        ? (data.lastDisplayedOptionIds as string[])
        : Array.isArray(data.anchorOrder)
          ? (data.anchorOrder as string[])
          : [],
      referencedOptionId:
        typeof data.referencedOptionId === 'string' ? data.referencedOptionId : undefined,
      parentEpisodeId: typeof data.parentEpisodeId === 'string' ? data.parentEpisodeId : undefined,
      focusSequence: Number(data.focusSequence || 0),
      unresolvedReferences: Array.isArray(data.unresolvedReferences)
        ? (data.unresolvedReferences as string[])
        : [],
    };
  }

  /**
   * Resolve the best frame for a turn.  It is intentionally deterministic and
   * bounded by the repository's scoped work view.  Session is only a ranking
   * hint; stable anchors and the persisted focus chain work across sessions.
   */
  resolveEpisode(
    handle: ScopeHandle,
    sessionId: string | undefined,
    text: string,
    evidenceIds: string[] = [],
  ): { episode?: WorkRecord; status: 'resolved' | 'uncertain' | 'none' } {
    const episodes = this.repo
      .work(handle, 'episode')
      .filter((e) => !['closed', 'cancelled', 'stale', 'blocked'].includes(e.status));
    if (!episodes.length) return { status: 'none' };
    const queryAnchorTerms = anchorTerms(text);
    const frames = episodes.map((episode) => ({
      episode,
      data: episode.data,
      score: anchorScore(text, Array.isArray(episode.data.anchorTerms) ? (episode.data.anchorTerms as string[]) : []),
      evidenceScore: evidenceIds.filter((id) => episode.evidenceIds.includes(id)).length,
      focus: Number(episode.data.focusSequence || 0),
      sameSession:
        (typeof episode.data.lastSessionId === 'string' && episode.data.lastSessionId === sessionId) ||
        (Array.isArray(episode.data.sessionIds) && (episode.data.sessionIds as string[]).includes(sessionId || '')) ||
        episode.data.sessionId === sessionId,
    }));
    const hasStableAnchor = (frame: (typeof frames)[number]) =>
      frame.evidenceScore > 0 ||
      frame.score >= 2 ||
      (queryAnchorTerms.length > 0 && queryAnchorTerms.length <= 2 && frame.score === queryAnchorTerms.length);
    const ref = isReference(text);
    if (ref) {
      // "刚才那个/继续" means the prior focus when the newest frame was a
      // tangent; this is the only place where parentEpisodeId is followed.
      const latest = [...frames].sort((a, b) => b.focus - a.focus)[0];
      const explicitlyAnchored = frames
        .filter(hasStableAnchor)
        .sort(
          (a, b) =>
            Number(b.sameSession) - Number(a.sameSession) ||
            b.evidenceScore - a.evidenceScore ||
            b.score - a.score ||
            b.focus - a.focus,
        );
      if (explicitlyAnchored.length) return { episode: explicitlyAnchored[0].episode, status: 'resolved' };
      let prior =
        /刚才那个|刚刚那个|之前那个|回到|回来/.test(text) && typeof latest?.data.parentEpisodeId === 'string'
          ? frames.find((f) => f.episode.id === latest.data.parentEpisodeId)
          : undefined;
      // A run of small tangents should still return to the most recent frame
      // that has a displayed option/episode, not to an empty intermediary.
      const frameHasOptions = (frame: (typeof frames)[number]) =>
        Array.isArray(frame.data.lastDisplayedOptionIds) &&
        (frame.data.lastDisplayedOptionIds as string[]).length > 0 ||
        Array.isArray(frame.data.optionIds) && (frame.data.optionIds as string[]).length > 0;
      const byId = new Map(frames.map((frame) => [frame.episode.id, frame]));
      while (prior && !frameHasOptions(prior) && typeof prior.data.parentEpisodeId === 'string')
        prior = byId.get(prior.data.parentEpisodeId);
      const candidates = prior
        ? [prior]
        : frames
            .filter((f) => {
              const optionIds = new Set([
                ...(Array.isArray(f.data.lastDisplayedOptionIds) ? (f.data.lastDisplayedOptionIds as string[]) : []),
                ...(Array.isArray(f.data.optionIds) ? (f.data.optionIds as string[]) : []),
              ]);
              return optionIds.size > 0;
            })
            .sort(
              (a, b) =>
                Number(b.sameSession) - Number(a.sameSession) ||
                b.focus - a.focus ||
                b.score - a.score,
            );
      if (candidates.length) return { episode: candidates[0].episode, status: 'resolved' };
      if (latest) return { episode: latest.episode, status: 'resolved' };
    }
    const anchored = frames
      .filter(hasStableAnchor)
      .sort(
        (a, b) =>
          Number(b.sameSession) - Number(a.sameSession) ||
          b.evidenceScore - a.evidenceScore ||
          b.score - a.score ||
          b.focus - a.focus,
      );
    if (anchored.length) {
      // Equal-strength anchors from independent matters are not guessed.  A
      // caller can still answer the harmless turn and ask the one needed
      // clarification through resolveReference.
      if (!ref && anchored.length > 1 && anchored[0].score === anchored[1].score && !anchored[0].sameSession)
        return { status: 'uncertain' };
      return { episode: anchored[0].episode, status: 'resolved' };
    }
    return { status: 'none' };
  }

  /** Explicitly mark a frame as the currently displayed/focused one. */
  focus(
    handle: ScopeHandle,
    episodeId: string,
    sessionId?: string,
    displayedOptionIds?: string[],
  ): WorkRecord | undefined {
    const episode = this.repo.work(handle, 'episode', episodeId)[0];
    if (!episode) return undefined;
    const all = this.repo.work(handle, 'episode');
    const maxSequence = Math.max(0, ...all.map((e) => Number(e.data.focusSequence || 0)));
    const sessions = new Set<string>([
      ...(Array.isArray(episode.data.sessionIds) ? (episode.data.sessionIds as string[]) : []),
      ...(typeof episode.data.sessionId === 'string' ? [episode.data.sessionId] : []),
      ...(sessionId ? [sessionId] : []),
    ]);
    const nextData = {
      ...episode.data,
      sessionIds: [...sessions].slice(-32),
      focusSequence: maxSequence + 1,
      focusUpdatedAt: this.repo.clock.now(),
      ...(sessionId || episode.data.lastSessionId
        ? { lastSessionId: sessionId || episode.data.lastSessionId }
        : {}),
      ...(displayedOptionIds ? { lastDisplayedOptionIds: [...new Set(displayedOptionIds)] } : {}),
    };
    return this.update(handle, episode.id, episode.revision, {
      data: nextData,
    });
  }

  episode(
    handle: ScopeHandle,
    sessionId: string,
    text: string,
    evidenceIds: string[],
  ): WorkRecord | undefined {
    const s = this.policy.validate(handle);
    if (s.retention === 'session_only' || !s.grants.includes('work:write')) return;
    const episodes = this.repo
      .work(handle, 'episode')
      .filter((e) => !['closed', 'cancelled', 'stale', 'blocked'].includes(e.status));
    const terms = anchorTerms(text), key = [...terms].sort().slice(0, 8).join('|');
    const resolved = this.resolveEpisode(handle, sessionId, text, evidenceIds);
    const focused = episodes.sort(
      (a, b) => Number(b.data.focusSequence || 0) - Number(a.data.focusSequence || 0),
    )[0];
    const current = resolved.episode && (isReference(text) || anchorScore(text, (resolved.episode.data.anchorTerms as string[]) || []) >= 2)
      ? resolved.episode
      : !isReference(text) && resolved.status === 'none'
        ? undefined
        : resolved.episode;
    if (current) {
      const sessions = new Set<string>([
        ...(Array.isArray(current.data.sessionIds) ? (current.data.sessionIds as string[]) : []),
        ...(typeof current.data.sessionId === 'string' ? [current.data.sessionId] : []),
        sessionId,
      ]);
      const maxSequence = Math.max(0, ...episodes.map((e) => Number(e.data.focusSequence || 0)));
      return this.update(handle, current.id, current.revision, {
        evidenceIds: [...new Set([...current.evidenceIds, ...evidenceIds])].slice(-100),
        data: {
          ...current.data,
          sessionIds: [...sessions].slice(-32),
          lastSessionId: sessionId,
          lastEventIds: evidenceIds,
          focusSequence: maxSequence + 1,
          focusUpdatedAt: this.repo.clock.now(),
          anchorTerms: [...new Set([...(Array.isArray(current.data.anchorTerms) ? (current.data.anchorTerms as string[]) : []), ...terms])].slice(0, 24),
          anchorKey: String(current.data.anchorKey || key),
        },
      });
    }
    const maxSequence = Math.max(0, ...episodes.map((e) => Number(e.data.focusSequence || 0)));
    return this.create(
      handle,
      'episode',
      text.split('\n')[0].slice(0, 120),
      {
        sessionId,
        sessionIds: [sessionId],
        lastSessionId: sessionId,
        anchorKey: key,
        anchorTerms: terms,
        focusSequence: maxSequence + 1,
        focusUpdatedAt: this.repo.clock.now(),
        lastDisplayedOptionIds: [],
        optionIds: [],
        selectedOptionIds: [],
        unresolvedReferences: [],
        openQuestions: [],
        nextSmallQuestion: '',
        coveredEventRanges: [],
        ...(focused ? { parentEpisodeId: focused.id } : {}),
      },
      { status: 'active', evidenceIds },
    );
  }
  resolveReference(
    handle: ScopeHandle,
    episodeId: string,
    text: string,
  ): { optionId?: string; status: 'resolved' | 'uncertain' | 'none' } {
    const episode = this.repo.work(handle, 'episode', episodeId)[0];
    if (!episode) return { status: 'none' };
    const options = ((episode.data.optionIds as string[]) || []).flatMap(id => this.repo.work(handle, 'option', id))
      .filter(
        (o) =>
          ((episode.data.optionIds as string[]) || []).includes(o.id) &&
          !['cancelled', 'closed', 'stale', 'blocked', 'rejected'].includes(o.status),
      );
    let selected: WorkRecord | undefined;
    const direct = options.filter((o) => text.includes(o.id));
    const ordinal = text.match(/第([一二三四五六七八九十\d]+)个/),
      numerals: Record<string, number> = {
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
        十: 10,
      };
    const anchors =
      (episode.data.lastDisplayedOptionIds as string[] | undefined) ||
      (episode.data.anchorOrder as string[] | undefined);
    if (direct.length === 1) selected = direct[0];
    else if (ordinal && anchors) {
      const index = (numerals[ordinal[1]] || Number(ordinal[1])) - 1;
      selected = options.find((o) => o.id === anchors[index]);
    } else if (/刚刚那个|刚才那个|继续比较/.test(text) && typeof episode.data.referencedOptionId === 'string')
      selected = options.find((o) => o.id === episode.data.referencedOptionId);
    if (selected) {
      this.update(handle, episode.id, episode.revision, {
        data: {
          ...episode.data,
          referencedOptionId: selected.id,
          lastDisplayedOptionIds: Array.isArray(episode.data.lastDisplayedOptionIds)
            ? episode.data.lastDisplayedOptionIds
            : episode.data.anchorOrder || episode.data.optionIds || [],
          focusSequence:
            Math.max(
              0,
              ...this.repo.work(handle, 'episode').map((e) => Number(e.data.focusSequence || 0)),
            ) + 1,
          focusUpdatedAt: this.repo.clock.now(),
        },
      });
      return { optionId: selected.id, status: 'resolved' };
    }
    if (/就这样|可以|第二个|第三个|那里|之前那个|刚才|刚刚|继续/.test(text)) {
      this.update(handle, episode.id, episode.revision, {
        data: {
          ...episode.data,
          unresolvedReferences: [...((episode.data.unresolvedReferences as string[]) || []), '需要明确选项'],
          nextSmallQuestion: '你指的是哪一个方案？',
        },
      });
      return { status: 'uncertain' };
    }
    return { status: 'none' };
  }

  /** Resolve a reference against the durable focus chain when the caller does
   * not already have an episode id (for example, a fresh chat window). */
  resolveCurrentReference(
    handle: ScopeHandle,
    sessionId: string | undefined,
    text: string,
  ): { episodeId?: string; optionId?: string; status: 'resolved' | 'uncertain' | 'none' } {
    const resolved = this.resolveEpisode(handle, sessionId, text);
    if (!resolved.episode) return { status: resolved.status };
    const result = this.resolveReference(handle, resolved.episode.id, text);
    return { episodeId: resolved.episode.id, optionId: result.optionId, status: result.status };
  }
  addOptions(
    handle: ScopeHandle,
    episodeId: string,
    options: { id: string; title: string; data?: WorkRecord['data'] }[],
    anchorOrder?: string[],
  ) {
    const episode = this.repo.work(handle, 'episode', episodeId)[0];
    if (!episode) throw new HarnessError('episode_missing', '当前事项不存在。');
    const optionAnchorTerms = options.flatMap((option) => anchorTerms(option.title));
    const mergedAnchorTerms = [
      ...new Set([
        ...(Array.isArray(episode.data.anchorTerms) ? (episode.data.anchorTerms as string[]) : anchorTerms(episode.title)),
        ...optionAnchorTerms,
      ]),
    ].slice(0, 24);
    this.repo.write(() => {
      for (const option of options)
        this.create(handle, 'option', option.title, option.data || {}, {
          id: option.id,
          status: 'candidate',
        });
      this.update(handle, episode.id, episode.revision, {
        data: {
          ...episode.data,
          optionIds: [
            ...new Set([...((episode.data.optionIds as string[]) || []), ...options.map((o) => o.id)]),
          ],
          anchorOrder: anchorOrder || options.map((o) => o.id),
          lastDisplayedOptionIds: anchorOrder || options.map((o) => o.id),
          anchorTerms: mergedAnchorTerms,
          anchorKey: [...mergedAnchorTerms].sort().slice(0, 8).join('|'),
          focusSequence:
            Math.max(0, ...this.repo.work(handle, 'episode').map((e) => Number(e.data.focusSequence || 0))) + 1,
          focusUpdatedAt: this.repo.clock.now(),
        },
      });
    });
  }
  cancelGoal(handle: ScopeHandle, id: string) {
    const goal = this.repo.work(handle, 'goal', id)[0];
    if (!goal) throw new HarnessError('goal_missing', '目标不存在。');
    this.repo.write(() => {
      this.update(handle, id, goal.revision, { status: 'cancelled' });
      this.repo.invalidate(id, 'goal_cancelled');
      this.repo.db.prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE goal_id=?").run(id);
      this.repo.db.prepare("UPDATE h_watches SET status='inactive' WHERE goal_id=?").run(id);
    });
  }
  applyCurrentControls(handle: ScopeHandle, text: string) {
    if (!this.policy.can(handle, 'work:write')) return;
    for (const option of this.repo.work(handle, 'option'))
      if (
        typeof option.data.rejectionCheckExpiresAt === 'string' &&
        Date.parse(option.data.rejectionCheckExpiresAt) <= Date.parse(this.repo.clock.now()) &&
        option.status === 'candidate'
      )
        this.update(handle, option.id, option.revision, {
          status: 'stale',
          data: {
            ...option.data,
            rejectionStillApplicable: null,
            invalidationReason: 'resource_check_expired',
          },
        });
    if (/不参加|不追了|取消.*目标|别再提醒准备/.test(text)) {
      const goals = this.repo.work(handle, 'goal').filter((g) => g.status === 'active');
      const matches = goals.filter(
        (g) => text.includes(g.title) || g.title.split(/\s+/).some((t) => t.length > 1 && text.includes(t)),
      );
      if (matches.length === 1) this.cancelGoal(handle, matches[0].id);
      else if (goals.length === 1 && /这次|这个目标/.test(text)) this.cancelGoal(handle, goals[0].id);
    }
  }
  createWorld(
    handle: ScopeHandle,
    id: string,
    assumptions: Record<string, unknown>,
    evidenceIds: string[] = [],
  ) {
    const s = this.policy.validate(handle);
    const baseline = this.repo.assertions(handle).map((a) => ({ id: a.id, revision: a.revision }));
    const f = this.repo.filter(handle);
    const domainRefs = this.repo.db
      .prepare(
        `SELECT r.id,r.source,r.domain,r.institution,r.term,r.revision FROM h_domain r WHERE ${f.sql} AND r.status!='known_absent'`,
      )
      .all(...f.params);
    const payload = {
      id,
      parent: 'real',
      baseRevision: this.repo.domainRevision,
      privacyEpoch: s.privacyEpoch,
      baseline,
      domainRefs,
      assumptions,
      evidenceIds,
      createdAt: this.repo.clock.now(),
      status: 'active',
      adoptionApproved: false,
    };
    this.repo.write(() => {
      this.repo.db
        .prepare('INSERT INTO h_worlds VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(
          id,
          s.principalId,
          s.workspaceId,
          s.subjectId,
          this.repo.domainRevision,
          'active',
          JSON.stringify(payload),
        );
      for (const ref of [...baseline, ...evidenceIds.map((id) => ({ id, revision: 1 }))])
        this.repo.addDependency(handle, {
          consumerId: id,
          producerId: ref.id,
          producerRevision: ref.revision,
          sensitivity: 'privacy',
          invalidation: 'revalidate',
        });
    });
    return payload;
  }
  worlds(handle: ScopeHandle) {
    const s = this.policy.validate(handle);
    return this.repo.db
      .prepare('SELECT payload FROM h_worlds WHERE owner=? AND workspace=? AND subject=?')
      .all(s.principalId, s.workspaceId, s.subjectId)
      .map((r) => JSON.parse(String(r.payload)));
  }
  readWorldBaseline(handle: ScopeHandle, id: string) {
    const s = this.policy.validate(handle),
      world = this.worlds(handle).find((w) => w.id === id);
    if (!world) throw new HarnessError('world_missing', '假设分支不存在。');
    if (world.privacyEpoch !== s.privacyEpoch)
      return { status: 'stale', assertions: [], domainRecords: [], assumptions: {} };
    const real = this.policy.hostScope({
      subjectId: s.subjectId,
      worldId: 'real',
      sources: s.sources,
      purposes: s.purposes,
      audience: s.audience,
      grants: s.grants,
      infer: false,
    });
    const allowed = this.repo.assertions(real, {
      statuses: ['active', 'inactive', 'candidate', 'superseded', 'expired'],
      limit: 500,
    });
    const assertions = (world.baseline as { id: string; revision: number }[])
      .filter((ref) => allowed.some((a) => a.id === ref.id))
      .flatMap((ref) => {
        const row = this.repo.db
          .prepare('SELECT payload FROM h_assertion_versions WHERE id=? AND revision=?')
          .get(ref.id, ref.revision);
        return row ? [JSON.parse(String(row.payload))] : [];
      });
    const domainRecords = ((world.domainRefs as any[]) || [])
      .filter((ref) => s.sources.includes(ref.source))
      .flatMap((ref) => {
        const row = this.repo.db
          .prepare(
            'SELECT payload FROM h_domain_versions WHERE id=? AND source=? AND domain=? AND institution=? AND term=? AND revision=?',
          )
          .get(ref.id, ref.source, ref.domain, ref.institution, ref.term, ref.revision);
        if (!row) return [];
        const record = JSON.parse(String(row.payload));
        return this.repo.evidence(real, record.evidenceId) ? [record] : [];
      });
    return { status: world.status, assertions, domainRecords, assumptions: world.assumptions };
  }
  staleWorlds() {
    this.repo.write(() => {
      for (const row of this.repo.db
        .prepare('SELECT id,payload FROM h_worlds WHERE base_revision<?')
        .all(this.repo.domainRevision)) {
        const world = JSON.parse(String(row.payload));
        world.status = 'stale';
        this.repo.db
          .prepare("UPDATE h_worlds SET status='stale',payload=? WHERE id=?")
          .run(JSON.stringify(world), String(row.id));
      }
    });
  }
  adoptionDiff(handle: ScopeHandle, id: string) {
    const world = this.worlds(handle).find((w) => w.id === id);
    if (!world) throw new HarnessError('world_missing', '假设方案不存在。');
    return {
      worldId: id,
      baseRevision: world.baseRevision,
      status: world.privacyEpoch !== this.policy.validate(handle).privacyEpoch ? 'stale' : world.status,
      items: Object.entries(world.assumptions).map(([key, value]) => ({
        id: id + ':' + key,
        key,
        proposed: value,
        operation: 'prepare_only',
        effect: 'local_write',
        requiresApproval: true,
      })),
    };
  }
  adoptPreparation(handle: ScopeHandle, id: string, itemIds: string[]) {
    const diff = this.adoptionDiff(handle, id);
    if (diff.status === 'stale') throw new HarnessError('world_stale', '现实条件已变，请先重新核对假设。');
    const selected = diff.items.filter((i) => itemIds.includes(i.id));
    if (selected.length !== itemIds.length)
      throw new HarnessError('unknown_adoption_item', '采用范围不存在。');
    return this.repo.write(() =>
      selected.map((item) => {
        const existing = this.repo.work(handle, 'task').find((t) => t.data.adoptionItemId === item.id);
        if (existing) return existing;
        const task = this.create(
          handle,
          'task',
          '准备：' + (typeof item.proposed === 'string' ? item.proposed.slice(0, 90) : item.key),
          {
            kind: 'prepare_' + item.key,
            worldRef: id,
            adoptionItemId: item.id,
            assumption: item.proposed as any,
          },
          { status: 'draft' },
        );
        this.repo.addDependency(handle, {
          consumerId: task.id,
          producerId: id,
          producerRevision: diff.baseRevision,
          sensitivity: 'privacy',
          invalidation: 'revalidate',
        });
        return task;
      }),
    );
  }
  introducedNeeds(candidate: PlanCandidate): Need[] {
    const needs = [...candidate.needs];
    const add = (key: string, capability?: string, importance: Need['importance'] = 'must') => {
      if (!needs.some((n) => n.key === key))
        needs.push({
          id: candidate.id + ':' + key,
          key,
          importance,
          capability,
          args: {},
          condition: always,
          mode: 'all',
          childIds: [],
        });
    };
    // Dependencies are declared by the model from the actual task and the
    // capability contracts. Activity/location strings never synthesize a
    // fictitious home computer, transport mode or unregistered tool name.
    for (const capability of candidate.resourceCapabilities) add('resource.' + capability, capability);
    return needs;
  }
  validatePlan(
    contract: ContextContract,
    raw: unknown,
    results: NeedResult[],
    assertions: Assertion[],
    facts: Record<string, TypedValue> = {},
  ): ValidatedPlan {
    this.policy.validate(contract.scope);
    const candidate = candidateSchema.parse(raw),
      needs = this.introducedNeeds(candidate);
    const byId = new Map(
      results.flatMap(
        (r) =>
          [
            [r.id, r],
            [r.key, r],
          ] as const,
      ),
    );
    const satisfied = (need: Need, seen = new Set<string>()): boolean => {
      if (seen.has(need.id)) return false;
      seen.add(need.id);
      if (evaluateCondition(need.condition, facts) === 'false') return true;
      if (need.childIds.length) {
        const child = need.childIds
          .map((id) => needs.find((n) => n.id === id))
          .map((n) => (n ? satisfied(n, new Set(seen)) : false));
        return need.mode === 'any' ? child.some(Boolean) : child.every(Boolean);
      }
      const result = byId.get(need.id) || byId.get(need.key);
      return !!result && ['fresh', 'known_absent'].includes(result.status);
    };
    const unresolved = needs.filter((n) => n.importance !== 'optional' && !satisfied(n)).map((n) => n.key),
      violations: string[] = [];
    if (
      candidate.startsAt &&
      candidate.endsAt &&
      Date.parse(candidate.endsAt) <= Date.parse(candidate.startsAt)
    )
      violations.push('invalid_interval');
    if (contract.temporalAmbiguities.length) unresolved.push('time_ambiguity');
    if (!needs.length) unresolved.push('environment_not_checked');
    const world =
      contract.worldId === 'real'
        ? undefined
        : this.worlds(this.policy.hostScope()).find((w) => w.id === contract.worldId);
    if (world?.status === 'stale') violations.push('stale_world');
    return {
      ...candidate,
      needs,
      feasibility: violations.length ? 'not_feasible' : unresolved.length ? 'conditional' : 'verified',
      unresolvedNeeds: [...new Set(unresolved)],
      violations,
      changeCost: '保留未受影响的已接受安排；本方案仍需用户选择',
    };
  }
  savePlan(contract: ContextContract, plan: ValidatedPlan, evidenceIds: string[] = []) {
    const existing = this.repo.work(contract.scope, 'plan', plan.id)[0];
    const data = JSON.parse(JSON.stringify(plan));
    const result = existing
      ? this.update(contract.scope, existing.id, existing.revision, { status: plan.feasibility, data })
      : this.create(contract.scope, 'plan', plan.title, data, {
          id: plan.id,
          status: plan.feasibility,
          evidenceIds,
        });
    for (const d of plan.dependencies) this.repo.addDependency(contract.scope, { ...d, consumerId: plan.id });
    return result;
  }
  revalidateRejections(handle: ScopeHandle, capabilities: Record<string, TypedValue>) {
    const updated: WorkRecord[] = [];
    for (const option of this.repo.work(handle, 'option')) {
      const rejection = option.data.rejection as
        { reason: string; validWhen?: any; permanent?: boolean } | undefined;
      if (!rejection) continue;
      const applicable =
        rejection.permanent || rejection.reason === 'explicit_forbidden'
          ? true
          : evaluateCondition(
              rejection.validWhen || { op: 'unknown', reason: 'no_condition' },
              capabilities,
            ) !== 'false';
      if (option.data.rejectionStillApplicable !== applicable)
        updated.push(
          this.update(handle, option.id, option.revision, {
            status: applicable ? 'rejected' : 'candidate',
            data: { ...option.data, rejectionStillApplicable: applicable },
          }),
        );
    }
    return updated;
  }
  /** Minimal-change repair produces a reviewable diff, never silently edits accepted or external activities. */
  repair(handle: ScopeHandle, changes: Record<string, unknown>) {
    const plans = this.repo.work(handle, 'plan');
    return plans.map((plan) => ({
      id: plan.id,
      revision: plan.revision,
      changed: plan.status === 'stale' || plan.status === 'blocked',
      preserveAccepted: plan.data.accepted === true,
      next:
        plan.status === 'stale' || plan.status === 'blocked'
          ? { ...plan.data, proposedChanges: changes, requiresReview: true }
          : plan.data,
    }));
  }
  participation(
    handle: ScopeHandle,
    id: string,
    participant: string,
    status: 'confirmed' | 'declined',
    evidenceId: string,
  ) {
    const commitment = this.repo.work(handle, 'commitment', id)[0];
    if (!commitment) throw new HarnessError('commitment_missing', '共同约定不存在。');
    const participants = (commitment.data.participants as string[]) || [];
    if (!participants.includes(participant))
      throw new HarnessError('participant_unknown', '没有这位参与者。');
    const evidence = this.repo.evidence(handle, evidenceId);
    if (!evidence) throw new HarnessError('evidence_missing', '缺少该参与者确认依据。');
    const confirmations = {
      ...((commitment.data.confirmations as Record<string, any>) || {}),
      [participant]: { status, evidenceId },
    };
    return this.update(handle, id, commitment.revision, {
      data: {
        ...commitment.data,
        confirmations,
        allConfirmed: participants.every((p) => confirmations[p]?.status === 'confirmed'),
      },
    });
  }
}
