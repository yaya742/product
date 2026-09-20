import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, { parseNoticeBody, parseLinks, validAcademicYear } from '../index.mjs';

function contextFor(routes) {
  const requested = [];
  return {
    requested,
    request: async (url) => {
      requested.push(url);
      const body = routes[url];
      if (body === undefined) return new Response('missing', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  };
}

test('manifest-facing calendar capability reads only the mediated host request', async () => {
  const indexUrl = 'https://ugrs.zju.edu.cn/28218/list1.htm';
  const pageUrl = 'https://ugrs.zju.edu.cn/2026/0710/c28218a3187939/page.htm';
  const context = contextFor({
    [indexUrl]: `<a href="${pageUrl}">浙江大学2026—2027学年校历</a>`,
    [pageUrl]: '<title>浙江大学2026-2027学年校历</title><a href="/files/calendar.pdf">校历 PDF</a><p>国庆节10月1日至10月7日放假。</p>',
  });

  const result = await plugin.invoke({
    name: 'school.calendar.read',
    args: { academicYear: '2026-2027' },
    context,
  });

  assert.equal(result.status, 'fresh');
  assert.equal(result.sourceId, 'plugin:campus.zju-public');
  assert.equal(result.simulated, false);
  assert.equal(result.data.events[0].startDate, '2026-10-01');
  assert.equal(result.data.sources[0].pdfUrl, 'https://ugrs.zju.edu.cn/files/calendar.pdf');
  assert.deepEqual(context.requested, [indexUrl, pageUrl]);
});

test('public notices normalize JSON and cap detail requests', async () => {
  const listUrl = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_cxMoreLoginNews.html?doType=query&queryModel.currentPage=1&queryModel.showCount=10&queryModel.sortName=sfzd+desc%2Cfbsj&queryModel.sortOrder=desc&xwbt=%E9%80%89%E8%AF%BE';
  const detailUrl = 'https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_ckLoginNews.html?xwbh=ABC';
  const context = contextFor({
    [listUrl]: JSON.stringify({ items: [{ xwbh: 'ABC', xwbt: '选课安排通知', fbsj: '2026-09-20', fbdz: detailUrl }], totalCount: 1 }),
    [detailUrl]: '<h3>选课安排通知</h3><div class="news_con">请按时完成选课。</div>',
  });

  const result = await plugin.invoke({
    name: 'school.notices.search',
    args: { query: '选课', detail: true },
    context,
  });

  assert.equal(result.status, 'fresh');
  assert.equal(result.data.notices[0].detail, '请按时完成选课。');
  assert.equal(context.requested.length, 2);
  assert.ok(context.requested.every((url) => new URL(url).hostname === 'zdbk.zju.edu.cn'));
});

test('college directory returns an official entry without following an undeclared college subdomain', async () => {
  const directoryUrl = 'https://www.zju.edu.cn/599/listm.htm';
  const context = contextFor({
    [directoryUrl]: '<a href="https://math.zju.edu.cn/">数学科学学院</a><a href="https://www.zju.edu.cn/about">学校简介</a>',
  });

  const result = await plugin.invoke({
    name: 'school.college.directory',
    args: { college: '数院' },
    context,
  });

  assert.equal(result.status, 'fresh');
  assert.equal(result.data.college, '数学科学学院');
  assert.equal(result.data.collegeHome, 'https://math.zju.edu.cn/');
  assert.match(result.data.records[0].detailUnavailable, /白名单/);
  assert.deepEqual(context.requested, [directoryUrl]);
});

test('invalid academic years and malformed public pages fail clearly', async () => {
  const badYear = await plugin.invoke({
    name: 'school.calendar.read',
    args: { academicYear: '2026-2028' },
    context: contextFor({}),
  });
  assert.equal(badYear.status, 'failed');
  assert.match(badYear.reason, /学年格式/);

  assert.equal(validAcademicYear('2026-2027'), '2026-2027');
  assert.equal(validAcademicYear('2026-2028'), null);
  assert.equal(parseNoticeBody(JSON.stringify({ items: [{ xwbh: '1', xwbt: '通知', fbdz: '' }] }), 'https://zdbk.zju.edu.cn/list', '').notices.length, 1);
  assert.equal(parseLinks('<a href="javascript:bad">不应返回</a><a href="/ok">官方页面</a>', 'https://www.zju.edu.cn/599/listm.htm').length, 1);
});

test('network failures are returned as controlled plugin failures', async () => {
  const result = await plugin.invoke({
    name: 'school.notices.search',
    args: {},
    context: { request: async () => { throw new Error('network'); } },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /network/);
});
