import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FORMAT_PARAMETER } from './toolContract';
import { TraverseGraphTool } from './TraverseGraph';

const backlinksParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'The note: a path, its name, a [[link]] or "active" for the note the user has open.',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: ['path'],
} as const);

export type BacklinksArgs = InferArgs<typeof backlinksParameters>;

/** Most backlinks listed by the alias (traverse_graph's own limit is 500). */
const MAX_BACKLINKS = 200;

/**
 * Deprecated alias kept so chats, skills and saved scripts that name `get_backlinks` keep
 * working: it is exactly traverse_graph with direction `in` and depth 1, with the same output,
 * errors and JSON.
 */
export class BacklinksTool extends Tool<BacklinksArgs> {
  readonly name = 'get_backlinks';
  readonly classification = 'Vault';
  readonly description =
    'Lists the notes that link to one note (its backlinks), one hop only. Deprecated: traverse_graph does this with direction "in" and depth 1, and can also follow outgoing links and typed relations several hops out, so use traverse_graph instead. Parameters: path (path, name, [[link]] or active) and format (json for scripts).';
  readonly parameters = backlinksParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Delegates to traverse_graph (incoming links, one hop).
   * @param args - Tool arguments.
   */
  async execute(args: BacklinksArgs): Promise<string> {
    return await new TraverseGraphTool(this.chat, this.registry).execute({
      note: args.path,
      direction: 'in',
      depth: 1,
      max_nodes: MAX_BACKLINKS,
      format: args.format,
    });
  }
}
