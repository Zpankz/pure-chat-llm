// The only file that imports Pi Durable, pi-ai and Chord. Their APIs are still experimental and
// change between releases (1.5.0 moved tool schemas to JSON Schema and changed the Storage commit
// contract), so every other file imports from here and a version bump touches one place.
// Adapted from vault-agent's src/agent/pi.ts (Zpankz/vault-agent at 58bd6b7) for 1.5.2.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TextContent } from '@earendil-works/pi-ai';

export type { Context } from '@earendil-works/chord/context';
export { withAbortSignal } from '@earendil-works/chord/context';

export {
  collapseSystemMessages,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
export type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  Models,
  MutableModels,
  ProviderStreams,
  StreamOptions,
  Tool as ModelTool,
  ToolCall as ModelToolCall,
  TranscriptContext,
  Usage,
} from '@earendil-works/pi-ai';

export {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  ToolTask,
} from '@earendil-works/pi-durable';
export type {
  Conversation,
  Extension,
  HarnessSettings,
  Registry,
  Report,
  Storage,
  ToolExecutionResult,
  ToolHookCall,
  ToolRegistration,
} from '@earendil-works/pi-durable';

/**
 * Never cancels. Cancelling a wait never cancels the work it waits for, so every harness call
 * that is not tied to one request takes this.
 */
export const CTX = BACKGROUND_CONTEXT;

/** Tool result text. `execute()` must return `{ output: [...] }`; a bare string is dropped. */
export const text = (t: string): { output: TextContent[] } => ({
  output: [{ type: 'text', text: t }],
});

export { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';
