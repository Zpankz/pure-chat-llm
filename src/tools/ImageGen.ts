import { normalizePath, requestUrl, TFile } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import type { PureChatLLMAPI } from '../types';
import { EmptyApiKey } from '../assets/constants';
import { writePolicy } from '../agents/peerReview';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';
import imgModels from './ImageGen.json';

const imgModelsJson = imgModels as {
  [provider: string]: {
    [model: string]: {
      landscape: string[];
      portrait: string[];
      square: string[];
    };
  };
};

type ImageProvider = 'OpenAI' | 'xAI';
type Ratio = 'square' | 'portrait' | 'landscape';

const defaultModels: Record<ImageProvider, string> = {
  OpenAI: 'gpt-image-1.5',
  xAI: 'grok-2-image',
};

const MAX_PROMPT = 4000;
const MAX_IMAGES = 4;

const imageGenerationParameters = defineToolParameters({
  type: 'object' as const,
  properties: {
    prompt: {
      type: 'string',
      description: `What the image should show: subject, setting, style, lighting and mood (up to ${MAX_PROMPT} characters).`,
    },
    ratio: {
      type: 'string',
      description: 'Shape: "square" (default), "portrait" (tall) or "landscape" (wide).',
      enum: ['square', 'portrait', 'landscape'],
    },
    n: {
      type: 'integer',
      description: `How many images, 1 (default) to ${MAX_IMAGES}. Each one is billed.`,
    },
    // Spread with an inline enum: FORMAT_PARAMETER's readonly enum doesn't fit ToolParameter.
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['prompt'],
} as const);

export type ImageGenerationArgs = InferArgs<typeof imageGenerationParameters>;

/** One generated image as the provider returns it. */
export interface GeneratedImage {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

/** The endpoint an image request goes to, and which provider it is. */
export interface ImageEndpoint {
  endpoint: PureChatLLMAPI;
  provider: ImageProvider;
  model: string;
}

/**
 * Which image provider an endpoint is, by name or by host.
 * @param endpoint - Endpoint.
 */
export function imageProviderOf(endpoint: PureChatLLMAPI | undefined): ImageProvider | null {
  if (!endpoint) return null;
  if (endpoint.name === 'OpenAI' || /\/\/api\.openai\.com\b/.test(endpoint.endpoint))
    return 'OpenAI';
  if (endpoint.name === 'xAI' || /\/\/api\.x\.ai\b/.test(endpoint.endpoint)) return 'xAI';
  return null;
}

/**
 * Generates images with the chat's own endpoint (OpenAI or xAI) and saves them as new
 * attachments, never over an existing file.
 */
export class ImageGenerationTool extends Tool<ImageGenerationArgs> {
  static readonly _name = 'generate_image';
  readonly name = ImageGenerationTool._name;
  readonly classification = 'AI';
  readonly description =
    'Creates images from a text description and saves them in the vault as new attachments, returning their paths and embeds. ' +
    'Use it only when the user asks for an image or picture. ' +
    `Each image is billed by the provider (OpenAI or xAI, a few cents each), so make one unless the user asks for more (at most ${MAX_IMAGES}). ` +
    'It uses the same provider as this chat and is only offered when that provider is OpenAI or xAI with an API key.';
  readonly parameters = imageGenerationParameters;

  /**
   * The endpoint this chat would generate with: the chat's own endpoint, when it is OpenAI or
   * xAI and has an API key. Used by both `isAvailable` and `execute`, so they agree.
   */
  imageEndpoint(): ImageEndpoint | null {
    const settings = this.chat.plugin.settings;
    const endpoint = this.chat.endpoint ?? settings.endpoints[settings.endpoint];
    const provider = imageProviderOf(endpoint);
    if (!provider) return null;
    const key = endpoint.apiKey?.trim();
    if (!key || key === EmptyApiKey) return null;
    const model = defaultModels[provider] || Object.keys(imgModelsJson[provider] ?? {})[0];
    return model ? { endpoint, provider, model } : null;
  }

  /** Offered only when this chat's endpoint can make images. */
  isAvailable(): boolean {
    return this.imageEndpoint() !== null;
  }

  /** @param args - Prompt, ratio, count and format. */
  async execute(args: ImageGenerationArgs): Promise<string> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return toolError('InvalidArgument', '"prompt" is empty.', ['Describe the image.']);
    if (prompt.length > MAX_PROMPT) {
      return toolError(
        'InvalidArgument',
        `The prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT}.`,
        ['Shorten the description.'],
      );
    }
    const n = args.n === undefined ? 1 : Number(args.n);
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) {
      return toolError('InvalidArgument', `"n" must be a whole number from 1 to ${MAX_IMAGES}.`);
    }
    const ratio: Ratio =
      args.ratio === 'portrait' || args.ratio === 'landscape' ? args.ratio : 'square';

    // Saving an image is a new file: refuse before spending anything where this agent can't
    // create files, or where its creates need a review that can't look at an image.
    const policy = writePolicy(this.chat.plugin, this.chat, 'create');
    if (policy === 'deny' || (this.chat.role === 'subagent' && policy !== 'allow')) {
      return toolError(
        'NotAllowed',
        'This agent may not save new files without review, so no image was generated (nothing was spent).',
        ['Describe the image you would make in your report instead.'],
      );
    }

    const target = this.imageEndpoint();
    if (!target) {
      return toolError(
        'Unavailable',
        "This chat's provider can't make images, or has no API key.",
        ['Ask the user to switch the chat to an OpenAI or xAI endpoint with an API key.'],
      );
    }

    void this.status(`Generating ${n} image${n === 1 ? '' : 's'} with ${target.provider}...`);
    let images: GeneratedImage[];
    try {
      images = await this.requestImages(target, prompt, ratio, n);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('ProviderError', `Image generation failed: ${message}`, [
        'Check the API key and account limits for this provider.',
        'Try a different description if it was refused.',
      ]);
    }
    if (!images.length) {
      return toolError('ProviderError', 'The provider returned no images.', [
        'Try again or change the description.',
      ]);
    }

    const sourcePath =
      this.chat.file?.path ?? this.chat.plugin.app.workspace.getActiveFile()?.path ?? '';
    const saved: { path: string; link: string; revised_prompt: string | null }[] = [];
    for (let i = 0; i < images.length; i++) {
      try {
        const file = await this.saveImage(images[i], i, sourcePath);
        saved.push({
          path: file.path,
          link: this.chat.plugin.app.fileManager.generateMarkdownLink(file, sourcePath),
          revised_prompt: images[i].revised_prompt ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const kept = saved.length
          ? ` Saved before the failure: ${saved.map(s => s.path).join(', ')}.`
          : '';
        return toolError(
          'SaveFailed',
          `Image ${i + 1} was generated but couldn't be saved: ${message}.${kept}`,
          ["Check the attachment folder in Obsidian's Files and links settings."],
        );
      }
    }

    if (wantsJson(args)) {
      return jsonResult({
        provider: target.provider,
        model: target.model,
        count: saved.length,
        images: saved,
      });
    }
    const lines = [
      `Saved ${saved.length} image${saved.length === 1 ? '' : 's'}: ${saved.map(s => s.path).join(', ')}.`,
    ];
    for (const s of saved) {
      lines.push(`!${s.link}`);
      if (s.revised_prompt) lines.push(`Revised prompt: ${s.revised_prompt}`);
    }
    return lines.join('\n');
  }

  /**
   * Asks the provider for images. Throws on an HTTP or API error.
   * @param target - Endpoint, provider and model.
   * @param prompt - Description.
   * @param ratio - Shape.
   * @param n - Count.
   */
  protected async requestImages(
    target: ImageEndpoint,
    prompt: string,
    ratio: Ratio,
    n: number,
  ): Promise<GeneratedImage[]> {
    const { endpoint, provider, model } = target;
    const body: Record<string, unknown> = { model, prompt, n };
    // xAI picks its own size; OpenAI takes the model's size for the shape.
    if (provider === 'OpenAI') {
      const size = imgModelsJson.OpenAI?.[model]?.[ratio]?.[0];
      if (size) body.size = size;
    }
    const response = await requestUrl({
      url: `${endpoint.endpoint.replace(/\/+$/, '')}/images/generations`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      throw: false,
    });
    const data = response.json as
      | { data?: GeneratedImage[]; error?: { message?: string } }
      | undefined;
    if (response.status >= 400) {
      throw new Error(data?.error?.message || `HTTP ${response.status}`);
    }
    return data?.data ?? [];
  }

  /**
   * Saves one image under a fresh attachment path.
   * @param image - Image as returned (base64 or a URL).
   * @param index - Position in the batch.
   * @param sourcePath - Note the attachment belongs to, for the attachment folder.
   */
  private async saveImage(
    image: GeneratedImage,
    index: number,
    sourcePath: string,
  ): Promise<TFile> {
    const { vault, fileManager } = this.chat.plugin.app;
    let bytes: ArrayBuffer;
    if (image.b64_json) {
      bytes = base64ToBytes(image.b64_json);
    } else if (image.url) {
      bytes = (await requestUrl({ url: image.url })).arrayBuffer;
    } else {
      throw new Error('the provider sent neither image data nor a link');
    }
    const ext = imageExtension(bytes);
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, '')
      .slice(0, 14);
    const name = `generated-image-${stamp}-${index + 1}.${ext}`;
    const available = normalizePath(
      await fileManager.getAvailablePathForAttachment(name, sourcePath),
    );
    // Never overwrite: if the path is somehow taken, number it.
    const dot = available.lastIndexOf('.');
    let path = available;
    for (let k = 2; vault.getAbstractFileByPath(path); k++) {
      path = `${available.slice(0, dot)} ${k}${available.slice(dot)}`;
    }
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    return vault.createBinary(path, bytes);
  }
}

/** @param b64 - Base64 text. */
function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * File extension from the image's first bytes (PNG unless it looks like JPEG or WebP).
 * @param data - Image bytes.
 */
export function imageExtension(data: ArrayBuffer): 'png' | 'jpg' | 'webp' {
  const b = new Uint8Array(data.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  return 'png';
}
