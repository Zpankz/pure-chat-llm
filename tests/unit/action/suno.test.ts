import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { EmptyApiKey } from '../../../src/assets/constants';
import { SunoConfirmationModal, SunoTool, sunoCost } from '../../../src/tools/Suno';
import { isToolError } from '../../../src/tools/toolContract';
import { actionChat, flush, openedModals, resetModals } from './fixtures';

const withKey = (apiKey = 'suno-test-key') => ({
  endpoints: [{ name: 'Suno', apiKey, endpoint: 'https://api.sunoapi.org' }],
});

/** Records Suno calls and answers them without the network. */
class FakeSuno extends SunoTool {
  calls: { path: string; body?: object }[] = [];
  answers: Record<string, unknown> = {
    '/generate': { taskId: 'task-1' },
    '/get-credits': { credits: 42 },
  };
  protected async call<T>(path: string, _key: string, body?: object): Promise<T> {
    this.calls.push({ path, body });
    const answer = this.answers[path.split('?')[0]];
    if (!answer) throw new Error(`no answer for ${path}`);
    return answer as T;
  }
}

beforeEach(resetModals);

test('suno is offered only with a real key', async () => {
  assert.equal(actionChat({ settings: withKey() }).tool(SunoTool).isAvailable(), true);
  assert.equal(
    actionChat({ settings: withKey(EmptyApiKey) })
      .tool(SunoTool)
      .isAvailable(),
    false,
  );
  const none = actionChat({ settings: { endpoints: [] } }).tool(SunoTool);
  assert.equal(none.isAvailable(), false);
  assert.ok(isToolError(await none.execute({ action: 'get_credits' })));
});

test('voice: a paid action without confirm spends nothing and opens no modal', async () => {
  const c = actionChat({ role: 'voice', settings: withKey() });
  const tool = c.tool(FakeSuno);
  const out = await tool.execute({ action: 'generate_music', prompt: 'calm piano' });
  assert.ok(isToolError(out), out);
  assert.match(out, /ConfirmationNeeded/);
  assert.match(out, /12 credits, about \$0\.060/);
  assert.equal(tool.calls.length, 0);
  assert.equal(openedModals.length, 0);
});

test('voice: confirm true runs without a modal and returns stable JSON', async () => {
  const c = actionChat({ role: 'voice', settings: withKey() });
  const tool = c.tool(FakeSuno);
  const out = JSON.parse(
    await tool.execute({
      action: 'generate_music',
      prompt: 'calm piano',
      confirm: true,
      format: 'json',
    }),
  ) as Record<string, unknown>;
  assert.equal(openedModals.length, 0);
  assert.equal(tool.calls.length, 1);
  assert.equal(tool.calls[0].path, '/generate');
  assert.deepEqual(Object.keys(out).sort(), [
    'action',
    'cost_credits',
    'credits',
    'lyrics',
    'status',
    'stems',
    'summary',
    'task_id',
    'tracks',
  ]);
  assert.equal(out.task_id, 'task-1');
  assert.equal(out.cost_credits, 12);
});

test('note chat: the cost modal decides, even when confirm is passed', async () => {
  const c = actionChat({ settings: withKey() });
  const tool = c.tool(FakeSuno);

  const declined = tool.execute({ action: 'generate_lyrics', prompt: 'rain', confirm: true });
  await flush();
  assert.equal(openedModals.length, 1);
  const modal = openedModals[0] as SunoConfirmationModal;
  assert.equal(modal.cost, sunoCost('generate_lyrics'));
  assert.deepEqual(modal.details, { prompt: 'rain' });
  modal.finish(false);
  const out = await declined;
  assert.ok(isToolError(out), out);
  assert.equal(tool.calls.length, 0);

  tool.answers['/lyrics'] = { taskId: 'lyr-1' };
  const approved = tool.execute({ action: 'generate_lyrics', prompt: 'rain' });
  await flush();
  (openedModals[1] as SunoConfirmationModal).finish(true);
  const text = await approved;
  assert.match(text, /^Started writing the lyrics/);
  assert.match(text, /lyr-1/);
});

test('free actions run without confirmation; check_status reports tracks', async () => {
  const c = actionChat({ role: 'voice', settings: withKey() });
  const tool = c.tool(FakeSuno);
  assert.equal(await tool.execute({ action: 'get_credits' }), 'You have 42 Suno credits left.');
  tool.answers['/generate/record-info'] = {
    status: 'SUCCESS',
    response: {
      data: [{ id: 'a1', title: 'Rain', audio_url: 'https://cdn.example/a1.mp3', duration: 61.4 }],
    },
  };
  const status = JSON.parse(
    await tool.execute({ action: 'check_status', taskId: 'task 1', format: 'json' }),
  ) as { status: string; tracks: unknown[]; summary: string };
  assert.equal(status.status, 'SUCCESS');
  assert.deepEqual(status.tracks, [
    { id: 'a1', title: 'Rain', audio_url: 'https://cdn.example/a1.mp3', duration: 61.4 },
  ]);
  assert.equal(status.summary, 'Done: 1 track.');
  assert.equal(tool.calls[1].path, '/generate/record-info?taskId=task%201');
  assert.equal(openedModals.length, 0);
});

test('suno validates before asking, refuses background layers and reports API errors', async () => {
  const voice = actionChat({ role: 'voice', settings: withKey() }).tool(FakeSuno);
  for (const args of [
    { action: 'generate_music' },
    { action: 'generate_music', prompt: 'x', customMode: true },
    { action: 'extend_music', audioId: 'a', prompt: 'x' },
    { action: 'separate_vocals', audioId: 'a' },
    { action: 'check_status' },
    { action: 'generate_music', prompt: 'x', model: 'V9' },
    { action: 'dance' },
  ]) {
    const out = await voice.execute(args as never);
    assert.ok(isToolError(out), `${JSON.stringify(args)} -> ${out}`);
    assert.match(out, /InvalidArgument/);
  }
  assert.equal(voice.calls.length, 0);

  const worker = actionChat({ role: 'subagent', settings: withKey() }).tool(FakeSuno);
  const out = await worker.execute({ action: 'generate_music', prompt: 'x', confirm: true });
  assert.ok(isToolError(out), out);
  assert.equal(worker.calls.length, 0);
  assert.equal(openedModals.length, 0);

  // The real client with the test mock's requestUrl: fails cleanly, no network.
  const real = actionChat({ role: 'voice', settings: withKey() }).tool(SunoTool);
  const failed = await real.execute({ action: 'get_credits' });
  assert.ok(isToolError(failed), failed);
  assert.match(failed, /SunoApiError/);
});
