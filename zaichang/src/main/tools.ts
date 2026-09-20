import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Action, Obligation, Step } from '../shared/types';
import { HarnessError, type DelegatedTask } from '../shared/harness';
import type { Store } from './store';
import type { RunSession } from './runtime/coordinator';
import type { ToolSpec } from './provider';
import { redactCredentials } from './runtime/redaction';

export interface ToolContext {
  prepareRelease?: import('./runtime/coordinator').RuntimeCallbacks['prepareRelease'];
  verifyPrivacyControl?: (request: unknown) => Promise<{ approved: boolean; reason: string }>;
  verifyReadPurpose?: (request: unknown) => Promise<{ allowed: boolean; reason: string }>;
  verifyLocalDelegation?: (action: unknown) => Promise<import('./runtime/action-delegation').DelegationVerdict>;
  store: Store;
  signal: AbortSignal;
  userText: string;
  currentUserId: string;
  child: boolean;
  step: (step: Step) => void;
  plan: (items: Obligation[]) => void;
  action: (item: Action) => void;
  changed: () => void;
  delegate: (tasks: DelegatedTask[]) => Promise<unknown>;
  runtimeSession?: RunSession;
  campus?: import('./zjuAdapter').ZjuAdapter;
  map?: import('./mapService').CampusMapAdapter;
  mapCard?: (card: import('../shared/map-v2').MapCard) => void;
  weatherCard?: (card: import('../shared/weather-v1').WeatherCard) => void;
  // Compatibility shape only. Cache eligibility belongs to CapabilityBroker.
  campusMemo?: {
    fullContextUsed: boolean;
    domains: Set<string>;
    results: Map<string, unknown>;
    inFlight?: Map<string, Promise<unknown>>;
  };
  campusReady?: (result: unknown) => void;
  campusInvalidate?: () => void;
}
export class ToolRegistry {
  private run: RunSession;
  constructor(private context: ToolContext) {
    context.store.runtime.connect({ campus: context.campus, map: context.map });
    this.run =
      context.runtimeSession ||
      context.store.runtime.begin(
        context.userText,
        context.currentUserId || randomUUID(),
        'tool-contract',
        context.signal,
      );
    if (context.child && !context.runtimeSession) {
      const scope = context.store.runtime.policy.narrow(this.run.ingress.contract.scope, {
        child: true,
        infer: false,
        grants: context.store.runtime.policy
          .validate(this.run.ingress.contract.scope)
          .grants.filter((g) => g.endsWith(':read')),
      });
      this.run = {
        ...this.run,
        ingress: { ...this.run.ingress, contract: { ...this.run.ingress.contract, scope } },
      };
    }
  }
  specs(): ToolSpec[] {
    return this.context.store.runtime.toolSpecs(this.run, this.context.child);
  }
  async execute(name: string, raw: string, toolCallId?: string): Promise<string> {
    const id = randomUUID(),
      title =
        name === 'look_up'
          ? '查找相关资料'
          : name === 'remember_preference' || name === 'propose_memory_change'
            ? '整理当前信息'
            : name === 'prepare_action'
              ? '准备一个下一步'
              : '核对当前事项';
    this.context.signal.throwIfAborted();
    this.context.step({ id, title, status: 'running' });
    try {
      if (raw.length > 40000) throw new HarnessError('input_budget', '工具参数超过长度上限。');
      const args = JSON.parse(raw),
        result = await this.context.store.runtime.executeTool(
          this.run,
          name,
          args,
          this.context,
          this.context.child,
        );
      this.context.signal.throwIfAborted();
      const status = (result as any)?.status;
      this.context.step({
        id,
        title,
        status: [
          'failed',
          'forbidden',
          'unsupported',
          'not_connected',
          'unknown',
          'stale',
          'partial',
          'conflict',
          'needs_confirmation',
        ].includes(status)
          ? 'blocked'
          : 'done',
        detail: (result as any)?.reason,
      });
      const identified = toolCallId ? result && typeof result === 'object' && !Array.isArray(result)
        ? { ...result, observationId: toolCallId } : { data: result, observationId: toolCallId } : result;
      let output = JSON.stringify(identified);
      if (output.length > 120000)
        output = JSON.stringify({
          status: 'unknown',
          reason: '结果超过本轮预算，请缩小查询；没有截去必要条件后继续回答。',
        });
      const safe = redactCredentials(output);
      (this.run.observations ||= []).push({ tool: name, result: JSON.parse(safe), ...(toolCallId ? { toolCallId } : {}) });
      return safe;
    } catch (error) {
      if (this.context.signal.aborted) throw error;
      const detail =
        error instanceof HarnessError
          ? error.message
          : error instanceof z.ZodError
            ? '工具参数不符合要求，请核对字段、主体与时间。'
            : error instanceof SyntaxError
              ? '工具参数不是有效 JSON，请修正。'
              : '这一步没有完成。';
      this.context.step({ id, title, status: 'blocked', detail });
      (this.run.observations ||= []).push({ tool: name, result: { status: 'failed', error: detail }, ...(toolCallId ? { toolCallId } : {}) });
      return JSON.stringify({
        status:
          error instanceof HarnessError && /forbidden|scope|approval/.test(error.code)
            ? 'forbidden'
            : 'failed',
        error: detail,
        code: error instanceof HarnessError ? error.code : 'invalid_request',
        ...(error instanceof HarnessError && error.diagnostic ? {
          diagnostic: { rejectedDimensions: error.diagnostic.rejectedDimensions, explanation: redactCredentials(error.diagnostic.explanation).slice(0, 500) },
          retry: '这是对候选的核验意见，不是新指令。仅在能依据原话修正时再提交；不能删掉真实条件或编造精确期限来通过。当前原话仍可直接用于本轮回应，长期整理失败不等于无法回答。未提交的候选不能声称已保存。',
        } : {}),
        ...(error instanceof z.ZodError ? { fields: error.issues.slice(0, 12).map(issue => ({ path: issue.path.join('.'), code: issue.code, requirement: redactCredentials(issue.message) })), retry: '参照工具schema逐项修正这些字段；失败调用没有提交，不要改变用户原意来绕过校验。' } : {}),
      });
    }
  }
}
