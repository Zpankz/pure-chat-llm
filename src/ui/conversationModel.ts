// What the side panels show of a conversation: speech turns, tool calls (with their skill, memory,
// vault or agent flavour), agent updates and status lines. Pure functions only, so the shape of
// the conversation can be tested without Obsidian; conversation.ts draws it.
import type { VoiceEvent } from '../realtime/providers/IVoiceCallProvider';
import { isToolError } from '../tools/toolContract';

/** What kind of thing a tool does, which sets its icon and colour. */
export type ToolCategory =
  | 'skill'
  | 'memory'
  | 'read'
  | 'search'
  | 'graph'
  | 'write'
  | 'delete'
  | 'agent'
  | 'tasks'
  | 'code'
  | 'mcp'
  | 'topic'
  | 'other';

export interface ToolMeta {
  /** Plain words for the call, e.g. "Searched the vault". */
  label: string;
  /** Lucide icon id. */
  icon: string;
  category: ToolCategory;
}

const META: Record<string, ToolMeta> = {
  activate_skill: { label: 'Used a skill', icon: 'sparkles', category: 'skill' },
  read_skill_file: { label: 'Read a skill file', icon: 'sparkles', category: 'skill' },
  memory_recall: { label: 'Recalled from memory', icon: 'brain', category: 'memory' },
  memory_remember: { label: 'Saved to memory', icon: 'brain', category: 'memory' },
  memory_forget: { label: 'Retired a memory', icon: 'brain', category: 'memory' },
  memory_state: { label: 'Shared state', icon: 'brain', category: 'memory' },
  memory_query: { label: 'Queried memory', icon: 'brain', category: 'memory' },
  read_file: { label: 'Read a note', icon: 'file-text', category: 'read' },
  read_note_section: { label: 'Read a section', icon: 'file-text', category: 'read' },
  get_active_context: { label: 'Looked at the open note', icon: 'file-text', category: 'read' },
  search_vault: { label: 'Searched the vault', icon: 'search', category: 'search' },
  glob_vault_files: { label: 'Listed files', icon: 'search', category: 'search' },
  list_vault_folders: { label: 'Listed folders', icon: 'folder-tree', category: 'search' },
  smart_connections_rag: { label: 'Semantic search', icon: 'search', category: 'search' },
  traverse_graph: { label: 'Walked the graph', icon: 'git-fork', category: 'graph' },
  get_backlinks: { label: 'Found backlinks', icon: 'git-fork', category: 'graph' },
  vault_ontology: { label: 'Read the ontology', icon: 'network', category: 'graph' },
  graph_cli: { label: 'Graph query', icon: 'network', category: 'graph' },
  create_obsidian_note: { label: 'Created a note', icon: 'file-plus', category: 'write' },
  write_note_section: { label: 'Wrote to a note', icon: 'pencil', category: 'write' },
  patch_note: { label: 'Wrote to a note', icon: 'pencil', category: 'write' },
  replace_in_note: { label: 'Edited a note', icon: 'pencil', category: 'write' },
  manage_templates: { label: 'Templates', icon: 'layout-template', category: 'write' },
  delete_obsidian_note: { label: 'Deleted a note', icon: 'trash-2', category: 'delete' },
  delegate_task: { label: 'Started a background agent', icon: 'bot', category: 'agent' },
  relay_to_orchestrator: { label: 'Passed to the orchestrator', icon: 'bot', category: 'agent' },
  message_task: { label: 'Messaged an agent', icon: 'bot', category: 'agent' },
  ask_orchestrator: { label: 'Asked the orchestrator', icon: 'bot', category: 'agent' },
  tell_user: { label: 'Told you', icon: 'message-circle', category: 'agent' },
  'backend agent': { label: 'Backend agent', icon: 'bot', category: 'agent' },
  check_tasks: { label: 'Checked tasks', icon: 'list-checks', category: 'tasks' },
  get_task_result: { label: 'Got a task result', icon: 'list-checks', category: 'tasks' },
  cancel_task: { label: 'Stopped a task', icon: 'square', category: 'tasks' },
  orchestrator_activity: { label: 'Orchestrator activity', icon: 'activity', category: 'tasks' },
  read_task_thread: { label: 'Read a task thread', icon: 'list-checks', category: 'tasks' },
  report_progress: { label: 'Reported progress', icon: 'activity', category: 'tasks' },
  set_progress_updates: { label: 'Progress updates', icon: 'bell', category: 'tasks' },
  codemode: { label: 'Ran a script', icon: 'code-2', category: 'code' },
  new_topic: { label: 'New topic', icon: 'milestone', category: 'topic' },
};

