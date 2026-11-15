import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ImageGenerationTool,
  imageExtension,
  type GeneratedImage,
  type ImageEndpoint,
} from '../../../src/tools/ImageGen';
import { isToolError } from '../../../src/tools/toolContract';
import { actionChat } from './fixtures';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const JPG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64');

const openai = {
  name: 'OpenAI',
  apiKey: 'sk-test',
  endpoint: 'https://api.openai.com/v1',
  defaultmodel: 'x',
  getapiKey: '',
};
const xai = {
  name: 'xAI',
  apiKey: 'xai-test',
  endpoint: 'https://api.x.ai/v1',
  defaultmodel: 'x',
  getapiKey: '',
};
const gemini = {
  name: 'Gemini',
  apiKey: 'g-test',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
  defaultmodel: 'x',
  getapiKey: '',
};

/** Answers image requests without the network. */
class FakeImages extends ImageGenerationTool {
  requests: { provider: string; model: string; n: number }[] = [];
  images: GeneratedImage[] = [{ b64_json: PNG_B64, revised_prompt: 'a red fox, watercolour' }];
  protected async requestImages(target: ImageEndpoint, _p: string, _r: string, n: number) {
    this.requests.push({ provider: target.provider, model: target.model, n });
    return this.images.slice(0, n);
  }
}

const chatOn = (endpoint: unknown, extra: Record<string, unknown> = {}) =>
  actionChat({
    settings: { endpoint: 0, endpoints: [openai, gemini, xai], ...extra },
    chat: { endpoint, file: { path: 'Notes/Fox.md' } },
  });

test('availability follows the endpoint the chat will actually use', () => {
  // Default endpoint is OpenAI, but this chat runs on Gemini: not offered.
  assert.equal(chatOn(gemini).tool(ImageGenerationTool).isAvailable(), false);
  // Default endpoint is OpenAI and the chat runs on xAI: offered, for xAI.
  const tool = chatOn(xai).tool(ImageGenerationTool);
  assert.equal(tool.isAvailable(), true);
  assert.equal(tool.imageEndpoint()?.provider, 'xAI');
  // A renamed OpenAI endpoint is recognised by its host; a placeholder key is not a key.
  assert.equal(
    chatOn({ ...openai, name: 'Work' })
      .tool(ImageGenerationTool)
      .isAvailable(),
    true,
  );
  assert.equal(
    chatOn({ ...openai, apiKey: 'sk-XXXXXXXXX' })
      .tool(ImageGenerationTool)
      .isAvailable(),
    false,
  );
  assert.equal(ImageGenerationTool._name, 'generate_image');
});

test('saves a new attachment and reports its path as text and JSON', async () => {
  const c = chatOn(openai);
  const tool = c.tool(FakeImages);
  const text = await tool.execute({ prompt: 'a red fox' });
  assert.ok(!isToolError(text), text);
  const [first, embed, revised] = text.split('\n');
  assert.match(first, /^Saved 1 image: generated-image-\d{14}-1\.png\.$/);
  assert.match(embed, /^!\[\[generated-image-\d{14}-1\]\]$/);
  assert.equal(revised, 'Revised prompt: a red fox, watercolour');
  assert.equal(tool.requests[0].model, 'gpt-image-1.5');

  tool.images = [{ b64_json: JPG_B64 }, { b64_json: PNG_B64 }];
  const json = JSON.parse(await tool.execute({ prompt: 'two foxes', n: 2, format: 'json' })) as {
    provider: string;
    model: string;
    count: number;
    images: { path: string; link: string; revised_prompt: string | null }[];
  };
  assert.equal(json.provider, 'OpenAI');
  assert.equal(json.count, 2);
  assert.match(json.images[0].path, /\.jpg$/);
  assert.equal(json.images[0].revised_prompt, null);
  for (const img of json.images) assert.ok(c.app.vault.getFileByPath(img.path), img.path);
});

test('never overwrites: a taken attachment path gets a number, folders are created', async () => {
  const c = chatOn(openai);
  c.app.vault.put('Attachments/fox.png', 'existing');
  c.app.fileManager.getAvailablePathForAttachment = async () => 'Attachments/fox.png';
  const out = JSON.parse(await c.tool(FakeImages).execute({ prompt: 'fox', format: 'json' })) as {
    images: { path: string }[];
  };
  assert.equal(out.images[0].path, 'Attachments/fox 2.png');
  assert.equal(c.app.vault.contents.get('Attachments/fox.png'), 'existing');

  c.app.fileManager.getAvailablePathForAttachment = async () => 'New folder/fox.png';
  const made = JSON.parse(await c.tool(FakeImages).execute({ prompt: 'fox', format: 'json' })) as {
    images: { path: string }[];
  };
  assert.equal(made.images[0].path, 'New folder/fox.png');
  assert.ok(c.app.vault.getFolderByPath('New folder'));
});

test('refuses before spending where new files are denied, and validates arguments', async () => {
  const denied = actionChat({
    role: 'subagent',
    settings: {
      endpoint: 0,
      endpoints: [openai],
      orchestrator: { writes: { create: 'deny', edit: 'peer', delete: 'peer' } },
    },
    chat: { endpoint: openai },
  }).tool(FakeImages);
  const out = await denied.execute({ prompt: 'fox' });
  assert.ok(isToolError(out), out);
  assert.match(out, /NotAllowed/);
  assert.equal(denied.requests.length, 0);

  const tool = chatOn(openai).tool(FakeImages);
  for (const args of [
    { prompt: '' },
    { prompt: 'x'.repeat(4001) },
    { prompt: 'x', n: 9 },
    { prompt: 'x', n: 1.5 },
  ]) {
    const res = await tool.execute(args);
    assert.ok(isToolError(res), `${JSON.stringify(args).slice(0, 40)} -> ${res}`);
  }
  assert.equal(tool.requests.length, 0);

  tool.images = [{}];
  assert.match(await tool.execute({ prompt: 'x' }), /^Error: SaveFailed/);
});

test('the real request path fails cleanly in tests (no network) and on unsupported chats', async () => {
  const real = chatOn(openai).tool(ImageGenerationTool);
  const out = await real.execute({ prompt: 'fox' });
  assert.ok(isToolError(out), out);
  assert.match(out, /ProviderError/);
  const none = await chatOn(gemini).tool(ImageGenerationTool).execute({ prompt: 'fox' });
  assert.ok(isToolError(none), none);
  assert.equal(
    imageExtension(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer,
    ),
    'webp',
  );
});
