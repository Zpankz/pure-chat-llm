// The plugin side of the durable engine: layer requests through `layerFetch`, tools through a
// chat's tool registry with the caller's role, and the session opened once per vault on demand.
import { Notice, Platform } from 'obsidian';
import { PureChatLLMChat } from '../core/Chat';
import type PureChatLLM from '../main';
import { layerFetch, resolveLayer } from '../agents/layers';
import { LocalSubAgentBackend } from '../agents/LocalSubAgentBackend';
import { ORCHESTRATOR_TOOL_NAMES, SUBAGENT_TOOL_NAMES } from '../tools/Orchestrator';
import {
  AbortHost,
  callWithSignal,
  isReadOnlyTool,
  toolTimeoutMs,
  withToolTimeout,
} from '../tools/toolContract';
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
 * The Classic engine's task tools are left out for both roles: the durable engine has its own
 * (`workers.ts`).
 * @param plugin - Plugin.
 * @param role - Whose tools.
 */
export function pluginToolSource(plugin: PureChatLLM, role: 'orchestrator' | 'worker'): ToolSource {
  const chat = new PureChatLLMChat(plugin);
  if (role === 'worker') chat.role = 'subagent';
  chat.registerAvailableTools();
  const classicTaskTools = new Set<string>([...ORCHESTRATOR_TOOL_NAMES, ...SUBAGENT_TOOL_NAMES]);
  return {
    definitions: () =>
      chat.toolregistry.getEnabledDefinitions().filter(d => !classicTaskTools.has(d.function.name)),
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

  constructor(private plugin: PureChatLLM) {}

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
    this.opening ??= openDurable(
      {
        vaultKey: vaultKey(this.plugin),
        send: pluginLayerSend(this.plugin),
        tools: pluginToolSource(this.plugin, 'orchestrator'),
        workerTools: pluginToolSource(this.plugin, 'worker'),
        orchestratorInstructions: () => DURABLE_ORCHESTRATOR_GUIDANCE,
        workerInstructions: () => new LocalSubAgentBackend(this.plugin).systemPrompt(),
        maxResultChars: this.plugin.settings.voice.maxToolOutputChars || 6000,
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
    ).catch(error => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  /** Closes the session, if one is open. */
  async dispose(): Promise<void> {
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
