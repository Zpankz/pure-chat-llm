/**
 * Fixtures for the write tools: plugin settings with the worker write policy, a fake reviewer
 * model, and access to modals the tools open.
 */
import { Modal } from 'obsidian';
import { reviewerTransport } from '../../../src/agents/peerReview';
import type { SubAgentWritePolicy } from '../../../src/types';

// peerReview uses window timers, as Obsidian code does.
(globalThis as { window?: unknown }).window ??= globalThis;

const endpoint = {
  name: 'Test',
  endpoint: 'https://example.invalid/v1',
  apiKey: 'test-key',
  defaultmodel: 'test-model',
  getmodels: false,
};

/**
 * Plugin settings with a write policy for background workers.
 * @param writes - Policy per action.
 * @param extra - More orchestrator settings.
 */
export function writeSettings(
  writes: Partial<Record<'create' | 'edit' | 'delete', SubAgentWritePolicy>> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    endpoint: 0,
    endpoints: [endpoint],
    orchestrator: {
      writes: { create: 'allow', edit: 'peer', delete: 'peer', ...writes },
      reviewerModels: '',
      backupEdits: true,
      taskFolder: 'Agent tasks',
      layers: {
        orchestrator: { endpoint: '', model: '', effort: '', api: 'chat' },
        worker: { endpoint: '', model: 'worker-model', effort: 'xhigh', api: 'chat' },
        evaluator: { enabled: false, endpoint: '', model: '', effort: 'high', api: 'chat' },
      },
      ...extra,
    },
  };
}

export interface FakeReviewer {
  /** Requests the reviewers received. */
  calls: { model: string; effort: string; system: string; user: string; maxTokens?: number }[];
  /** Restores the real transport. */
  restore(): void;
}

/**
 * Replaces the reviewer model with a function of the request.
 * @param answer - Returns the reviewer's reply text for a call (0-based call number).
 */
export function fakeReviewer(
  answer: (call: number, system: string, user: string) => string | Promise<string>,
): FakeReviewer {
  const original = reviewerTransport.ask;
  const calls: FakeReviewer['calls'] = [];
  reviewerTransport.ask = async (_plugin, layer, request) => {
    const system = String(request.messages[0]?.content ?? '');
    const user = String(request.messages[1]?.content ?? '');
    calls.push({
      model: layer.model,
      effort: String(layer.effort),
      system,
      user,
      maxTokens: request.max_completion_tokens,
    });
    return answer(calls.length - 1, system, user);
  };
  return { calls, restore: () => (reviewerTransport.ask = original) };
}

/** Modals opened since the last call, then forgets them. */
export function takeModals(): Modal[] {
  const opened = (Modal as unknown as { opened: Modal[] }).opened;
  return opened.splice(0, opened.length);
}
