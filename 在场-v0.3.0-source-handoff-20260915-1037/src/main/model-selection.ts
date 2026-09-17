import { DeepSeekClient } from './provider';
import { AppServerLunaClient } from './luna-provider';

export type ModelClient = Pick<DeepSeekClient, 'complete' | 'assistantMessage' | 'invalidateBoundary' | 'providerMetadata'>;
/** Host launch choice only. Saved settings and renderer input cannot select it. */
export const usingLunaTestTransport = () => process.env.ZAICHANG_MODEL_TRANSPORT === 'luna-app-server-test';
export function createModelClient(key: string, model: string): ModelClient {
  return usingLunaTestTransport() ? new AppServerLunaClient() : new DeepSeekClient(key, model);
}
