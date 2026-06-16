// ─── LLM Message Types ──────────────────────────────────────────────────────

export interface MessageContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | MessageContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Stripped before persistence — blobs only live for the duration of the API call */
  attachments?: { name: string; type: string; dataUrl: string }[];
  autoAttachedNotes?: string[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ─── Provider Types ──────────────────────────────────────────────────────────

export type ProviderType = 'openai_compat' | 'anthropic';
export type EditPermission = 'read_only' | 'read_append' | 'full_edit';
export type ToolCallingMode = 'native' | 'prompt_injection' | 'disabled';
export type ScopeMode = 'all' | 'allowlist' | 'denylist';

export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  isLocal: boolean;
}

// ─── Persona Types ───────────────────────────────────────────────────────────

export interface Persona {
  id: string;
  name: string;
  systemPrompt: string;
}

// ─── Memory Types ────────────────────────────────────────────────────────────

export interface MemoryFact {
  section: string;
  fact: string;
}

// ─── Vault Index Types ───────────────────────────────────────────────────────

export interface NoteMetadata {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  mtime: number;
  wordCount: number;
  size: number;
}

// ─── Plugin Settings ─────────────────────────────────────────────────────────

export interface EngramSettings {
  // Active provider
  activeProviderId: string;
  providerType: ProviderType;
  providerBaseUrl: string;
  providerApiKey: string;
  model: string;
  temperature: number;

  // Persona
  activePersonaId: string;
  personas: Persona[];

  // Memory
  memoryPath: string;
  memoryEnabled: boolean;
  maxMemoryTokens: number;
  autoExtractMemory: boolean;

  // Vault scope
  scopeMode: ScopeMode;
  scopeFolders: string[];
  editPermission: EditPermission;
  excludePatterns: string[];

  // Context
  contextWindowTokens: number;
  maxRecentMessages: number;
  autoInjectNotes: number;
  toolCallingMode: ToolCallingMode;
  maxToolCallDepth: number;

  // Embeddings
  ollamaEmbedEndpoint: string;
  embeddingModel: string;
  embedProvider?: 'none' | 'ollama' | 'openai' | 'custom';
  ollamaEmbedUrl?: string;
  ollamaEmbedModel?: string;
  openaiEmbedModel?: string;
  openaiEmbedApiKey?: string;
  customEmbedUrl?: string;
  customEmbedModel?: string;
  customEmbedApiKey?: string;

  // Edit safety
  showDiffPreview: boolean;
  diffPreviewThreshold: number;
  showAdvancedSettings?: boolean;
}

// ─── Persisted Chat Session ───────────────────────────────────────────────────

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

// ─── Stream / UI Event Types ──────────────────────────────────────────────────

export interface StreamChunk {
  type: 'token' | 'tool_start' | 'tool_end' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  error?: string;
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  snippet?: string;
  score: number;
}

// ─── Legacy alias (keeps old imports working during transition) ──────────────
/** @deprecated Use EngramSettings */
export type LlamaPluginSettings = EngramSettings;
