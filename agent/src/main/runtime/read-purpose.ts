import { z } from 'zod';
import type { DeepSeekClient, ToolSpec } from '../provider';
import { HarnessError } from '../../shared/harness';

const verdictSchema = z.object({ allowed: z.boolean(), sourceQuote: z.string().max(3000), reason: z.string().max(600) }).strict();
/** Purpose verification for sensitive or mixed-subject reads; no data is read first. */
export async function verifyReadPurpose(original: string, proposed: unknown, complete: DeepSeekClient['complete'], signal: AbortSignal) {
  const { $schema: _, ...parameters } = z.toJSONSchema(verdictSchema);
  const tool: ToolSpec = { type: 'function', function: { name: 'verify_read_purpose', description: '在读取正文前核对本人敏感资料是否为这次请求所需，及参数范围是否相称。', parameters } };
  const result = await complete([
    { role: 'system', content: '在读取正文前核对拟读取来源是否为当前请求所需，以及具体领域、时间窗、字段范围是否相称。先区分资料是本人个人信息、他人信息，还是普通任务材料；明确委托的任务材料查询无需虚构本人个人资料用途。没有读取任何私人资料。不能把代问/假想对象的需要套成本人资料用途；混合请求中明确的本人查询可独立成立。连接授权不代表本次需要读所有字段。allowed必须有逐字sourceQuote；无法确定就不读取受影响资料，其他帮助继续。调用指定工具。' },
    { role: 'user', content: JSON.stringify({ original, proposed }) },
  ], [tool], signal, undefined, { thinking: 'enabled', maxOutputTokens: 4096 });
  const call = result.tool_calls.find(c => c.function.name === tool.function.name);
  if (!call) throw new HarnessError('purpose_unknown', '这次资料用途还没核清，暂未读取。');
  const verdict = verdictSchema.parse(JSON.parse(call.function.arguments));
  if (verdict.allowed && (!verdict.sourceQuote || !original.includes(verdict.sourceQuote))) throw new HarnessError('purpose_unknown', '读取用途缺少原话依据。');
  return verdict;
}
