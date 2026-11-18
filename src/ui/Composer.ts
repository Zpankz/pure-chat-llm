// The typed message box under the conversation: a + menu for context, tools, skills, photos and
// the camera, a send button that turns into stop while the agent works, and inline triggers:
// [[ and @ for notes, / for skills and the box's own commands.
import {
  App,
  Component,
  FuzzySuggestModal,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  setIcon,
  TFile,
} from 'obsidian';
import {
  findTrigger,
  rank,
  replaceTrigger,
  SLASH_COMMANDS,
  type ContextItem,
  type Trigger,
} from './composerModel';

/** What the box needs from the panel. */
export interface ComposerHost {
  /** Skills that can be asked for. */
  skills(): { name: string; description: string }[];
  /** Tools the orchestrator has. */
  tools(): { name: string; description: string }[];
  /** Sends a message; resolves once it has been handed on. */
  send(text: string, context: ContextItem[]): Promise<void>;
  /** Runs one of the box's own commands (`stop`, `new`, `clear`). */
  command(name: string): void;
  /** Whether the agent is working, so the send button offers stop. */
  busy(): boolean;
  /** The note links resolve from. */
  sourcePath(): string;
}

interface Suggestion {
  label: string;
  detail?: string;
  icon: string;
  choose: () => void;
}

/** The longest side of an attached photo; bigger ones are scaled down before sending. */
const MAX_IMAGE_SIDE = 1600;

export class Composer extends Component {
  readonly el: HTMLElement;
  private input: HTMLTextAreaElement;
  private chipsEl: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private suggestEl: HTMLElement;
  private context: ContextItem[] = [];
  private suggestions: Suggestion[] = [];
  private selected = 0;
  private trigger: Trigger | null = null;
  private sending = false;