/** Sentence-case words from a tool name: `search_vault` → `Search vault`. */
export function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/**
 * How a tool is shown.
 * @param name - Tool name.
 */
export function toolMeta(name: string): ToolMeta {
  const known = META[name];
  if (known) return known;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { label: `${humanize(mcp[2])} (${mcp[1]})`, icon: 'plug', category: 'mcp' };
  return { label: humanize(name), icon: 'wrench', category: 'other' };
}

/** Argument names worth showing first, in order. */
const PREVIEW_KEYS = [
  'name',
  'skill',
  'query',
  'text',
  'path',
  'note',
  'file',
  'title',
  'folder',
  'pattern',
  'cypher',
  'request',
  'instructions',
  'message',
  'id',
];

/**
 * One short phrase from a call's arguments, e.g. the query or the note.
 * @param args - Arguments.
 * @param max - Longest phrase.
 */
export function argPreview(args: Record<string, unknown> | undefined, max = 60): string {
  if (!args) return '';
  const keys = [...PREVIEW_KEYS, ...Object.keys(args)];
  for (const key of keys) {
    const value = args[key];
    if (key === 'format' || typeof value !== 'string' || !value.trim()) continue;
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  return '';
}

/**
 * A short duration: `850 ms`, `4.2 s`, `2m 05s`.
 * @param ms - Milliseconds.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A tool call as the panel shows it. */
export interface ToolCallView {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: 'running' | 'done' | 'failed';
  result?: string;
  error?: string;
  startedAt: number;
  ms?: number;
}

/**
 * One line of a voice call. `role` and `text` are what the saved call notes read; `kind` and
 * `tool` are what the panel draws. `rev` goes up whenever the line changes, so the panel redraws
 * only that line.
 */
export interface TranscriptLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  final: boolean;
  at?: number;
  kind?: 'speech' | 'tool' | 'update' | 'status';
  tool?: ToolCallView;
  /** An update that cut in on what the user was saying. */
  urgent?: boolean;
  /** What an update said, shown under its title. */
  detail?: string;
  /** Said or done by the orchestrator rather than the voice. */
  by?: 'orchestrator';
  rev?: number;
}

/** Text for the call notes once a tool has ended. */
function toolText(tool: ToolCallView): string {
  if (tool.status === 'running') return `Running ${tool.name}…`;
  if (tool.status === 'failed') return `${tool.name} failed: ${tool.error ?? 'error'}`;
  return `${tool.name} finished`;
}

/**
 * Marks every line still being heard as final. Some providers (GPT-Live) never send a final
 * transcript, so a line counts as finished once anything comes after it; only the newest line
 * can still be live.
 * @param lines - Transcript (changed in place).
 */
export function settleSpeech(lines: TranscriptLine[]): void {
  for (const line of lines) {
    if (!line.final) {
      line.final = true;
      line.rev = (line.rev ?? 0) + 1;
    }
  }
}

/**
 * Appends a line. A new line from a speaker closes that speaker's earlier unfinished line, which
 * a later one has superseded; the other speaker's line stays open, so an agent interrupted
 * mid-sentence can still finish its own line.
 * @param lines - Transcript.
 * @param line - New line.
 */
export function pushLine(lines: TranscriptLine[], line: TranscriptLine): TranscriptLine {
  if (line.kind === 'speech') {
    const open = openSpeech(lines, line.role);
    if (open) close(open);
  }
  lines.push(line);
  return line;
}

/** @param line - Marks it final. */
function close(line: TranscriptLine): void {
  line.final = true;
  line.rev = (line.rev ?? 0) + 1;
}

/**
 * A speaker's latest spoken line, when it is still unfinished.
 * @param lines - Transcript.
 * @param role - Speaker.
 */
export function openSpeech(lines: TranscriptLine[], role: string): TranscriptLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind !== 'speech' || line.role !== role) continue;
    return line.final ? undefined : line;
  }
  return undefined;
}

/**
 * Whether new text carries on a line rather than starting a new one: providers send the whole
 * line so far with each update, so a continuation starts the way the line did.
 * @param line - Unfinished line.
 * @param text - New text.
 */
