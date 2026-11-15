import { defineToolParameters, InferArgs, Tool } from '../tools';
import { Modal, Setting, Notice, App } from 'obsidian';
import { FORMAT_PARAMETER, jsonResult, layerForRole, toolError, wantsJson } from './toolContract';

/** How long the confirmation window waits before it counts as "no". */
const CONFIRM_TIMEOUT_MS = 180_000;

/** Keys whose values are never shown to or changed by a model. */
const SECRET_KEY =
  /api_?key|secret|password|bearer|access_?token|refresh_?token|^token$|^headers$|^oauth$/i;
/** Settings that hold secrets or server lists; they change only in the settings window. */
const SETTINGS_WINDOW_ONLY = new Set(['endpoints', 'mcpServers']);
const UNSAFE_SEGMENT = new Set(['__proto__', 'prototype', 'constructor']);
const HIDDEN = '[hidden]';

const pluginSettingsParameters = defineToolParameters({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: '"read" shows settings; "update" changes one setting.',
      enum: ['read', 'update'],
    },
    key: {
      type: 'string',
      description:
        'Setting name; use dots for nested ones, such as "defaultmaxTokens", "voice.provider" or "orchestrator.voiceRole". Optional for "read" (all settings), required for "update".',
    },
    value: {
      type: 'string',
      description:
        'New value for "update", as text: a number, true or false, or a string. It must be the same kind of value the setting has now.',
    },
    confirm: {
      type: 'boolean',
      description:
        'Voice calls only: set true only after you told the user the setting, its current value and the new value, and they said yes. Ignored in a note chat, where a confirmation window asks the user.',
    },
    // Spread with an inline enum: FORMAT_PARAMETER's readonly enum doesn't fit ToolParameter.
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['action'],
} as const);

export type PluginSettingsArgs = InferArgs<typeof pluginSettingsParameters>;

type Primitive = string | number | boolean;

/**
 * A copy of a settings value with secrets replaced.
 * @param value - Settings value.
 * @param key - Its key.
 */
