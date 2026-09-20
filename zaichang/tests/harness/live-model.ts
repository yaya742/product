import { DeepSeekClient } from '../../src/main/provider';
import { AppServerLunaClient, LUNA_SUBSTITUTE } from '../../src/main/luna-provider';
import { usingLunaTestTransport } from '../../src/main/model-selection';
export { usingLunaTestTransport };
export const evaluationModel = () => usingLunaTestTransport() ? LUNA_SUBSTITUTE : { model: 'deepseek-flash', providerId: 'deepseek', temporaryTestSubstitute: false };
export function evaluationClient(key = '', model = 'deepseek-flash', fetcher: typeof fetch = fetch) {
  return usingLunaTestTransport() ? new AppServerLunaClient({ fetcher }) : new DeepSeekClient(key, model, fetcher);
}
/** Reports only: never apply DeepSeek's estimated API prices to account usage. */
export function evaluationBudget<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = { ...value, modelTransport: evaluationModel() };
  if (usingLunaTestTransport()) {
    for (const key of ['pricing', 'estimatedUpperUsd', 'estimatedMaxUsd', 'estimatedCurrencyCostUpperUsd', 'maxCostUsd']) if (key in result) result[key] = null;
    result.costStatus = 'account_usage_unknown_cost';
  }
  return result as T;
}
