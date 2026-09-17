import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { structuredResult } from '../../src/main/runtime/structured-result';
import type { DeepSeekClient, ToolSpec } from '../../src/main/provider';
import { ProviderError } from '../../src/main/provider';

test('a structured review length failure gets one clean attempt without dropping thinking or masking access errors', async () => {
  const schema = z.object({ allowed: z.boolean() }).strict();
  const tool: ToolSpec = { type: 'function', function: { name: 'verify', description: 'Contract fixture', parameters: { type: 'object' } } };
  const input = { schema, tool, messages: [{ role: 'user' as const, content: 'Same evidence' }], signal: new AbortController().signal, options: { thinking: 'enabled' as const, maxOutputTokens: 16384, phase: 'completion_review' as const }, failureCode: 'bad_result', failureMessage: 'Incomplete' };
  let calls = 0;
  const result = await structuredResult({ ...input, complete: async (messages, tools, _signal, _onText, options) => {
    calls++; assert.equal(messages.filter(m => m.role === 'user')[0].content, 'Same evidence');
    assert.ok(messages.every(m => m.role !== 'assistant')); assert.deepEqual(tools, [tool]); assert.deepEqual(options, input.options);
    if (calls === 1) throw new ProviderError('Incomplete synthetic output', false, 'output_length');
    return { content: '', tool_calls: [{ id: 'verified', type: 'function', function: { name: 'verify', arguments: '{"allowed":false}' } }] };
  } });
  assert.equal(calls, 2); assert.deepEqual(result, { allowed: false });
  let denied = 0;
  await assert.rejects(structuredResult({ ...input, complete: async () => { denied++; throw new ProviderError('Denied', false, 'authentication'); } }), /Denied/);
  assert.equal(denied, 1);
});

test('malformed structured output gets one bounded repair without treating an invalid approval as authority', async () => {
  const schema = z.object({ allowed: z.boolean() }).strict();
  const tool: ToolSpec = { type: 'function', function: { name: 'verify', description: 'Contract fixture', parameters: { type: 'object' } } };
  let calls = 0;
  const complete: DeepSeekClient['complete'] = async messages => {
    calls++; assert.ok(messages.some(message => message.content === '原始资料'));
    return { content: '', tool_calls: [{ id: 'result-' + calls, type: 'function', function: { name: 'verify', arguments: calls === 1 ? '{"allowed":true,}' : '{"allowed":false}' } }] };
  };
  const value = await structuredResult({ schema, tool, messages: [{ role: 'user', content: '原始资料' }], complete, signal: new AbortController().signal, options: { thinking: 'enabled' }, failureCode: 'bad_result', failureMessage: '结果不可靠' });
  assert.equal(calls, 2); assert.deepEqual(value, { allowed: false });
  let invalid = 0;
  await assert.rejects(structuredResult({ schema, tool, messages: [{ role: 'user', content: '原始资料' }], complete: async () => { invalid++; return { content: 'I approve', tool_calls: [] }; }, signal: new AbortController().signal, options: { thinking: 'enabled' }, failureCode: 'bad_result', failureMessage: '结果不可靠' }), /结果不可靠/);
  assert.equal(invalid, 2);
});
