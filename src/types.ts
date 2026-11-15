import type { SubAgentEventKind, SubAgentEventRoute } from './agents/types';
export interface PureChatLLMSettings {
  AutogenerateTitle: number;
  SystemPrompt: string;
  debug: boolean;
  endpoint: number;
  endpoints: PureChatLLMAPI[];
  defaultmaxTokens: number;
  messageRoleFormatter: string;
  AutoReverseRoles: boolean;
  selectionTemplates: { [key: string]: string };
  chatTemplates: { [key: string]: string };
  addfiletocontext: boolean;
  CMDselectionTemplates: { [key: string]: boolean };
  CMDchatTemplates: { [key: string]: boolean };
  ModelsOnEndpoint: { [key: string]: string[] };
  useImageGeneration: boolean;
  resolveFilesForChatAnalysis: boolean;
  autoConcatMessagesFromSameRole: boolean;
  agentMode: boolean;
  useYAMLFrontMatter: boolean;
  enabledToolClassifications: {
    Vault: boolean;
    UI: boolean;
    System: boolean;
    AI: boolean;
    MCP: boolean;
  };
  blueFileResolution: {
    enabled: boolean;
    maxDepth: number;
    enableCaching: boolean;
    writeIntermediateResults: boolean;
  };
  blueResolutionViewMode?: 'tree' | 'graph';
  removeEmptyMessages: boolean;
  realtimeSystemPromptFile: string;
  /** Voice agent configuration (OpenAI Realtime, GPT-Live, Gemini Live, Grok Voice). */
  voice: VoiceSettings;
  /** Remote MCP servers (Streamable HTTP). */
  mcpServers: McpServerConfig[];
  /** Vault folder that holds Agent Skills (one sub-folder per skill, with `<name>.md` or SKILL.md). */
  skillsFolder: string;
  /** Code mode tool configuration. */
  codeMode: CodeModeSettings;
  orchestrator: OrchestratorSettings;
  graph: GraphSettings;
}

export type VoiceProviderId = 'openai-realtime' | 'openai-live' | 'gemini-live' | 'xai-voice';

/** How tools are exposed to voice agents. */
export type VoiceToolExposure = 'all' | 'codemode';

export interface OpenAIRealtimeVoiceSettings {
  model: string;
  voice: string;
  speed: number;
  turnDetection: 'semantic_vad' | 'server_vad' | 'none';
  eagerness: 'auto' | 'low' | 'medium' | 'high';
  noiseReduction: 'near_field' | 'far_field' | 'none';
  transcriptionModel: string;
  reasoningEffort: 'default' | 'minimal' | 'low' | 'medium' | 'high';
  idleTimeoutMs: number;
}

export interface OpenAILiveVoiceSettings {
  model: string;
  voice: string;
  /**
   * Who runs the duplex agent's backend.
   * - `responses`: OpenAI runs the backend model through the Responses API.
   * - `client`: this plugin runs the backend with the default chat provider and vault tools.
   */
  delegation: 'responses' | 'client';
  backendModel: string;
  backendInstructions: string;
  backendReasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high';
  toolChoice: 'auto' | 'required' | 'none';
  parallelToolCalls: boolean;
  serviceTier: 'auto' | 'priority';
  hostedWebSearch: boolean;
  acknowledgementDelayMs: number;
  store: boolean;
}

export interface GeminiLiveVoiceSettings {
  model: string;
  voice: string;
  languageCode: string;
  thinkingLevel: 'default' | 'low' | 'medium' | 'high';
  startSensitivity: 'default' | 'high' | 'low';
  endSensitivity: 'default' | 'high' | 'low';
  silenceDurationMs: number;
  proactiveAudio: boolean;
  transcription: boolean;
  contextCompression: boolean;
  sessionResumption: boolean;
  nonBlockingTools: boolean;
  toolScheduling: 'WHEN_IDLE' | 'INTERRUPT' | 'SILENT';
  googleSearch: boolean;
}