export function redactSecrets(value: unknown, key = ''): unknown {
  if (key && SECRET_KEY.test(key)) {
    return value === '' || value === undefined || value === null ? value : HIDDEN;
  }
  if (Array.isArray(value)) return value.map(v => redactSecrets(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecrets(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Reads or changes one plugin setting. Changes need the user's yes: the confirmation window in a
 * note chat, or `confirm: true` after a spoken yes in a voice call. Secrets are never shown or
 * changed.
 */
export class PluginSettingsTool extends Tool<PluginSettingsArgs> {
  readonly name = 'manage_plugin_settings';
  readonly classification = 'System';
  readonly description =
    'Reads or changes one Voice Agent plugin setting, such as the default max tokens or the voice provider. ' +
    'Use "read" to look (with a key, or without one for all settings), and "update" only when the user asks to change a setting. ' +
    "An update needs the user's yes: in a note chat a confirmation window asks them; in a voice call, first say the setting, its current value and the new value, ask, and only after they say yes call again with confirm: true. " +
    'API keys, tokens, endpoints and MCP servers are hidden and can only be changed in the settings window. Free.';
  readonly parameters = pluginSettingsParameters;

  /** Always offered; layers decide who gets it. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Action, key, value, confirm and format. */
  async execute(args: PluginSettingsArgs): Promise<string> {
    if (args.action === 'read') return this.read(args);
    if (args.action === 'update') return this.update(args);
    return toolError('InvalidArgument', `Unknown action "${String(args.action)}".`, [
      'Use "read" or "update".',
    ]);
  }

  private get settings(): Record<string, unknown> {
    return this.chat.plugin.settings as unknown as Record<string, unknown>;
  }

  /**
   * Splits and checks a dotted key.
   * @param key - Dotted key.
   */
  private segments(key: string): string[] | string {
    const parts = key
      .trim()
      .split('.')
      .map(p => p.trim());
    if (!parts.length || parts.some(p => !p)) {
      return toolError('InvalidArgument', `"${key}" is not a setting name.`, [
        'Use action "read" without a key to see the setting names.',
      ]);
    }
    if (parts.some(p => UNSAFE_SEGMENT.has(p))) {
      return toolError('InvalidArgument', `"${key}" is not a setting name.`);
    }
    return parts;
  }

  /**
   * Finds the object holding a dotted key.
   * @param parts - Key segments.
   */
  private locate(parts: string[]): { parent: Record<string, unknown>; leaf: string } | null {
    let node: unknown = this.settings;
    for (const p of parts.slice(0, -1)) {
      if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, p))
        return null;
      node = (node as Record<string, unknown>)[p];
    }
    const leaf = parts[parts.length - 1];
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, leaf))
      return null;
    return { parent: node as Record<string, unknown>, leaf };
  }

  /** @param key - Missing key. */
  private notFound(key: string): string {
    return toolError('NotFound', `There is no setting "${key}".`, [
      'Use action "read" without a key to see the setting names.',
    ]);
  }

  /** @param args - Key and format. */
  private read(args: PluginSettingsArgs): string {
    if (!args.key?.trim()) {
      const all = redactSecrets(this.settings) as Record<string, unknown>;
      if (wantsJson(args)) return jsonResult({ key: null, value: all });
      return `Read all ${Object.keys(all).length} settings (secrets hidden).\n${JSON.stringify(all, null, 2)}`;
    }
    const parts = this.segments(args.key);
    if (typeof parts === 'string') return parts;
    const key = parts.join('.');
    const found = this.locate(parts);
    if (!found) return this.notFound(key);
    const hidden = parts.some(p => SECRET_KEY.test(p));
    const value = hidden ? HIDDEN : redactSecrets(found.parent[found.leaf], found.leaf);
    if (wantsJson(args)) return jsonResult({ key, value });
    const shown = JSON.stringify(value, null, 2);
    return value !== null && typeof value === 'object'
      ? `Setting "${key}" has ${Object.keys(value).length} fields.\n${shown}`
      : `Setting "${key}" is ${shown}.`;
  }

  /** @param args - Key, value, confirm and format. */
  private async update(args: PluginSettingsArgs): Promise<string> {
    if (!args.key?.trim()) {
      return toolError('InvalidArgument', '"key" is required for "update".', [
        'Pass the setting name, such as "voice.provider".',
      ]);
    }
    if (args.value === undefined || args.value === null) {
      return toolError('InvalidArgument', '"value" is required for "update".', [
        'Pass the new value as text.',
      ]);
    }
    const parts = this.segments(args.key);
    if (typeof parts === 'string') return parts;
    const key = parts.join('.');
    if (SETTINGS_WINDOW_ONLY.has(parts[0]) || parts.some(p => SECRET_KEY.test(p))) {
      return toolError(
        'NotAllowed',
        `"${key}" holds API keys, tokens or server details, so it can only be changed in the plugin's settings window.`,
        ['Ask the user to change it in Settings, Voice Agent.'],
      );
    }
    const found = this.locate(parts);
    if (!found) return this.notFound(key);
    const oldValue = found.parent[found.leaf];
    if (!isPrimitive(oldValue)) {
      const fields =
        oldValue && typeof oldValue === 'object' && !Array.isArray(oldValue)
          ? Object.keys(oldValue).slice(0, 12)
          : [];
      return toolError(
        'InvalidArgument',
        `"${key}" is ${Array.isArray(oldValue) ? 'a list' : 'a group of settings'}; change one field at a time.`,
        fields.length
          ? [`Use a dotted key such as "${key}.${fields[0]}" (fields: ${fields.join(', ')}).`]
          : ['Ask the user to change it in the settings window.'],
      );
    }
    const newValue = coerce(String(args.value), oldValue);
    if (newValue === undefined) {
      return toolError(
        'InvalidArgument',
        `"${key}" is a ${typeof oldValue}, and "${String(args.value)}" isn't one.`,
        [`Pass a ${typeof oldValue} value; it is ${JSON.stringify(oldValue)} now.`],
      );
    }
    if (key === 'endpoint') {
      const count = (this.settings.endpoints as unknown[] | undefined)?.length ?? 0;
      if (
        !Number.isInteger(newValue) ||
        (newValue as number) < 0 ||
        (newValue as number) >= count
      ) {
        return toolError(
          'InvalidArgument',
          `"endpoint" is a position in the endpoint list (0 to ${count - 1}).`,
          ['Read "endpoints" to see the list.'],
        );
      }
    }
    if (newValue === oldValue) {
      if (wantsJson(args))
        return jsonResult({ key, changed: false, old_value: oldValue, new_value: newValue });
      return `Setting "${key}" is already ${JSON.stringify(newValue)}; nothing changed.`;
    }

    const layer = layerForRole(this.chat.role);
    if (layer === 'voice') {
      if (args.confirm !== true) {
        return toolError(
          'ConfirmationNeeded',
          `Not changed yet: "${key}" would go from ${JSON.stringify(oldValue)} to ${JSON.stringify(newValue)}.`,
          [
            'Tell the user that change and ask if they want it.',
            'Only after they say yes, call again with the same key and value and confirm: true.',
          ],
        );
      }
      return this.apply(found, key, oldValue, newValue, args);
    }
    if (layer !== 'chat') {
      return toolError('NotAllowed', 'Settings changes need the user present to confirm them.', [
        'Report the change you want to the user instead.',
      ]);
    }

    // Note chat: the user confirms in a window; `confirm` is ignored here.
    void this.status(`Asking you to approve a change to "${key}"...`);
    const approved = await new Promise<boolean>(resolve => {
      new SettingsConfirmationModal(this.chat.plugin.app, key, oldValue, newValue, resolve).open();
    });
    if (!approved) {
      return toolError(
        'Declined',
        `The user didn't approve changing "${key}", so it is unchanged.`,
        ['Ask the user what they want instead.'],
      );
    }
    return this.apply(found, key, oldValue, newValue, args);
  }

  /**
   * Saves the change.
   * @param found - Where the setting lives.
   * @param found.parent - Object holding it.
   * @param found.leaf - Its key in that object.
   * @param key - Dotted key.
   * @param oldValue - Value before.
   * @param newValue - Value after.
   * @param args - Format.
   */
  private async apply(
    found: { parent: Record<string, unknown>; leaf: string },
    key: string,
    oldValue: Primitive,
    newValue: Primitive,
    args: PluginSettingsArgs,
  ): Promise<string> {
    try {
      found.parent[found.leaf] = newValue;
      await this.chat.plugin.saveSettings();
    } catch (error) {
      found.parent[found.leaf] = oldValue;
      const message = error instanceof Error ? error.message : String(error);
      return toolError('SaveFailed', `Couldn't save "${key}": ${message}`, [
        'Nothing changed. Try again, or ask the user to change it in the settings window.',
      ]);
    }
    new Notice(`Setting "${key}" changed to ${JSON.stringify(newValue)}.`);
    if (wantsJson(args))
      return jsonResult({ key, changed: true, old_value: oldValue, new_value: newValue });
    return `Changed "${key}" from ${JSON.stringify(oldValue)} to ${JSON.stringify(newValue)}.`;
  }
}

