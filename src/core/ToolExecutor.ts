import { ToolRegistry } from '../tools';
import { ChatRequestOptions, RoleType, StreamDelta, ToolCall } from '../types';
import { ChatSession } from './ChatSession';
import {
  AbortHost,
  callWithSignal,
  isReadOnlyTool,
  toolError,
  toolTimeoutMs,
  withToolTimeout,
} from '../tools/toolContract';

/**
 * ToolExecutor handles the execution of tool calls from LLM responses.
 *
 * Responsibilities:
 * - Execute tool calls using the ToolRegistry, each with its time limit and abort signal
 *   (see toolContract): a hung call comes back as `Error: Timeout: ...`
 * - Run read-only calls from one model turn side by side; everything else one at a time, in order
 * - Manage tool execution flow
 * - Filter uncalled tool calls from message history
 * - Update chat session with tool execution results
 */
export class ToolExecutor {
  private streamCallback?: (delta: StreamDelta) => Promise<boolean>;

  /**
   * @param toolRegistry - Tools of the chat.
   * @param host - Where tools read their abort signal (the chat). Its `abortSignal` at the start
   *   of a turn is the request's: when it aborts, running calls are cancelled. Defaults to the
   *   registry's chat.
   */
  constructor(
    private toolRegistry: ToolRegistry,
    private host?: AbortHost,
  ) {}

  /** The chat tools read their abort signal from. */
  private get signalHost(): AbortHost | undefined {
    return this.host ?? (this.toolRegistry as unknown as { chat?: AbortHost }).chat;
  }

  /**
   * Sets the stream callback for tool status updates.
   * @param callback - The callback function to invoke with tool status updates
   */
  setStreamCallback(callback?: (delta: StreamDelta) => Promise<boolean>): void {
    this.streamCallback = callback;
    this.toolRegistry.setCallBack(callback);
  }

  /**
   * Executes tool calls and updates the session and options.
   *
   * @param toolCalls - The tool calls to execute
   * @param session - The chat session to update
   * @param options - The request options to update
   * @param assistantMessage - Optional assistant message containing the tool calls
   * @param assistantMessage.role
   * @param assistantMessage.content
   * @param assistantMessage.tool_calls
   * @returns True if any tools were executed, false otherwise
   */
  async executeToolCalls(
    toolCalls: ToolCall[],
    session: ChatSession,
    options: ChatRequestOptions,
    assistantMessage?: { role: RoleType; content?: string | null; tool_calls?: ToolCall[] },
  ): Promise<boolean> {
    const known = toolCalls.filter(call => this.toolRegistry.getTool(call.function.name));
    const hasExecutedAnyTool = known.length > 0;
    const executedTools: { call: ToolCall; output: string }[] = [];

    if (hasExecutedAnyTool) {
      this.toolRegistry.setCallBack(this.streamCallback);
      const outputs = await this.runCalls(toolCalls);
      toolCalls.forEach((call, i) => executedTools.push({ call, output: outputs[i] }));
    }

    // If any tools were executed, add the assistant message with all tool calls
    if (hasExecutedAnyTool) {
      // Add assistant message with all tool calls
      const messageToAdd = assistantMessage || {
        role: 'assistant' as RoleType,
        content: null,
        tool_calls: toolCalls,
      };

      session.appendMessage({
        role: messageToAdd.role,
        content: messageToAdd.content ?? '',
      });

      options.messages.push(messageToAdd);

      // Add all tool responses
      for (const { call, output } of executedTools) {
        session.appendMessage({ role: 'tool', content: output ?? '' });
        options.messages.push({ role: 'tool', content: output, tool_call_id: call.id });
      }
    }

    return hasExecutedAnyTool;
  }

  /**
   * Runs the calls of one model turn and returns their outputs in the same order. Consecutive
   * read-only calls run side by side; any other call runs alone, after the ones before it.
   * Every call answers, so the model's turn stays valid: unknown tools and bad arguments come
   * back as tool errors.
   * @param calls - Tool calls of one assistant message.
   */
  async runCalls(calls: ToolCall[]): Promise<string[]> {
    const parent = this.signalHost?.abortSignal;
    const outputs: string[] = new Array<string>(calls.length);
    let i = 0;
    while (i < calls.length) {
      let j = i + 1;
      if (isReadOnlyTool(calls[i].function.name)) {
        while (j < calls.length && isReadOnlyTool(calls[j].function.name)) j++;
      }
      const batch = calls.slice(i, j);
      const results = await Promise.all(batch.map(call => this.runCall(call, parent)));
      results.forEach((output, k) => (outputs[i + k] = output));
      i = j;
    }
    return outputs;
  }

  /**
   * Runs one call with its time limit and signal.
   * @param call - Tool call.
   * @param parent - Signal of the request.
   */
  private runCall(call: ToolCall, parent?: AbortSignal): Promise<string> {
    const name = call.function.name;
    if (!this.toolRegistry.getTool(name)) {
      return Promise.resolve(toolError('UnknownTool', `There is no tool named "${name}".`));
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(this.fixDuplicatedArguments(call.function.arguments || '{}')) as Record<
        string,
        unknown
      >;
    } catch {
      return Promise.resolve(
        toolError('InvalidArguments', `The arguments for ${name} were not valid JSON.`, [
          'Call it again with one JSON object of arguments.',
        ]),
      );
    }
    return withToolTimeout(
      name,
      toolTimeoutMs(name),
      signal =>
        callWithSignal(this.signalHost, signal, () => this.toolRegistry.executeTool(name, args)),
      parent,
    );
  }

  /**
   * Filters out tool calls that don't have corresponding responses.
   *
   * @param msgs - The messages to filter
   * @returns Filtered messages with only called tools
   */
  filterOutUncalledToolCalls(
    msgs: {
      role: RoleType;
      content?: string;
      tool_call_id?: string;
      tool_calls?: ToolCall[];
    }[],
  ): {
    role: RoleType;
    content?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
  }[] {
    const [agent, ...responses] = msgs;
    if (agent.tool_calls) {
      agent.tool_calls = agent.tool_calls.filter(call =>
        responses.some(i => i.tool_call_id === call.id),
      );
    }
    return [agent, ...responses];
  }

  /**
   * Fixes duplicated arguments in tool calls (a known issue with some LLMs).
   * If arguments are invalid JSON and the string is duplicated, returns the first half.
   *
   * @param args - The arguments string to fix
   * @returns Fixed arguments string
   */
  private fixDuplicatedArguments(args: string): string {
    try {
      JSON.parse(args);
      return args; // Valid JSON, no fix needed
    } catch {
      // Invalid JSON, check for duplication
      const halfLength = Math.floor(args.length / 2);
      const firstHalf = args.slice(0, halfLength);
      const secondHalf = args.slice(halfLength);
      if (firstHalf === secondHalf) {
        return firstHalf;
      }
      return args;
    }
  }
}
