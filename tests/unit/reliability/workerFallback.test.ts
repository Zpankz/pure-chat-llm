import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, EmptyApiKey } from '../../../src/assets/constants';
import { layerProblem, resolveLayer } from '../../../src/agents/layers';
import type PureChatLLM from '../../../src/main';

/** @param keys - API keys by endpoint name. */
function plugin(keys: Record<string, string>): PureChatLLM {
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (const e of settings.endpoints) e.apiKey = keys[e.name] ?? EmptyApiKey;
  return { settings } as unknown as PureChatLLM;
}

test('workers run on the orchestrator model when the worker model has no key', () => {
  const p = plugin({ OpenAI: 'sk-test' });
  const worker = resolveLayer(p, 'worker');
  assert.equal(layerProblem(p, worker), '');
  assert.equal(worker.endpoint?.name, 'OpenAI');
  assert.equal(worker.model, resolveLayer(p, 'orchestrator').model);
  assert.match(worker.fallback ?? '', /Meta/);
});

test('workers keep their own model when it can run', () => {
  const p = plugin({ OpenAI: 'sk-test', Meta: 'meta-test' });
  const worker = resolveLayer(p, 'worker');
  assert.equal(worker.endpoint?.name, 'Meta');
  assert.equal(worker.fallback, undefined);
});

test('with no keys at all the worker problem is still reported', () => {
  const p = plugin({});
  assert.notEqual(layerProblem(p, resolveLayer(p, 'worker')), '');
});
