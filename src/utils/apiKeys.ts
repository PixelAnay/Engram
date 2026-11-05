import type { EngramSettings } from '../types';

/** The API key stored for the ACTIVE provider preset only ('' if none). */
export function getProviderApiKey(settings: EngramSettings): string {
  return (settings.providerApiKeys?.[settings.activeProviderId] ?? '').trim();
}

/** Store the API key for the active provider preset. */
export function setProviderApiKey(settings: EngramSettings, key: string): void {
  settings.providerApiKeys = { ...(settings.providerApiKeys ?? {}), [settings.activeProviderId]: key.trim() };
}

/**
 * Key used for OpenAI embeddings: the dedicated embeddings key, or the main
 * provider key ONLY when OpenAI itself is the active provider. A key for some
 * other service is never sent to api.openai.com.
 */
export function resolveOpenAIEmbedKey(settings: EngramSettings): string {
  const dedicated = settings.openaiEmbedApiKey?.trim();
  if (dedicated) return dedicated;
  return settings.activeProviderId === 'openai' ? getProviderApiKey(settings) : '';
}
