import { createHash } from 'node:crypto';
import type { Draft } from '../../shared/types';
import { HarnessError } from '../../shared/harness';
import type { Store } from '../store';
import { isEphemeral } from '../runtime/policy';
import { hasCredentials } from '../runtime/redaction';
import { canonical } from '../runtime/semantics';

/** Unsent input stays in memory. Only a reviewed native UI action persists it. */
export class DraftStore {
  private pending = new Map<string, { draft: Draft; temporary: boolean; epoch: number }>();
  constructor(private store: Store) {}
  get(id: string): Draft { return structuredClone(this.pending.get(id)?.draft || this.store.meta<Draft>('draft:' + id, { text: '', attachment: null })); }
  save(id: string, draft: Draft, temporary = false, expectedEpoch?: number) {
    if (expectedEpoch !== undefined && expectedEpoch !== this.store.kernel.epoch) throw new HarnessError('stale_draft', '旧窗口的草稿未覆盖当前资料范围。');
    this.pending.set(id, { draft: structuredClone(draft), temporary, epoch: this.store.kernel.epoch });
    const old = this.store.db.prepare('SELECT 1 FROM meta WHERE key=?').get('draft:' + id);
    if (old) { this.store.db.prepare('DELETE FROM meta WHERE key=?').run('draft:' + id); this.store.kernel.checkpointPrivacy(); }
  }
  info(id: string) {
    const entry = this.pending.get(id), draft = this.get(id);
    const digest = createHash('sha256').update(canonical({ draft, epoch: entry?.epoch ?? this.store.kernel.epoch })).digest('hex');
    return { digest, changed: !!entry, empty: !draft.text && !draft.attachment, temporary: entry?.temporary || false, persisted: !entry };
  }
  persist(id: string, digest: string) {
    const entry = this.pending.get(id);
    if (!entry || this.info(id).digest !== digest || entry.epoch !== this.store.kernel.epoch) throw new HarnessError('stale_draft', '草稿或资料范围已改变，请先查看当前内容。');
    const text = entry.draft.text + (entry.draft.attachment?.kind === 'text' ? '\n' + entry.draft.attachment.text : '');
    if (entry.temporary || isEphemeral(entry.draft.text) || hasCredentials(text)) throw new HarnessError('ephemeral_draft', '这份草稿不写入本机保存区。');
    this.store.putMeta('draft:' + id, entry.draft);
    this.pending.delete(id);
  }
  clear(id?: string) {
    if (id) this.pending.delete(id); else this.pending.clear();
  }
  unsaved() { return [...this.pending].filter(([, value]) => value.draft.text || value.draft.attachment).map(([id]) => ({ id, ...this.info(id) })); }
}
