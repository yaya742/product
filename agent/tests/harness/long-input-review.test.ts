import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, controlProposal } from './support';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient } from '../../src/main/provider';
import type { Message } from '../../src/shared/types';
const tool = (name: string, args: unknown) => ({ id: 'fixture-' + name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
test('long tool-free input reviews the full original and repairs a middle omission without adding an action', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true;
  const quote = '请回复资料编号 CHECK_486。';
  const original = '合成背景信息。'.repeat(700) + quote + '其余背景信息。'.repeat(700) + '不登记任何事项。';
  let latest: Message | undefined, mainCalls = 0, reviews = 0;
  const harness = new Harness(f.store, () => '', event => { if (event.type === 'message' && event.message.role === 'assistant') latest = event.message; }, () => {
    const client = new DeepSeekClient('synthetic');
    client.complete = async (messages, _tools, _signal, _onText, options) => {
      if (options?.phase === 'control') { const { sources: _, ...proposal } = controlProposal({ actions: 'none', actionsApplyToWholeTurn: true }); return { content: '', tool_calls: [tool('propose_turn_controls', proposal)] }; }
      if (options?.phase === 'completion_review') {
        reviews++; const input = JSON.parse(String(messages.at(-1)?.content)); assert.ok(input.original.includes(quote));
        return { content: '', tool_calls: [tool('report_completion_gaps', { missing: reviews === 1 ? [{ quote, needed: 'The explicitly requested code was omitted.' }] : [], contradictions: [], requests: [] })] };
      }
      mainCalls++; return { content: mainCalls === 1 ? '没有登记任何事项。' : '资料编号 CHECK_486，没有登记事项。', tool_calls: [] };
    };
    return client;
  });
  try { harness.start(undefined, original); await harness.idle(); assert.equal(latest?.status, 'done'); assert.ok(latest.content.includes('CHECK_486')); assert.equal(mainCalls, 2); assert.equal(reviews, 2); assert.equal(f.store.agenda().length, 0); assert.equal(f.repo.work(f.scope()).length, 0); }
  finally { await harness.stop(); f.close(); }
});
test('a short direct exchange still needs no coverage review or working-state object', async () => {
  const f = new Fixture(); f.store.saveSettings({ mode: 'deepseek' }); f.memory.paused = true; let calls = 0;
  const harness = new Harness(f.store, () => '', () => {}, () => {
    const client = new DeepSeekClient('synthetic'); client.complete = async (_messages, _tools, _signal, _onText, options) => {
      if (options?.phase === 'control') { const { sources: _, ...proposal } = controlProposal(); return { content: '', tool_calls: [tool('propose_turn_controls', proposal)] }; }
      assert.equal(options?.phase, 'main'); calls++; return { content: '收到。', tool_calls: [] };
    }; return client;
  });
  try { harness.start(undefined, '请说收到。'); await harness.idle(); assert.equal(calls, 1); assert.equal(f.repo.work(f.scope()).length, 0); }
  finally { await harness.stop(); f.close(); }
});