export interface XaiVoiceSettings {
  model: string;
  voice: string;
  speed: number;
  reasoningEffort: 'high' | 'none';
  turnDetection: 'server_vad' | 'none';
  webSearch: boolean;
  xSearch: boolean;
}

export interface VoiceSettings {
  provider: VoiceProviderId;
  toolExposure: VoiceToolExposure;
  /** Maximum characters of a tool result sent back to a voice model. */
  maxToolOutputChars: number;
  /**
   * Full duplex: you can talk over the voice model and cut it off (barge-in). Off keeps your
   * microphone closed while the model speaks, which suits speakers without headphones.
   * GPT-Live is always full duplex.
   */
  fullDuplex: boolean;
  /** Save each call, with the orchestrator's conversation and every sub-thread, as linked notes. */
  saveCalls: boolean;
  /** Vault folder for saved calls; each call gets its own folder inside. */
  callsFolder: string;
  openai: OpenAIRealtimeVoiceSettings;
  live: OpenAILiveVoiceSettings;
  gemini: GeminiLiveVoiceSettings;
  xai: XaiVoiceSettings;
}

export interface McpServerConfig {
  /** Short label, used to namespace tools (mcp__label__tool). */
  name: string;
  /** Streamable HTTP endpoint, e.g. https://example.com/mcp */
  url: string;
  enabled: boolean;
  /** Optional bearer token sent as `Authorization: Bearer ...`. */
  bearerToken: string;
  /** Extra headers, one `Name: value` per line. */
  headers: string;
  /**
   * `bridge`: the plugin calls the server and exposes its tools to every model.
   * `native`: hand the server to providers that support remote MCP natively
   * (OpenAI Realtime, GPT-Live Responses delegation, Grok Voice); other providers fall back to bridge.
   */
  mode: 'bridge' | 'native';
  /** Optional comma-separated allow-list of tool names. */
  allowedTools: string;
  /**
   * How the plugin authenticates: `token` sends `bearerToken` when set (also for servers with no
   * auth); `oauth` signs in through the browser (MCP authorization spec) and refreshes tokens.
   */
  auth?: 'token' | 'oauth';
  /** OAuth client and tokens, kept after sign-in. */
  oauth?: McpOAuthState;
}

export interface McpOAuthState {
  /** Client id: entered by the user or from dynamic registration. */
  clientId: string;
  clientSecret?: string;
  /** Space-separated scopes requested (empty uses the server's advertised scopes). */
  scope: string;
  /** Resource indicator sent with requests (RFC 8707). */
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires; 0 when unknown. */
  expiresAt: number;
}

export interface OrchestratorSettings {
  /**
   * How voice models work.
   * - `layered`: four layers. The voice model translates and filters, and relays requests to a
   *   separate orchestrator agent, which plans, writes briefs and runs worker sub-agents in the
   *   background (with an optional evaluator). Each layer keeps its own context.
   * - `orchestrator`: the voice model itself delegates to background sub-agents, checks on
   *   them and relays results.
   * - `direct`: the voice model calls tools itself.
   */
  voiceRole: 'layered' | 'orchestrator' | 'direct';
  /** Model, provider and reasoning effort for each layer. */
  layers: LayerSettings;
  /**
   * What the orchestrator sees of the call: `full` passes every transcript line once (its
   * context holds the whole conversation); `recent` passes only the last few lines per request.
   */
  voiceContext: 'full' | 'recent';
  /** With `recent`, transcript lines passed along with each request. */
  relayTranscriptLines: number;
  /** Characters of a worker's result or event the orchestrator gets as its summary. */
  taskSummaryChars: number;
  /** Messages the orchestrator keeps before older turns are dropped (its own context only). */
  orchestratorMaxMessages: number;
  /**
   * The voice model is told quietly which tools the orchestrator used and which tasks it started
   * (not their outputs), and can list them with orchestrator_activity.
   */
  voiceSeesActivity: boolean;
  /** System instructions for sub-agents. */
  subAgentInstructions: string;
  /** Model responses per task before it stops. */
  maxSteps: number;
  /** Tasks that run at the same time; the rest wait in a queue. */
  maxConcurrent: number;
  /** Minutes between timed check-ins on a running task. 0 turns them off. */
  checkInMinutes: number;
  /** Identical tool calls in a row, or failed tool calls in a row, that count as stuck. */
  stuckThreshold: number;
  /** Seconds a sub-agent waits for advice before it carries on alone. */
  adviceTimeoutSeconds: number;
  /**
   * Seconds between spoken progress updates while tasks run, from the start of each call.
   * 0 keeps the voice model quiet until something happens or you ask ("keep me posted").
   */
  progressUpdateSeconds: number;
  /**
   * When a result or question arrives while you are talking: `model` asks the sub-agent model
   * whether it overrules or changes what you are saying (then the voice model cuts in), `keywords`
   * compares words, `off` always waits for a pause.
   */
  relevanceCheck: 'model' | 'keywords' | 'off';
  /** Vault folder for task transcripts. Empty saves nothing to the vault. */
  taskFolder: string;
  /** How each event reaches the orchestrator. */
  routes: Record<SubAgentEventKind, SubAgentEventRoute>;
  /** What happens when a sub-agent creates, edits or deletes a note. */
  writes: Record<'create' | 'edit' | 'delete', SubAgentWritePolicy>;
  /**
   * Models for the two independent reviewers, comma separated, each optionally `model@Endpoint
   * name`. Empty uses the worker layer for both. Different models make the verdicts more
   * independent.
   */
  reviewerModels: string;
  /** Copy a note into the task folder before a reviewed edit changes it. */
  backupEdits: boolean;
}

