import type { z } from 'zod';
import type { DeepSeekClient, ModelWireMessage, ToolSpec, CompletionOptions } from '../provider';
import { ProviderError } from '../provider';
import { HarnessError } from '../../shared/harness';

/** A malformed proposal gets one fresh bounded attempt; never relax its schema. */
export async function structuredResult<T>(input: {
  schema: z.ZodType<T>; tool: ToolSpec; messages: ModelWireMessage[];
  complete: DeepSeekClient['complete']; signal: AbortSignal; options: CompletionOptions;
  failureCode: string; failureMessage: string;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt ? [...input.messages, { role: 'system' as const, content: '上次未给出可采用的完整结构，未被采用。根据相同原始材料重新调用指定工具，简洁提交严格合法的JSON对象，补齐schema所需字段。不得为通过格式校验改变事实、权限或任务要求。' }] : input.messages;
    let result: Awaited<ReturnType<DeepSeekClient['complete']>>;
    try { result = await input.complete(messages, [input.tool], input.signal, undefined, input.options); }
    catch (error) {
      if (attempt !== 0 || !(error instanceof ProviderError) || error.code !== 'output_length') throw error;
      input.signal.throwIfAborted();
      continue;
    }
    const calls = result.tool_calls.filter(call => call.function.name === input.tool.function.name);
    if (calls.length !== 1) continue;
    try {
      const parsed = input.schema.safeParse(JSON.parse(calls[0].function.arguments));
      if (parsed.success) return parsed.data;
    } catch { /* Malformed JSON has no authority and is not executed. */ }
  }
  throw new HarnessError(input.failureCode, input.failureMessage);
}
