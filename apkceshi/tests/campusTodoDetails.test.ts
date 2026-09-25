import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOfficialCourseUrl, normalizeTodoDetails } from '../src/runtime/todoDetails.ts';

test('normalizes only explicitly returned todo detail fields and strips markup', () => {
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
});

test('does not invent detail fields or accept non-official source links', () => {
  const details = normalizeTodoDetails({ title: '周作业', course_name: '概率论', end_time: '2026-09-30' });

  assert.equal(details.description, undefined);
  assert.equal(details.submissionRequirements, undefined);
  assert.deepEqual(details.attachments, []);
  assert.equal(details.sourceUrl, undefined);
  assert.equal(normalizeOfficialCourseUrl('https://example.com/assignment'), undefined);
  assert.equal(normalizeOfficialCourseUrl('http://courses.zju.edu.cn/assignment'), undefined);
});

test('keeps an attachment label but rejects an untrusted attachment URL', () => {
  const details = normalizeTodoDetails({ attachments: [{ name: '参考资料', url: 'https://example.com/file.pdf' }] });
  assert.deepEqual(details.attachments, [{ name: '参考资料' }]);
});
