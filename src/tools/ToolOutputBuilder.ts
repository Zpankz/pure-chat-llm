import { jsonResult, toolError } from './toolContract';

/**
 * ToolOutputBuilder gives tool output one layout for people and models, and the same content as
 * one JSON object for scripts and workers.
 *
 * The pattern for a tool that takes `format` (see `FORMAT_PARAMETER` in toolContract):
 *
 * ```ts
 * const out = new ToolOutputBuilder({ json: wantsJson(args) });
 * if (!file) return out.addError('NotFound', `No note at "${path}".`, ['Use glob_vault_files.']).build();
 * out.addHeader('Search results')
 *   .addKeyValue('Files searched', files.length)      // json: "files_searched": 42 (a number)
 *   .addTable(['Path', 'Line'], rows, 'matches')      // json: "matches": [{ "path", "line" }]
 *   .set('truncated', rows.length >= limit)           // json only
 *   .addSuggestions('Narrow the query.');             // json: "suggestions": [...]
 * return out.build();                                  // text, or compact JSON when json is set
 * ```
 *
 * Rules for JSON output, so every tool's JSON looks alike:
 * - One compact object (`jsonResult`). Keys are snake_case, made from the labels
 *   (`'Files searched'` becomes `files_searched`) unless a key is passed.
 * - Values keep their type: pass numbers and booleans as such; the text shows `String(value)`.
 * - A table is a list of row objects keyed by its headers, under `rows` or the key given.
 * - `addHeader` sets `title` (and `status`); `addSection` sets its own key to the content.
 * - Errors are never JSON: `addError` makes `build()` return the `toolError` text in both modes,
 *   so `isToolError` and code mode see the failure. Tools that return their own JSON with
 *   `jsonResult` follow the same rules.
 */
export class ToolOutputBuilder {
  private sections: string[] = [];
  private data: Record<string, unknown> = {};
  private error: string | null = null;
  private readonly json: boolean;

  /**
   * @param options - Output options.
   * @param options.json - Build a JSON object instead of text (the caller asked for `format: json`).
   */
  constructor(options: { json?: boolean } = {}) {
    this.json = !!options.json;
  }

  /**
   * Turns a label into a JSON key: `'Files searched'` becomes `files_searched`.
   * @param label - Label.
   */
  static key(label: string): string {
    return (
      label
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'value'
    );
  }

  /**
   * Add a header with optional status indicator
   * @param title - Title of the operation
   * @param status - Optional status (e.g., "Recoverable", "Success")
   */
  addHeader(title: string, status?: string): this {
    const statusPart = status ? ` (${status})` : '';
    this.sections.push(`${title}${statusPart}`);
    this.sections.push('---');
    this.data.title = title;
    if (status) this.data.status = status;
    return this;
  }

  /**
   * Add a key-value pair
   * @param label - The label/key
   * @param value - The value (numbers and booleans stay typed in JSON)
   * @param key - JSON key (default: from the label)
   */
  addKeyValue(label: string, value: string | number | boolean, key?: string): this {
    this.sections.push(`${label}: ${String(value)}`);
    this.data[key ?? ToolOutputBuilder.key(label)] = value;
    return this;
  }

  /**
   * Adds a value to the JSON object only (data the text layout leaves out).
   * @param key - JSON key.
   * @param value - Any JSON value.
   */
  set(key: string, value: unknown): this {
    this.data[key] = value;
    return this;
  }

  /**
   * Add a visual separator line
   */
  addSeparator(): this {
    this.sections.push('\n---');
    return this;
  }

  /**
   * Add a titled section with content
   * @param title - Section title
   * @param content - Section content
   * @param key - JSON key (default: from the title)
   */
  addSection(title: string, content: string, key?: string): this {
    this.sections.push(`\n${title}:\n---\n${content}\n---`);
    this.data[key ?? ToolOutputBuilder.key(title)] = content;
    return this;
  }

  /**
   * Add a formatted markdown table
   * @param headers - Column headers
   * @param rows - Data rows
   * @param key - JSON key for the list of row objects (default `rows`)
   */
  addTable(headers: string[], rows: string[][], key = 'rows'): this {
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map(r => (r[i] || '').length)),
    );

    const formatRow = (cells: string[]) =>
      '| ' + cells.map((c, i) => c.padEnd(colWidths[i])).join(' | ') + ' |';

    this.sections.push(formatRow(headers));
    this.sections.push('|' + colWidths.map(w => '-'.repeat(w + 2)).join('|') + '|');
    rows.forEach(row => this.sections.push(formatRow(row)));

    const keys = headers.map(h => ToolOutputBuilder.key(h));
    this.data[key] = rows.map(row => Object.fromEntries(keys.map((k, i) => [k, row[i] ?? ''])));
    return this;
  }

  /**
   * Add suggested actions for the LLM to consider
   * @param actions - Array of suggested actions
   */
  addSuggestions(...actions: string[]): this {
    this.sections.push('\nSUGGESTED ACTIONS:');
    actions.forEach((action, i) => {
      this.sections.push(`${i + 1}. ${action}`);
    });
    this.data.suggestions = [...((this.data.suggestions as string[]) ?? []), ...actions];
    return this;
  }

  /**
   * Add a structured error message with recovery options
   * @param type - Error type (e.g., "FileNotFoundError")
   * @param message - Detailed error message
   * @param recovery - Array of recovery suggestions
   */
  addError(type: string, message: string, recovery: string[]): this {
    // One error format for every tool (see toolContract): the error replaces whatever was added
    // before, in text and JSON mode alike, so `isToolError` and code mode see it.
    this.error = toolError(type, message, recovery);
    this.sections = [this.error];
    return this;
  }

  /** The JSON object built so far (without an error). */
  toObject(): Record<string, unknown> {
    return { ...this.data };
  }

  /** The output as compact JSON, or the error text when an error was added. */
  toJson(): string {
    return this.error ?? jsonResult(this.data);
  }

  /** The output as text (the error text when an error was added). */
  toText(): string {
    return this.sections.join('\n');
  }

  /**
   * Build and return the final output: JSON when the builder was made with `json: true`,
   * otherwise text.
   */
  build(): string {
    return this.json ? this.toJson() : this.toText();
  }
}
