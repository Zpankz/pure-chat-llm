import { createPatch } from 'diff';
import {
  App,
  Modal,
  normalizePath,
  Notice,
  Setting,
  TextAreaComponent,
  TFile,
  TFolder,
} from 'obsidian';
import { ToolOutputBuilder } from './ToolOutputBuilder';
import type { PureChatLLMChat } from '../core/Chat';
import { backupNote, buildProposal, peerReview, writePolicy } from '../agents/peerReview';
import type { WriteAction } from '../agents/peerReview';

/**
 *
 */
export class EditReview {
  /**
   * Asks for approval of a write, then makes it. Background sub-agents follow the write
   * policy in settings (write straight away, two independent reviewers, this window, or not at
   * all); every other chat gets this window.
   * @param app - Obsidian app.
   * @param path - Note path.
   * @param newContent - Full new content.
   * @param properties - Frontmatter properties to merge.
   * @param overwrite - Whether an existing file may be replaced.
   * @param instruction - What the edit is for.
   * @param chat - Chat the tool runs in.
   */
  static async prompt(
    app: App,
    path: string,
    newContent: string,
    properties: Record<string, unknown> | undefined,
    overwrite: boolean,
    instruction?: string,
    chat?: PureChatLLMChat,
  ): Promise<string> {
    const target = normalizePath(path);
    const existing = app.vault.getAbstractFileByPath(target);
    const action: WriteAction = existing instanceof TFile ? 'edit' : 'create';
    const plugin = chat?.plugin;
    const policy = plugin ? writePolicy(plugin, chat, action) : 'review';
    if (plugin && policy !== 'review') {
      if (policy === 'deny') {
        return `Not done: sub-agents can't ${action === 'edit' ? 'edit existing notes' : 'create notes'} (plugin setting). Report the change you wanted instead.`;
      }
      const original = existing instanceof TFile ? await app.vault.read(existing) : null;
      if (policy === 'peer') {
        const proposal = await buildProposal(plugin, target, newContent, instruction, action);
        const verdict = await peerReview(plugin, proposal);
        logReview(chat, `${action} ${target}`, verdict.approved, verdict.verdicts);
        if (!verdict.approved) {
          return `Not done: the ${action} of "${target}" needs both independent reviewers to approve, and they didn't.\n${verdict.verdicts.join('\n')}\nRevise the change or ask the orchestrator.`;
        }
        if (action === 'edit') {
          const backup = await backupNote(plugin, target).catch(() => null);
          if (backup) logReview(chat, `backup of ${target} saved to ${backup}`, true, []);
        }
      }
      const result = await applyNoteWrite(
        app,
        target,
        newContent,
        properties,
        overwrite,
        instruction,
        original,
      );
      return policy === 'peer' ? `Approved by both reviewers.\n${result}` : result;
    }
    return new Promise(resolve => {
      new EditReviewModal(app, path, newContent, properties, overwrite, instruction, result =>
        resolve(result),
      ).open();
    });
  }
}

/**
 * Records a reviewer decision on the sub-agent's task.
 * @param chat - Sub-agent chat.
 * @param what - The change.
 * @param approved - Outcome.
 * @param verdicts - Reviewer lines.
 */
export function logReview(
  chat: PureChatLLMChat | undefined,
  what: string,
  approved: boolean,
  verdicts: string[],
): void {
  const id = chat?.subAgentTaskId;
  if (!id || !chat) return;
  const line = verdicts.length
    ? `Review of ${what}: ${approved ? 'approved' : 'rejected'}. ${verdicts.join(' ')}`
    : what;
  chat.plugin.agents?.report(id, line);
}

/**
 *
 */
class EditReviewModal extends Modal {
  path: string;
  newContent: string;
  properties?: Record<string, unknown>;
  overwrite: boolean;
  instruction?: string;
  onResolve: (result: string) => void;
  originalContent: string | null = null;
  resolved = false;

