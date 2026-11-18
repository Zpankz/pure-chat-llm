// The plugin side of the durable engine: layer requests through `layerFetch`, tools through a
// chat's tool registry with the caller's role, and the session opened once per vault on demand.
import { DurableTaskList } from './durableTasks';
import { Notice, Platform } from 'obsidian';
import { PureChatLLMChat } from '../core/Chat';
import type PureChatLLM from '../main';
import { layerFetch, layerProblem, logTiming, resolveLayer } from '../agents/layers';
import { ORCHESTRATOR_READ_TOOLS, spokenError } from '../agents/OrchestratorAgent';
import { LocalSubAgentBackend } from '../agents/LocalSubAgentBackend';
import {
  MEMORY_TOOL_NAMES,
  ORCHESTRATOR_AGENT_TOOL_NAMES,
  ORCHESTRATOR_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
} from '../tools/Orchestrator';
import {
  AbortHost,
  callWithSignal,
  isReadOnlyTool,
  toolTimeoutMs,
  withToolTimeout,
} from '../tools/toolContract';
import { DurableOrchestrator } from './bridge';
import { openDurable } from './durable';
import { DURABLE_ORCHESTRATOR_GUIDANCE } from './workers';
import type { DurableSession } from './durable';
import type { LayerSend } from './layerProvider';
import type { ToolSource } from './toolsExtension';

/**
 * Sends a layer request exactly as the Classic engine does.
 * @param plugin - Plugin.
 */
export function pluginLayerSend(plugin: PureChatLLM): LayerSend {
  return (layer, request, { signal }) =>
    layerFetch(plugin, resolveLayer(plugin, layer), request, {
      signal,
      label: `The durable ${layer} request`,
    });
}

/**
 * The plugin's tools for one role. A worker gets a chat with role `subagent`, so the write
 * policy, the two reviewers and proposals apply inside the write tools as on the Classic engine.
 * The orchestrator gets what it has on Classic: `tell_user`, the evaluator, the read-only vault
 * tools and remote MCP tools. The Classic engine's task tools are left out for both roles: the
 * durable engine has its own (`workers.ts`), and `read_task_thread` reads Classic tasks.
 * @param plugin - Plugin.
 * @param role - Whose tools.
 */
export function pluginToolSource(plugin: PureChatLLM, role: 'orchestrator' | 'worker'): ToolSource {
  const chat = new PureChatLLMChat(plugin);
  chat.role = role === 'worker' ? 'subagent' : 'orchestrator-agent';
  chat.registerAvailableTools();
  const registry = chat.toolregistry;
  const classicTaskTools = new Set<string>([
    ...ORCHESTRATOR_TOOL_NAMES,
    ...SUBAGENT_TOOL_NAMES,
    'read_task_thread',
  ]);
  const orchestratorTools = new Set<string>([
    ...ORCHESTRATOR_AGENT_TOOL_NAMES,
    ...ORCHESTRATOR_READ_TOOLS,
    ...MEMORY_TOOL_NAMES,
  ]);
  const offered = (name: string) =>
    !classicTaskTools.has(name) &&
    (role === 'worker' ||
      orchestratorTools.has(name) ||
      registry.classificationForTool(name) === 'MCP');
  return {
    definitions: () => registry.getEnabledDefinitions().filter(d => offered(d.function.name)),
    readOnly: isReadOnlyTool,
    run: (name, args, signal) =>
      withToolTimeout(
        name,
        toolTimeoutMs(name),
        callSignal =>
          callWithSignal(chat as unknown as AbortHost, callSignal, () =>
            chat.toolregistry.executeTool(name, args),
          ),
        signal,
      ),
  };
}

/** A stable key of this vault for its database name. */
function vaultKey(plugin: PureChatLLM): string {
  const appId = (plugin.app as unknown as { appId?: string }).appId;
  return appId || plugin.app.vault.getName();
}

/** Opens the durable engine once, on first use, when it is chosen in settings. */
export class DurableEngine {
  private opening: Promise<DurableSession> | null = null;
  /** The orchestrator the voice call talks to on this engine. */
  readonly orchestrator: DurableOrchestrator;
  /** Its background tasks, for the voice tools, the call panel and the call notes. */
  readonly tasks: DurableTaskList;

