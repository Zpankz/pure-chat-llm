import { defineToolParameters, InferArgs, Tool } from '../tools';
import { MarkdownView, normalizePath, TFile, type WorkspaceLeaf } from 'obsidian';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

const manageWorkspaceParameters = defineToolParameters({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        '"list" the open notes; "open" a note; "close" the tabs showing a note; "set_mode" switches a note between editing and reading.',
      enum: ['list', 'open', 'close', 'set_mode'],
    },
    path: {
      type: 'string',
      description:
        'Note path or name, such as "Projects/Plan.md" or "Plan". Required for "open" and "close". "active" means the note in focus. For "set_mode", defaults to the note in focus.',
    },
    split: {
      type: 'string',
      description:
        '"open" only: "vertical" opens beside the current note, "horizontal" below it, "none" (default) in a tab.',
      enum: ['none', 'vertical', 'horizontal'],
    },
    new_leaf: {
      type: 'boolean',
      description:
        '"open" only: true opens a new tab even if the note is already open; false replaces the note in the current tab. Left out, an open note is brought to the front, otherwise a new tab opens.',
    },
    mode: {
      type: 'string',
      description: '"source" (editing) or "preview" (reading). Required for "set_mode".',
      enum: ['source', 'preview'],
    },
    active: {
      type: 'boolean',
      description: '"open" only: focus the note (default true).',
    },
    all: {
      type: 'boolean',
      description:
        '"close" only: close every tab showing the note (default false: the most recent one).',
    },
    // Spread with an inline enum: FORMAT_PARAMETER's readonly enum doesn't fit ToolParameter.
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['action'],
} as const);

export type ManageWorkspaceArgs = InferArgs<typeof manageWorkspaceParameters>;

type Mode = 'source' | 'preview';

interface TabInfo {
  path: string;
  mode: Mode;
  pinned: boolean;
  active: boolean;
}

/**
 * Opens, closes and lists note tabs, and switches reading or editing mode. It only ever touches
 * Markdown tabs, saves a note before closing its tab, and leaves pinned tabs alone.
 */
export class ManageWorkspaceTool extends Tool<ManageWorkspaceArgs> {
  readonly name = 'manage_workspace';
  readonly classification = 'UI';
  readonly description =
    "Opens, closes or lists the notes open in Obsidian's tabs, and switches a note between editing and reading mode. " +
    'Use it when the user asks to see, open, put side by side or close a note. ' +
    'It only touches note tabs (never the chat, voice or other panels), saves a note before closing it, and never closes pinned tabs. ' +
    "Free, no confirmation; the change is on the user's screen, so say what you did.";
  readonly parameters = manageWorkspaceParameters;

  /** Always offered; layers decide who gets it. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Action and options. */
  async execute(args: ManageWorkspaceArgs): Promise<string> {
    switch (args.action) {
      case 'list':
        return this.list(args);
      case 'open':
        return this.open(args);
      case 'close':
        return this.close(args);
      case 'set_mode':
        return this.setMode(args);
      default:
        return toolError('InvalidArgument', `Unknown action "${String(args.action)}".`, [
          'Use one of: list, open, close, set_mode.',
        ]);
    }
  }

  private get workspace() {
    return this.chat.plugin.app.workspace;
  }

  /** Markdown tabs, in Obsidian's order. */
  private markdownLeaves(): WorkspaceLeaf[] {
    return this.workspace.getLeavesOfType('markdown').filter(l => l.view instanceof MarkdownView);
  }

  /** @param leaf - Tab. */
  private leafPath(leaf: WorkspaceLeaf): string {
    return leaf.view instanceof MarkdownView ? (leaf.view.file?.path ?? '') : '';
  }

  /** @param leaf - Tab. */
  private leafMode(leaf: WorkspaceLeaf): Mode {
    return leaf.view instanceof MarkdownView && leaf.view.getMode?.() === 'preview'
      ? 'preview'
      : 'source';
  }

  /** @param leaf - Tab. */
  private isPinned(leaf: WorkspaceLeaf): boolean {
    return !!leaf.getViewState?.().pinned;
  }

  /** Path of the note in focus, if any. */
  private activePath(): string {
    return this.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? '';
  }

