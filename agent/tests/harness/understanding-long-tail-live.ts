import { evaluationClient, evaluationModel, evaluationBudget, usingLunaTestTransport } from './live-model';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Fixture } from './support';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient, ProviderError } from '../../src/main/provider';
import type { Message } from '../../src/shared/types';
import { usageCost, DEEPSEEK_PRICING } from '../../src/main/runtime/model-usage';

const key = process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if ((!key && !usingLunaTestTransport()) || process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1') throw new Error('Project live evaluation gate required.');
const out = process.env.ZAICHANG_EVAL_REPORT!;
// Test content only: same intent with five new final corrections plus one
// neighboring positive control. Do not import these strings into production.
const corrections = [
  '最后更正：前面要求登记的那场演示取消，请不要登记，也不要建立提醒。',
  '说到最后我改主意了，那场演示先别记进本地安排，任何提醒也先不要设。',
  '前面的登记委托现在撤回，日程保持原样，不要替我留下那场演示。',
  '刚确认演示不办了，所以本轮不要执行开头那项登记。',
  '收尾补充：只保留对这份内容的理解，开头说的演示不登记、不提醒。',
  '最后那项变动优先：我不再委托登记演示，现有安排一条都别新增。',
  '最后确认：开头的演示照常举行，请按最初的标题和时间实际登记，结束时间仍未定。',
];
const selected = corrections.map((correction, index) => ({ correction, index, id: 'L' + String(index + 1).padStart(2, '0') })).filter(row => !process.env.ZAICHANG_LONG_TAIL_FILTER || process.env.ZAICHANG_LONG_TAIL_FILTER.split(',').includes(row.id));
if (!selected.length) throw new Error('No long-input cases selected.');
const results: any[] = []; let calls = 0, stopped = false;
fs.writeFileSync(path.join(out, 'budget.json'), JSON.stringify({ maxCalls: 100, outputTokens: 16384, pricing: usingLunaTestTransport() ? null : DEEPSEEK_PRICING, estimatedUpperUsd: usingLunaTestTransport() ? null : 100 * (30000 * .3 + 16384 * 1.2) / 1e6, role: 'targeted long-input repair validation, not additional independent story families' }, null, 2));
void (async () => {
  for (const { index, correction } of selected) {
    const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
    const row: any = { id: 'L' + String(index + 1).padStart(2, '0'), familyId: 'S12', positiveControl: index === 6, correction, calls: [] };
    let message: Message | undefined;
    const input = '请把“长文本演示”登记为明天14:00开始的本地事件，结束时间未定。先读完这整条话，再处理我的要求。\n'
      + '以下为无动作含义的合成工作记录。'.repeat(350)
      + '\n中部核对点：这次资料编号是 MID-784，请在回复中带上这个编号。\n'
      + '后续仍是无动作含义的合成工作记录。'.repeat(350) + '\n' + correction;
    row.input = input;
    const harness = new Harness(f.store, () => key || '', event => { if (event.type === 'message' && event.message.role === 'assistant') message = structuredClone(event.message); }, (secret, model) => {
      const client = evaluationClient(secret, model), original = client.complete.bind(client);
      client.complete = async (...args) => {
        if (++calls > 100 || stopped) throw new Error('Long-input batch stopped');
        const call: any = { phase: args[4]?.phase, tools: args[1].map(tool => tool.function.name), inputCharacters: JSON.stringify(args[0]).length }; row.calls.push(call);
        try { const result = await original(...args); Object.assign(call, { usage: result.usage || null, cost: usageCost(result.usage), output: result.content, toolCalls: result.tool_calls }); return result; }
        catch (error) { call.error = error instanceof Error ? error.message : 'unknown'; if (error instanceof ProviderError && ['quota','authentication'].includes(error.code)) stopped = true; throw error; }
      };
      return client;
    });
    try {
      harness.start(undefined, input); await harness.idle();
      const agenda = f.repo.db.prepare('SELECT payload FROM agenda').all().map(record => JSON.parse(String(record.payload)));
      row.message = message; row.agenda = agenda;
      assert.equal(message?.status, 'done'); assert.ok(message.content.includes('MID-784'), 'Middle content was not used');
      assert.equal(agenda.length, index === 6 ? 1 : 0, 'Final correction did not govern the actual effect');
      if (index === 6) { assert.equal(agenda[0].title, '长文本演示'); assert.equal(Date.parse(agenda[0].startsAt), Date.parse('2026-09-15T14:00:00+08:00')); assert.equal(agenda[0].durationMinutes, undefined); }
      row.status = 'passed';
    } catch (error) { row.status = 'failed'; row.error = error instanceof Error ? error.message : 'unknown'; }
    finally { await harness.stop(); f.close(); results.push(row); fs.writeFileSync(path.join(out, row.id + '.json'), JSON.stringify(row, null, 2)); console.log(JSON.stringify({ id: row.id, status: row.status, error: row.error, calls: row.calls.length })); }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ kind: 'real_model_long_input_cancellation', modelTransport: evaluationModel(), complete: results.length === selected.length, planned: selected.length, results: results.map(row => ({ id: row.id, status: row.status, error: row.error })), totalCalls: calls, status: stopped ? 'externally_blocked' : results.length === selected.length && results.every(row => row.status === 'passed') ? 'passed' : 'incomplete_or_failed' }, null, 2));
    if (stopped) break;
  }
  if (stopped || results.some(row => row.status !== 'passed')) process.exitCode = 1;
})();
