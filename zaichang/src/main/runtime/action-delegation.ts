import { z } from 'zod';
import { structuredResult } from './structured-result';
import type { DeepSeekClient, ModelWireMessage, ToolSpec } from '../provider';

const schema = z.object({
  decision: z.enum(['execute_local', 'draft_only', 'not_requested', 'needs_clarification']),
  basis: z.array(z.object({ id: z.string(), quote: z.string().min(1).max(2000) }).strict()).max(8),
  missing: z.array(z.string().max(200)).max(5),
  reason: z.string().max(500),
}).strict();
export type DelegationVerdict = z.infer<typeof schema>;

export async function checkLocalDelegation(
  request: { current: { id: string; text: string }; history: { id: string; role: string; content: string }[]; action: unknown; now: string; timeZone: string; conversationRetention?: string },
  complete: DeepSeekClient['complete'], signal: AbortSignal,
): Promise<DelegationVerdict> {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema);
  const tool: ToolSpec = { type: 'function', function: { name: 'verify_local_delegation', description: '检查拟执行的具体本地可撤销动作是否与当前明确委托一致，不签发外部授权。', parameters } };
  const messages: ModelWireMessage[] = [
    { role: 'system', content: '核对当前原话、允许的对话前情和拟执行的本地记录。判断用户是否明确委托这件事、日期/对象/参数是否相符、是否只是讨论或草稿、是否有尚未解决且会改变后果的歧义。聊天保留和业务记录是不同权限：不保存聊天不取消另行明确委托的本地登记，但事项参数只能含用户授权保存的必要业务内容，不复制私下原话或无关原因。用户同时禁止业务写入时不得执行。情绪不取消明确委托，赞同措辞不等于批准发送，助手建议不等于用户同意。结束时间未知时可以只登记开始时刻，不编造时长。createNew=true必须得到明确创建重复副本的要求，重试或重复确认不算。execute_local的basis仅引用current或history中的用户逐字原话，并且缺失项为空；优先引用current的宿主id。assistantContextNotAuthorization仅用于理解对象，不得放进授权basis；可以引用用户前文决定及本轮确认。不要输出最终答复，调用指定核验工具。' },
    { role: 'user', content: JSON.stringify({ ...request, history: request.history.filter(message => message.role === 'user'), assistantContextNotAuthorization: request.history.filter(message => message.role === 'assistant') }) },
  ];
  const evidence = new Map([[request.current.id, request.current.text], ...request.history.filter(m => m.role === 'user').map(m => [m.id, m.content] as [string, string])]);
  const assistantContext = request.history.filter(message => message.role === 'assistant');
  const verifiedSchema = schema.transform(value => {
    const basis = value.basis.flatMap(citation => {
      if (evidence.get(citation.id)?.includes(citation.quote)) return [citation];
      // Repeated identical wording has a strongest current-turn witness.
      if (request.current.text.includes(citation.quote)) return [{ ...citation, id: request.current.id }];
      const matches = [...evidence].filter(([, text]) => text.includes(citation.quote));
      if (matches.length === 1) return [{ ...citation, id: matches[0][0] }];
      // A genuine assistant quote can explain the object, but never grants
      // authority. Discard it, retaining only separately supported user basis.
      if (!matches.length && assistantContext.some(message => message.content.includes(citation.quote))) return [];
      return [citation];
    });
    return { ...value, basis };
  }).superRefine((value, context) => {
    if (value.basis.some(b => !evidence.get(b.id)?.includes(b.quote)) || (value.decision === 'execute_local' && (!value.basis.length || value.missing.length))) context.addIssue({ code: 'custom', message: '授权依据必须来自current或history中的用户逐字原话；助手上下文不能作为批准，未知引用不能执行。' });
  });
  return structuredResult({ schema: verifiedSchema, tool, messages, complete, signal, options: { thinking: 'enabled', maxOutputTokens: 8192, phase: 'verification' }, failureCode: 'delegation_unknown', failureMessage: '这项记录缺少有效的用户原话依据，未保存。' });
}
