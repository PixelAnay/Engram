import type { EngramSettings } from '../types';

/** Changes to any of these require the vault index to be rebuilt. */
export function scopeSignature(s: EngramSettings): string {
  return JSON.stringify([s.scopeMode, [...(s.scopeFolders ?? [])].sort(), s.excludePatterns ?? []]);
}

/** Changes to any of these require a fresh provider and a connection check. */
export function providerSignature(s: EngramSettings): string {
  return JSON.stringify([
    s.activeProviderId,
    s.providerType,
    s.providerBaseUrl,
    s.providerApiKeys?.[s.activeProviderId] ?? '',
    s.model,
  ]);
}
