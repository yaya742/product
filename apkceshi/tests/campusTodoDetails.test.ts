import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusActivity, CampusTodo } from '../src/runtime/types.ts';
import { hasOfficialTodoDetails, normalizeOfficialCourseUrl, normalizeTodoDetails, officialActivityUrl, officialTodoPageUrl } from '../src/runtime/todoDetails.ts';
import { campusTodoDetailKey, CampusTodoDetailsSession } from '../src/runtime/todoDetailSession.ts';
import { runWithSingleFallback } from '../src/runtime/singleFallback.ts';

const messages = {
  noCourseId: 'missing course id',
  noExactMatch: 'no exact match',
  summaryOnly: 'summary only',
};

function todo(id: string, courseId = 'course-1'): CampusTodo {
  return {
    id,
    courseId,
    name: `作业 ${id}`,
    course: '概率论',
    deadline: '',
    status: 'pending',
    source: '官方待办',
    sourceUrl: 'https://courses.zju.edu.cn/user/index',
  };
}

function activity(id: string, courseId: string, details: Partial<CampusActivity> = {}): CampusActivity {
  return {
    id,
    courseId,
    title: `作业 ${id}`,
    type: 'assignment',
    startTime: '',
    endTime: '',
    deadline: '',
    status: '',
    url: '',
    ...details,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('reopening a completed todo reuses its session result; retry and todo refresh invalidate it', async () => {
  const session = new CampusTodoDetailsSession();
  const item = todo('assignment-1');
  let requests = 0;
  const requestedIds: string[] = [];
  const reader = async (courseId: string, activityId: string) => {
    requests += 1;
    requestedIds.push(activityId);
    return [activity(item.id, courseId, { description: `说明 ${requests}` })];
  };

  const first = await session.load(item, reader, messages);
  const reopened = await session.load(item, reader, messages);
  assert.equal(requests, 1);
  assert.deepEqual(requestedIds, [item.id], 'the reader receives the exact expanded assignment ID');
  assert.equal(reopened.todo.description, first.todo.description);

  const retried = await session.load(item, reader, messages, true);
  assert.equal(requests, 2);
  assert.equal(retried.todo.description, '说明 2');

  session.invalidate();
  await session.load(item, reader, messages);
  assert.equal(requests, 3);
});

test('one loading todo does not block another; per-todo states remain independent and requests are serialized', async () => {
  const session = new CampusTodoDetailsSession();
  const firstTodo = todo('assignment-1', 'course-1');
  const secondTodo = todo('assignment-2', 'course-2');
  const firstGate = deferred<CampusActivity[]>();
  const secondGate = deferred<CampusActivity[]>();
  const gates = new Map([['course-1', firstGate], ['course-2', secondGate]]);
  const requestedCourses: string[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const reader = async (courseId: string) => {
    requestedCourses.push(courseId);
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const items = await gates.get(courseId)!.promise;
    activeRequests -= 1;
    return items;
  };

  const firstRequest = session.load(firstTodo, reader, messages);
  assert.equal(session.load(firstTodo, reader, messages), firstRequest, 'same todo shares the in-flight request');
  const secondRequest = session.load(secondTodo, reader, messages);
  const snapshotWhileLoading = session.snapshot();
  assert.equal(snapshotWhileLoading[campusTodoDetailKey(firstTodo)]?.loading, true);
  assert.equal(snapshotWhileLoading[campusTodoDetailKey(secondTodo)]?.loading, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requestedCourses, ['course-1'], 'the second row is open/loading but waits for the shared connector');

  firstGate.resolve([activity(firstTodo.id, firstTodo.courseId!, { description: '第一项说明' })]);
  await firstRequest;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requestedCourses, ['course-1', 'course-2']);
  secondGate.resolve([activity(secondTodo.id, secondTodo.courseId!, { description: '第二项说明' })]);
  await secondRequest;
  assert.equal(maxActiveRequests, 1);
  assert.equal(session.snapshot()[campusTodoDetailKey(firstTodo)]?.todo.description, '第一项说明');
  assert.equal(session.snapshot()[campusTodoDetailKey(secondTodo)]?.todo.description, '第二项说明');
});

test('incomplete official activity stays incomplete instead of fabricating assignment fields', async () => {
  const session = new CampusTodoDetailsSession();
  const item = todo('assignment-1');
  const result = await session.load(item, async (courseId) => [activity(item.id, courseId, { deadline: '2026-10-01' })], messages);

  assert.equal(result.todo.deadline, '2026-10-01');
  assert.equal(result.todo.description, undefined);
  assert.equal(result.todo.submissionRequirements, undefined);
  assert.deepEqual(result.todo.attachments, undefined);
  assert.equal(result.reason, messages.summaryOnly);
  assert.equal(result.source, '官方待办 · 学在浙大课程活动详情接口');
});

test('transient errors and unmatched activities are not cached; a later reopen can load a matching result', async () => {
  const session = new CampusTodoDetailsSession();
  const item = todo('assignment-1');
  let requests = 0;

  const failed = await session.load(item, async () => {
    requests += 1;
    throw new Error('temporary network error');
  }, messages);
  assert.equal(failed.reason, 'temporary network error');

  const unmatched = await session.load(item, async () => {
    requests += 1;
    return [activity('another-assignment', item.courseId!, { description: '不能错配' })];
  }, messages);
  assert.equal(unmatched.reason, messages.noExactMatch);

  const matched = await session.load(item, async (courseId) => {
    requests += 1;
    return [activity(item.id, courseId, { description: '重新读取后取得的说明' })];
  }, messages);
  assert.equal(matched.todo.description, '重新读取后取得的说明');

  const reopened = await session.load(item, async () => {
    requests += 1;
    return [];
  }, messages);
  assert.equal(requests, 3, 'only the successfully matched result is reused');
  assert.equal(reopened.todo.description, '重新读取后取得的说明');
});

test('raw native timeout is shown as a clear retryable network error', async () => {
  const session = new CampusTodoDetailsSession();
  const item = todo('assignment-timeout');
  const result = await session.load(item, async () => { throw new Error('timeout'); }, messages);

  assert.equal(result.reason, '详情接口连接超时，请检查网络后重试。');
  assert.equal(result.todo.description, undefined);
});

test('a direct course-platform network timeout retries once through the fallback transport', async () => {
  let requests = 0;
  let fallbackActivations = 0;
  const value = await runWithSingleFallback(
    async () => {
      requests += 1;
      if (requests === 1) throw new Error('timeout');
      return 'official detail';
    },
    async () => { fallbackActivations += 1; },
    (error) => error instanceof Error && /timeout/i.test(error.message),
  );

  assert.equal(value, 'official detail');
  assert.equal(requests, 2);
  assert.equal(fallbackActivations, 1);
});

test('fallback transport does not retry authentication or data-integrity failures', async () => {
  let fallbackActivations = 0;
  await assert.rejects(
    runWithSingleFallback(
      async () => { throw new Error('wrong activity ID'); },
      async () => { fallbackActivations += 1; },
      (error) => error instanceof Error && /timeout/i.test(error.message),
    ),
    /wrong activity ID/,
  );
  assert.equal(fallbackActivations, 0);
});

test('activity match requires both the exact course ID and assignment ID', async () => {
  const session = new CampusTodoDetailsSession();
  const item = todo('assignment-1', 'course-1');
  const result = await session.load(item, async () => [
    activity(item.id, 'course-2', { description: '另一个课程的作业，不能错配' }),
    activity('different-assignment', item.courseId!, { description: '同课程的其他作业，不能错配' }),
  ], messages);

  assert.equal(result.reason, messages.noExactMatch);
  assert.equal(result.todo.description, undefined);
  assert.equal(result.source, '官方待办 · 学在浙大课程活动详情接口');
});

test('normalizes explicit details and accepts only trusted HTTPS platform links', () => {
  const details = normalizeTodoDetails({
    description: '<p>完成报告</p><script>alert(1)</script><p>上传 PDF</p>',
    submission_requirements: '仅接受 PDF',
    attachments: [{ filename: '说明.pdf', url: '/uploads/brief.pdf' }],
    updated_at: '2026-09-25 12:30',
    url: 'https://courses.zju.edu.cn/course/123/activities/456',
  });

  assert.equal(details.description, '完成报告\n上传 PDF');
  assert.equal(details.submissionRequirements, '仅接受 PDF');
  assert.deepEqual(details.attachments, [{ name: '说明.pdf', url: 'https://courses.zju.edu.cn/uploads/brief.pdf' }]);
  assert.equal(details.updatedAt, '2026-09-25 12:30');
  assert.equal(details.sourceUrl, 'https://courses.zju.edu.cn/course/123/activities/456');
  assert.equal(normalizeOfficialCourseUrl('https://example.com/assignment'), undefined);
  assert.equal(normalizeOfficialCourseUrl('http://courses.zju.edu.cn/assignment'), undefined);
});

test('detects when the official response contains no assignment body or attachments', () => {
  assert.equal(hasOfficialTodoDetails({ attachments: [] }), false);
  assert.equal(hasOfficialTodoDetails({ description: '  ', attachments: [] }), false);
  assert.equal(hasOfficialTodoDetails({ description: '作业说明', attachments: [] }), true);
  assert.equal(hasOfficialTodoDetails({ attachments: [{ name: '说明.pdf' }] }), true);
});

test('normalizes the verified official activity detail shape and attachment references', () => {
  const details = normalizeTodoDetails({
    description: '列表摘要，不应覆盖详情接口正文',
    data: { description: '<p>参见附件，并完成</p>' },
    upload_references: [{ upload_id: 12345, name: '作业说明.pdf', reference_id: 12345 }],
  });

  assert.equal(details.description, '参见附件，并完成');
  assert.deepEqual(details.attachments, [{
    name: '作业说明.pdf',
    url: 'https://courses.zju.edu.cn/api/uploads/reference/12345/blob',
  }]);
});

test('builds direct links only from numeric exact course and activity IDs', () => {
  assert.equal(officialActivityUrl('102844', '1191531'), 'https://courses.zju.edu.cn/course/102844/learning-activity#/1191531');
  assert.equal(officialActivityUrl('course-1', 'assignment-1'), undefined);
});

test('uses the exact official activity page when only a generic or untrusted todo URL is available', () => {
  const expected = 'https://courses.zju.edu.cn/course/102844/learning-activity#/1191531';
  assert.equal(officialTodoPageUrl('https://courses.zju.edu.cn/user/index', '102844', '1191531'), expected);
  assert.equal(officialTodoPageUrl('https://example.com/fake', '102844', '1191531'), expected);
  assert.equal(officialTodoPageUrl(undefined, '102844', '1191531'), expected);
});

test('preserves a trusted item-specific URL and falls back to the platform home only without verified IDs', () => {
  const specific = 'https://courses.zju.edu.cn/course/102844/learning-activity#/1191531';
  assert.equal(officialTodoPageUrl(specific, '102844', '1191531'), specific);
  assert.equal(officialTodoPageUrl('https://courses.zju.edu.cn/user/index', 'course-x', 'activity-y'), 'https://courses.zju.edu.cn/user/index');
});
