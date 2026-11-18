// Draws conversations in the side panels: speech turns, tool and skill cards, agent updates,
// background agents and live wikilinks. Colours come from the theme's variables (styles.css,
// `.va-*`), so light, dark and mobile all follow the user's theme.
import { App, Component, Keymap, MarkdownRenderer, setIcon } from 'obsidian';
import type { SubAgentTask } from '../agents/types';
import {
  argPreview,
  clipPreview,
  formatDuration,
  labelFor,
  toolMeta,
  type ToolCallView,
} from './conversationModel';

/**
 * Makes rendered wikilinks in a container work like they do in notes: click opens the note
 * (Ctrl/Cmd-click in a new tab), hovering shows Obsidian's page preview.
 * @param app - App.
 * @param component - Owner of the listeners (the view).
 * @param el - Container.
 * @param source - The view type, registered as a hover-link source.
 * @param sourcePath - Note that relative links resolve from.
 */
export function wireLinks(
  app: App,
  component: Component,
  el: HTMLElement,
  source: string,
  sourcePath: () => string,
): void {
  const linkOf = (event: MouseEvent) =>
    (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a.internal-link') ?? null;
  component.registerDomEvent(el, 'click', event => {
    const link = linkOf(event);
    if (!link) return;
    event.preventDefault();
    const target = link.dataset.href ?? link.getAttribute('href') ?? '';
    if (target) void app.workspace.openLinkText(target, sourcePath(), Keymap.isModEvent(event));
  });
  component.registerDomEvent(el, 'mouseover', event => {
    const link = linkOf(event);
    if (!link) return;
    app.workspace.trigger('hover-link', {
      event,
      source,
      hoverParent: component,
      targetEl: link,
      linktext: link.dataset.href ?? link.getAttribute('href') ?? '',
      sourcePath: sourcePath(),
    });
  });
}

/**
 * Renders Markdown (wikilinks included) into an element.
 * @param app - App.
 * @param component - Owner of what the renderer adds.
 * @param text - Markdown.
 * @param el - Target.
 * @param sourcePath - Note that links resolve from.
 */
export function renderMarkdown(
  app: App,
  component: Component,
  text: string,
  el: HTMLElement,
  sourcePath: string,
): void {
  el.addClass('markdown-rendered', 'va-md');
  void MarkdownRenderer.render(app, text, el, sourcePath, component);
}

/**
 * The header of a turn: an avatar, who is speaking and when.
 * @param parent - Container.
 * @param who - Speaker.
 * @param name - Name shown.
 * @param at - Time.
 */
export function drawTurnHeader(
  parent: HTMLElement,
  who: 'user' | 'agent' | 'orchestrator' | 'system',
  name: string,
  at?: number,
): HTMLElement {
  const head = parent.createDiv({ cls: 'va-turn__head' });
  const icon =
    who === 'user'
      ? 'user-round'
      : who === 'agent'
        ? 'audio-lines'
        : who === 'orchestrator'
          ? 'workflow'
          : 'settings-2';
  setIcon(head.createSpan({ cls: 'va-avatar' }), icon);
  head.createSpan({ cls: 'va-turn__name', text: name });
  if (at) {
    head.createSpan({
      cls: 'va-turn__time',
      text: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  }
  return head;
}

/** A spinner, a tick or a cross for a status. */
function drawState(parent: HTMLElement, status: string): void {
  const el = parent.createSpan({ cls: `va-state is-${status}` });
  if (status === 'running' || status === 'queued') el.createSpan({ cls: 'va-spinner' });
  else setIcon(el, status === 'failed' ? 'x' : status === 'waiting' ? 'help-circle' : 'check');
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/**
 * A tool call as a card: what it did and on what, its state and time; opens to show the
 * arguments and the result (rendered on first open).
 * @param app - App.
 * @param component - Owner.
 * @param parent - Container.
 * @param tool - The call.
 * @param sourcePath - Note that links resolve from.
 * @param show - Label and preview to show instead of the ones the tool's name gives.
 * @param show.label - Label.
 * @param show.preview - Short preview.
 */
export function drawToolCard(
  app: App,
  component: Component,
  parent: HTMLElement,
  tool: ToolCallView,
  sourcePath: string,
  show: { label?: string; preview?: string } = {},
): HTMLElement {
  const meta = { ...toolMeta(tool.name), ...(show.label ? { label: show.label } : {}) };
  const card = parent.createDiv({
    cls: `va-tool va-cat-${meta.category} is-${tool.status}`,
    attr: { 'data-tool': tool.name },
  });
  const details = card.createEl('details');
  const head = details.createEl('summary', { cls: 'va-tool__head' });
  setIcon(head.createSpan({ cls: 'va-tool__icon' }), meta.icon);
  const arg = show.preview ?? argPreview(tool.args);
  if (meta.category === 'skill' && arg) {
    head.createSpan({ cls: 'va-tool__label', text: 'Skill' });
    head.createSpan({ cls: 'va-chip', text: arg });
  } else {
    const label = show.label ? meta.label : labelFor(meta.label, tool.status);
    head.createSpan({ cls: 'va-tool__label', text: label });
    if (arg) head.createSpan({ cls: 'va-tool__arg', text: arg, attr: { title: arg } });
  }
  if (tool.status === 'running') drawElapsed(head, tool.startedAt).addClass('va-tool__time');
  else if (tool.ms !== undefined) {
    head.createSpan({ cls: 'va-tool__time', text: formatDuration(tool.ms) });
  }
  drawState(head, tool.status);
  if (tool.status === 'failed' && tool.error) {
    card.createDiv({ cls: 'va-tool__error', text: tool.error });
  }
  let filled = false;
  details.addEventListener('toggle', () => {
    if (!details.open || filled) return;
    filled = true;
    const body = details.createDiv({ cls: 'va-tool__body' });
    if (!show.label) body.createDiv({ cls: 'va-label', text: tool.name });
    const args = Object.entries(tool.args ?? {}).filter(([k]) => k !== 'format');
    if (args.length) {
      const dl = body.createEl('dl', { cls: 'va-args' });
      for (const [key, value] of args) {
        dl.createEl('dt', { text: key });
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
        dl.createEl('dd', { text: clipPreview(text, 400) });
      }
    }
    if (tool.result) {
      body.createDiv({ cls: 'va-label', text: 'Result' });
      const result = clipPreview(tool.result, 1500);
      if (looksLikeJson(result)) body.createEl('pre', { cls: 'va-result', text: result });
      else renderMarkdown(app, component, result, body.createDiv({ cls: 'va-result' }), sourcePath);
    } else if (tool.status === 'running') {
      body.createDiv({ cls: 'va-muted', text: 'Still running…' });
    }
  });
  return card;
}

/**
 * A message from a background agent or the orchestrator: a finished task, a question, a
 * check-in.
 * @param app - App.
 * @param component - Owner.
 * @param parent - Container.
 * @param title - Who, and what happened ("Find the notes: finished").
 * @param detail - What it said (Markdown).
 * @param urgent - It cut in on the user.
 * @param sourcePath - Note that links resolve from.
 */
export function drawUpdate(
  app: App,
  component: Component,
  parent: HTMLElement,
  title: string,
  detail: string | undefined,
  urgent: boolean,
  sourcePath: string,
): HTMLElement {
  const card = parent.createDiv({ cls: `va-update${urgent ? ' is-urgent' : ''}` });
  const head = card.createDiv({ cls: 'va-update__head' });
  setIcon(head.createSpan({ cls: 'va-update__icon' }), urgent ? 'zap' : 'bot');
  head.createSpan({ cls: 'va-update__title', text: title });
  if (urgent) head.createSpan({ cls: 'va-pill', text: 'cut in' });
  if (detail?.trim()) {
    renderMarkdown(
      app,
      component,
      clipPreview(detail, 600),
      card.createDiv({ cls: 'va-update__text' }),
      sourcePath,
    );
  }
  return card;
}

/**
 * A quiet line between turns (connecting, a topic change, an error from the provider).
 * @param parent - Container.
 * @param text - Line.
 */
export function drawStatus(parent: HTMLElement, text: string): HTMLElement {
  const el = parent.createDiv({ cls: 'va-status' });
  el.createSpan({ text });
  return el;
}

const STEP_ICONS: Record<string, string> = {
  response: 'message-square',
  tool: 'wrench',
  message: 'mail',
  advice: 'help-circle',
  note: 'sticky-note',
};

/** A live "2m 05s" that the view's ticker keeps current. */
export function drawElapsed(parent: HTMLElement, since: number, until?: number): HTMLElement {
  const el = parent.createSpan({ cls: 'va-elapsed' });
  if (until) el.setText(formatDuration(until - since));
  else {
    el.dataset.since = String(since);
    el.setText(formatDuration(Date.now() - since));
  }
  return el;
}

/**
 * Updates every live elapsed time in a container (call once a second).
 * @param el - Container.
 */
export function tickElapsed(el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>('.va-elapsed[data-since]').forEach(span => {
    span.setText(formatDuration(Date.now() - Number(span.dataset.since)));
  });
}

/**
 * A background agent as a card: status, title (opens its thread note), how long it has run,
 * what it is doing now, its question or result, and its steps on demand.
 * @param app - App.
 * @param component - Owner.
 * @param parent - Container.
 * @param task - Task.
 * @param actions - Buttons.
 * @param actions.open - Opens the task's note.
 * @param actions.stop - Stops it.
 */
export function drawTaskCard(
  app: App,
  component: Component,
  parent: HTMLElement,
  task: SubAgentTask,
  actions: { open?: () => void; stop?: () => void },
): HTMLElement {
  const live = task.status === 'running' || task.status === 'queued' || task.status === 'waiting';
  const card = parent.createDiv({ cls: `va-task is-${task.status}` });
  const head = card.createDiv({ cls: 'va-task__head' });
  setIcon(head.createSpan({ cls: 'va-task__icon' }), 'bot');
  const title = head.createSpan({ cls: 'va-task__title', text: task.title });
  if (actions.open) {
    title.addClass('is-clickable');
    title.setAttr('aria-label', 'Open the task’s thread');
    title.onclick = actions.open;
  }
  head.createSpan({ cls: 'va-pill', text: task.status });
  const start = task.startedAt ?? task.createdAt;
  drawElapsed(head, start, live ? undefined : (task.finishedAt ?? start));
  if (live && task.status !== 'waiting') card.createDiv({ cls: 'va-progress' });

  const last = task.steps[task.steps.length - 1];
  if (task.status === 'waiting' && task.question) {
    const q = card.createDiv({ cls: 'va-task__question' });
    setIcon(q.createSpan({ cls: 'va-task__qicon' }), 'help-circle');
    q.createSpan({ text: task.question });
  } else if (live && last) {
    card.createDiv({ cls: 'va-task__now', text: last.text.replace(/\s+/g, ' ').slice(0, 160) });
  } else if (task.status === 'done' && task.result) {
    renderMarkdown(
      app,
      component,
      clipPreview(task.result, 400),
      card.createDiv({ cls: 'va-task__result' }),
      task.notePath ?? '',
    );
  } else if (task.status === 'failed' && task.error) {
    card.createDiv({ cls: 'va-task__error', text: task.error });
  }

  const foot = card.createDiv({ cls: 'va-task__foot' });
  if (task.steps.length) {
    const details = foot.createEl('details', { cls: 'va-steps' });
    details.createEl('summary', {
      text: `${task.steps.length} step${task.steps.length === 1 ? '' : 's'}`,
    });
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('ol')) return;
      const ol = details.createEl('ol');
      for (const step of task.steps.slice(-12)) {
        const li = ol.createEl('li', { cls: `va-step va-step-${step.kind}` });
        setIcon(li.createSpan({ cls: 'va-step__icon' }), STEP_ICONS[step.kind] ?? 'dot');
        li.createSpan({ text: step.text.replace(/\s+/g, ' ').slice(0, 200) });
      }
    });
  }
  const buttons = foot.createDiv({ cls: 'va-task__buttons' });
  if (actions.open) {
    const b = buttons.createEl('button', {
      cls: 'clickable-icon',
      attr: { 'aria-label': 'Open thread' },
    });
    setIcon(b, 'file-text');
    b.onclick = actions.open;
  }
  if (live && actions.stop) {
    const b = buttons.createEl('button', {
      cls: 'clickable-icon mod-warning',
      attr: { 'aria-label': 'Stop' },
    });
    setIcon(b, 'square');
    b.onclick = actions.stop;
  }
  return card;
}
