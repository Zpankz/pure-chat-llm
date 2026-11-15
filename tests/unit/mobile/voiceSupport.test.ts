import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeCallError,
  voiceUnsupportedReason,
  type VoiceEnvironment,
} from '../../../src/realtime/support';

const full: VoiceEnvironment = {
  getUserMedia: true,
  peerConnection: true,
  webSocket: true,
  audioWorklet: true,
  mobile: false,
};

test('a full desktop can call with every provider', () => {
  for (const p of ['openai-realtime', 'openai-live', 'gemini-live', 'xai-voice'] as const)
    assert.equal(voiceUnsupportedReason(p, full), null);
});

test('a phone without microphone access gets a plain reason, not a crash', () => {
  const reason = voiceUnsupportedReason('openai-realtime', {
    ...full,
    getUserMedia: false,
    mobile: true,
  });
  assert.match(reason ?? '', /phone or tablet.*microphone.*computer/);
});

test('missing WebRTC blocks only the WebRTC providers', () => {
  const env = { ...full, peerConnection: false };
  assert.match(voiceUnsupportedReason('openai-live', env) ?? '', /WebRTC/);
  assert.equal(voiceUnsupportedReason('gemini-live', env), null);
});

test('missing audio worklets block only the PCM providers', () => {
  const env = { ...full, audioWorklet: false };
  assert.match(voiceUnsupportedReason('xai-voice', env) ?? '', /live audio/);
  assert.equal(voiceUnsupportedReason('openai-realtime', env), null);
});

test('microphone errors become plain words', () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  assert.match(describeCallError(denied), /refused/);
  const none = Object.assign(new Error('x'), { name: 'NotFoundError' });
  assert.match(describeCallError(none), /No microphone/);
  assert.equal(describeCallError(new Error('Socket closed')), 'Socket closed');
});
