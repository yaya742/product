import type { ScopeHandle } from '../../shared/harness';
import type { ReleaseArtifact } from '../../shared/types';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from './policy';

/** Reads only approved draft payloads, after SQL identity/source/fence filtering. */
export function readReleaseArtifacts(repo: KernelRepository, policy: PolicyKernel, scope: ScopeHandle, sessionId: string, id?: string): ReleaseArtifact[] {
  const allowed = policy.validate(scope);
  if (!allowed.sources.includes('history:self') || !allowed.grants.includes('evidence:read') || allowed.audience !== 'self' || allowed.subjectId !== allowed.principalId || allowed.worldId !== 'real') return [];
  const rows = repo.db.prepare(`WITH eligible AS (
    SELECT j.value, m.rowid AS message_order,
      ROW_NUMBER() OVER(PARTITION BY json_extract(j.value,'$.id') ORDER BY json_extract(j.value,'$.revision') DESC,m.rowid DESC) AS version_rank
    FROM messages m,json_each(m.payload,'$.releaseArtifacts') j
    JOIN h_evidence origin ON origin.id=json_extract(j.value,'$.sourceMessageId')
    WHERE m.session_id=? AND m.role='assistant' AND json_extract(m.payload,'$.status')='done'
      AND origin.owner=? AND origin.workspace=? AND origin.status='active'
      AND json_extract(j.value,'$.privacyEpoch')=?
      AND (json_extract(j.value,'$.ownerId') IS NULL OR json_extract(j.value,'$.ownerId')=?)
      AND (json_extract(j.value,'$.workspaceId') IS NULL OR json_extract(j.value,'$.workspaceId')=?)
      AND NOT EXISTS(SELECT 1 FROM h_source_restrictions x WHERE x.event_id=origin.id)
      AND NOT EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(j.value,'$.sourceIds'),json_extract(m.payload,'$.contextReceipt.providedSourceIds'),'["history:self"]')) src WHERE src.value NOT IN (SELECT value FROM json_each(?)))
      ${id ? "AND json_extract(j.value,'$.id')=?" : ''}
  ) SELECT value FROM eligible WHERE version_rank=1 ORDER BY message_order DESC ${id ? '' : 'LIMIT 12'}`).all(sessionId, allowed.principalId, allowed.workspaceId, allowed.privacyEpoch, allowed.principalId, allowed.workspaceId, JSON.stringify(allowed.sources), ...(id ? [id] : []));
  const artifacts = rows.map(row => JSON.parse(String(row.value)) as ReleaseArtifact);
  for (const artifact of artifacts) repo.access.push({ principalId: allowed.principalId, scopeId: scope.id, purposes: allowed.purposes, source: 'history:self', objectId: artifact.id, kind: 'release_artifact' });
  return artifacts;
}

/** Legacy outward-only messages have no draft version; never treat owner prose as an old draft. */
export function readLegacyRelease(repo: KernelRepository, policy: PolicyKernel, scope: ScopeHandle, sessionId: string) {
  const allowed = policy.validate(scope);
  if (!allowed.sources.includes('history:self') || !allowed.grants.includes('evidence:read') || allowed.audience !== 'self' || allowed.subjectId !== allowed.principalId || allowed.worldId !== 'real') return;
  const row = repo.db.prepare(`SELECT m.id,m.content,json_extract(m.payload,'$.scopeSummary.release') AS brief FROM messages m
    WHERE m.session_id=? AND m.role='assistant' AND json_extract(m.payload,'$.status')='done'
      AND json_type(m.payload,'$.releaseArtifacts') IS NULL
      AND json_type(m.payload,'$.scopeSummary.release')='object' AND json_extract(m.payload,'$.scopeSummary.audience') IN ('group','public')
      AND json_extract(m.payload,'$.contextReceipt.privacyEpoch')=?
      AND EXISTS(SELECT 1 FROM messages u JOIN h_evidence e ON e.id=u.id WHERE u.session_id=m.session_id AND e.owner=? AND e.workspace=?)
      AND NOT EXISTS(SELECT 1 FROM messages u JOIN h_evidence e ON e.id=u.id WHERE u.session_id=m.session_id AND (e.owner!=? OR e.workspace!=?))
      AND NOT EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(m.payload,'$.contextReceipt.providedSourceIds'),'[]')) src WHERE src.value NOT IN (SELECT value FROM json_each(?)))
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`).get(sessionId, allowed.privacyEpoch, allowed.principalId, allowed.workspaceId, allowed.principalId, allowed.workspaceId, JSON.stringify(allowed.sources));
  if (!row) return;
  repo.access.push({ principalId: allowed.principalId, scopeId: scope.id, purposes: allowed.purposes, source: 'history:self', objectId: String(row.id), kind: 'legacy_release' });
  return { id: String(row.id), text: String(row.content), brief: JSON.parse(String(row.brief)) as { recipient: string; [key: string]: unknown } };
}
