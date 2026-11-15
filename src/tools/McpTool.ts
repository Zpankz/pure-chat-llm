import type { PureChatLLMChat } from '../core/Chat';
import type { BridgedMcpTool } from '../mcp/McpManager';
import { Tool, ToolRegistry } from '../tools';
import type { ToolClassification, ToolParameters } from '../types';

/**
 * Wraps one remote MCP tool as a regular plugin tool, so chat models, code mode and every voice
 * provider can call it.
 */
export class McpTool extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
  readonly classification: ToolClassification = 'MCP';

  /**
   * @param chat - Owning chat.
   * @param registry - Owning registry.
   * @param bridged - The remote tool.
   */
  constructor(
    chat: PureChatLLMChat,
    registry: ToolRegistry,
    private bridged: BridgedMcpTool,
  ) {
    super(chat, registry);
    const { server, tool, exposedName } = bridged;
    this.name = exposedName;
    const hints: string[] = [];
    if (tool.annotations?.readOnlyHint) hints.push('read-only');
    if (tool.annotations?.destructiveHint) hints.push('destructive');
    const title = tool.title ?? tool.annotations?.title;
    this.description = [
      `[MCP ${server.name}${hints.length ? `, ${hints.join(', ')}` : ''}]`,
      title && title !== tool.name ? `${title}.` : '',
      tool.description ?? `Remote tool ${tool.name}.`,
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1024);
    const schema = tool.inputSchema ?? {};
    this.parameters = {
      ...(schema as object),
      type: 'object',
      properties: (schema.properties as ToolParameters['properties']) ?? {},
      required: (schema.required as string[]) ?? [],
    };
  }

  /** Available while the server stays enabled. */
  isAvailable(): boolean {
    return this.chat.plugin.mcp?.servers.some(s => s.name === this.bridged.server.name) ?? false;
  }

  /**
   * Calls the remote tool.
   * @param args - Arguments from the model.
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    void this.status(`Calling ${this.bridged.server.name} → ${this.bridged.tool.name}...`);
    return this.chat.plugin.mcp.call(this.bridged, args ?? {});
  }

  /** The server this tool belongs to. */
  get server() {
    return this.bridged.server;
  }
}
