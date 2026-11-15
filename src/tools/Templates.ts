import { App, moment, normalizePath, parseYaml, TFile, TFolder } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { notePath, REASON_PARAMETER, WRITE_FORMAT } from './CreateNote';
import { renderWrite, submitWrite } from './EditReview';
import { writeWhole } from './WriteNoteSection';
import { jsonResult, toolError, wantsJson } from './toolContract';

/** The parts of Obsidian's core Templates and the Templater plugin that we read. */
interface ObsidianAppWithPlugins extends App {
  internalPlugins?: {
    getPluginById(id: string): {
      enabled: boolean;
      instance?: { options?: { folder?: string; dateFormat?: string; timeFormat?: string } };
    } | null;
  };
  plugins?: {
    getPlugin(
      id: string,
    ): { settings?: { templates_folder?: string; template_folder?: string } } | null;
  };
}

const MODES = ['create', 'append', 'prepend', 'overwrite'] as const;
type Mode = (typeof MODES)[number];
const MAX_LISTED = 200;

const templatesParameters = defineToolParameters({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        '`list` shows the templates; `apply` makes a note from one or adds one to a note.',
      enum: ['list', 'apply'],
    },
    template_path: {
      type: 'string',
      description: 'For apply: the template, as a path or as its name in the templates folder.',
    },
    target_path: {
      type: 'string',
      description: 'For apply: the note to create or add to. `.md` is added when missing.',
    },
    mode: {
      type: 'string',
      description:
        'For apply: `create` (default) makes a new note and fails if it exists; `append` adds the template to the end of an existing note and `prepend` after its frontmatter (template properties fill in missing ones); `overwrite` replaces the note with the template.',
      enum: [...MODES],
    },
    reason: REASON_PARAMETER,
    format: WRITE_FORMAT,
  },
  required: ['action'],
} as const);

export type TemplatesArgs = InferArgs<typeof templatesParameters>;

