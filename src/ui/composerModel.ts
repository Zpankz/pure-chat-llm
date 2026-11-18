// The typed message box's logic, apart from the DOM so it can be tested: which inline trigger the
// caret is in, what choosing a suggestion does to the text, and the request the orchestrator gets.

/** An inline trigger being typed: `[[` or `@` for a note, `/` for a skill or command. */
export interface Trigger {
  kind: 'link' | 'mention' | 'slash';
  /** What has been typed after the trigger. */
  query: string;
  /** Where the trigger starts (its first character) and where the caret is. */
  start: number;
  end: number;
}

/**
 * The trigger the caret is in, if any.
 * @param text - The box's text.
 * @param caret - Caret offset.
 */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  // [[ wins: it may hold spaces, and it ends at ]] or a line break.
  const open = before.lastIndexOf('[[');
  if (open !== -1) {
    const query = before.slice(open + 2);
    if (!query.includes(']]') && !query.includes('\n') && query.length <= 120) {
      return { kind: 'link', query, start: open, end: caret };
    }
  }
  const slash = /(^|\s)\/([\w:.-]*)$/.exec(before);
  if (slash) {
    const start = caret - slash[2].length - 1;
    return { kind: 'slash', query: slash[2], start, end: caret };
  }
  // @ may be followed by a note name with spaces; it stays open to the end of the line.
  const mention = /(^|\s)@([^@\n]{0,80})$/.exec(before);
  if (mention && !mention[2].startsWith(' ')) {
    const start = caret - mention[2].length - 1;
    return { kind: 'mention', query: mention[2], start, end: caret };
  }
  return null;
}

/**
 * The text after a suggestion replaces the trigger.
 * @param text - The box's text.
 * @param trigger - The trigger chosen from.
 * @param insert - What replaces it ('' to just remove it).
 */
export function replaceTrigger(
  text: string,
  trigger: Trigger,
  insert: string,
): { text: string; caret: number } {
  let after = text.slice(trigger.end);
  // A link typed as [[Not then completed should not leave a stray ]] the editor added.
  if (trigger.kind === 'link' && after.startsWith(']]')) after = after.slice(2);
  const head = text.slice(0, trigger.start) + insert;
  const spaced = insert && !after.startsWith(' ') && !head.endsWith(' ') ? ' ' : '';
  return { text: head + spaced + after, caret: head.length + spaced.length };
}

/** Something attached to a message. */
export type ContextItem =
  | { kind: 'note'; path: string; label: string; content?: string }
  | { kind: 'selection'; path: string; label: string; content: string }
  | { kind: 'skill'; name: string; label: string }
  | { kind: 'tool'; name: string; label: string }
  | { kind: 'image'; label: string; dataUrl: string; path?: string };

/** The longest part of an attached note sent with a message. */
export const NOTE_CONTEXT_CHARS = 6000;

/**
 * The request the orchestrator gets for a typed message: the words, then what was attached.
 * Notes go with their text (clipped), skills and tools as plain asks, images by their vault path.
 * @param text - What the user typed.
 * @param context - What they attached.
 */
export function buildRequest(text: string, context: ContextItem[]): string {
  const parts = [text.trim()];
  const lines: string[] = [];
  for (const item of context) {
    if (item.kind === 'note' || item.kind === 'selection') {
      const what = item.kind === 'note' ? 'Note' : 'Selection from';
      if (item.content === undefined) {
        lines.push(`- ${what} [[${item.path}]] (read it if you need it).`);
        continue;
      }
      const body =
        item.content.length > NOTE_CONTEXT_CHARS
          ? `${item.content.slice(0, NOTE_CONTEXT_CHARS)}\n… (cut; read the note for the rest)`
          : item.content;
      lines.push(`- ${what} [[${item.path}]]:`, fence(body));
    } else if (item.kind === 'skill') {
      lines.push(`- Use the skill "${item.name}".`);
    } else if (item.kind === 'tool') {
      lines.push(`- Use the tool ${item.name}.`);
    } else {
      lines.push(
        item.path
          ? `- An image, saved at [[${item.path}]], is attached to this message.`
          : '- An image is attached to this message.',
      );
    }
  }
  if (lines.length) parts.push('Attached by the user:', ...lines);
  return parts.filter(Boolean).join('\n');
}

/**
 * How the user's own message shows in the conversation: their words, then a line for what they
 * attached, with images and notes as embeds and links so they render as in a note.
 * @param text - What the user typed.
 * @param context - What they attached.
 */
export function displayMessage(text: string, context: ContextItem[]): string {
  const extras = context.map(item => {
    if (item.kind === 'image') return item.path ? `![[${item.path}]]` : '(image)';
    if (item.kind === 'note' || item.kind === 'selection') return `[[${item.path}]]`;
    return item.kind === 'skill' ? `skill: ${item.name}` : `tool: ${item.name}`;
  });
  return [text.trim(), extras.join(' · ')].filter(Boolean).join('\n\n');
}

/** @param body - Text to fence, with a fence longer than any it holds. */
function fence(body: string): string {
  const longest = Math.max(2, ...(body.match(/`{3,}/g) ?? []).map(m => m.length));
  const mark = '`'.repeat(longest + 1);
  return `${mark}markdown\n${body}\n${mark}`;
}

/** A command typed after `/`. */
export interface SlashCommand {
  name: string;
  description: string;
}

/** The box's own commands; skills are offered after them. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'stop', description: 'Stop what the orchestrator is doing' },
  { name: 'new', description: 'Start a new topic with the orchestrator' },
  { name: 'clear', description: 'Clear this conversation from the panel' },
];

/**
 * Ranks names against a query: prefix matches first, then word starts, then anywhere.
 * @param items - Candidates.
 * @param query - Typed text.
 * @param key - Text to match.
 * @param limit - Most to return.
 */
export function rank<T>(items: T[], query: string, key: (item: T) => string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const name = key(item).toLowerCase();
    const base = name.split('/').pop() ?? name;
    const score = base.startsWith(q)
      ? 0
      : name.startsWith(q)
        ? 1
        : new RegExp(`[\\s_\\-/.]${escape(q)}`).test(name)
          ? 2
          : name.includes(q)
            ? 3
            : -1;
    if (score >= 0) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || key(a.item).length - key(b.item).length)
    .slice(0, limit)
    .map(s => s.item);
}

/** @param text - Text to use literally in a RegExp. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
