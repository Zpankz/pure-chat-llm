import { normalizePath, parseYaml, TAbstractFile } from 'obsidian';
import type PureChatLLM from '../main';

/**
 * One Agent Skill discovered in the vault.
 * Format: https://agentskills.io/specification
 */
export interface SkillInfo {
  name: string;
  description: string;
  /** Vault path of the skill directory. */
  dir: string;
  /**
   * The skill's main file, relative to its folder: `<folder name>.md` (so the vault does not
   * fill up with identical SKILL.md names) or `SKILL.md` (the Agent Skills standard).
   */
  mainFile: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, string>;
  /** Problems found while validating the frontmatter (the skill still loads). */
  warnings: string[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Splits a SKILL.md file into its YAML frontmatter and markdown body.
 * @param text - File contents.
 */
export function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: match[2] };
}

/**
 * Validates frontmatter against the Agent Skills spec and builds a SkillInfo.
 * @param dir - Skill directory path.
 * @param frontmatter - Parsed frontmatter.
 */
export function toSkillInfo(
  dir: string,
  frontmatter: Record<string, unknown>,
  mainFile = 'SKILL.md',
): SkillInfo | null {
  const dirName = dir.split('/').pop() ?? dir;
  const warnings: string[] = [];
  const rawName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) return null; // description is required for discovery
  let name = rawName || dirName;
  if (!rawName) warnings.push('missing name; using folder name');
  if (name.length > 64 || !NAME_RE.test(name))
    warnings.push('name should be lowercase letters, digits and single hyphens (max 64)');
  if (rawName && rawName !== dirName) warnings.push(`name should match folder name "${dirName}"`);
  if (description.length > 1024) warnings.push('description is longer than 1024 characters');
  name = name.slice(0, 64);
  const metadata =
    frontmatter.metadata && typeof frontmatter.metadata === 'object'
      ? Object.fromEntries(
          Object.entries(frontmatter.metadata as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v),
          ]),
        )
      : undefined;
  return {
    name,
    description: description.slice(0, 1024),
    dir,
    mainFile,
    license: typeof frontmatter.license === 'string' ? frontmatter.license : undefined,
    compatibility:
      typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility : undefined,
    allowedTools:
      typeof frontmatter['allowed-tools'] === 'string' ? frontmatter['allowed-tools'] : undefined,
    metadata,
    warnings,
  };
}

/**
 * The main file of a skill folder: `<folder name>.md` first, then the standard `SKILL.md`
 * (any case). Returns null when the folder holds neither.
 * @param adapter - Vault adapter.
 * @param dir - Skill folder path.
 */
export async function skillMainFile(
  adapter: {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files: string[] }>;
  },
  dir: string,
): Promise<string | null> {
  const name = dir.split('/').pop() ?? '';
  if (name && (await adapter.exists(`${dir}/${name}.md`))) return `${name}.md`;
  const { files } = await adapter.list(dir);
  const standard = files
    .map(f => f.split('/').pop() ?? f)
    .find(f => f.toLowerCase() === 'skill.md');
  return standard ?? null;
}

/**
 * Discovers Agent Skills under the configured vault folder and keeps them up to date.
 * Uses the vault adapter so hidden folders such as `.agents/skills` also work.
 */
export class SkillsCatalog {
  skills: SkillInfo[] = [];
  private timer: number | null = null;

  /**
   * @param plugin - The plugin instance.
   */
  constructor(private plugin: PureChatLLM) {}

  /** Normalised skills folder from settings. */
  get folder(): string {
    return normalizePath(this.plugin.settings.skillsFolder || 'Skills');
  }

  /** Re-scans the skills folder. */
  async refresh(): Promise<SkillInfo[]> {
    const adapter = this.plugin.app.vault.adapter;
    const found: SkillInfo[] = [];
    try {
      if (await adapter.exists(this.folder)) {
        const { folders } = await adapter.list(this.folder);
        for (const dir of folders) {
          const mainFile = await skillMainFile(adapter, dir);
          if (!mainFile) continue;
          const { frontmatter } = splitFrontmatter(await adapter.read(`${dir}/${mainFile}`));
          const info = toSkillInfo(dir, frontmatter, mainFile);
          if (info) found.push(info);
        }
      }
    } catch (error) {
      this.plugin.console?.error('Failed to load skills', error);
    }
    this.skills = found.sort((a, b) => a.name.localeCompare(b.name));
    return this.skills;
  }

  /**
   * Finds a skill by name (case-insensitive).
   * @param name - Skill name.
   */
  get(name: string): SkillInfo | undefined {
    const key = name.trim().toLowerCase();
    return this.skills.find(s => s.name.toLowerCase() === key);
  }

  /**
   * Debounced refresh when a file inside the skills folder changes.
   * @param file - Changed file.
   */
  onVaultChange(file: TAbstractFile | string): void {
    const path = typeof file === 'string' ? file : file.path;
    if (!path.startsWith(this.folder + '/')) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, 500);
  }

  /** Lists files inside a skill directory (relative paths, up to two levels deep). */
  async listFiles(skill: SkillInfo): Promise<string[]> {
    const adapter = this.plugin.app.vault.adapter;
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      const { files, folders } = await adapter.list(dir);
      files.forEach(f => out.push(f.slice(skill.dir.length + 1)));
      if (depth < 2) for (const sub of folders) await walk(sub, depth + 1);
    };
    await walk(skill.dir, 0);
    return out.sort();
  }

  /**
   * Reads a file inside a skill directory, refusing paths that escape it.
   * @param skill - The skill.
   * @param relativePath - Path relative to the skill root.
   */
  async readFile(skill: SkillInfo, relativePath: string): Promise<string> {
    const clean = normalizePath(relativePath.replace(/^\.?\//, ''));
    if (!clean || clean.split('/').some(part => part === '..')) {
      throw new Error('Path must stay inside the skill folder.');
    }
    const full = `${skill.dir}/${clean}`;
    if (!(await this.plugin.app.vault.adapter.exists(full))) {
      throw new Error(`File not found in skill ${skill.name}: ${clean}`);
    }
    return this.plugin.app.vault.adapter.read(full);
  }

  /** The `<available_skills>` block used for progressive disclosure. */
  catalogText(): string {
    if (this.skills.length === 0) return '';
    const items = this.skills
      .map(s => `<skill><name>${s.name}</name><description>${s.description}</description></skill>`)
      .join('\n');
    return `<available_skills>\n${items}\n</available_skills>`;
  }
}
