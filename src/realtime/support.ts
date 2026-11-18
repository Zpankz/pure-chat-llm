import { Platform } from 'obsidian';
import type { VoiceProviderId } from '../types';

/** What a device must offer for a voice call. Obsidian on phones may lack some of it. */
export interface VoiceEnvironment {
  getUserMedia: boolean;
  peerConnection: boolean;
  webSocket: boolean;
  audioWorklet: boolean;
  mobile: boolean;
}

/** Reads what this device offers. */
export function currentVoiceEnvironment(): VoiceEnvironment {
  const g = globalThis as unknown as Record<string, unknown>;
  const nav = g.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined;
  return {
    getUserMedia: typeof nav?.mediaDevices?.getUserMedia === 'function',
    peerConnection: typeof g.RTCPeerConnection === 'function',
    webSocket: typeof g.WebSocket === 'function',
    audioWorklet: typeof g.AudioWorkletNode === 'function',
    mobile: Platform.isMobile,
  };
}

/** Providers that stream audio over WebRTC; the others use a WebSocket with PCM audio. */
const WEBRTC: VoiceProviderId[] = ['openai-realtime', 'openai-live'];

/**
 * Why a voice call can't start on this device, in words for the user, or null if it can.
 * @param provider - Voice provider.
 * @param env - Device capabilities (defaults to this device).
 */
export function voiceUnsupportedReason(
  provider: VoiceProviderId,
  env: VoiceEnvironment = currentVoiceEnvironment(),
): string | null {
  const where = env.mobile ? 'Obsidian on this phone or tablet' : 'This version of Obsidian';
  if (!env.getUserMedia)
    return `${where} doesn't let plugins use the microphone, so voice calls can't start here. Use Obsidian on a computer; note chats and agents still work here.`;
  if (WEBRTC.includes(provider)) {
    if (!env.peerConnection)
      return `${where} has no WebRTC, which this voice provider needs. Pick Gemini or xAI under Voice, or call from a computer.`;
  } else {
    if (!env.webSocket)
      return `${where} has no WebSockets, which this voice provider needs. Call from a computer.`;
    if (!env.audioWorklet)
      return `${where} can't process live audio for this voice provider. Pick an OpenAI voice under Voice, or call from a computer.`;
  }
  return null;
}

/**
 * Turns a microphone error into words for the user.
 * @param error - Error from getUserMedia or the connection.
 */
export function describeCallError(error: unknown): string {
  const name = (error as { name?: string })?.name ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError' || /Permission denied|NotAllowedError/i.test(message))
    return Platform.isMobile
      ? "Microphone access was refused. Allow it for Obsidian in your phone's settings, then try again."
      : 'Microphone access was refused. Allow it for Obsidian in your system settings, then try again.';
  if (name === 'NotFoundError' || /Requested device not found|NotFoundError/i.test(message))
    return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError' || /NotReadableError|Could not start audio source/i.test(message))
    return 'The microphone is busy in another app. Close it there and try again.';
  return message || 'The voice call could not start.';
}
