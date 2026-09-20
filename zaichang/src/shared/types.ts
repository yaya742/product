import type { CalendarFields } from './calendar';
import type { ManagedInterface } from './interfaces';
import type { InstalledPlugin } from './plugins';

export type StepStatus = 'running' | 'done' | 'blocked' | 'cancelled';
export const DEEPSEEK_MODEL = 'deepseek-flash' as const;
export type ImageMimeType = 'image/jpeg';
export interface ImageAttachment {
  kind: 'image';
  name: string;
  mimeType: ImageMimeType;
  dataUrl: string;
  width: number;
  height: number;
}
export interface TextAttachment {
  kind: 'text';
  name: string;
  text: string;
}
export type DraftAttachment = TextAttachment | ImageAttachment;
export interface Step {
  id: string;
  title: string;
  detail?: string;
  status: StepStatus;
  scope?: string;
}
export interface Obligation {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'blocked';
}
export interface Action extends CalendarFields {
  effectActionId?: string;
  id: string;
  title: string;
  detail: string;
  startsAt?: string;
  durationMinutes?: number;
  saved?: boolean;
  done?: boolean;
  demo?: boolean;
  revision?: number;
  approvalDigest?: string;
  coverage?: 'verified' | 'conditional' | 'not_feasible';
  missingNeeds?: string[];
}
export interface InterpretationSummary {
  posture: 'listen' | 'listen_and_local' | 'analyze' | 'act' | 'mixed';
  fragmentCount: number;
  explicitLocalWrite: boolean;
  unresolvedReferences: string[];
}
export interface ReleaseSummary {
  recipient: string;
  purpose: string;
  allowedFacts: string[];
  tone: string;
  mode: 'draft' | 'send';
  status: 'draft_only' | 'send_not_connected';
}
/** Host-created immutable local draft; this is not a remote mailbox receipt. */
export interface ReleaseArtifact {
  ownerId?: string;
  workspaceId?: string;
  sourceIds?: string[];
  sourceMessageIds?: string[];
  id: string;
  revision: number;
  body: string;
  createdAt: string;
  sourceMessageId: string;
  privacyEpoch: number;
  audience: 'group' | 'public';
  brief: { recipient: string; purpose: string; allowedFacts: string[]; tone: string; useAvailability: boolean };
  delivery: 'not_sent';
  supersedes?: { id: string; revision: number };
}
export interface Message {
  /** User-facing owner response before the host appends separately authored drafts. */
  responseText?: string;
  releaseArtifacts?: ReleaseArtifact[];
  requestControls?: TurnControls;
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  steps: Step[];
  obligations: Obligation[];
  actions: Action[];
  demo?: boolean;
  mapCards?: import('./map-v2').MapCard[];
  weatherCards?: import('./weather-v1').WeatherCard[];
  retention?: import('./harness').ContextContract['retention'];
  scopeSummary?: {
    memoryMode: string;
    retention: string;
    audience: string;
    interactionMode: string;
    interpretation?: InterpretationSummary;
    release?: ReleaseSummary;
  };
  contextReceipt?: import('./harness').ContextReceipt;
  image?: ImageAttachment;
}
export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}
export interface TurnControls {
  transmission?: 'cloud_allowed' | 'local_only';
  memoryMode?: import('./harness').ContextContract['memoryMode'];
  retention?: import('./harness').ContextContract['retention'];
  audience?: 'self' | 'group' | 'public';
}
export interface Memory {
  id: string;
  text: string;
  quote: string;
  createdAt: string;
}
export interface Draft {
  text: string;
  attachment: DraftAttachment | null;
}
export interface Settings {
  model: typeof DEEPSEEK_MODEL;
  mode: 'demo' | 'deepseek';
  memoryEnabled: boolean;
  weatherEnabled: boolean;
  weatherUseLocation: boolean;
  remindersEnabled: boolean;
  guidance: string;
  hasKey: boolean;
  keyStatus?: 'missing' | 'available' | 'invalid';
  timeZone?: string;
}
export interface CampusSnapshot {
  source: string;
  updatedAt: string;
  schedule: CampusEvent[];
  exams: CampusEvent[];
  sports?: { completed: number; required: number; deadline: string; ruleSource: string };
  places: { name: string; description: string; latitude?: number; longitude?: number }[];
  rules: { title: string; content: string; source: string }[];
}
export interface CampusEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  status: 'scheduled' | 'cancelled';
  source: string;
}
export interface State {
  privacyEpoch?: number;
  policyRevision?: number;
  settings: Settings;
  conversations: Conversation[];
  memories: Memory[];
  agenda: Action[];
  interfaces: ManagedInterface[];
  plugins: InstalledPlugin[];
  campus: { source: string; updatedAt: string; count: number } | null;
  campusConnector: {
    configured: boolean;
    available: boolean;
    label: string;
    sourceKind?: 'zju_account';
    accessMode?: 'compatibility_local' | 'official';
    supportedDomains?: string[];
    authStatus?: 'needs_login' | 'credentials_saved' | 'verified' | 'failed';
    lastVerifiedAt?: string;
    catalogued?: number;
    verified?: number;
    blocked?: number;
    credentialsConfigured?: boolean;
    reason?: string;
  } | null;
}
export type RunEvent =
  | { type: 'message'; message: Message }
  | { type: 'state'; state: State }
  | { type: 'conversations'; conversations: Conversation[] };
