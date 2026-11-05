import { describe, it, expect } from 'vitest';
import { sanitizeForApi } from '../src/providers/sanitize';
import { ProviderFactory } from '../src/providers/ProviderFactory';
import { MessageRenderer } from '../src/ui/MessageRenderer';
import { findTurnUserIndex, lastAssistantIndexFrom } from '../src/chat/turnHelpers';
import { makeSettings } from './helpers';
import type { ChatMessage, ToolCall } from '../src/types';

const call = (id: string, name = 'read_note', args = '{"path":"A.md"}'): ToolCall =>
  ({ id, type: 'function', function: { name, arguments: args } });

describe('sanitizeForApi', () => {
  it('drops empty assistant messages (a failed reply must not poison later requests)', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: null },
    ];
    expect(sanitizeForApi(history).map(m => m.role)).toEqual(['user', 'user']);
  });

  it('strips UI-only fields', () => {
    const out = sanitizeForApi([
      { role: 'user', content: 'x', attachments: [{ name: 'a', type: 't' }], autoAttachedNotes: ['n.md'] },
    ]);
    expect(out[0]).toEqual({ role: 'user', content: 'x' });
  });

  it('keeps complete native tool exchanges', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [call('c1')] },
      { role: 'tool', tool_call_id: 'c1', name: 'read_note', content: 'result' },
      { role: 'assistant', content: 'answer' },
    ];
    const out = sanitizeForApi(history, 'native');
    expect(out).toHaveLength(4);
    expect(out[1].tool_calls).toHaveLength(1);
  });

  it('drops tool calls that never got a result (e.g. after Stop) and orphan results', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [call('lost')] },
      { role: 'user', content: 'next' },
      { role: 'tool', tool_call_id: 'ghost', name: 'x', content: 'orphan' },
    ];
    const out = sanitizeForApi(history, 'native');
    expect(out.map(m => m.role)).toEqual(['user', 'user']);
  });

  it('keeps answered calls and drops only the unanswered one', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: 'x', tool_calls: [call('a'), call('b')] },
      { role: 'tool', tool_call_id: 'a', name: 'read_note', content: 'ok' },
    ];
    const out = sanitizeForApi(history, 'native');
    expect(out[0].tool_calls?.map(t => t.id)).toEqual(['a']);
  });

  it('prompt_injection mode: tool traffic becomes plain text', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [call('c1')] },
      { role: 'tool', tool_call_id: 'c1', name: 'read_note', content: 'RESULT' },
    ];
    const out = sanitizeForApi(history, 'prompt_injection');
    expect(out.map(m => m.role)).toEqual(['assistant', 'user']);
    expect(out[0].tool_calls).toBeUndefined();
    expect(out[0].content).toContain('<tool_call>');
    expect(out[0].content).toContain('read_note');
    expect(out[1].content).toBe('[Tool result: read_note]\nRESULT');
  });

  it('does not mutate its input', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: '' }, { role: 'user', content: 'a', attachments: [] }];
    const copy = JSON.stringify(history);
    sanitizeForApi(history);
    expect(JSON.stringify(history)).toBe(copy);
  });
});

function fakeFactory(stream: (messages: ChatMessage[], options: any, onChunk: (c: any) => void) => Promise<any>) {
  const factory = new ProviderFactory(makeSettings({ toolCallingMode: 'disabled' }));
  (factory as any)._provider = { name: 'fake', supportsTools: true, stream, healthCheck: async () => ({}), listModels: async () => [] };
  return factory;
}

async function collect(gen: AsyncGenerator<any>) {
  let last: any = null;
  for await (const r of gen) last = r;
  return last as { messages: ChatMessage[]; error?: string };
}

const noTools = { execute: async () => 'x' } as any;