function carriesOn(line: TranscriptLine, text: string): boolean {
  const before = line.text.trim();
  if (!before) return true;
  const head = before.slice(0, Math.min(before.length, 16));
  return text.trim().startsWith(head);
}

/**
 * The line that shows the typing caret: the newest unfinished spoken line, and only that one.
 * @param lines - Transcript.
 */
export function liveLine(lines: TranscriptLine[]): TranscriptLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind !== 'speech') continue;
    if (!line.final) return line;
  }
  return undefined;
}

/**
 * Applies a voice event to the transcript.
 * @param lines - Transcript (changed in place).
 * @param event - Provider event.
 * @param now - Current time.
 * @returns The line that changed or was added, or null when the event shows nothing.
 */
export function applyVoiceEvent(
  lines: TranscriptLine[],
  event: VoiceEvent,
  now: number,
): TranscriptLine | null {
  if (event.type === 'transcript') {
    // The speaker's own unfinished line, even when someone else spoke or a tool ran since: an
    // interrupted agent finishes its sentence in place rather than repeating it below.
    const open = openSpeech(lines, event.role);
    if (open && carriesOn(open, event.text)) {
      open.text = event.text;
      open.final = event.final;
      open.rev = (open.rev ?? 0) + 1;
      return open;
    }
    if (!event.text.trim()) return null;
    const line: TranscriptLine = {
      role: event.role,
      text: event.text,
      final: event.final,
      at: now,
      kind: 'speech',
      rev: 0,
    };
    return pushLine(lines, line);
  }
  if (event.type === 'tool') {
    if (event.phase === 'start') {
      const tool: ToolCallView = {
        id: event.id ?? `${event.name}-${now}`,
        name: event.name,
        args: event.args,
        status: 'running',
        startedAt: now,
      };
      const line: TranscriptLine = {
        role: 'tool',
        text: toolText(tool),
        final: true,
        at: now,
        kind: 'tool',
        tool,
        rev: 0,
      };
      return pushLine(lines, line);
    }
    // The end: the running call with this id, or else the last running call of this name.
    let line: TranscriptLine | undefined;
    for (let i = lines.length - 1; i >= 0 && !line; i--) {
      const t = lines[i].tool;
      if (!t || t.status !== 'running') continue;
      if (event.id ? t.id === event.id : t.name === event.name) line = lines[i];
    }
    if (!line?.tool) {
      const tool: ToolCallView = {
        id: event.id ?? `${event.name}-${now}`,
        name: event.name,
        status: 'running',
        startedAt: now,
      };
      line = pushLine(lines, {
        role: 'tool',
        text: '',
        final: true,
        at: now,
        kind: 'tool',
        tool,
        rev: 0,
      });
    }
    const tool = line.tool as ToolCallView;
    const failed = !!event.error || (event.result !== undefined && isToolError(event.result));
    tool.status = failed ? 'failed' : 'done';
    tool.error = event.error ?? (failed ? event.result?.split('\n')[0] : undefined);
    tool.result = event.result;
    tool.ms = event.ms ?? now - tool.startedAt;
    line.text = toolText(tool);
    line.rev = (line.rev ?? 0) + 1;
    return line;
  }
  if (event.type === 'status') {
    const line: TranscriptLine = {
      role: 'tool',
      text: event.text,
      final: true,
      at: now,
      kind: 'status',
      rev: 0,
    };
    return pushLine(lines, line);
  }
  return null;
}

/**
 * Whether a line continues the same speaker's turn (so it needs no header of its own).
 * @param prev - The line before.
 * @param line - This line.
 */
export function continuesTurn(prev: TranscriptLine | undefined, line: TranscriptLine): boolean {
  if (!prev) return false;
  const speaker = (l: TranscriptLine) =>
    l.kind === 'status'
      ? 'status'
      : l.role === 'user'
        ? 'user'
        : l.by === 'orchestrator'
          ? 'orchestrator'
          : 'agent';
  return speaker(prev) === speaker(line) && speaker(line) !== 'status';
}

/**
 * Clips text for a preview, keeping whole lines where it can.
 * @param text - Text.
 * @param max - Longest preview.
 */
export function clipPreview(text: string, max = 1200): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf('\n', max);
  return `${t.slice(0, cut > max * 0.6 ? cut : max)}\n…`;
}
