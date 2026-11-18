import { PureChatLLMChat } from '../core/Chat';
import type PureChatLLM from '../main';
import type { ChatResponse, ToolCall } from '../types';
import { ORCHESTRATOR_TOOL_NAMES } from '../tools/Orchestrator';
import type { SubAgentBackend, SubAgentRunContext, SubAgentTask } from './types';
import { VaultGraph } from '../graph/VaultGraph';
import { ontologySummary } from '../graph/ontology';
import { layerFetch, resolveLayer } from './layers';
import { memoryWithModels } from '../memory/pluginModels';
import {
  AbortHost,
  callWithSignal,
  isToolError,
  toolError,
  toolErrorLine,
  toolTimeoutMs,
  withToolTimeout,
} from '../tools/toolContract';

/** Characters of one tool output kept in a worker's history (system review C3). */
export const MAX_TOOL_OUTPUT_IN_HISTORY = 8000;
/** Characters of tool output kept in a worker's history in all before old outputs are dropped. */
export const HISTORY_TOOL_BUDGET = 60_000;
/** The latest tool outputs that are always kept whole. */
const KEEP_RECENT_TOOL_OUTPUTS = 6;

/**
 * Clips one tool output for the history, keeping its head and tail.
 * @param output - Tool output.
 */
export function clipToolOutput(output: string, max = MAX_TOOL_OUTPUT_IN_HISTORY): string {
  if (output.length <= max) return output;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${output.slice(0, head)}\n…[${output.length - max} characters cut; call the tool again with a narrower request if you need them]…\n${output.slice(-tail)}`;
}

/**
 * Keeps a worker's history from growing without limit: once the tool outputs add up past the
 * budget, the oldest ones (all but the latest few) are replaced by a one-line stub. The model's
 * own messages and the brief are kept. Returns how many outputs were dropped.
 * @param messages - Task history, changed in place.
 */
export function compactHistory(
  messages: { role: string; content?: unknown }[],
  budget = HISTORY_TOOL_BUDGET,
): number {
  const toolIndexes = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
  const size = (i: number) =>
    typeof messages[i].content === 'string' ? messages[i].content.length : 0;
  let total = toolIndexes.reduce((n, i) => n + size(i), 0);
  let dropped = 0;
  for (const i of toolIndexes.slice(0, -KEEP_RECENT_TOOL_OUTPUTS)) {
    if (total <= budget) break;
    const before = size(i);
    if (before < 200) continue;
    messages[i].content =
      '[Older tool output dropped to keep the context small. Call the tool again if you need it.]';
    total -= before - size(i);
    dropped++;
  }
  return dropped;
}

/** Tools a sub-agent may not use (orchestration belongs to the orchestrator). */
const ORCHESTRATOR_ONLY = new Set(ORCHESTRATOR_TOOL_NAMES);

/**
 * Runs sub-agents inside Obsidian with the default chat provider.
 *
 * Each task gets its own chat (role `subagent`) with every enabled tool, Agent Skills, remote MCP
 * tools and code mode, plus `ask_orchestrator` and `report_progress`. The loop is explicit so the
 * manager can cancel between steps, deliver orchestrator messages, run hooks and spot loops.
 */
export class LocalSubAgentBackend implements SubAgentBackend {
  readonly id = 'local';

  /** @param plugin - Plugin. */
  constructor(private plugin: PureChatLLM) {}

  /**
   * Sub-agent instructions, plus the write rules in force and a short map of the vault's typed
   * ontology so traversals use the vault's own relation names.
   */
  systemPrompt(): string {
    const { orchestrator, graph } = this.plugin.settings;
    const w = orchestrator.writes;
    const say = (p: string) =>
      p === 'allow'
        ? 'go ahead'
        : p === 'peer'
          ? 'need two independent reviewers to approve (a rejection explains why; revise or ask the orchestrator; large removals, changes to a note’s type and deletes of well-linked notes are held for the user)'
          : p === 'review'
            ? 'are saved as proposals for the user to review later (not applied)'
            : 'are not allowed';
    const parts = [
      orchestrator.subAgentInstructions,
      `Vault writes: new notes ${say(w.create)}; edits to existing notes ${say(w.edit)}; deletions ${say(w.delete)} (deleted notes go to the trash).`,
    ];
    if (graph?.ontologyInPrompt) {
      try {
        parts.push(ontologySummary(VaultGraph.for(this.plugin.app, graph.typesFolder), true));
      } catch (error) {
        this.plugin.console?.error('Could not read the vault ontology', error);
      }
    }
    // The shared memory's standing part: how to use it, and the user's standing preferences,
    // instructions and pinned facts. What it knows about the task comes with the brief.
    const memory = this.plugin.memory?.standingBrief('worker');
    if (memory) parts.push(memory);
    return parts.join('\n\n');
  }

  /**
   * @param task - Task to run or continue.
   * @param ctx - Manager hooks and channels.
   */
  async run(task: SubAgentTask, ctx: SubAgentRunContext): Promise<string> {
    const settings = this.plugin.settings.orchestrator;
    const chat = new PureChatLLMChat(this.plugin);
    chat.role = 'subagent';
    chat.subAgentTaskId = task.id;
    chat.task = task;
    // Tools see cancellation too, so a cancelled or timed-out task never lands a write later.
    chat.abortSignal = ctx.signal;
    chat.registerAvailableTools();
    const tools = chat.toolregistry
      .getEnabledDefinitions()
      .filter(t => !ORCHESTRATOR_ONLY.has(t.function.name));

    if (task.messages.length === 0) {
      // What the shared memory knows about this task's people, projects and notes.
      const recalled =
        (await memoryWithModels(this.plugin)?.context('worker', `${task.title}\n${task.prompt}`)) ??
        '';
      task.messages.push(
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: recalled ? `${task.prompt}\n\n${recalled}` : task.prompt },
      );
    }

    // Workers run on the worker layer; each task keeps the model it started with.
    const layer = resolveLayer(this.plugin, 'worker', task.model);
    const threshold = Math.max(2, settings.stuckThreshold || 3);
    let lastSignature = '';
    let repeats = 0;
    let failures = 0;
    let stuckReported = false;

    for (let step = 1; step <= Math.max(1, settings.maxSteps || 40); step++) {
      if (ctx.isCancelled()) throw new Error('cancelled');
      for (const message of ctx.drainInbox()) {
        task.messages.push({ role: 'user', content: `Message from the orchestrator: ${message}` });
        ctx.log({ kind: 'message', text: message });
      }

      compactHistory(task.messages);
      const response: ChatResponse = await layerFetch(
        this.plugin,
        layer,
        {
          messages: task.messages,
          max_completion_tokens: this.plugin.settings.defaultmaxTokens,
          ...(tools.length ? { tools } : {}),
        },
        { signal: ctx.signal, label: `Task ${task.id}'s model request` },
      );
      if (ctx.isCancelled()) throw new Error('cancelled');
      for (const hook of ctx.hooks) await hook.afterResponse?.({ task, step }, response);

      const calls = (response.tool_calls ?? []).filter(c => c.function?.name);
      if (calls.length === 0) {
        const finalText = (response.content ?? '').trim();
        task.messages.push({ role: 'assistant', content: finalText });
        let continueWith: string | undefined;
        for (const hook of ctx.hooks) {
          const decision = await hook.onYield?.({ task, step }, finalText);
          if (decision?.continueWith) {
            continueWith = decision.continueWith;
            break;
          }
        }
        if (!continueWith) return finalText;
        task.messages.push({ role: 'user', content: continueWith });
        ctx.log({ kind: 'note', text: `Hook asked to continue: ${continueWith}` });
        continue;
      }

      if (response.content) ctx.log({ kind: 'response', text: response.content });
      task.messages.push({
        role: 'assistant',
        content: response.content ?? null,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (ctx.isCancelled()) throw new Error('cancelled');
        const output = await this.runCall(chat, task, step, call, ctx);
        task.messages.push({
          role: 'tool',
          content: clipToolOutput(output),
          tool_call_id: call.id,
        });

        // Deterministic stuck checks: the same call over and over, or failures in a row.
        const signature = `${call.function.name}:${call.function.arguments}`;
        repeats = signature === lastSignature ? repeats + 1 : 1;
        lastSignature = signature;
        failures = isToolError(output) ? failures + 1 : 0;
        if (!stuckReported && (repeats >= threshold || failures >= threshold)) {
          stuckReported = true;
          ctx.emit(
            'stuck',
            repeats >= threshold
              ? `It has called ${call.function.name} with the same input ${repeats} times in a row.`
              : `${failures} tool calls in a row failed. Last error: ${toolErrorLine(output).slice(0, 300)}`,
          );
        } else if (repeats < threshold && failures === 0) {
          stuckReported = false;
        }
      }
      ctx.emit('progress', `Step ${step}: ${calls.map(c => c.function.name).join(', ')}`);
    }
    throw new Error(`Stopped after ${settings.maxSteps} steps without a final answer.`);
  }

  /**
   * Runs one tool call through the hooks.
   * @param chat - Sub-agent chat.
   * @param task - Task.
   * @param step - Step number.
   * @param call - Tool call.
   * @param ctx - Run context.
   */
  private async runCall(
    chat: PureChatLLMChat,
    task: SubAgentTask,
    step: number,
    call: ToolCall,
    ctx: SubAgentRunContext,
  ): Promise<string> {
    const name = call.function.name;
    for (const hook of ctx.hooks) {
      const decision = await hook.beforeTool?.({ task, step }, call);
      if (decision?.block) {
        ctx.log({ kind: 'tool', text: `${name} blocked: ${decision.block}` });
        return toolError('Blocked', `A hook blocked ${name}: ${decision.block}`);
      }
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      return toolError('InvalidArguments', `The arguments for ${name} were not valid JSON.`, [
        'Call it again with one JSON object of arguments.',
      ]);
    }
    let output = ORCHESTRATOR_ONLY.has(name)
      ? toolError('NotAllowed', `${name} is only available to the orchestrator.`)
      : await this.execute(chat, name, args, ctx);
    for (const hook of ctx.hooks) {
      const replaced = await hook.afterTool?.({ task, step }, call, output);
      if (typeof replaced === 'string') output = replaced;
    }
    ctx.log({ kind: 'tool', text: `${name}: ${output.slice(0, 200).replace(/\s+/g, ' ')}` });
    return output;
  }

  /**
   * Runs one tool with its time limit (see toolContract). The call's abort signal fires on the
   * time limit and the moment the task is cancelled or times out (the task's own signal).
   * @param chat - Sub-agent chat.
   * @param name - Tool name.
   * @param args - Arguments.
   * @param ctx - Run context.
   */
  private execute(
    chat: PureChatLLMChat,
    name: string,
    args: Record<string, unknown>,
    ctx: SubAgentRunContext,
  ): Promise<string> {
    return withToolTimeout(
      name,
      toolTimeoutMs(name),
      signal =>
        callWithSignal(chat as unknown as AbortHost, signal, () =>
          chat.toolregistry.executeTool(name, args),
        ),
      ctx.signal,
    );
  }
}