  /**
   *
   * @param app
   * @param path
   * @param newContent
   * @param properties
   * @param overwrite
   * @param instruction
   * @param onResolve
   */
  constructor(
    app: App,
    path: string,
    newContent: string,
    properties: Record<string, unknown> | undefined,
    overwrite: boolean,
    instruction: string | undefined,
    onResolve: (result: string) => void,
  ) {
    super(app);
    this.path = normalizePath(path);
    this.newContent = newContent;
    this.properties = properties;
    this.overwrite = overwrite;
    this.instruction = instruction;
    this.onResolve = onResolve;
  }

  /**
   *
   */
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (file && file instanceof TFile) {
      this.originalContent = await this.app.vault.cachedRead(file);
    }

    contentEl.createEl('h2', { text: 'Review proposed edit' });

    if (this.instruction) {
      contentEl.createEl('p', { text: `Goal: ${this.instruction}`, cls: 'edit-instruction' });
    }

    contentEl.createEl('h4', { text: `File: ${this.path}` });

    // Display Properties if present
    if (this.properties && Object.keys(this.properties).length > 0) {
      new Setting(contentEl)
        .setName('Frontmatter properties')
        .setDesc('These properties will be added or updated.')
        .setHeading();
      const propPre = contentEl.createEl('pre');
      propPre.createEl('code', { text: JSON.stringify(this.properties, null, 2) });
    }

    // Diff
    new Setting(contentEl).setName('Changes').setHeading();

    const diffContainer = contentEl.createEl('div');
    diffContainer.addClass('diff-container');

    if (this.originalContent !== null) {
      const patch = createPatch(this.path, this.originalContent, this.newContent);
      const lines = patch.split('\n');
      for (const line of lines) {
        const div = diffContainer.createEl('div');
        if (line.startsWith('+')) {
          div.addClass('diff-added');
        } else if (line.startsWith('-')) {
          div.addClass('diff-removed');
        } else if (line.startsWith('@@')) {
          div.addClass('diff-hunk');
        } else {
          div.addClass('diff-equal');
        }
        div.setText(line);
      }
    } else {
      diffContainer.createEl('div').setText('New file - no diff available');
    }

    // New Content
    new Setting(contentEl).setName('Proposed content').setHeading();

    const newArea = new TextAreaComponent(contentEl);
    newArea.setValue(this.newContent);
    newArea.inputEl.addClass('PUREcodePreview');
    newArea.onChange(val => {
      this.newContent = val;
    });

    // Actions
    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Approve and apply')
          .setCta()
          .onClick(async () => {
            const result = await this.applyEdit();
            this.resolved = true;
            this.onResolve(result);
            this.close();
          }),
      )
      .addButton(btn =>
        btn.setButtonText('Reject edit').onClick(() => {
          this.resolved = true;
          this.onResolve('Edit rejected by user.');
          this.close();
        }),
      );
  }

  /**
   *
   */
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.resolved) {
      this.onResolve('Edit review cancelled.');
    }
  }

  /** Applies the reviewed edit. */
  async applyEdit(): Promise<string> {
    return applyNoteWrite(
      this.app,
      this.path,
      this.newContent,
      this.properties,
      this.overwrite,
      this.instruction,
      this.originalContent,
    );
  }
}

/**
 * Writes a note (creating folders as needed) and reports what changed.
 * @param app - Obsidian app.
 * @param path - Note path.
 * @param newContent - Full new content.
 * @param properties - Frontmatter properties to merge.
 * @param overwrite - Whether an existing file may be replaced.
 * @param instruction - What the edit is for.
 * @param originalContent - Content before the edit, when known.
 */
