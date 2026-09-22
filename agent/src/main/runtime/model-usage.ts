import type { Completion } from '../provider';

export const DEEPSEEK_PRICING = {
  source: 'https://api-docs.deepseek.com/quick_start/pricing/', verifiedAt: '2026-09-13', currency: 'USD',
  perMillion: { peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }, offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 } },
};
/** A price range, not an account bill; missing usage remains unknown. */
export function usageCost(usage: Completion['usage']) {
  if (!usage || (usage.providerId && usage.providerId !== 'deepseek')) return null;
  const hit = Math.min(usage.prompt_tokens, Math.max(0, usage.prompt_cache_hit_tokens || 0));
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
  const cost = (rate: typeof DEEPSEEK_PRICING.perMillion.peak) => (hit * rate.cacheHit + miss * rate.cacheMiss + usage.completion_tokens * rate.output) / 1_000_000;
  return { usdMin: cost(DEEPSEEK_PRICING.perMillion.offPeak), usdMax: cost(DEEPSEEK_PRICING.perMillion.peak), pricingDate: DEEPSEEK_PRICING.verifiedAt };
}
