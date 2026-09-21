import { z } from 'zod';
import { HarnessError } from '../../shared/harness';
import type { DeepSeekClient, ToolSpec } from '../provider';
import { structuredResult } from './structured-result';

const reviewSchema = z.object({
  missing: z.array(z.object({ quote: z.string().max(3000), needed: z.string().max(1500) }).strict()).max(12),
  contradictions: z.array(z.string().max(1200)).max(12),
  requests: z.array(z.object({ id: z.string().max(160), status: z.enum(['answered', 'succeeded', 'unresolved']), actionIds: z.array(z.string().max(160)).max(8),
    kind: z.enum(['answer', 'action', 'artifact']).optional().describe('按用户实际所需结果核对；请求记录里的分类也是可纠正提案。说明是answer，成稿是artifact，改变业务状态才是action。'),
    basisQuote: z.string().max(3000).optional().describe('修正请求分类时逐字引用该请求原话，不能由成稿推定外发已经完成。'),
    artifactIds: z.array(z.string().max(160)).max(8).optional().describe('实际成稿ID；它们不是动作ID，不放入actionIds。'),
  }).strict()).max(20),
}).strict();
export type CompletionReview = z.infer<typeof reviewSchema>;

/** Targeted coverage/receipt review, not a style/personality rewriting agent. */
export async function reviewCompletion(input: {
  original: string; reply: string; requests: unknown[]; actions: unknown[]; observations: unknown[]; hostState?: unknown;
}, complete: DeepSeekClient['complete'], signal: AbortSignal): Promise<CompletionReview> {
  const { $schema: _, ...parameters } = z.toJSONSchema(reviewSchema);
  const tool: ToolSpec = { type: 'function', function: { name: 'report_completion_gaps', description: '只报告实质遗漏、事实/回执不一致，以及各明确请求的实际状态。', parameters } };
  const value = await structuredResult({ schema: reviewSchema, tool, complete, signal, failureCode: 'review_incomplete', failureMessage: '答复还没完成必要核查，已执行结果可在安排中查看。', options: { thinking: 'enabled', maxOutputTokens: 16384, phase: 'completion_review' }, messages: [
    { role: 'system', content: '核对原话、实际工具观察、宿主动作回执与拟发答复。检查明确请求是否真正答到或办成、最新纠正是否改变判断、禁止动作是否仍未执行、失败/未知是否诚实、未来提醒是否有实际渠道。不能信答复自报成功，action请求必须对应参数相符的成功回执。hostState中的目录是宿主提供的能力说明；搜索结果只覆盖匹配项，没出现在某页中不能证明能力不存在。区分能力存在、连接状态、本轮操作许可和动作已经发生；目录不证明动作完成。若hostState.requireReleaseArtifacts=true，用户实际要求的对外稿件须有hostState.releaseArtifacts或prepare_release回执；宿主会把成稿原样附在主回复后，应连同成稿判断是否交付，不要求主Agent复写正文。主回复自行写出的对外文稿不能代替独立成稿。只请求私下讨论/说明或当前通道未连接的发送请求不强求新稿。若hostState.writingOnly=true，则本次本身是成稿核验，不需要另一份成稿回执。只报告实质问题，禁止扩张用户目标或按个人风格重写答复；不要将合理简短回答判为缺详细解释。missing.quote必须逐字来自original；没有实质缺口就返回空数组。requests只更新输入提供的请求ID，不自造ID。原请求类别也是模型提案：私下说明是answer，交付草稿是artifact，实际登记/发送才是action；类别误判时给kind及该请求的逐字basisQuote。成稿引用artifactIds并标answered，业务操作引用actionIds及成功回执，不能用稿件冒充发送回执。调用指定工具提交。' },
    { role: 'user', content: JSON.stringify(input) },
  ] });
  const replyClaims = value.missing.filter(gap => !input.original.includes(gap.quote) && input.reply.includes(gap.quote));
  value.contradictions.push(...replyClaims.map(gap => gap.needed));
  value.missing = value.missing.filter(gap => !replyClaims.includes(gap));
  if (value.missing.some(gap => !input.original.includes(gap.quote)))
    throw new HarnessError('review_evidence', '核查未能对齐原话，不能据此扩大任务。');
  return value;
}
