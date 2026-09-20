import { z } from 'zod';
import type { DeepSeekClient, ToolSpec } from '../provider';
import { HarnessError } from '../../shared/harness';

const schema = z.object({ approved: z.boolean(), quote: z.string().max(3000), reason: z.string().max(600) }).strict();
export async function verifyPrivacyControl(original: string, operation: unknown, complete: DeepSeekClient['complete'], signal: AbortSignal) {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema);
  const tool: ToolSpec = { type: 'function', function: { name: 'verify_privacy_control', description: '核对具体停用、遗忘或撤权是否得到当前用户明确要求。', parameters } };
  const result = await complete([
    { role: 'system', content: '核对原始用户话语是否明确要求对给定对象停用、遗忘或撤权；区分讨论、引用、假设、抱怨与实际控制。遗忘会清理本机原文和派生资料，不能把暂时不用理解成删除，不能扩大目标对象。信息不足则approved=false。批准必须引用当前用户逐字quote。只调用给定工具，不执行任何操作。' },
    { role: 'user', content: JSON.stringify({ original, operation }) },
  ], [tool], signal, undefined, { thinking: 'enabled', maxOutputTokens: 4096 });
  const call = result.tool_calls.find(c => c.function.name === tool.function.name);
  if (!call) throw new HarnessError('privacy_control_unknown', '这次要改动的内容还不明确，尚未删除或撤权。');
  const verdict = schema.parse(JSON.parse(call.function.arguments));
  if (verdict.approved && (!verdict.quote || !original.includes(verdict.quote))) throw new HarnessError('privacy_control_unknown', '这项控制没有有效的原话依据。');
  return verdict;
}