export interface RuntimeOverview {
  worlds: {
    worldId: string;
    baseRevision: number;
    status: string;
    items: {
      id: string;
      key: string;
      proposed: unknown;
      operation: string;
      effect: string;
      requiresApproval: boolean;
    }[];
  }[];
  memories: import('./harness').MemoryView[];
  work: import('./harness').WorkRecord[];
  actions: { action: import('./harness').EffectAction; receipts: import('./harness').EffectReceipt[] }[];
  processing: {
    eventId: string;
    receivedAt: string;
    fileName?: string;
    pending: number;
    failed: number;
    total: number;
  }[];
  watermarks: import('./harness').Watermarks;
  privacyEpoch: number;
  policyRevision: number;
  revoked: string[];
  notifications: {
    submitted: boolean;
    delivered: boolean;
    seen: boolean;
    stableId: boolean;
    closedApp: boolean;
  };
  storage: { atRestEncrypted: boolean; keyProtection: string };
}
export interface Bridge {
  state(): Promise<State>;
  messages(id: string): Promise<Message[]>;
  draft(id: string): Promise<Draft>;
  saveDraft(input: { id: string; draft: Draft; retention?: 'session_only'; privacyEpoch?: number }): Promise<void>;
  draftInfo(id: string): Promise<{ digest: string; changed: boolean; empty: boolean; temporary: boolean; persisted: boolean }>;
  unsavedDrafts(): Promise<{ id: string; digest: string; changed: boolean; empty: boolean; temporary: boolean; persisted: boolean }[]>;
  persistDraft(input: { id: string; digest: string; confirmed: true }): Promise<void>;
  send(input: {
    sessionId?: string;
    content: string;
    image?: ImageAttachment;
    controls?: TurnControls;
  }): Promise<{ sessionId: string }>;
  stop(): Promise<void>;
  saveSettings(input: Partial<Omit<Settings, 'hasKey'>> & { apiKey?: string }): Promise<State>;
  testConnection(input: { apiKey?: string }): Promise<string>;
  cancelConnection(): Promise<void>;
  deleteKey(): Promise<State>;
  interfaces(): Promise<ManagedInterface[]>;
  setInterfaceEnabled(input: { id: string; enabled: boolean }): Promise<State>;
  installPlugin(): Promise<State>;
  upgradePlugin(id: string): Promise<State>;
  uninstallPlugin(id: string): Promise<State>;
  memory(input: {
    action: 'save' | 'delete' | 'deactivate';
    id?: string;
    text?: string;
    expectedRevision?: number;
    operation?: 'CORRECT' | 'SUPERSEDE' | 'ADD_EXCEPTION' | 'REFINE';
    validFrom?: string;
    validTo?: string;
    conditions?: import('./harness').Condition;
  }): Promise<State>;
  runtimeOverview(): Promise<RuntimeOverview>;
  adoptWorld(input: {
    id: string;
    itemIds: string[];
    expectedBaseRevision: number;
    expectedPrivacyEpoch: number;
  }): Promise<RuntimeOverview>;
  evidence(id: string): Promise<import('./harness').EvidenceEvent | null>;
  goal(input: {
    id: string;
    expectedRevision: number;
    status: 'active' | 'paused' | 'cancelled';
  }): Promise<RuntimeOverview>;
  feedback(input: {
    recommendationId: string;
    response: 'accepted' | 'declined' | 'not_observed';
    reason?: string;
  }): Promise<{ saved: boolean; causalSuccess: 'not_established' }>;
  retryProcessing(eventId: string): Promise<RuntimeOverview>;
  reconcileAction(id: string): Promise<RuntimeOverview>;
  actionState(id: string): Promise<{
    action: import('./harness').EffectAction | null;
    receipts: import('./harness').EffectReceipt[];
  }>;
  permission(input: {
    scope: 'campus:read' | 'map:read' | 'location:read';
    enabled: boolean;
  }): Promise<RuntimeOverview>;
  deleteConversation(id: string): Promise<State>;
  clearData(): Promise<State>;
  importCampus(): Promise<State | null>;
  campusTemplate(): Promise<boolean>;
  connectCampusAccount(): Promise<State>;
  configureCampusConnector(): Promise<State>;
  disconnectCampusConnector(): Promise<State>;
  configureCampusCredentials(): Promise<State>;
  forgetCampusCredentials(): Promise<State>;
  mapLocate(): Promise<import('./map-v2').LocationStatusResult>;
  mapStopLocation(): Promise<void>;
  mapOverview(): Promise<import('./map-v2').MapOverview>;
  mapSearch(input: { query: string; limit?: number }): Promise<import('./map-v2').MapPoint[]>;
  mapLocationStatus(): Promise<import('./map-v2').LocationStatusResult>;
  mapRoute(input: import('./map-v2').MapRouteQuery): Promise<import('./map-v2').MapRouteResult>;
  disconnectCampus(): Promise<State>;
  action(input: { action: 'save' | 'delete' | 'done'; item: Action }): Promise<State>;
  attachText(): Promise<TextAttachment | null>;
  attachImage(): Promise<ImageAttachment | null>;
  exportData(): Promise<boolean>;
  openLink(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  window(action: 'minimize' | 'maximize' | 'close'): void;
  onEvent(callback: (event: RunEvent) => void): () => void;
}
export const DEFAULT_SETTINGS: Settings = {
  model: DEEPSEEK_MODEL,
  mode: 'demo',
  memoryEnabled: true,
  weatherEnabled: false,
  weatherUseLocation: false,
  remindersEnabled: false,
  guidance: '',
  hasKey: false,
  timeZone: 'Asia/Shanghai',
};
