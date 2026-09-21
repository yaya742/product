import type { ManagedInterface } from '../../shared/interfaces';
import type { CapabilityProviderSnapshot } from '../capabilities/broker';

export interface InterfaceBroker {
  providerSnapshots(): CapabilityProviderSnapshot[];
  setProviderEnabled(id: string, enabled: boolean): void;
}

export class InterfaceManager {
  constructor(
    private readonly broker: InterfaceBroker,
    private readonly load: () => Record<string, boolean>,
    private readonly save: (states: Record<string, boolean>) => void,
    private readonly defaultEnabled: (id: string) => boolean = () => true,
  ) {}

  restore() {
    const stored = this.load() || {};
    const states: Record<string, boolean> = {};
    for (const item of this.broker.providerSnapshots()) {
      const enabled = typeof stored[item.id] === 'boolean' ? stored[item.id] : this.defaultEnabled(item.id);
      this.broker.setProviderEnabled(item.id, enabled);
      states[item.id] = enabled;
    }
    this.save(states);
  }

  list(): ManagedInterface[] {
    return this.broker.providerSnapshots().map((item) => ({
      id: item.id,
      displayName: item.displayName || item.id,
      description: item.description || '由在场宿主管理的能力接口。',
      version: item.version,
      trust: item.trust,
      sourceId: item.sourceId,
      egressHosts: [...item.egressHosts],
      platforms: [...item.platforms],
      simulated: item.simulated,
      offline: item.offline,
      license: item.license,
      enabled: item.enabled,
      connection: { ...item.connection },
      capabilities: item.capabilities.map((capability) => ({
        name: capability.name,
        displayName: capability.displayName || capability.name,
        description: capability.description || '按声明的参数和权限访问此能力。',
        version: capability.version,
        effect: capability.effect,
        requiredScopes: [...capability.requiredScopes],
        timeoutMs: capability.timeoutMs,
        maxBytes: capability.maxBytes,
        supportsIdempotency: capability.supportsIdempotency,
        supportsInspect: capability.supportsInspect,
        supportsCancel: capability.supportsCancel,
      })),
    }));
  }

  setEnabled(id: string, enabled: boolean) {
    this.broker.setProviderEnabled(id, enabled);
    const states = Object.fromEntries(this.broker.providerSnapshots().map((item) => [item.id, item.enabled]));
    this.save(states);
  }
}