/** Reasoning effort levels sent to providers that accept them. Empty sends none. */
export type ReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Which API a layer calls. `auto` uses Responses for OpenAI and ChatGPT sign-in. */
export type LayerApi = 'auto' | 'chat' | 'responses';

/** Endpoint name meaning "the ChatGPT account you signed in with". */
export const CHATGPT_SIGN_IN = 'ChatGPT sign-in';

export interface LayerModel {
  /** Endpoint name from the endpoint list, `ChatGPT sign-in`, or empty for the default endpoint. */
  endpoint: string;
  /** Model id. Empty uses the endpoint's default model. */
  model: string;
  effort: ReasoningEffort;
  api: LayerApi;
}

export interface LayerSettings {
  /** The agent that plans, writes briefs and runs workers. */
  orchestrator: LayerModel;
  /** Background sub-agents, and by default the two write reviewers. */
  worker: LayerModel;
  /** Optional advisor that checks plans and results when the orchestrator asks. */
  evaluator: LayerModel & { enabled: boolean };
}

/**
 * - `allow`: the sub-agent writes straight away.
 * - `peer`: two independent reviewer agents see only the proposed change; it is made only if both
 *   approve.
 * - `review`: the Edit Review window asks you.
 * - `deny`: sub-agents can't do it.
 */
export type SubAgentWritePolicy = 'allow' | 'peer' | 'review' | 'deny';

/** Typed graph and traversal settings. */
export interface GraphSettings {
  /**
   * Folder of Typed Graph schema notes (frontmatter with `tgs:`, such as `_types` or `Types`).
   * Empty finds every note whose frontmatter has `tgs:`.
   */
  typesFolder: string;
  /** Add a short summary of the vault's ontology to every sub-agent's instructions. */
  ontologyInPrompt: boolean;
  /** Vault folder of saved graph commands (scripts promoted into the graph CLI). */
  commandsFolder: string;
}

export interface CodeModeSettings {
  enabled: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  /**
   * Script engine.
   * - `auto`: djs when its WebAssembly module is found, otherwise the Web Worker.
   * - `djs`: djs only (fails when the module is missing).
   * - `worker`: the built-in Web Worker sandbox.
   */
  engine: 'auto' | 'djs' | 'worker';
  /** Vault path of djs.wasm. Empty means djs.wasm in the plugin folder. */
  djsModulePath: string;
  /** djs instruction budget per script. */
  djsMaxFuel: number;
  /** djs heap cap per script, in MB. */
  djsMemoryLimitMb: number;
}

