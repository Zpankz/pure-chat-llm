import type { VoiceProviderId, VoiceSettings } from '../types';

/**
 * Catalogue of voice agent providers, models and voices.
 *
 * Model ids and voices come from each provider's official docs (checked November 2026):
 * - OpenAI Realtime: https://developers.openai.com/api/docs/guides/realtime-conversations
 * - OpenAI GPT-Live: https://developers.openai.com/api/docs/guides/live
 * - Gemini Live: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/api/live
 * - Grok Voice: https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 *
 * Every field in the settings UI also accepts free text, so newer ids work without a plugin update.
 */
export interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  /** Endpoint name in plugin settings that holds the API key. */
  keyEndpoint: string;
  models: string[];
  voices: string[];
}

export const VOICE_PROVIDERS: Record<VoiceProviderId, VoiceProviderInfo> = {
  'openai-realtime': {
    id: 'openai-realtime',
    label: 'OpenAI realtime',
    keyEndpoint: 'OpenAI',
    models: ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime'],
    voices: [
      'marin',
      'cedar',
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'sage',
      'shimmer',
      'verse',
    ],
  },
  'openai-live': {
    id: 'openai-live',
    label: 'OpenAI GPT-Live (full duplex)',
    keyEndpoint: 'OpenAI',
    models: ['gpt-live-1'],
    voices: ['marin', 'cedar'],
  },
  'gemini-live': {
    id: 'gemini-live',
    label: 'Gemini live',
    keyEndpoint: 'Gemini',
    models: [
      'gemini-3.8-live',
      'gemini-3.8-live-extended-thinking',
      'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-3.1-flash-live-preview',
    ],
    voices: ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'],
  },
  'xai-voice': {
    id: 'xai-voice',
    label: 'Grok voice',
    keyEndpoint: 'xAI',
    models: ['grok-voice-latest', 'grok-voice-3.0'],
    voices: ['eve', 'ara', 'leo', 'rex', 'sal'],
  },
};

/** Backend models suggested for GPT-Live Responses delegation (from OpenAI's GPT-Live guides). */
export const LIVE_BACKEND_MODELS = ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-terra'];

/** Transcription models suggested for OpenAI Realtime input transcription. */
export const OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'whisper-1',
];

/** Gemini models that only support NON_BLOCKING functions and reject `scheduling`. */
export function geminiSupportsScheduling(model: string): boolean {
  return !model.includes('extended-thinking');
}

/** Gemini models that accept `thinkingConfig`. */
export function geminiSupportsThinking(model: string): boolean {
  return model.includes('extended-thinking');
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  provider: 'openai-realtime',
  toolExposure: 'all',
  maxToolOutputChars: 6000,
  openai: {
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    speed: 1,
    turnDetection: 'semantic_vad',
    eagerness: 'auto',
    noiseReduction: 'near_field',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    reasoningEffort: 'low',
    idleTimeoutMs: 0,
  },
  live: {
    model: 'gpt-live-1',
    voice: 'marin',
    delegation: 'responses',
    backendModel: 'gpt-6-luna',
    backendInstructions:
      'You are the reasoning backend for a voice assistant inside the user’s Obsidian vault. Use tools to look things up or change notes, then answer briefly in plain spoken language. No markdown, tables or links.',
    backendReasoningEffort: 'default',
    toolChoice: 'auto',
    parallelToolCalls: true,
    serviceTier: 'auto',
    hostedWebSearch: false,
    acknowledgementDelayMs: 800,
    store: false,
  },
  gemini: {
    model: 'gemini-3.8-live',
    voice: 'Puck',
    languageCode: '',
    thinkingLevel: 'default',
    startSensitivity: 'default',
    endSensitivity: 'default',
    silenceDurationMs: 0,
    proactiveAudio: false,
    transcription: true,
    contextCompression: true,
    sessionResumption: true,
    nonBlockingTools: true,
    toolScheduling: 'WHEN_IDLE',
    googleSearch: false,
  },
  xai: {
    model: 'grok-voice-latest',
    voice: 'eve',
    speed: 1,
    reasoningEffort: 'high',
    turnDetection: 'server_vad',
    webSearch: false,
    xSearch: false,
  },
};

/**
 * Deep-merges saved voice settings over defaults so new fields get sensible values after upgrades.
 * @param saved - Voice settings loaded from disk (may be partial or missing).
 */
export function mergeVoiceSettings(saved: Partial<VoiceSettings> | undefined): VoiceSettings {
  const d = DEFAULT_VOICE_SETTINGS;
  const s = saved ?? {};
  return {
    ...d,
    ...s,
    openai: { ...d.openai, ...(s.openai ?? {}) },
    live: { ...d.live, ...(s.live ?? {}) },
    gemini: { ...d.gemini, ...(s.gemini ?? {}) },
    xai: { ...d.xai, ...(s.xai ?? {}) },
  };
}
