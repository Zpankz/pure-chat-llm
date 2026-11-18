import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesBody } from '../../../src/core/ResponsesClient';
import type { ChatRequestOptions } from '../../../src/types';

test('Responses tools are sent with strict checking off', () => {
  const options = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_vault',
          description: 'Search',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ],
  } as unknown as ChatRequestOptions;
  const body = toResponsesBody(options, undefined, false);
  const tools = body.tools as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].strict, false);
  assert.equal(tools[0].name, 'search_vault');
});
