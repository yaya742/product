export type InterfaceTrust = 'bundled_reviewed' | 'external_reviewed' | 'untrusted_disabled';
export type InterfaceOfflineMode = 'read_cache' | 'unsupported';

export interface InterfaceCapabilitySummary {
  name: string;
  displayName: string;
  description: string;
  version: string;
  effect: 'read' | 'local_write' | 'external_write';
  requiredScopes: string[];
  timeoutMs: number;
  maxBytes: number;
  supportsIdempotency: boolean;
  supportsInspect: boolean;
  supportsCancel: boolean;
}

export interface InterfaceConnection {
  connected: boolean;
  reason?: string;
  entry?: string;
}

/** Renderer-safe view of an installed capability interface. Schemas are kept in the host. */
export interface ManagedInterface {
  id: string;
  displayName: string;
  description: string;
  version: string;
  trust: InterfaceTrust;
  sourceId: string;
  egressHosts: string[];
  platforms: string[];
  simulated: boolean;
  offline: InterfaceOfflineMode;
  license: string;
  enabled: boolean;
  connection: InterfaceConnection;
  capabilities: InterfaceCapabilitySummary[];
}
