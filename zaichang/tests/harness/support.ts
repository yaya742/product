import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/main/store';
import { KernelRepository } from '../../src/main/storage/repository';
import { PolicyKernel } from '../../src/main/runtime/policy';
import { MemoryService, type SemanticReview } from '../../src/main/memory/service';
import {
  always,
  personalLabel,
  type ClockPort,
  type EvidenceEvent,
  type MemoryChange,
  type ScopeHandle,
} from '../../src/shared/harness';
import type { TurnControlProposal } from '../../src/main/runtime/turn-controls';
import type { DeepSeekClient } from '../../src/main/provider';

/** Explicit boundary fixture, not a simulated natural-language understanding score. */
export const controlProposal = (overrides: Partial<TurnControlProposal> = {}): TurnControlProposal => ({
  retention: 'unchanged', sources: 'unchanged', sourceAllowlist: null, sourceExclusions: [], sourceBasis: null, subject: 'self', world: 'real', audience: 'self',
  actions: 'unchanged', actionsApplyToWholeTurn: false, specificActionLimits: [], release: null,
  basis: [], uncertain: false, uncertainControls: [], ...overrides,
});

/** Explicit structural-model fixture for host mechanism tests, never a live-quality judge. */
export function withHostReplies(client: DeepSeekClient, proposal = controlProposal()): DeepSeekClient {
  const original = client.complete.bind(client);
  client.complete = async (...args) => {
    const names = args[1].map(tool => tool.function.name);
    const result = (name: string, value: unknown) => ({ content: '', tool_calls: [{ id: 'fixture-' + name, type: 'function' as const, function: { name, arguments: JSON.stringify(value) } }] });
    if (names.length === 1 && names[0] === 'propose_turn_controls') {
      const { sources, ...wire } = proposal;
      return result(names[0], { ...wire, sourceAllowlist: sources === 'current_only' ? ['current'] : wire.sourceAllowlist });
    }
    if (names.length === 1 && names[0] === 'report_completion_gaps') return result(names[0], { missing: [], contradictions: [], requests: [] });
    if (names.length === 1 && names[0] === 'verify_local_delegation') return result(names[0], { decision: 'draft_only', basis: [], missing: [], reason: 'Mechanism fixture has no semantic action approval.' });
    return original(...args);
  };
  return client;
}

export class FakeClock implements ClockPort {
  constructor(
    public time = '2026-09-14T06:00:00.000Z',
    private tick = 0,
  ) {}
  now() {
    return this.time;
  }
  monotonicMs() {
    return this.tick;
  }
  set(time: string) {
    this.tick += Math.max(0, Date.parse(time) - Date.parse(this.time));
    this.time = new Date(time).toISOString();
  }
  advance(ms: number) {
    this.tick += ms;
    this.time = new Date(Date.parse(this.time) + ms).toISOString();
  }
}
export const supported: SemanticReview = {
  supported: true,
  preservesSubject: true,
  preservesWorld: true,
  preservesTime: true,
  preservesConditions: true,
  reason: 'scripted contract review; not a real model evaluation',
  retention: 'allowed',
  temporalType: 'stable',
};
export function testDirectory(label: string) {
  const root = process.env.ZAICHANG_DATA_DIR;
  if (process.env.ZAICHANG_TEST !== '1' || !root || !process.env.ZAICHANG_TEST_ROOT)
    throw new Error('Use scripts/test-harness.mjs: isolated test profile required.');
  const relative = path.relative(process.env.ZAICHANG_TEST_ROOT, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Refusing non-isolated test directory');
  return fs.mkdtempSync(path.join(root, label + '-'));
}
export class Fixture {
  dir: string;
  file: string;
  store: Store;
  repo: KernelRepository;
  policy: PolicyKernel;
  memory: MemoryService;
  clock: FakeClock;
  constructor(dir?: string, clock = new FakeClock()) {
    this.dir = dir || testDirectory('fixture');
    this.file = path.join(this.dir, 'test.sqlite');
    this.clock = clock;
    this.store = new Store(this.file, {
      clock,
      identity: { principalId: 'student-a', workspaceId: 'personal-test', deviceId: 'desktop-test' },
    });
    this.repo = this.store.kernel;
    this.policy = this.store.runtime.policy;
    this.memory = this.store.runtime.memory;
  }
  scope(overrides: Parameters<PolicyKernel['hostScope']>[0] = {}) {
    return this.policy.hostScope(overrides);
  }
  ingest(text: string, id: string = randomUUID(), overrides: Partial<EvidenceEvent> = {}) {
    const scope = this.scope({
      currentEventIds: [id],
      ...(overrides.subjectId ? { subjectId: overrides.subjectId } : {}),
      ...(overrides.worldId ? { worldId: overrides.worldId } : {}),
    });
    return this.repo.ingest(scope, {
      id,
      ownerId: this.repo.identity.principalId,
      workspaceId: this.repo.identity.workspaceId,
      subjectId: this.repo.identity.principalId,
      worldId: 'real',
      sourceId: 'history:self',
      contentVersion: 1,
      text,
      speaker: 'user',
      kind: 'user_message',
      authority: 'user_statement',
      roots: [id],
      label: { ...personalLabel },
      receivedAt: this.clock.now(),
      status: 'active',
      ...overrides,
    });
  }
  change(event: EvidenceEvent, overrides: Partial<MemoryChange> = {}): MemoryChange {
    return {
      operation: 'ADD',
      eventId: event.id,
      sourceQuote: event.text,
      predicate: 'preference.explicit',
      value: { type: 'text', value: event.text },
      text: event.text,
      kind: 'explicit_preference',
      strength: 'soft',
      conditions: always,
      subject: 'source_subject',
      world: 'source_world',
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }
  async remember(text: string, overrides: Partial<MemoryChange> = {}) {
    const event = this.ingest(text);
    return this.memory.propose(this.scope(), this.change(event, overrides), undefined, { review: supported });
  }
  restart() {
    this.store.close();
    return new Fixture(this.dir, this.clock);
  }
  close() {
    this.store.close();
  }
}
