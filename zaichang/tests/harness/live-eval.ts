import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Fixture } from './support';
import { Harness } from '../../src/main/harness';
import { DeepSeekClient } from '../../src/main/provider';
import type { ContextPack } from '../../src/shared/harness';
async function main() {
  const out = process.env.ZAICHANG_EVAL_REPORT!;
  if (process.env.ZAICHANG_ALLOW_LIVE_EVAL !== '1' || !process.env.ZAICHANG_TEST_DEEPSEEK_KEY)
    throw new Error('Explicit isolated live evaluation authorization and test key required.');
  const corpusPath = process.env.ZAICHANG_LIVE_CORPUS || 'tests/harness/semantic-corpus.json';
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const defaultVariants = [
    'full',
    'no_long_memory',
    'small_profile',
    'lexical',
    'without_time_conditions',
    'without_original',
    'without_current_correction',
    'without_dependency_expansion',
    'without_experience_reasons',
  ];
  const variants = (process.env.ZAICHANG_LIVE_VARIANTS || defaultVariants.join(','))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    requestedEpisodes = (process.env.ZAICHANG_LIVE_EPISODES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    episodes = requestedEpisodes.length
      ? corpus.episodes.filter((episode: any) => requestedEpisodes.includes(episode.id))
      : corpus.episodes,
    episodeBudget = Math.max(1, Number(process.env.ZAICHANG_LIVE_CALL_BUDGET || 24)),
    sampleLabel = process.env.ZAICHANG_LIVE_SAMPLE_LABEL || (requestedEpisodes.length ? 'bounded_sample' : 'full_corpus');
  if (!episodes.length) throw new Error('ZAICHANG_LIVE_EPISODES did not match any corpus episode.');
  if (episodes.length * variants.length > 64)
    throw new Error('Live sample exceeds the 64-run safety cap; narrow episodes or variants explicitly.');
  const results: any[] = [],
    model = 'deepseek-flash';
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  for (const variant of variants)
    for (const episode of episodes) {
      const f = new Fixture(),
        r = f.store.runtime,
        started = performance.now(),
        requests: any[] = [],
        trace: any[] = [],
        emitted: any[] = [];
      let message: any, error: string | undefined;
      f.store.saveSettings({ mode: 'deepseek', model });
      // Evaluation-only interventions. Production defaults and all authorization/commit/action guards remain intact.
      if (variant === 'without_current_correction') (r.context as any).currentFacts = () => ({});
      if (variant === 'without_dependency_expansion') r.context.expand = async (pack) => pack;
      const serialize = r.context.serialize.bind(r.context);
      r.context.serialize = (pack: ContextPack) => {
        const copy = structuredClone(pack.data);
        if (variant === 'no_long_memory') {
          copy.evidenceBundles = [];
          copy.workState = [];
        }
        if (variant === 'small_profile')
          copy.evidenceBundles = (copy.evidenceBundles as any[])
            .filter((b) => b.understanding)
            .slice(0, 5)
            .map((b) => ({ profile: b.understanding.map((a: any) => a.text) }));
        if (variant === 'lexical')
          copy.evidenceBundles = (copy.evidenceBundles as any[]).filter((b) => b.original);
        if (variant === 'without_original')
          copy.evidenceBundles = (copy.evidenceBundles as any[])
            .filter((b) => !b.original)
            .map((b) => ({ ...b, sources: [] }));
        if (variant === 'without_time_conditions') {
          delete copy.time;
          copy.evidenceBundles = (copy.evidenceBundles as any[]).map((b) => ({
            ...b,
            understanding: b.understanding?.map(({ conditions, validFrom, validTo, ...a }: any) => a),
          }));
        }
        if (variant === 'without_current_correction') {
          copy.currentFacts = {};
          copy.correctionOverlay = [];
        }
        if (variant === 'without_experience_reasons')
          copy.workState = (copy.workState as any[]).filter((w) => w.kind !== 'experience');
        return serialize({ ...pack, data: copy });
      };
      let totalCalls = 0;
      const harness = new Harness(
        f.store,
        () => process.env.ZAICHANG_TEST_DEEPSEEK_KEY!,
        (event) => {
          if (event.type === 'message' && event.message.role === 'assistant') message = event.message;
          if (event.type === 'message')
            emitted.push({
              role: event.message.role,
              status: event.message.status,
              contentLength: event.message.content.length,
              steps: event.message.steps.map((step) => ({
                title: step.title,
                status: step.status,
                scope: step.scope,
              })),
              actionCount: event.message.actions.length,
            });
          else if (event.type === 'state') emitted.push({ type: 'state' });
        },
        (key, m) => {
          const client = new DeepSeekClient(key, m),
            complete = client.complete.bind(client);
          client.complete = async (...args) => {
            if (++totalCalls > episodeBudget) throw new Error('Fixed episode call budget exceeded');
            const at = performance.now(),
              messages = args[0],
              kind = messages[0]?.content?.includes('[harness:extract')
                ? 'extraction'
                : messages[0]?.content?.includes('[harness:verify')
                  ? 'verification'
                  : 'generation',
              record: any = {
                call: totalCalls,
                kind,
                inputCharacters: JSON.stringify(messages).length,
                payloadHash: hash(JSON.stringify(messages)),
                messageRoles: messages.map((item) => item.role),
                availableToolNames: args[1].map((tool) => tool.function.name),
                priorToolResults: messages
                  .filter((item) => item.role === 'tool')
                  .map((item) => {
                    let parsed: any;
                    try {
                      parsed = JSON.parse(item.content || '{}');
                    } catch {
                      parsed = undefined;
                    }
                    return {
                      toolCallId: item.tool_call_id,
                      contentLength: item.content?.length || 0,
                      status: parsed?.status,
                      capability: parsed?.capability,
                      reason: parsed?.reason || parsed?.error?.code,
                    };
                  }),
              };
            requests.push(record);
            try {
              const value = await complete(...args);
              record.outputCharacters = JSON.stringify(value).length;
              record.outputText = value.content || '';
              record.toolCalls = value.tool_calls.map((call) => ({
                name: call.function.name,
                arguments: call.function.arguments.slice(0, 4000),
              }));
              // Presence only: provider reasoning is deliberately not retained.
              record.reasoningPresent = Boolean(client.assistantMessage(value).reasoning_content);
                return value;
              } catch (e) {
                record.failed = true;
                record.error = e instanceof Error ? e.message : String(e);
                throw e;
              } finally {
                record.latencyMs = performance.now() - at;
                trace.push({ ...record });
              }
          };
          return client;
        },
      );
      try {
        let sessionId: string | undefined;
        for (const text of episode.turns) {
          sessionId = harness.start(sessionId, text).sessionId;
          await harness.idle();
          if (message?.status === 'error') throw new Error(message.content);
        }
      } catch (e) {
        error = String(e);
      }
      const memories = r.memory.views(),
        contract = r.lastSession?.ingress.contract;
      const violations: string[] = [];
      if (episode.expectedMemoryMode && contract?.memoryMode !== episode.expectedMemoryMode)
        violations.push('memory_mode');
      if (episode.expectedAudience && contract?.audience !== episode.expectedAudience)
        violations.push('audience');
      for (const forbidden of episode.forbiddenFacts)
        if (memories.some((m) => m.status === 'active' && m.text.includes(forbidden)))
          violations.push('forbidden_fact:' + forbidden);
      results.push({
        episodeId: episode.id,
        split: episode.split,
        groups: episode.groups,
        variant,
        status: error ? 'failed' : 'requires_semantic_review',
        error,
        violations,
        latencyMs: performance.now() - started,
        requests,
        trace,
        emitted,
        modelCalls: totalCalls,
        output: message?.content,
        contract: contract
          ? {
              memoryMode: contract.memoryMode,
              interactionMode: contract.interactionMode,
              audience: contract.audience,
              retention: contract.retention,
              purpose: contract.purpose,
              sources: contract.scope.sources,
            }
          : undefined,
        memories,
        receipt: message?.contextReceipt,
        actions: r.actions.list(f.scope()),
        note: 'Synthetic corpus only. Slot checks are diagnostics, not a semantic correctness oracle.',
      });
      await harness.stop();
      f.close();
      fs.writeFileSync(path.join(out, 'runs.json'), JSON.stringify(results, null, 2));
    }
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const providerReceipts = results
    .map((result) => result.receipt?.provider)
    .filter((provider) => provider && typeof provider === 'object');
  const observedProviders = [
    ...new Map(
      providerReceipts.map((provider: any) => [
        JSON.stringify({
          providerId: provider.providerId,
          endpoint: provider.endpoint,
          model: provider.model,
          protocol: provider.protocol,
          protocolVersion: provider.protocolVersion,
        }),
        provider,
      ]),
    ).values(),
  ];
  fs.writeFileSync(
    path.join(out, 'live.json'),
    JSON.stringify(
      {
        status: results.some((r) => r.error || r.violations.length) ? 'failed' : 'requires_semantic_review',
        kind: 'real_model',
        model,
        provider: {
          observed: observedProviders,
          note: 'Observed from ContextReceipt; no provider secret or prompt payload is recorded.',
        },
        thinking:
          observedProviders.length === 1
            ? observedProviders[0].requestModes?.thinking || 'not_observed'
            : observedProviders.length > 1
              ? 'mixed'
              : 'not_observed',
        seed: null,
        providerSeedSupport: 'not_claimed',
        promptVersion: 'harness-v1',
        corpusHash: hash(JSON.stringify(corpus)),
        goldStatus: corpus.goldStatus,
        episodeBudget: { modelCalls: episodeBudget, perTurnContextTokens: 24000 },
        sampleLabel,
        selectedEpisodeIds: episodes.map((episode: any) => episode.id),
        variants,
        runs: results.length,
        failedRuns: results.filter((r) => r.error).length,
        diagnosticViolations: results.reduce((n, r) => n + r.violations.length, 0),
        latencyMs: {
          p50: latencies[Math.floor(latencies.length * 0.5)],
          p95: latencies[Math.floor(latencies.length * 0.95)],
        },
        cost: {
          currency: null,
          amount: null,
          reason: 'billing usage/prices unavailable; character and call counts recorded',
        },
        semanticMetrics: {
          precision: null,
          conditionRetention: null,
          bundleRecall: null,
          confidenceIntervals: null,
          denominator: results.filter((r) => r.split === 'heldout').length,
          reason:
            'Independent semantic adjudication must label every run before calculating precision/recall and episode-cluster intervals.',
        },
        limitations: [
          'Serialization baselines can use the same authorized tools; report tool recovery and budget use.',
          'Time/condition ablation removes structured slots; original prose still carries conditions.',
          'Current correction ablation removes deterministic overlay; original current input remains.',
          'No vector baseline: no approved embedding provider.',
        ],
      },
      null,
      2,
    ),
  );
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
