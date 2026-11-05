import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicProvider, convertContentParts } from '../src/providers/AnthropicProvider';
import { OpenAIProvider } from '../src/providers/OpenAIProvider';
import { ProviderFactory } from '../src/providers/ProviderFactory';
import { makeSettings } from './helpers';
import type { ChatMessage } from '../src/types';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function sse(...events: object[]) {
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stubFetch(responseFactory: () => Response) {
  const fetchMock = vi.fn(async (_url: string, _init: any) => responseFactory());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const okStream = () => sse(
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'message_stop' }
);

describe('image conversion', () => {
  it('data URLs become base64 image blocks; text parts stay text', () => {
    const blocks = convertContentParts([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
    expect(blocks).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('http(s) images use a url source', () => {
    expect(convertContentParts([{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }]))
      .toEqual([{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }]);
  });

  it('unsupported types are replaced by a note instead of failing the request', () => {
    const blocks = convertContentParts([{ type: 'image_url', image_url: { url: 'data:application/zip;base64,AAAA' } }]);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect((blocks[0] as any).text).toContain('application/zip');
  });
});

describe('AnthropicProvider request', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: PNG } },
    ] },
  ];

  it('sends images as image blocks, the browser-access header, max_tokens and a clamped temperature', async () => {
    const fetchMock = stubFetch(okStream);
    const p = new AnthropicProvider('https://api.anthropic.com', 'key-1');
    const res = await p.stream(messages, { model: 'claude-x', temperature: 1.8, maxTokens: 2048 }, () => {});
    expect(res.text).toBe('hi');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(init.headers['x-api-key']).toBe('key-1');
    expect(init.headers['anthropic-version']).toBeTruthy();

    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(1);               // 1.8 clamped
    expect(body.system).toBe('be brief');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(JSON.stringify(body)).not.toContain('image_url');
  });

  it('clamps negative temperature to 0 and keeps in-range values', async () => {
    const fetchMock = stubFetch(okStream);
    const p = new AnthropicProvider('https://api.anthropic.com', 'k');
    await p.stream([{ role: 'user', content: 'x' }], { model: 'm', temperature: -1 }, () => {});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0);
    await p.stream([{ role: 'user', content: 'x' }], { model: 'm', temperature: 0.4 }, () => {});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).temperature).toBe(0.4);
  });

  it('merges a text turn that follows a tool result without losing the image', async () => {
    const fetchMock = stubFetch(okStream);
    const p = new AnthropicProvider('https://api.anthropic.com', 'k');
    await p.stream([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_note', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'read_note', content: 'res' },
      { role: 'user', content: [{ type: 'text', text: 'and this?' }, { type: 'image_url', image_url: { url: PNG } }] },
    ], { model: 'm', temperature: 0.5 }, () => {});
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content.map((b: any) => b.type)).toEqual(['tool_result', 'text', 'image']);
  });
});

describe('reply length setting', () => {
  it('ProviderFactory passes maxOutputTokens (not a share of the context window)', async () => {
    const seen: any[] = [];
    const factory = new ProviderFactory(makeSettings({
      providerType: 'anthropic', maxOutputTokens: 1234, contextWindowTokens: 200000, toolCallingMode: 'disabled',
    }));
    (factory as any)._provider = {
      name: 'x', supportsTools: true, healthCheck: async () => ({}), listModels: async () => [],
      stream: async (_m: any, o: any) => { seen.push(o); return { toolCalls: [], text: 'ok', finishReason: 'stop' }; },
    };
    for await (const _ of factory.runTurn([{ role: 'user', content: 'x' }], { execute: async () => '' } as any, () => {})) { /* drain */ }
    expect(seen[0].maxTokens).toBe(1234);
  });

  it('OpenAI-compatible servers get max_tokens; api.openai.com gets max_completion_tokens', async () => {
    const fetchMock = stubFetch(() => new Response('data: [DONE]\n\n', { status: 200 }));
    await new OpenAIProvider('local', 'http://localhost:8080', '').stream(
      [{ role: 'user', content: 'x' }], { model: 'm', temperature: 0.7, maxTokens: 999 }, () => {});
    await new OpenAIProvider('openai', 'https://api.openai.com/v1', 'k').stream(
      [{ role: 'user', content: 'x' }], { model: 'm', temperature: 0.7, maxTokens: 999 }, () => {});
    const local = JSON.parse(fetchMock.mock.calls[0][1].body);
    const openai = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(local.max_tokens).toBe(999);
    expect(local.max_completion_tokens).toBeUndefined();
    expect(openai.max_completion_tokens).toBe(999);
    expect(openai.max_tokens).toBeUndefined();
  });
});
