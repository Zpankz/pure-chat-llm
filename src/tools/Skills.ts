import { defineToolParameters, InferArgs, Tool } from '../tools';

const activateSkillParameters = defineToolParameters({
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Exact skill name from the available skills list.',
    },
  },
  required: ['name'],
} as const);

export type ActivateSkillArgs = InferArgs<typeof activateSkillParameters>;

/**
 * Loads an Agent Skill's full instructions on demand (progressive disclosure).
 * Spec: https://agentskills.io/specification
 */
export class ActivateSkillTool extends Tool<ActivateSkillArgs> {
  readonly name = 'activate_skill';
  readonly classification = 'System';
  readonly parameters = activateSkillParameters;

  /** Description carries the skills catalogue (name + description of each skill). */
  get description(): string {
    const catalog = this.chat.plugin.skills?.catalogText() ?? '';
    return (
      'Load the full instructions of an Agent Skill before doing a task it covers. ' +
      'Call this as soon as a request matches a skill description, then follow the returned instructions. ' +
      'Use read_skill_file for files the skill references.\n' +
      catalog
    );
  }

  /** Available when at least one skill is installed. */
  isAvailable(): boolean {
    return (this.chat.plugin.skills?.skills.length ?? 0) > 0;
  }

  /**
   * Returns SKILL.md and the skill's file list.
   * @param args - Tool arguments.
   */
  async execute(args: ActivateSkillArgs): Promise<string> {
    const catalog = this.chat.plugin.skills;
    const skill = catalog.get(args.name) ?? (await catalog.refresh(), catalog.get(args.name));
    if (!skill) {
      const names = catalog.skills.map(s => s.name).join(', ') || 'none';
      return `Error: no skill named "${args.name}". Available skills: ${names}.`;
    }
    void this.status(`Activating skill ${skill.name}...`);
    const content = await catalog.readFile(skill, 'SKILL.md');
    const files = (await catalog.listFiles(skill)).filter(f => f !== 'SKILL.md');
    return [
      `<skill_content name="${skill.name}" dir="${skill.dir}">`,
      content.trim(),
      '</skill_content>',
      files.length
        ? `<skill_files>\n${files.join('\n')}\n</skill_files>\nRead these with read_skill_file when the instructions point to them. Scripts cannot run here, except JavaScript you pass to codemode.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

const readSkillFileParameters = defineToolParameters({
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Skill name.' },
    path: {
      type: 'string',
      description: 'Path relative to the skill folder, e.g. references/REFERENCE.md',
    },
  },
  required: ['name', 'path'],
} as const);

export type ReadSkillFileArgs = InferArgs<typeof readSkillFileParameters>;

/**
 * Reads a bundled reference, script or asset from an Agent Skill.
 */
export class ReadSkillFileTool extends Tool<ReadSkillFileArgs> {
  readonly name = 'read_skill_file';
  readonly classification = 'System';
  readonly description =
    "Read a file bundled with an Agent Skill (references/, scripts/, assets/). Use after activate_skill when the skill's instructions point to a file.";
  readonly parameters = readSkillFileParameters;

  /** Available when at least one skill is installed. */
  isAvailable(): boolean {
    return (this.chat.plugin.skills?.skills.length ?? 0) > 0;
  }

  /**
   * Reads the file.
   * @param args - Tool arguments.
   */
  async execute(args: ReadSkillFileArgs): Promise<string> {
    const catalog = this.chat.plugin.skills;
    const skill = catalog.get(args.name);
    if (!skill) return `Error: no skill named "${args.name}".`;
    try {
      return await catalog.readFile(skill, args.path);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
