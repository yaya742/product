import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DeepSeekClient, ProviderError } from '../../src/main/provider';
import { parseTurnControls } from '../../src/main/runtime/turn-controls';
import { DEEPSEEK_PRICING, usageCost } from '../../src/main/runtime/model-usage';
import { Fixture } from './support';
const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if ((!key && !usingLunaTestTransport()) || process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1') throw new Error('Live gate required.');
const out = process.env.ZAICHANG_EVAL_REPORT!;
const inputs = [
  '今天真烦。明天下午三点有组会，帮我记到本地安排里，结束时间没定；其他事情先别安排。',
  '脑子有点挤不动了，后天十点的碰头请放入日程，除此之外让我自己来。',
  '只替我登记周五的读书会就行，没交代的活动一概别加。',
  '我今天不想被规划，不过晚上七点和同伴的约定麻烦落个记录。',
  '先处理这一笔：9月18日的排练记到本机，剩下那些都别动。',
  '谢谢，讨论的开始时刻就按九点存一下，不要顺着它替我排一天。',
  '这只是练习材料，请只据附件给出建议，所有安排先当草稿，不要实际登记。',
  '请先写一封邮件草稿给老师，暂时不要发送。我周四可以参加。',
  '今天不想跑，只是今天。',
  '这周先在室内活动，下周再恢复原来的选择。',
  '明晚先不练琴，后天照旧。',
  '现在暂时不去图书馆，等雨停了再考虑。',
  '这个月先少接活动，别把它当我一直如此。',
  '这趟不坐车，下次还没决定。',
  '今天这些话不要保存。',
  '聊天可以保留，但是不要生成长期记忆。',
  '先读取我保存的“校对时长上限”，再判断20分钟的校对能不能放进去。不要改安排。',
  '翻出我记过的整备时间，再看看这会儿来不来得及。',
  '读取之前保存的绳长上限，判断八米是否符合。',
  '看看那份偏好里有没有对声音的限制，再提出候选。',
  '先核对我的会议记录，再告诉我是否已经改期。',
  '把已经登记的那条要求找出来，以它作为比较依据。',
  '这次只看我刚发的附件，不读任何旧记录。',
];
const rows: any[] = []; let calls = 0;
const client = evaluationClient(key), complete = client.complete.bind(client);
client.complete = async (...args) => {
  if (++calls > inputs.length * 2) throw new Error('Control validation budget exhausted.');
  const response = await complete(...args);
  (rows.at(-1).usage ||= []).push({ usage: response.usage || null, cost: usageCost(response.usage) });
  return response;
};
(async () => {
  const fixture = new Fixture();
  try {
  for (const [index, text] of inputs.entries()) {
    const row: any = { index, text }; rows.push(row);
    try {
      const proposal = await parseTurnControls(text, client, AbortSignal.timeout(90000), { sources: [...fixture.policy.validate(fixture.scope()).sources, ...([6, 22].includes(index) ? ['file:control-material'] : [])], capabilities: fixture.store.runtime.broker.catalog(fixture.scope(), '', 0, 100).items }); row.proposal = proposal;
      if (index < 6) {
        assert.equal(proposal.sources, 'unchanged');
        assert.ok(proposal.actions === 'unchanged' || !proposal.actionsApplyToWholeTurn);
      } else if (index === 6) {
        const ingress = fixture.policy.ingress(text, 'control-fixture-' + index, fixture.store.settings(), { semantic: proposal });
        const scope = fixture.policy.validate(ingress.contract.scope);
        row.effectiveSources = scope.sources;
        assert.ok(!scope.sources.includes('history:self') && !scope.sources.includes('profile:self'));
        assert.notEqual(proposal.actions, 'unchanged');
      } else if (index === 7) { assert.equal(proposal.audience, 'group'); assert.ok(proposal.release?.allowedFacts.length); }
      else if (index < 14) { assert.equal(proposal.retention, 'unchanged'); assert.ok(!proposal.uncertainControls.some(control => control.dimension === 'retention')); }
      else if (index < 16) assert.equal(proposal.retention, index === 14 ? 'session_only' : 'history_no_inference');
      else if (index < 22) { assert.equal(proposal.sourceAllowlist, null, 'requested lookup target is not an exclusive source restriction'); assert.equal(proposal.retention, 'unchanged'); }
      else {
        const ingress = fixture.policy.ingress(text, 'control-fixture-' + index, fixture.store.settings(), { semantic: proposal });
        const sources = fixture.policy.validate(ingress.contract.scope).sources;
        assert.ok(!sources.includes('history:self') && !sources.includes('profile:self'));
      }
      row.status = 'passed';
    } catch (error) { row.status = 'failed'; row.error = error instanceof Error ? error.message : 'error'; if (error instanceof ProviderError && ['quota', 'authentication'].includes(error.code)) row.externalBlock = error.code; }
    console.log(JSON.stringify({ index, status: row.status, error: row.error }));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ kind: 'real_model_control_development', modelTransport: evaluationModel(), budget: { maxCalls: inputs.length * 2, outputTokensPerCall: 16384, estimatedUpperUsd: usingLunaTestTransport() ? null : inputs.length * 2 * (6000 * .3 + 16384 * 1.2) / 1e6, pricing: usingLunaTestTransport() ? null : DEEPSEEK_PRICING }, calls, rows }, null, 2));
    if (row.externalBlock) break;
  }
  if (rows.some(row => row.status !== 'passed')) process.exitCode = 1;
  } finally { fixture.close(); }
})();