describe('runTurn', () => {
  it('a provider error yields an error and stores NO assistant message', async () => {
    const chunks: any[] = [];
    const factory = fakeFactory(async (_m, _o, onChunk) => {
      onChunk({ type: 'error', error: 'Provider error 500' });
      return { toolCalls: [], text: '', finishReason: 'error' };
    });
    const res = await collect(factory.runTurn([{ role: 'user', content: 'hi' }], noTools, c => chunks.push(c)));
    expect(res.error).toContain('500');
    expect(res.messages.map(m => m.role)).toEqual(['user']);
    expect(chunks.some(c => c.type === 'error')).toBe(true);
  });

  it('an empty reply is reported as an error, not stored', async () => {
    const factory = fakeFactory(async () => ({ toolCalls: [], text: '   ', finishReason: 'stop' }));
    const res = await collect(factory.runTurn([{ role: 'user', content: 'hi' }], noTools, () => {}));
    expect(res.error).toMatch(/empty reply/);
    expect(res.messages).toHaveLength(1);
  });

  it('a normal reply is stored', async () => {
    const factory = fakeFactory(async (_m, _o, onChunk) => {
      onChunk({ type: 'token', content: 'hello' });
      return { toolCalls: [], text: 'hello', finishReason: 'stop' };
    });
    const res = await collect(factory.runTurn([{ role: 'user', content: 'hi' }], noTools, () => {}));
    expect(res.error).toBeUndefined();
    expect(res.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('Stop then an immediate new turn: the old turn cannot clear or abort the new one', async () => {
    const signals: AbortSignal[] = [];
    const factory = fakeFactory((_m, options) => new Promise(resolve => {
      signals.push(options.signal);
      options.signal.addEventListener('abort', () =>
        resolve({ toolCalls: [], text: signals.length === 1 ? 'partial A' : '', finishReason: 'abort' }));
    }));

    const turnA = collect(factory.runTurn([{ role: 'user', content: 'A' }], noTools, () => {}));
    await new Promise(r => setTimeout(r, 5));
    factory.abort();                              // user presses Stop on A
    const turnB = collect(factory.runTurn([{ role: 'user', content: 'B' }], noTools, () => {}));
    await new Promise(r => setTimeout(r, 5));

    const resA = await turnA;                     // A finishes AFTER B started
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);       // B was not touched by A's cleanup
    expect((factory as any).abortController).not.toBeNull();

    factory.abort();                              // Stop now targets B
    expect(signals[1].aborted).toBe(true);
    const resB = await turnB;

    // No interleaving: each turn only contains its own messages
    expect(JSON.stringify(resA.messages)).toContain('partial A');
    expect(JSON.stringify(resA.messages)).not.toContain('"B"');
    expect(JSON.stringify(resB.messages)).not.toContain('partial A');
    expect((factory as any).abortController).toBeNull();
  });

  it('Stop during a tool loop answers every pending call', async () => {
    const factory = fakeFactory(async () => ({
      toolCalls: [call('c1'), call('c2')], text: '', finishReason: 'tool_calls',
    }));
    // enable tools so the loop runs, and abort from inside the first tool
    (factory as any).settings.toolCallingMode = 'native';
    const tools = { execute: async () => { factory.abort(); return 'first result'; } } as any;
    const res = await collect(factory.runTurn([{ role: 'user', content: 'go' }], tools, () => {}));
    const toolMsgs = res.messages.filter(m => m.role === 'tool');
    expect(toolMsgs.map(m => m.tool_call_id)).toEqual(['c1', 'c2']);
    expect(toolMsgs[1].content).toMatch(/Cancelled/);
    // the stored history is valid for the next request
    expect(sanitizeForApi(res.messages, 'native').filter(m => m.role === 'tool')).toHaveLength(2);
  });
});

describe('Edit / Regenerate target the right message', () => {
  // turn 1 used tools and succeeded; turn 2 failed with an error (user message only)
  const history: ChatMessage[] = [
    { role: 'user', content: 'first question' },                                   // 0
    { role: 'assistant', content: '', tool_calls: [call('c1')] },                  // 1
    { role: 'tool', tool_call_id: 'c1', name: 'read_note', content: 'result' },    // 2
    { role: 'assistant', content: 'first answer' },                                // 3
    { role: 'user', content: 'second question' },                                  // 4 (its reply failed)
  ];

  it('buildDisplayMessages records the history index of each bubble', () => {
    const display = MessageRenderer.buildDisplayMessages(history);
    expect(display.map(d => d.sourceIndex)).toEqual([0, 1, 3, 4]);
  });

  it('regenerating the final answer of a tool turn goes back to ITS user message', () => {
    const display = MessageRenderer.buildDisplayMessages(history);
    const finalAnswer = display.find(d => d.content === 'first answer')!;
    expect(findTurnUserIndex(history, finalAnswer.sourceIndex!)).toBe(0);
    // the tool-calling assistant bubble belongs to the same turn
    const toolBubble = display.find(d => d.sourceIndex === 1)!;
    expect(findTurnUserIndex(history, toolBubble.sourceIndex!)).toBe(0);
  });

  it('works when the bubble count and the message count differ', () => {
    // 4 bubbles vs 5 messages vs 3 user/assistant roles before index 4: counting would be wrong
    const display = MessageRenderer.buildDisplayMessages(history);
    const second = display.find(d => d.content === 'second question')!;
    expect(second.sourceIndex).toBe(4);
    expect(history[second.sourceIndex!].role).toBe('user');
  });

  it('lastAssistantIndexFrom links a live bubble to the end of its turn', () => {
    expect(lastAssistantIndexFrom(history, 1)).toBe(3);
    expect(lastAssistantIndexFrom(history, 4)).toBe(-1);
  });
});