/** Lists templates and applies them to notes. */
export class TemplatesTool extends Tool<TemplatesArgs> {
  readonly name = 'manage_templates';
  // Applying writes notes, so it sits with the other vault tools.
  readonly classification = 'Vault';
  readonly description =
    "Lists the vault's note templates, and applies one: makes a new note from it, or adds it to an existing note. Fills {{title}}, {{date}} and {{time}} (with optional formats, like {{date:YYYY-MM-DD}}); Templater commands are left as written. Use it when a note should follow a template; use create_obsidian_note for free-form notes. Applying is a write. In a chat the user reviews it first; background workers follow the write policy in settings.";
  readonly parameters = templatesParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: TemplatesArgs): Promise<string> {
    if (args.action === 'list') return this.list(args);
    if (args.action === 'apply') return this.apply(args);
    return toolError('InvalidArgument', 'action must be "list" or "apply".');
  }

  /** The configured templates folders (core Templates, Templater), or a folder named Templates. */
  private folders(): string[] {
    const app = this.chat.plugin.app as ObsidianAppWithPlugins;
    const found: string[] = [];
    const core = app.internalPlugins?.getPluginById('templates');
    if (core?.enabled && core.instance?.options?.folder) found.push(core.instance.options.folder);
    const templater = app.plugins?.getPlugin('templater-obsidian')?.settings;
    const tFolder = templater?.templates_folder ?? templater?.template_folder;
    if (tFolder) found.push(tFolder);
    if (!found.length) {
      const guess = app.vault
        .getAllLoadedFiles()
        .find(f => f instanceof TFolder && f.name.toLowerCase() === 'templates');
      if (guess) found.push(guess.path);
    }
    return [...new Set(found.map(f => normalizePath(f)))].filter(
      f => app.vault.getAbstractFileByPath(f) instanceof TFolder,
    );
  }

  /** Markdown files in the templates folders. */
  private templates(): TFile[] {
    const app = this.chat.plugin.app;
    const out: TFile[] = [];
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'md') out.push(child);
        else if (child instanceof TFolder) walk(child);
      }
    };
    for (const path of this.folders()) {
      const folder = app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder) walk(folder);
    }
    return [...new Map(out.map(f => [f.path, f])).values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }

  /** @param args - Tool arguments. */
  private list(args: TemplatesArgs): string {
    const folders = this.folders();
    if (!folders.length) {
      return toolError('NotFound', 'No templates folder is set up in this vault.', [
        'Set one in the core Templates plugin, or give template_path to apply a note directly.',
      ]);
    }
    const all = this.templates().map(f => f.path);
    const shown = all.slice(0, MAX_LISTED);
    if (wantsJson(args)) {
      return jsonResult({ ok: true, action: 'list', folders, count: all.length, templates: shown });
    }
    if (!all.length) return `No templates in ${folders.map(f => `"${f}"`).join(', ')}.`;
    const more = all.length > shown.length ? `\n…and ${all.length - shown.length} more.` : '';
    return `${all.length} template${all.length === 1 ? '' : 's'} in ${folders.map(f => `"${f}"`).join(', ')}:\n${shown.join('\n')}${more}`;
  }

  /**
   * Finds a template by path or by name.
   * @param ref - Path or name.
   */
  private findTemplate(ref: string): TFile | null {
    const app = this.chat.plugin.app;
    const direct =
      app.vault.getFileByPath(normalizePath(ref)) ?? app.vault.getFileByPath(notePath(ref));
    if (direct) return direct;
    const name = ref.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() ?? '';
    return this.templates().find(f => f.basename.toLowerCase() === name) ?? null;
  }

  /** @param args - Tool arguments. */
  private async apply(args: TemplatesArgs): Promise<string> {
    const app = this.chat.plugin.app as ObsidianAppWithPlugins;
    const mode = (args.mode ?? 'create') as Mode;
    if (!MODES.includes(mode)) {
      return toolError('InvalidArgument', `mode must be one of ${MODES.join(', ')}.`);
    }
    if (typeof args.template_path !== 'string' || !args.template_path.trim()) {
      return toolError('InvalidArgument', 'template_path is required for apply.', [
        'manage_templates(action="list") to see the templates',
      ]);
    }
    if (typeof args.target_path !== 'string' || !args.target_path.trim()) {
      return toolError('InvalidArgument', 'target_path is required for apply.');
    }
    const template = this.findTemplate(args.template_path.trim());
    if (!template) {
      return toolError('NotFound', `No template "${args.template_path}".`, [
        'manage_templates(action="list") to see the templates',
      ]);
    }
    const target = notePath(args.target_path);
    const existing = app.vault.getAbstractFileByPath(target);
    if (existing && !(existing instanceof TFile)) {
      return toolError('InvalidPath', `"${target}" is a folder.`);
    }
    if (mode === 'create' && existing) {
      return toolError('FileExists', `"${target}" already exists.`, [
        'mode: "append" or "prepend" to add the template to it',
        'mode: "overwrite" to replace it',
      ]);
    }
    if ((mode === 'append' || mode === 'prepend') && !existing) {
      return toolError('NotFound', `"${target}" does not exist, so there is nothing to add to.`, [
        'mode: "create" to make it from the template',
      ]);
    }

    const options = app.internalPlugins?.getPluginById('templates')?.instance?.options;
    const title = target.split('/').pop()?.replace(/\.md$/i, '') ?? '';
    const filled = fillTemplate(await app.vault.read(template), {
      title,
      dateFormat: options?.dateFormat || 'YYYY-MM-DD',
      timeFormat: options?.timeFormat || 'HH:mm',
    });

    let content = filled;
    let properties: Record<string, unknown> | undefined;
    let original: string | null = null;
    if (existing instanceof TFile && (mode === 'append' || mode === 'prepend')) {
      original = await app.vault.read(existing);
      // The template's frontmatter fills in properties the note lacks; its body is inserted.
      const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(filled);
      const body = fm ? filled.slice(fm[0].length) : filled;
      const have = (app.metadataCache.getFileCache(existing)?.frontmatter ?? {}) as Record<
        string,
        unknown
      >;
      if (fm) {
        let parsed: unknown = null;
        try {
          parsed = parseYaml(fm[1]);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === 'object') {
          const missing = Object.entries(parsed as Record<string, unknown>).filter(
            ([key]) => !(key in have),
          );
          if (missing.length) properties = Object.fromEntries(missing);
        }
      }
      content = writeWhole(original, body, mode);
    }

    void this.status(`Applying "${template.basename}" to "${target}"...`);
    const outcome = await submitWrite(this.chat, {
      kind: 'write',
      path: target,
      content,
      properties,
      overwrite: mode !== 'create',
      original: original ?? undefined,
      instruction: `Apply template "${template.basename}" (${mode})`,
      reason: args.reason,
    });
    const done = {
      create: `Created "${target}" from template "${template.basename}"`,
      overwrite: `Replaced "${target}" with template "${template.basename}"`,
      append: `Added template "${template.basename}" to the end of "${target}"`,
      prepend: `Added template "${template.basename}" to the start of "${target}"`,
    }[mode];
    const templater = /<%[\s\S]*?%>/.test(filled);
    const out = renderWrite(
      outcome,
      args,
      done,
      { mode, template: template.path, ...(templater ? { templater_left: true } : {}) },
      [`read_file("${target}") to check it`],
    );
    return templater && outcome.ok && !wantsJson(args)
      ? `${out}\nThe template has Templater commands; they were left as written.`
      : out;
  }
}

/**
 * Fills core Templates variables: {{title}}, {{date}}, {{time}}, and {{date:FORMAT}} or
 * {{time:FORMAT}} with a Moment.js format.
 * @param text - Template text.
 * @param vars - Title and default formats.
 * @param vars.title - Note title.
 * @param vars.dateFormat - Format for {{date}}.
 * @param vars.timeFormat - Format for {{time}}.
 */
export function fillTemplate(
  text: string,
  vars: { title: string; dateFormat: string; timeFormat: string },
): string {
  // Obsidian's `moment` is typed as the module namespace; it is the moment function.
  const now = (moment as unknown as () => { format(format: string): string })();
  return text.replace(
    /{{\s*(title|date|time)\s*(?::\s*([^}]*?))?\s*}}/gi,
    (_m, name: string, fmt?: string) => {
      const key = name.toLowerCase();
      if (key === 'title') return vars.title;
      return now.format(fmt?.trim() || (key === 'date' ? vars.dateFormat : vars.timeFormat));
    },
  );
}