  /**
   * Finds a note by path, path without `.md`, or name.
   * @param path - What the model passed.
   */
  private resolve(path: string): TFile | null {
    const app = this.chat.plugin.app;
    if (path.trim().toLowerCase() === 'active') {
      const active = this.activePath();
      return active ? app.vault.getFileByPath(active) : null;
    }
    const cleaned = normalizePath(path.trim().replace(/^\[\[|\]\]$/g, ''));
    const direct = app.vault.getAbstractFileByPath(cleaned);
    if (direct instanceof TFile) return direct;
    const withMd = app.vault.getAbstractFileByPath(`${cleaned}.md`);
    if (withMd instanceof TFile) return withMd;
    return app.metadataCache.getFirstLinkpathDest(cleaned, '') ?? null;
  }

  /** @param path - Missing path. */
  private notFound(path: string): string {
    return toolError('NotFound', `No note matches "${path}".`, [
      'Find the exact path with search_vault or glob_vault_files.',
      'Use manage_workspace with action "list" to see what is open.',
    ]);
  }

  /** @param args - Format. */
  private list(args: ManageWorkspaceArgs): string {
    const active = this.activePath();
    const tabs: TabInfo[] = this.markdownLeaves().map(leaf => {
      const path = this.leafPath(leaf);
      return {
        path,
        mode: this.leafMode(leaf),
        pinned: this.isPinned(leaf),
        active: !!path && path === active,
      };
    });
    if (wantsJson(args)) {
      return jsonResult({ action: 'list', changed: false, active: active || null, tabs });
    }
    if (!tabs.length) return 'No notes are open.';
    const lines = tabs.map(
      t =>
        `- ${t.path || '(empty tab)'} (${t.mode === 'preview' ? 'reading' : 'editing'}${t.pinned ? ', pinned' : ''}${t.active ? ', in focus' : ''})`,
    );
    return [`${tabs.length} note tab${tabs.length === 1 ? '' : 's'} open.`, ...lines].join('\n');
  }

  /** @param args - Path, split, tab and mode options. */
  private async open(args: ManageWorkspaceArgs): Promise<string> {
    if (!args.path?.trim()) {
      return toolError('InvalidArgument', '"path" is required for "open".', [
        'Pass the note path or name in "path".',
      ]);
    }
    const file = this.resolve(args.path);
    if (!file) return this.notFound(args.path);
    const split = args.split ?? 'none';
    const active = args.active ?? true;
    if (split !== 'none' && split !== 'vertical' && split !== 'horizontal') {
      return toolError('InvalidArgument', `Unknown split "${String(split)}".`, [
        'Use none, vertical or horizontal.',
      ]);
    }
    if (args.mode && args.mode !== 'source' && args.mode !== 'preview') {
      return toolError('InvalidArgument', `Unknown mode "${String(args.mode)}".`, [
        'Use source (editing) or preview (reading).',
      ]);
    }
    void this.status(`Opening "${file.path}"...`);

    let leaf: WorkspaceLeaf | null = null;
    let where: 'existing_tab' | 'new_tab' | 'current_tab' | 'split_vertical' | 'split_horizontal';
    const existing =
      split === 'none' && args.new_leaf === undefined
        ? this.markdownLeaves().find(l => this.leafPath(l) === file.path)
        : undefined;
    if (existing) {
      leaf = existing;
      where = 'existing_tab';
      if (active) {
        await this.workspace.revealLeaf?.(leaf);
        this.workspace.setActiveLeaf?.(leaf, { focus: true });
      }
    } else {
      if (split !== 'none') {
        leaf = this.workspace.getLeaf('split', split);
        where = split === 'vertical' ? 'split_vertical' : 'split_horizontal';
      } else if (args.new_leaf === false) {
        // Replaces the note in the current tab; Obsidian opens a new tab if that one is pinned.
        leaf = this.workspace.getLeaf(false);
        where = 'current_tab';
      } else {
        leaf = this.workspace.getLeaf('tab');
        where = 'new_tab';
      }
      if (!leaf) {
        return toolError('WorkspaceError', 'Obsidian gave no tab to open the note in.', [
          'Try again with split "none".',
        ]);
      }
      await leaf.openFile(file, { active });
    }

    if (args.mode) await this.applyMode(leaf, args.mode as Mode);

    const spokenWhere: Record<typeof where, string> = {
      existing_tab: 'brought its open tab to the front',
      new_tab: 'in a new tab',
      current_tab: 'in the current tab',
      split_vertical: 'beside the current note',
      split_horizontal: 'below the current note',
    };
    if (wantsJson(args)) {
      return jsonResult({
        action: 'open',
        changed: true,
        path: file.path,
        where,
        mode: args.mode ?? null,
        active,
      });
    }
    const modeText = args.mode ? `, ${args.mode === 'preview' ? 'reading' : 'editing'} mode` : '';
    return where === 'existing_tab'
      ? `"${file.basename}" was already open; ${spokenWhere[where]}${modeText}.\nPath: ${file.path}`
      : `Opened "${file.basename}" ${spokenWhere[where]}${modeText}.\nPath: ${file.path}`;
  }