  constructor(private plugin: PureChatLLM) {
    this.tasks = new DurableTaskList(
      taskId => this.session().then(s => s.abortTask(taskId)),
      () => resolveLayer(plugin, 'worker').label,
    );
    this.orchestrator = new DurableOrchestrator({
      session: () => this.session(),
      active: () => plugin.settings.orchestrator.voiceRole === 'layered',
      label: () => resolveLayer(plugin, 'orchestrator').label,
      problem: () => layerProblem(plugin, resolveLayer(plugin, 'orchestrator')),
      voiceContext: () => ({
        mode: plugin.settings.orchestrator.voiceContext,
        recentLines: plugin.settings.orchestrator.relayTranscriptLines ?? 6,
      }),
      voiceSeesActivity: () => plugin.settings.orchestrator.voiceSeesActivity,
      log: (kind, text, fromUser) => plugin.calls?.logOrchestrator(kind, text, fromUser),
      save: () => plugin.calls?.scheduleOrchestratorSave(),
      timing: (label, ms) => logTiming(plugin, label, ms),
      spokenError,
      error: (message, error) => plugin.console?.error?.(message, error),
    });
  }

  /** Whether settings choose it and this device can run it. */
  get enabled(): boolean {
    return this.plugin.settings.orchestrator.engine === 'durable' && Platform.isDesktopApp;
  }

  /** The open session; opens it on first call. */
  session(): Promise<DurableSession> {
    if (!this.enabled) {
      return Promise.reject(
        new Error(
          Platform.isDesktopApp
            ? 'The durable engine is off. Choose it under Settings > Voice Agent > Agent engine.'
            : 'The durable engine runs on desktop only for now.',
        ),
      );
    }
    // The memory opens first, so the orchestrator's instructions carry its brief.
    this.opening ??= (
      this.plugin.memory?.enabled
        ? this.plugin.memory.open().then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve()
    )
      .then(() =>
        openDurable(
          {
            vaultKey: vaultKey(this.plugin),
            send: pluginLayerSend(this.plugin),
            tools: pluginToolSource(this.plugin, 'orchestrator'),
            workerTools: pluginToolSource(this.plugin, 'worker'),
            orchestratorInstructions: () => {
              const memory = this.plugin.memory?.brief();
              return memory
                ? `${DURABLE_ORCHESTRATOR_GUIDANCE}\n\n${memory}`
                : DURABLE_ORCHESTRATOR_GUIDANCE;
            },
            workerInstructions: () => new LocalSubAgentBackend(this.plugin).systemPrompt(),
            maxResultChars: this.plugin.settings.voice.maxToolOutputChars || 6000,
            onTask: event => {
              this.tasks.record(event);
              const memory = this.plugin.memory;
              memory?.quietly(g =>
                g.recordTask(
                  {
                    key: `durable-${event.conversation}-${event.id}`,
                    title: event.title,
                    status: event.status,
                    result: event.text,
                    session: memory.session,
                  },
                  'worker',
                ),
              );
            },
            checkInMinutes: () => this.plugin.settings.orchestrator.checkInMinutes,
            mobile: Platform.isMobile,
          },
          {
            onReport: report => {
              this.plugin.console?.error?.('Durable engine report', report.kind, report.error);
              // 1.5 has no parked tasks: a task cut off restartLimit times in a row ends itself.
              if (
                (report.kind === 'task_interrupted' || report.kind === 'task_faulted') &&
                report.reason === 'restart_limit'
              ) {
                new Notice(
                  'Voice Agent: a task kept getting interrupted by restarts and was stopped.',
                  10_000,
                );
              } else if (report.kind === 'storage_failed') {
                new Notice(
                  'Voice Agent: the storage of the durable engine failed, so reload the app to open it again.',
                  10_000,
                );
              }
            },
          },
        ),
      )
      .catch(error => {
        this.opening = null;
        throw error;
      });
    return this.opening;
  }

  /** Closes the session, if one is open. */
  async dispose(): Promise<void> {
    this.orchestrator.dispose();
    const opening = this.opening;
    this.opening = null;
    if (!opening) return;
    try {
      await (await opening).close();
    } catch (error) {
      this.plugin.console?.error?.('Could not close the durable engine', error);
    }
  }
}