export interface PureChatLLMAPI {
  name: string;
  apiKey: string;
  endpoint: string;
  defaultmodel: string;
  getapiKey: string;
}

export interface ChatParser {
  name: string;
  SplitMessages: RegExp;
  getRole: RegExp;
  rolePlacement: string;
  isChat: RegExp;
}

export const PURE_CHAT_LLM_VIEW_TYPE = 'pure-chat-llm-left-pane';
export const VOICE_CALL_VIEW_TYPE = 'voice-call-side-view';
export const BLUE_RESOLUTION_VIEW_TYPE = 'blue-resolution-tree-view';

// Tool Types
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  additionalProperties?: boolean | ToolParameter | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required: string[];
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export type ToolClassification = 'Vault' | 'UI' | 'System' | 'AI' | 'MCP';

export const TOOL_CLASSIFICATIONS: ToolClassification[] = ['Vault', 'UI', 'System', 'AI', 'MCP'];

// Chat Types
export interface ChatMessage {
  role: RoleType;
  content: string;
}

export type RoleType = 'system' | 'user' | 'assistant' | 'developer' | 'tool';

export interface ToolCall {
  index?: number;
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamDelta {
  content?: string;
  tool_calls?: ToolCall[];
  role?: string;
}

export type MediaMessage =
  | {
      type: 'image_url';
      image_url: { url: string };
    }
  | {
      type: 'input_audio';
      input_audio: { data: string; format: 'wav' | 'mp3' };
    }
  | {
      type: 'text';
      text: string;
    };

export interface ChatResponse {
  role: RoleType;
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatRequestOptions {
  model: string;
  messages: {
    role: RoleType;
    content?: string | MediaMessage[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    [key: string]: unknown;
  }[];
  stream?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  [key: string]: unknown;
}

export interface ChatOptions {
  model: string;
  messages: { role: RoleType; content: string }[];
  stream?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  tools?: string[];
}

// Voice Call Types
export type CallStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface CallState {
  status: CallStatus;
  isMuted: boolean;
  isLocalAudioEnabled: boolean;
  remoteParticipants: string[];
  error?: string;
}

export const PURE_CHAT_LLM_ICON_SVG = `<g
		stroke="currentColor"
		fill="none"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path
			stroke-width="8"
			d="m 15.354732,74.616162 a 42.5,42.5 0 0 1 2.75854,-52.713966 42.5,42.5 0 0 1 51.947897,-9.369508"
		/>
		<path stroke-width="8" d="m 31.25,42.5 h 42.5" />
		<path stroke-width="8" d="m 26.25,57.5 h 42.5" />
		<path stroke-width="8" d="M 47.5,30 30,87.5" />
		<path stroke-width="8" d="M 52.5,70 70,12.5" />
		<path stroke-width="8" d="M 30,87.5 7.5,92.5 15,75" />
		<path
			stroke-width="8"
			d="M 83.039667,23.267427 A 42.5,42.5 0 0 1 87.575737,69.857342 42.5,42.5 0 0 1 46.52797,92.357939"
		/>
	</g>`;

export const PURE_CHAT_LLM_ICON_NAME = 'pure-chat-llm';

// Blue File Resolution Types
export type ResolutionStatus =
  | 'idle'
  | 'resolving'
  | 'complete'
  | 'error'
  | 'cached'
  | 'cycle-detected';

export interface ResolutionEvent {
  type: 'start' | 'complete' | 'error' | 'cache-hit' | 'cycle-detected' | 'depth-limit';
  filePath: string;
  parentPath: string | null;
  depth: number;
  status: ResolutionStatus;
  isPendingChat: boolean;
  isChatFile?: boolean;
  error?: string;
  timestamp: number;
}

export interface ResolutionTreeData {
  rootFile: string;
  nodes: Map<string, ResolutionNodeData>;
  edges: Array<{ from: string; to: string }>;
}

export interface ResolutionNodeData {
  filePath: string;
  depth: number;
  status: ResolutionStatus;
  isPendingChat: boolean;
  isChatFile?: boolean;
  children: string[];
  error?: string;
}
