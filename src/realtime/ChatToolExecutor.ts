import { PureChatLLMChat } from '../core/Chat';
import { IToolExecutor } from './providers/IVoiceCallProvider';
import { ToolDefinition } from '../types';
import { AbortHost, callWithSignal, toolTimeoutMs, withToolTimeout } from '../tools/toolContract';

/**
 * Runs a voice model's tool calls through the chat's tool registry, each with its time limit
 * and abort signal (see toolContract). `cancel()` aborts every call still running, for when the
 * call ends.
 */
export class ChatToolExecutor implements IToolExecutor {
  private controller = new AbortController();

  /**
   * @param chat - The voice chat whose tools run.
   */
  constructor(private chat: PureChatLLMChat) {}

  /**
   * Runs one tool. A timeout, cancellation or exception comes back as a tool error.
   * @param name - Tool name.
   * @param args - Arguments.
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const host = this.chat as unknown as AbortHost;
    return withToolTimeout(
      name,
      toolTimeoutMs(name),
      signal => callWithSignal(host, signal, () => this.chat.toolregistry.executeTool(name, args)),
      this.controller.signal,
    );
  }

  /** Aborts every running call (their results come back as `Cancelled`). */
  cancel(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  /**
   * Definitions of the enabled tools.
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.chat.toolregistry.getEnabledDefinitions();
  }
}
