import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async (orig) => {
  const actual: any = await orig();
  return { ...actual, requestUrl: vi.fn() };
});

import { requestUrl } from 'obsidian';
import { createDebouncer } from '../src/utils/debounce';
import { scopeSignature, providerSignature } from '../src/utils/settingsSignature';
import { DEFAULT_SETTINGS } from '../src/settings';
import { OpenAIProvider } from '../src/providers/OpenAIProvider';
import { AnthropicProvider } from '../src/providers/AnthropicProvider';

const clone = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

describe('debounced text saves', () => {
  it('10 keystrokes produce a single save', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const d = createDebouncer(save, 500);
    for (let i = 0; i < 10; i++) { d.call(); vi.advanceTimersByTime(100); }
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('flush runs a pending save immediately', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const d = createDebouncer(save, 500);
    d.call();
    d.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('settings signatures', () => {
  it('temperature changes affect neither signature', () => {
    const a = clone();
    const b = clone(); b.temperature = 1.3;
    expect(providerSignature(a)).toBe(providerSignature(b));
    expect(scopeSignature(a)).toBe(scopeSignature(b));
  });
  it('provider changes alter only the provider signature', () => {
    const a = clone();
    const b = clone(); b.activeProviderId = 'openai'; b.model = 'gpt-4o';
    expect(providerSignature(a)).not.toBe(providerSignature(b));
    expect(scopeSignature(a)).toBe(scopeSignature(b));
  });
  it('scope changes alter only the scope signature', () => {
    const a = clone();
    const b = clone(); b.excludePatterns = ['X/**'];
    expect(scopeSignature(a)).not.toBe(scopeSignature(b));
    expect(providerSignature(a)).toBe(providerSignature(b));
  });
});

describe('health checks never send a completion', () => {
  beforeEach(() => (requestUrl as any).mockReset());

  it('OpenAI-compatible uses GET /models only', async () => {
    (requestUrl as any).mockResolvedValue({ status: 200, json: { data: [{ id: 'gpt-4o' }] } });
    const p = new OpenAIProvider('x', 'http://h/v1', 'k');
    const s = await p.healthCheck('gpt-4o');
    expect(s.modelFound).toBe(true);
    const calls = (requestUrl as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('http://h/v1/models');
  });

  it('reports a model missing from the list', async () => {
    (requestUrl as any).mockResolvedValue({ status: 200, json: { data: [{ id: 'a' }] } });
    const p = new OpenAIProvider('x', 'http://h/v1', '');
    expect((await p.healthCheck('nope')).modelFound).toBe(false);
  });

  it('Anthropic uses GET /v1/models only', async () => {
    (requestUrl as any).mockResolvedValue({ status: 200, json: { data: [{ id: 'claude-x' }] } });
    const p = new AnthropicProvider('https://api.anthropic.com', 'k');
    await p.healthCheck('claude-x');
    const calls = (requestUrl as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/v1/models');
  });
});
