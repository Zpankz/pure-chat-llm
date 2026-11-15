import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FORMAT_PARAMETER, jsonResult, layerForRole, toolError, wantsJson } from './toolContract';

/**
 * Commands that delete, quit, close or reset are never run, even when allow-listed, because a
 * mistaken call could lose the user's work or end their session.
 */
const NEVER_RUN =
  /delete|remove|trash|quit|exit|uninstall|reload|restart|reset|purge|wipe|erase|discard|close|disable|clear/i;

const runCommandParameters = defineToolParameters({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: '"list" the commands you may run; "run" one by its id.',
      enum: ['list', 'run'],
    },
    id: {
      type: 'string',
      description:
        'Command id from the list, such as "dataview:dataview-force-refresh-views". Required for "run".',
    },
    // Spread with an inline enum: FORMAT_PARAMETER's readonly enum doesn't fit ToolParameter.
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['action'],
} as const);

export type RunCommandArgs = InferArgs<typeof runCommandParameters>;

/** The parts of Obsidian's (unofficial) command manager this tool uses. */
interface CommandManager {
  commands: Record<string, { id: string; name: string }>;
  executeCommandById(id: string): boolean;
}

/**
 * The user's allow-list of command ids. Read from `settings.commandAllowList` (a list of ids,
 * or text with one id per line or comma separated); empty when unset.
 * @param settings - Plugin settings.
 */
export function commandAllowList(settings: unknown): string[] {
  const raw = (settings as { commandAllowList?: unknown } | undefined)?.commandAllowList;
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : [];
  return [
    ...new Set(items.filter((s): s is string => typeof s === 'string').map(s => s.trim())),
  ].filter(Boolean);
}

/**
 * Whether a command is one that is never run.
 * @param id - Command id.
 * @param name - Command name, when known.
 */
export function isNeverRun(id: string, name = ''): boolean {
  return NEVER_RUN.test(id) || NEVER_RUN.test(name);
}

/**
 * Runs an Obsidian command (from Obsidian or another plugin, such as Templater or Dataview) by
 * id, but only one the user put on the allow-list in settings. Off while the list is empty.
 */
export class RunCommandTool extends Tool<RunCommandArgs> {
  readonly name = 'run_obsidian_command';
  readonly classification = 'System';
  readonly description =
    "Runs one of the user's Obsidian commands, such as a Templater or Dataview command, by its id. " +
    'Only commands the user allowed in the plugin settings can run; use "list" to see them with their names. ' +
    'Many commands act on the note in focus, so open it first with manage_workspace if needed. ' +
    'Commands that delete, close, quit, reload or reset are never run. Free, no confirmation.';
  readonly parameters = runCommandParameters;

  private get commands(): CommandManager | undefined {
    const manager = (this.chat.plugin.app as unknown as { commands?: CommandManager }).commands;
    return manager && typeof manager.executeCommandById === 'function' ? manager : undefined;
  }

  /** Allow-listed ids that may ever run. */
  private allowed(): string[] {
    return commandAllowList(this.chat.plugin.settings).filter(id => !isNeverRun(id));
  }

  /** Off unless the user allow-listed at least one command. */
  isAvailable(): boolean {
    return !!this.commands && this.allowed().length > 0;
  }

  /** @param args - Action, id and format. */
  async execute(args: RunCommandArgs): Promise<string> {
    const layer = layerForRole(this.chat.role);
    if (layer !== 'chat' && layer !== 'voice') {
      return toolError('NotAllowed', 'Commands only run while the user is in the conversation.', [
        'Report the command you would run instead.',
      ]);
    }
    const manager = this.commands;
    const allowed = this.allowed();
    if (!manager || !allowed.length) {
      return toolError('Unavailable', 'No Obsidian commands are allowed for the agent.', [
        'Ask the user to add command ids to the command allow-list in the plugin settings.',
      ]);
    }

    if (args.action === 'list') {
      const list = allowed.map(id => ({
        id,
        name: manager.commands[id]?.name ?? null,
        installed: !!manager.commands[id],
      }));
      if (wantsJson(args)) return jsonResult({ action: 'list', commands: list });
      return [
        `${list.length} command${list.length === 1 ? '' : 's'} allowed.`,
        ...list.map(c => `- ${c.id}: ${c.name ?? 'not installed (plugin missing or off)'}`),
      ].join('\n');
    }

    if (args.action !== 'run') {
      return toolError('InvalidArgument', `Unknown action "${String(args.action)}".`, [
        'Use "list" or "run".',
      ]);
    }
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) {
      return toolError('InvalidArgument', '"id" is required for "run".', [
        'Use action "list" to see the allowed command ids.',
      ]);
    }
    const command = manager.commands[id];
    if (isNeverRun(id, command?.name)) {
      return toolError(
        'NotAllowed',
        `"${id}" deletes, closes, quits or resets something, so it is never run.`,
        ['Ask the user to do it themselves.'],
      );
    }
    if (!allowed.includes(id)) {
      return toolError('NotAllowed', `"${id}" isn't on the user's command allow-list.`, [
        `Allowed: ${allowed.join(', ')}.`,
        'Ask the user to add it in the plugin settings if they want it.',
      ]);
    }
    if (!command) {
      return toolError('NotFound', `No installed command has the id "${id}".`, [
        'The plugin that provides it may be missing or turned off.',
      ]);
    }

    void this.status(`Running "${command.name}"...`);
    let ran: boolean;
    try {
      ran = manager.executeCommandById(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('CommandFailed', `"${command.name}" failed: ${message}`);
    }
    if (!ran) {
      return toolError('NotRun', `"${command.name}" can't run right now.`, [
        'It probably needs a note open and in focus; open one with manage_workspace and try again.',
      ]);
    }
    if (wantsJson(args)) return jsonResult({ action: 'run', id, name: command.name, ran: true });
    return `Ran "${command.name}".`;
  }
}