export async function applyNoteWrite(
  app: App,
  path: string,
  newContent: string,
  properties: Record<string, unknown> | undefined,
  overwrite: boolean,
  instruction: string | undefined,
  originalContent: string | null,
): Promise<string> {
  const self = {
    app,
    path: normalizePath(path),
    newContent,
    properties,
    overwrite,
    instruction,
    originalContent,
  };
  try {
    // 1. Ensure directory exists
    const folders = self.path.split('/').slice(0, -1);
    if (folders.length > 0) {
      let currentPath = '';
      for (const folder of folders) {
        currentPath = currentPath === '' ? folder : `${currentPath}/${folder}`;
        const existingFolder = self.app.vault.getAbstractFileByPath(currentPath);
        if (!existingFolder) {
          await self.app.vault.createFolder(currentPath);
        } else if (!(existingFolder instanceof TFolder)) {
          return new ToolOutputBuilder()
            .addError(
              'InvalidPathError',
              `Path component "${currentPath}" exists but is not a folder`,
              [
                `list_vault_folders("${currentPath.split('/').slice(0, -1).join('/')}") - Inspect the parent directory`,
                'Choose a different path that does not conflict with existing files',
                'Rename or move the conflicting file',
              ],
            )
            .build();
        }
      }
    }

    // 2. Check for existing file
    const existingFile = self.app.vault.getAbstractFileByPath(self.path);
    let targetFile: TFile;
    const isNewFile = !existingFile;
    const originalContent = self.originalContent || '';

    if (existingFile) {
      if (!self.overwrite) {
        return new ToolOutputBuilder()
          .addError(
            'FileExistsError',
            `File "${self.path}" already exists and overwrite is not enabled`,
            [
              `read_file("${self.path}") - Review the existing file content`,
              'Set overwrite parameter to true if you want to replace the existing file',
              'Choose a different file path to avoid overwriting',
            ],
          )
          .build();
      }
      if (!(existingFile instanceof TFile)) {
        return new ToolOutputBuilder()
          .addError('InvalidPathError', `Path "${self.path}" exists but is not a file`, [
            `list_vault_folders("${self.path.split('/').slice(0, -1).join('/')}") - Inspect the containing directory`,
            'Choose a different path that does not conflict with existing folders',
          ])
          .build();
      }
      // Atomic update using process
      await self.app.vault.process(existingFile, () => self.newContent);
      targetFile = existingFile;
    } else {
      // Create new file
      targetFile = await self.app.vault.create(self.path, self.newContent);
    }

    // 3. Update frontmatter if properties provided
    if (self.properties && typeof self.properties === 'object') {
      await self.app.fileManager.processFrontMatter(targetFile, frontmatter => {
        Object.assign(frontmatter, self.properties);
      });
    }

    new Notice(`Successfully saved "${self.path}".`);

    // Build enhanced success message
    const builder = new ToolOutputBuilder();
    builder.addHeader(isNewFile ? 'NOTE CREATED' : 'PATCH OPERATION APPROVED');
    builder.addKeyValue('Target', self.path);

    if (self.instruction) {
      builder.addKeyValue('Action', self.instruction);
    }

    // Calculate changes
    const originalLines = originalContent.split('\n').length;
    const newLines = self.newContent.split('\n').length;
    const lineDiff = newLines - originalLines;
    const charCount = self.newContent.length;

    if (!isNewFile) {
      if (lineDiff !== 0) {
        builder.addKeyValue(
          'Lines changed',
          `${lineDiff > 0 ? '+' : ''}${lineDiff} (${originalLines} -> ${newLines})`,
        );
      }
      builder.addKeyValue('Total characters', charCount.toLocaleString());
    } else {
      builder.addKeyValue('Lines created', newLines.toString());
      builder.addKeyValue('Characters', charCount.toLocaleString());
    }

    builder.addSeparator();
    builder.addKeyValue('File Status', 'Saved successfully');

    // Add helpful suggestions
    builder.addSeparator();
    builder.addSuggestions(
      `manage_workspace() to open the ${isNewFile ? 'new' : 'updated'} file`,
      `read_file("${self.path}") to verify the changes`,
    );

    return builder.build();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Error saving note: ${message}`);
    return new ToolOutputBuilder()
      .addError('FileSystemError', message, [
        'Check file permissions and vault configuration',
        'Verify the file path is valid',
        'Ensure no other process is locking the file',
      ])
      .build();
  }
}
