import type { CampusActivity, CampusTodo } from './types';

export interface CampusTodoDetailState {
  todo: CampusTodo;
  loading: boolean;
  reason: string;
  readAt: string;
  source: string;
}

export interface CampusTodoDetailMessages {
  noCourseId: string;
  noExactMatch: string;
  summaryOnly: string;
}

export type CampusTodoActivityReader = (courseId: string) => Promise<CampusActivity[]>;

export function campusTodoDetailKey(todo: Pick<CampusTodo, 'id' | 'courseId'>): string {
  return JSON.stringify([todo.courseId || '', todo.id]);
}

export function findMatchingTodoActivity(todo: CampusTodo, activities: CampusActivity[]): CampusActivity | undefined {
  if (!todo.courseId) return undefined;
  return activities.find((activity) => activity.courseId === todo.courseId && activity.id === todo.id);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.trim().slice(0, 240) : '';
}

export class CampusTodoDetailsSession {
  private generation = 0;
  private readonly cache = new Map<string, CampusTodoDetailState>();
  private readonly states = new Map<string, CampusTodoDetailState>();
  private readonly inFlight = new Map<string, Promise<CampusTodoDetailState>>();
  private queue: Promise<void> = Promise.resolve();

  snapshot(): Record<string, CampusTodoDetailState> {
    return Object.fromEntries(this.states);
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.states.clear();
    this.inFlight.clear();
  }

  load(
    todo: CampusTodo,
    reader: CampusTodoActivityReader,
    messages: CampusTodoDetailMessages,
    retry = false,
  ): Promise<CampusTodoDetailState> {
    const key = campusTodoDetailKey(todo);
    const active = this.inFlight.get(key);
    if (active) return active;

    const cached = this.cache.get(key);
    if (cached && !retry) {
      this.states.set(key, cached);
      return Promise.resolve(cached);
    }

    const generation = this.generation;
    const listSource = todo.source || '学在浙大待办列表';
    const source = todo.courseId ? `${listSource} · 学在浙大课程活动接口` : listSource;
    this.states.set(key, {
      todo,
      loading: true,
      reason: '',
      readAt: new Date().toISOString(),
      source: listSource,
    });

    const operation = this.queue.then(async (): Promise<CampusTodoDetailState> => {
      const checkedAt = new Date().toISOString();
      if (!todo.courseId) {
        return { todo, loading: false, reason: messages.noCourseId, readAt: checkedAt, source: listSource };
      }

      const activities = await reader(todo.courseId);
      const activity = findMatchingTodoActivity(todo, activities);
      if (!activity) {
        return { todo, loading: false, reason: messages.noExactMatch, readAt: new Date().toISOString(), source };
      }

      const mergedTodo: CampusTodo = {
        ...todo,
        deadline: todo.deadline || activity.deadline,
        ...(todo.description || !activity.description ? {} : { description: activity.description }),
        ...(todo.submissionRequirements || !activity.submissionRequirements ? {} : { submissionRequirements: activity.submissionRequirements }),
        ...(todo.attachments?.length || !activity.attachments?.length ? {} : { attachments: activity.attachments }),
        ...(!todo.updatedAt && activity.updatedAt ? { updatedAt: activity.updatedAt } : {}),
        sourceUrl: todo.sourceUrl && todo.sourceUrl !== 'https://courses.zju.edu.cn/user/index'
          ? todo.sourceUrl
          : activity.url || todo.sourceUrl || 'https://courses.zju.edu.cn/user/index',
      };
      const hasDetailFields = Boolean(mergedTodo.description || mergedTodo.submissionRequirements || mergedTodo.attachments?.length);
      return {
        todo: mergedTodo,
        loading: false,
        reason: hasDetailFields ? '' : messages.summaryOnly,
        readAt: new Date().toISOString(),
        source,
      };
    });

    this.queue = operation.then(() => undefined, () => undefined);
    let tracked: Promise<CampusTodoDetailState>;
    tracked = operation.catch((error): CampusTodoDetailState => ({
      todo,
      loading: false,
      reason: safeErrorMessage(error) || messages.summaryOnly,
      readAt: new Date().toISOString(),
      source,
    })).then((result) => {
      if (generation === this.generation) {
        this.cache.set(key, result);
        this.states.set(key, result);
      }
      return result;
    }).finally(() => {
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }
}