/** @param v - Value. */
function isPrimitive(v: unknown): v is Primitive {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Reads the model's text as the same kind of value the setting has, or undefined when it can't.
 * @param text - Value as text.
 * @param current - Current value.
 */
function coerce(text: string, current: Primitive): Primitive | undefined {
  if (typeof current === 'string') {
    // A JSON string literal ("\"x\"") is unwrapped; anything else is taken as typed.
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Plain text.
    }
    return text;
  }
  const trimmed = text.trim();
  if (typeof current === 'boolean') {
    if (/^true$/i.test(trimmed)) return true;
    if (/^false$/i.test(trimmed)) return false;
    return undefined;
  }
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Shows the change and waits for the user. Closing it, or no answer within a few minutes, counts
 * as no.
 */
export class SettingsConfirmationModal extends Modal {
  private resolved = false;
  private timer = 0;

  /**
   * @param app - Obsidian app.
   * @param key - Dotted key.
   * @param oldValue - Value now.
   * @param newValue - Proposed value.
   * @param onResolve - Called once with the answer.
   */
  constructor(
    app: App,
    readonly key: string,
    readonly oldValue: unknown,
    readonly newValue: unknown,
    readonly onResolve: (approved: boolean) => void,
  ) {
    super(app);
  }

  /** @param approved - The answer. */
  finish(approved: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    window.clearTimeout(this.timer);
    this.onResolve(approved);
    this.close();
  }

  /** Opens the window and starts the no-answer timer. */
  open(): void {
    this.timer = window.setTimeout(() => this.finish(false), CONFIRM_TIMEOUT_MS);
    super.open();
  }

  /** Draws the change. */
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Review setting change' });
    contentEl.createEl('p', { text: 'The agent wants to change this plugin setting:' });

    new Setting(contentEl).setName('Setting').setDesc(this.key).setHeading();

    const diffContainer = contentEl.createDiv('settings-diff-container');

    const oldCol = diffContainer.createDiv('settings-diff-col');
    oldCol.createEl('h4', { text: 'Current value' });
    oldCol.createEl('pre').createEl('code', { text: JSON.stringify(this.oldValue, null, 2) });

    const newCol = diffContainer.createDiv('settings-diff-col');
    newCol.createEl('h4', { text: 'Proposed value' });
    newCol.createEl('pre').createEl('code', { text: JSON.stringify(this.newValue, null, 2) });

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Approve and apply')
          .setCta()
          .onClick(() => this.finish(true)),
      )
      .addButton(btn => btn.setButtonText('Reject').onClick(() => this.finish(false)));
  }

  /** Closing without an answer counts as no. */
  onClose() {
    this.contentEl.empty();
    this.finish(false);
  }
}