  /**
   * @param app - App.
   * @param parent - Where the box goes.
   * @param host - The panel.
   */
  constructor(
    private app: App,
    parent: HTMLElement,
    private host: ComposerHost,
  ) {
    super();
    this.el = parent.createDiv({ cls: 'va-composer' });
    this.suggestEl = this.el.createDiv({ cls: 'va-suggest', attr: { role: 'listbox' } });
    this.suggestEl.hide();
    this.chipsEl = this.el.createDiv({ cls: 'va-composer__chips' });
    const box = this.el.createDiv({ cls: 'va-composer__box' });
    const plus = box.createEl('button', {
      cls: 'va-composer__plus clickable-icon',
      attr: { 'aria-label': 'Add context, a skill, a tool or a photo', type: 'button' },
    });
    setIcon(plus, 'plus');
    plus.addEventListener('click', e => this.openMenu(e));
    this.input = box.createEl('textarea', {
      cls: 'va-composer__input',
      attr: {
        rows: '1',
        placeholder: 'Message the agent. [[ or @ for notes, / for skills',
        'aria-label': 'Message',
      },
    });
    this.sendBtn = box.createEl('button', {
      cls: 'va-composer__send',
      attr: { type: 'button', 'aria-label': 'Send' },
    });
    this.sendBtn.addEventListener('click', () => {
      if (this.host.busy() && !this.hasContent()) this.host.command('stop');
      else void this.submit();
    });
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', e => this.onKeyDown(e));
    this.input.addEventListener('blur', () => window.setTimeout(() => this.hideSuggest(), 150));
    this.input.addEventListener('click', () => this.onInput());
    this.input.addEventListener('paste', e => this.onPaste(e));
    this.el.addEventListener('dragover', e => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.el.addEventListener('drop', e => this.onDrop(e));
    this.refresh();
  }

  /** Puts the caret in the box. */
  focus(): void {
    this.input.focus();
  }

  /** Redraws the send button for the agent's state. */
  refresh(): void {
    const stop = this.host.busy() && !this.hasContent();
    this.sendBtn.empty();
    setIcon(this.sendBtn, stop ? 'square' : 'arrow-up');
    this.sendBtn.setAttr('aria-label', stop ? 'Stop the agent' : 'Send');
    this.sendBtn.toggleClass('is-stop', stop);
    this.sendBtn.disabled = !stop && (!this.hasContent() || this.sending);
  }

  /**
   * Attaches something to the next message.
   * @param item - What to attach.
   */
  attach(item: ContextItem): void {
    const same = (a: ContextItem) =>
      a.kind === item.kind &&
      ('path' in a && 'path' in item
        ? a.path === item.path && a.kind !== 'image'
        : 'name' in a && 'name' in item && a.name === item.name);
    if (this.context.some(same)) return;
    this.context.push(item);
    this.drawChips();
    this.refresh();
  }

  private hasContent(): boolean {
    return !!this.input.value.trim() || this.context.length > 0;
  }

  private drawChips(): void {
    this.chipsEl.empty();
    this.chipsEl.toggleClass('is-empty', !this.context.length);
    for (const item of this.context) {
      const chip = this.chipsEl.createDiv({ cls: `va-chip va-chip--${item.kind}` });
      if (item.kind === 'image') {
        chip.createEl('img', { attr: { src: item.dataUrl, alt: item.label } });
      } else {
        const icon = { note: 'file-text', selection: 'text-cursor', skill: 'sparkles', tool: 'wrench' };
        setIcon(chip.createSpan({ cls: 'va-chip__icon' }), icon[item.kind]);
      }
      chip.createSpan({ cls: 'va-chip__label', text: item.label });
      const remove = chip.createEl('button', {
        cls: 'va-chip__remove',
        attr: { type: 'button', 'aria-label': `Remove ${item.label}` },
      });
      setIcon(remove, 'x');
      remove.addEventListener('click', () => {
        this.context = this.context.filter(c => c !== item);
        this.drawChips();
        this.refresh();
      });
    }
  }

  private async submit(): Promise<void> {
    if (this.sending || !this.hasContent()) return;
    const text = this.input.value;
    const command = /^\s*\/([\w-]+)\s*$/.exec(text);
    if (command && !this.context.length && SLASH_COMMANDS.some(c => c.name === command[1])) {
      this.input.value = '';
      this.autosize();
      this.host.command(command[1]);
      this.refresh();
      return;
    }
    const context = this.context;
    this.sending = true;
    this.refresh();
    try {
      await this.host.send(text, context);
      this.input.value = '';
      this.context = [];
      this.drawChips();
      this.autosize();
    } catch (error) {
      new Notice(`Voice Agent: couldn't send: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sending = false;
      this.refresh();
    }
  }

  // ── Typing and inline triggers ──

  private onInput(): void {
    this.autosize();
    this.refresh();
    const trigger = findTrigger(this.input.value, this.input.selectionStart ?? 0);
    this.trigger = trigger;
    if (!trigger) return this.hideSuggest();
    this.showSuggest(this.suggestionsFor(trigger));
  }

  private autosize(): void {
    this.input.setCssStyles({ height: 'auto' });
    this.input.setCssStyles({ height: `${Math.min(this.input.scrollHeight, 200)}px` });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const open = this.suggestEl.isShown() && this.suggestions.length > 0;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = this.suggestions.length;
      this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.drawSuggest();
      return;
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      this.suggestions[this.selected]?.choose();
      return;
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      this.hideSuggest();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !Platform.isMobile) {
      e.preventDefault();
      void this.submit();
    }
  }

  private suggestionsFor(trigger: Trigger): Suggestion[] {
    if (trigger.kind === 'slash') {
      const commands = rank(SLASH_COMMANDS, trigger.query, c => c.name).map(c => ({
        label: `/${c.name}`,
        detail: c.description,
        icon: 'terminal',
        choose: () => this.complete(trigger, `/${c.name}`),
      }));
      const skills = rank(this.host.skills(), trigger.query, s => s.name, 6).map(s => ({
        label: s.name,
        detail: s.description,
        icon: 'sparkles',
        choose: () => {
          this.complete(trigger, '');
          this.attach({ kind: 'skill', name: s.name, label: s.name });
        },
      }));
      return [...commands, ...skills];
    }
    const files = this.app.vault
      .getFiles()
      .filter(f => ['md', 'canvas', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(f.extension));
    const found = rank(files, trigger.query, f => f.path, 8);
    return found.map(file => ({
      label: file.extension === 'md' ? file.basename : file.name,
      detail: file.parent && !file.parent.isRoot() ? file.parent.path : undefined,
      icon: file.extension === 'md' ? 'file-text' : file.extension === 'pdf' ? 'file' : 'image',
      choose: () => {
        const link = this.app.metadataCache.fileToLinktext(file, this.host.sourcePath(), true);
        if (trigger.kind === 'link') {
          // [[ writes the link into the message, like in a note.
          this.complete(trigger, `[[${link}]]`);
        } else {
          // @ attaches the note's text as context.
          this.complete(trigger, '');
          void this.attachFile(file);
        }
      },
    }));
  }

  private complete(trigger: Trigger, insert: string): void {
    const next = replaceTrigger(this.input.value, trigger, insert);
    this.input.value = next.text;
    this.input.setSelectionRange(next.caret, next.caret);
    this.hideSuggest();
    this.autosize();
    this.refresh();
    this.input.focus();
  }

  private showSuggest(items: Suggestion[]): void {
    this.suggestions = items;
    this.selected = 0;
    if (!items.length) return this.hideSuggest();
    this.drawSuggest();
    this.suggestEl.show();
  }

  private drawSuggest(): void {
    this.suggestEl.empty();
    this.suggestions.forEach((s, i) => {
      const row = this.suggestEl.createDiv({
        cls: `va-suggest__item${i === this.selected ? ' is-selected' : ''}`,
        attr: { role: 'option', 'aria-selected': String(i === this.selected) },
      });
      setIcon(row.createSpan({ cls: 'va-suggest__icon' }), s.icon);
      const text = row.createDiv({ cls: 'va-suggest__text' });
      text.createDiv({ cls: 'va-suggest__label', text: s.label });
      if (s.detail) text.createDiv({ cls: 'va-suggest__detail', text: s.detail });
      // mousedown, so the textarea keeps focus.
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        s.choose();
      });
    });
  }

  private hideSuggest(): void {
    this.suggestEl.hide();
    this.suggestions = [];
  }

  // ── The + menu ──

  private openMenu(e: MouseEvent): void {
    const menu = new Menu();
    const active = this.app.workspace.getActiveFile();
    if (active) {
      menu.addItem(i =>
        i
          .setTitle(`Current note: ${active.basename}`)
          .setIcon('file-text')
          .onClick(() => void this.attachFile(active)),
      );
    }
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    const selection = editor?.getSelection();
    if (active && selection) {
      menu.addItem(i =>
        i
          .setTitle('Selected text')
          .setIcon('text-cursor')
          .onClick(() =>
            this.attach({ kind: 'selection', path: active.path, label: `Selection in ${active.basename}`, content: selection }),
          ),
      );
    }
    menu.addItem(i =>
      i
        .setTitle('Note or file…')
        .setIcon('file-search')
        .onClick(() =>
          new PickModal(this.app, 'Attach a note or file', this.app.vault.getFiles(), f => f.path, f =>
            void this.attachFile(f),
          ).open(),
        ),
    );
    menu.addSeparator();
    menu.addItem(i =>
      i
        .setTitle('Skill…')
        .setIcon('sparkles')
        .onClick(() =>
          new PickModal(this.app, 'Ask for a skill', this.host.skills(), s => s.name, s =>
            this.attach({ kind: 'skill', name: s.name, label: s.name }),
          ).open(),
        ),
    );
    menu.addItem(i =>
      i
        .setTitle('Tool…')
        .setIcon('wrench')
        .onClick(() =>
          new PickModal(this.app, 'Ask for a tool', this.host.tools(), t => t.name, t =>
            this.attach({ kind: 'tool', name: t.name, label: t.name }),
          ).open(),
        ),
    );
    menu.addSeparator();
    menu.addItem(i =>
      i
        .setTitle('Photo…')
        .setIcon('image')
        .onClick(() => this.pickImages(false)),
    );
    menu.addItem(i =>
      i
        .setTitle('Take a photo')
        .setIcon('camera')
        .onClick(() => (Platform.isMobile ? this.pickImages(true) : new CameraModal(this.app, url => this.attachImage(url, 'Photo')).open())),
    );
    menu.showAtMouseEvent(e);
  }

  private pickImages(camera: boolean): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttr('capture', 'environment');
    else input.multiple = true;
    input.addEventListener('change', () => {
      for (const file of Array.from(input.files ?? [])) void this.attachBlob(file);
    });
    input.click();
  }

  private async attachFile(file: TFile): Promise<void> {
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(file.extension)) {
      const data = await this.app.vault.readBinary(file);
      const url = await downscale(new Blob([data], { type: `image/${file.extension === 'jpg' ? 'jpeg' : file.extension}` }));
      this.attach({ kind: 'image', label: file.name, dataUrl: url, path: file.path });
      return;
    }
    const content = file.extension === 'md' ? await this.app.vault.cachedRead(file) : undefined;
    this.attach({ kind: 'note', path: file.path, label: file.basename, content });
  }

  private async attachBlob(blob: File | Blob): Promise<void> {
    if (!blob.type.startsWith('image/')) return;
    try {
      this.attachImage(await downscale(blob), 'name' in blob ? blob.name : 'Pasted image');
    } catch (error) {
      new Notice(`Voice Agent: couldn't read the image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private attachImage(dataUrl: string, label: string): void {
    this.context.push({ kind: 'image', label, dataUrl });
    this.drawChips();
    this.refresh();
  }

  private onPaste(e: ClipboardEvent): void {
    const images = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (!images.length) return;
    e.preventDefault();
    for (const image of images) void this.attachBlob(image);
  }

  private onDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) void this.attachBlob(file);
  }
}

/**
 * Reads an image, scaled so its longest side is at most MAX_IMAGE_SIDE, as a JPEG or PNG data URL.
 * @param blob - Image.
 */
async function downscale(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL(blob.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
}

/** A fuzzy picker over any list. */
class PickModal<T> extends FuzzySuggestModal<T> {
  constructor(
    app: App,
    placeholder: string,
    private items: T[],
    private text: (item: T) => string,
    private onPick: (item: T) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return this.text(item);
  }

  onChooseItem(item: T): void {
    this.onPick(item);
  }
}

/** Desktop camera: a live preview and a button that takes the picture. */
class CameraModal extends Modal {
  private stream: MediaStream | null = null;

  constructor(
    app: App,
    private onShot: (dataUrl: string) => void,
  ) {
    super(app);
    this.setTitle('Take a photo');
  }

  onOpen(): void {
    const video = this.contentEl.createEl('video', { cls: 'va-camera', attr: { autoplay: '', playsinline: '' } });
    video.muted = true;
    const status = this.contentEl.createDiv({ cls: 'va-muted va-small', text: 'Starting the camera…' });
    const take = this.contentEl.createEl('button', { cls: 'mod-cta', text: 'Take photo' });
    take.disabled = true;
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then(stream => {
        this.stream = stream;
        video.srcObject = stream;
        status.remove();
        take.disabled = false;
      })
      .catch((error: unknown) => {
        status.setText(`The camera isn't available: ${error instanceof Error ? error.message : String(error)}`);
      });
    take.addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      this.onShot(canvas.toDataURL('image/jpeg', 0.85));
      this.close();
    });
  }

  onClose(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.contentEl.empty();
  }
}