  /** @param args - Path and whether to close every tab. */
  private async close(args: ManageWorkspaceArgs): Promise<string> {
    if (!args.path?.trim()) {
      return toolError('InvalidArgument', '"path" is required for "close".', [
        'Pass the note path or name, or "active" for the note in focus.',
        'Use action "list" to see what is open.',
      ]);
    }
    const file = this.resolve(args.path);
    if (!file) return this.notFound(args.path);

    const showing = this.markdownLeaves().filter(l => this.leafPath(l) === file.path);
    const pinned = showing.filter(l => this.isPinned(l));
    const closable = showing.filter(l => !this.isPinned(l));
    // Most recent first: Obsidian lists tabs in layout order, so take the last ones.
    const targets = args.all ? closable : closable.slice(-1);

    let closed = 0;
    for (const leaf of targets) {
      // Write any pending edits before the tab goes, so nothing typed is lost.
      if (leaf.view instanceof MarkdownView) await leaf.view.save?.();
      leaf.detach();
      closed++;
    }
    const left = showing.length - closed;

    if (wantsJson(args)) {
      return jsonResult({
        action: 'close',
        changed: closed > 0,
        path: file.path,
        closed,
        kept_pinned: pinned.length,
        still_open: left,
        saved_before_closing: closed > 0,
      });
    }
    if (!showing.length) return `"${file.basename}" isn't open, so nothing was closed.`;
    if (!closed) {
      return `Nothing closed: "${file.basename}" is only open in pinned tabs, which stay open. The user can unpin and close them.`;
    }
    const extra = [
      pinned.length ? `${pinned.length} pinned tab${pinned.length === 1 ? '' : 's'} kept open` : '',
      left - pinned.length > 0 ? `${left - pinned.length} other tab(s) still show it` : '',
    ].filter(Boolean);
    return `Closed ${closed} tab${closed === 1 ? '' : 's'} showing "${file.basename}" (saved first)${extra.length ? `; ${extra.join('; ')}` : ''}.\nPath: ${file.path}`;
  }

  /** @param args - Mode and optional path. */
  private async setMode(args: ManageWorkspaceArgs): Promise<string> {
    if (args.mode !== 'source' && args.mode !== 'preview') {
      return toolError('InvalidArgument', '"mode" must be "source" or "preview" for "set_mode".', [
        'Pass mode "source" for editing or "preview" for reading.',
      ]);
    }
    const path = args.path?.trim() ? args.path : 'active';
    const file = this.resolve(path);
    if (!file) {
      return path === 'active'
        ? toolError('NotFound', 'No note is in focus.', [
            'Pass the note in "path", or open it first with action "open".',
          ])
        : this.notFound(path);
    }
    const leaves = this.markdownLeaves().filter(l => this.leafPath(l) === file.path);
    if (!leaves.length) {
      return toolError('NotOpen', `"${file.path}" isn't open.`, [
        `Open it with action "open" and mode "${args.mode}".`,
      ]);
    }
    let changed = 0;
    for (const leaf of leaves) {
      if (this.leafMode(leaf) === args.mode) continue;
      await this.applyMode(leaf, args.mode);
      changed++;
    }
    if (wantsJson(args)) {
      return jsonResult({
        action: 'set_mode',
        changed: changed > 0,
        path: file.path,
        mode: args.mode,
        tabs: leaves.length,
        switched: changed,
      });
    }
    const label = args.mode === 'preview' ? 'reading' : 'editing';
    return changed
      ? `Switched "${file.basename}" to ${label} mode.`
      : `"${file.basename}" was already in ${label} mode.`;
  }

  /**
   * @param leaf - Tab.
   * @param mode - Editing or reading.
   */
  private async applyMode(leaf: WorkspaceLeaf, mode: Mode): Promise<void> {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const state = view.getState();
    state.mode = mode;
    await view.setState(state, { history: false });
  }
}
