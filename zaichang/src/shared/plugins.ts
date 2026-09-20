import type { InterfaceTrust } from './interfaces';

/** The on-disk package lifecycle is deliberately restart based. */
export type PluginLifecycle =
  'active' | 'pending_install' | 'pending_upgrade' | 'pending_uninstall' | 'invalid';

export interface InstalledPlugin {
  id: string;
  displayName: string;
  description: string;
  version: string;
  activeVersion?: string;
  pendingVersion?: string;
  trust: InterfaceTrust;
  lifecycle: PluginLifecycle;
  enabled: boolean;
  installedAt: string;
  error?: string;
}

export interface PluginCapabilityPreview {
  name: string;
  displayName: string;
  description: string;
  effect: 'read' | 'local_write' | 'external_write';
  requiredScopes: string[];
  timeoutMs: number;
  maxBytes: number;
}

/** Renderer-safe summary shown before a third-party package is installed. */
export interface PluginPackagePreview {
  id: string;
  displayName: string;
  description: string;
  version: string;
  capabilities: PluginCapabilityPreview[];
  egressHosts: string[];
  platforms: string[];
  offline: 'read_cache' | 'unsupported';
  license: string;
}
