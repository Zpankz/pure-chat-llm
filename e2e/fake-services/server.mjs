// Fake network services for the end-to-end suite. EVERYTHING HERE IS FAKED.
//
// - An OpenAI-compatible chat completions endpoint (`/v1/chat/completions`, streaming and not)
//   that replays a script embedded in the conversation instead of calling a real model.
// - Two MCP servers: a stateless "modern" one (`/mcp`) and an older session-based one that only
//   answers after `initialize` (`/mcp-legacy`).
//
// The plugin under test is real and runs in real Obsidian; only these network peers are fake.
// Every request and reply is appended to `traces/fake-services.jsonl`, which is the tool-call trace
// the validation report cites.
//
// Script protocol: a user message (a chat note, an orchestrator relay or a sub-agent brief)
// contains `<<FAKE:base64url(json)>>` where json is
//   { "id": "scenario-id", "rounds": [[{ "name": "tool", "args": {...} }, ...], ...], "final": "text" }
// Round N is returned after N earlier assistant tool-call turns since that message. When the rounds
// are used up the fake model answers with `final`.
// Reviewer requests (system prompt "You review one proposed change") get APPROVE, or REJECT when
// the change contains the marker REVIEW-REJECT.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const FAKE_MARKER = /<<FAKE:([A-Za-z0-9_-]+=*)>>/g;

export function encodeScript(script) {
  return `<<FAKE:${Buffer.from(JSON.stringify(script)).toString('base64url')}>>`;
}

function decode(b64) {
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => p?.text ?? '').join('\n');
  return '';
}

/** Picks the reply for one chat completions request. Exported for the self-test. */
export function planReply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).join('\n');
  if (/You review one proposed change/.test(system)) {
    const change = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n');
    const reject = change.includes('REVIEW-REJECT');
    return {
      kind: 'reviewer',
      message: {
        role: 'assistant',
        content: reject
          ? 'REJECT\nFake reviewer: the change carries the REVIEW-REJECT test marker.'
          : 'APPROVE\nFake reviewer: no reject marker in the change.',
      },
    };
  }
  // The newest message carrying a script decides; count tool-call turns after it.
  let at = -1;
  let script = null;
  for (let i = messages.length - 1; i >= 0 && !script; i--) {
    if (messages[i].role !== 'user' && messages[i].role !== 'system') continue;
    const text = textOf(messages[i].content);
    const all = [...text.matchAll(FAKE_MARKER)];
    if (all.length) {
      script = decode(all[all.length - 1][1]);
      at = i;
    }
  }
  if (!script) {
    return {
      kind: 'unscripted',
      message: { role: 'assistant', content: 'FAKE MODEL: no script in this conversation, so nothing to do.' },
    };
  }
  const done = messages.slice(at + 1).filter(m => m.role === 'assistant' && m.tool_calls?.length).length;
  const rounds = script.rounds ?? [];
  if (done < rounds.length) {
    const calls = rounds[done].map((c, i) => ({
      id: `call_${script.id ?? 'x'}_${done}_${i}`.replace(/[^A-Za-z0-9_]/g, '_'),
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
    }));
    return { kind: 'tool_calls', script: script.id, round: done, message: { role: 'assistant', content: null, tool_calls: calls } };
  }
  return {
    kind: 'final',
    script: script.id,
    message: { role: 'assistant', content: script.final ?? `FAKE MODEL: scenario ${script.id} finished.` },
  };
}

const MCP_TOOLS = [
  {
    name: 'dtw_lookup',
    description: 'FAKE MCP tool: returns a canned definition for a term.',
    inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
  },
];

function mcpResult(method, params) {
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } };
  }
  if (method === 'tools/list') return { tools: MCP_TOOLS };
  if (method === 'tools/call') {
    const term = params?.arguments?.term ?? '';
    return { content: [{ type: 'text', text: `FAKE-MCP-RESULT for "${term}": a canned definition.` }] };
  }
  return {};
}

/**
 * Starts the fake services.
 * @param {{ port?: number, traceDir: string }} opts
 */
export function startFakeServices({ port = 8787, traceDir }) {
  fs.mkdirSync(traceDir, { recursive: true });
  const traceFile = path.join(traceDir, 'fake-services.jsonl');
  const trace = entry => fs.appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const legacySessions = new Set();

  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Expose-Headers': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const json = (status, obj, extra = {}) => {
        res.writeHead(status, { ...cors, 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/__trace') {
        json(200, fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
        return;
      }
      if (url.pathname.endsWith('/models')) {
        trace({ service: 'llm-models', origin: req.headers.origin ?? null });
        json(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
        return;
      }
      if (url.pathname.endsWith('/chat/completions')) {
        const plan = planReply(body);
        trace({
          service: 'llm',
          kind: plan.kind,
          script: plan.script,
          round: plan.round,
          model: body.model,
          stream: !!body.stream,
          tools_offered: (body.tools ?? []).map(t => t.function?.name ?? t.name),
          messages: body.messages,
          reply: plan.message,
        });
        if (body.stream) {
          res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const chunk = delta => res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          if (plan.message.tool_calls) {
            chunk({ role: 'assistant', tool_calls: plan.message.tool_calls.map((c, index) => ({ index, ...c })) });
          } else {
            chunk({ role: 'assistant', content: plan.message.content });
          }
          res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: plan.message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        json(200, {
          id: 'fake',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: plan.message, finish_reason: plan.message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
        return;
      }
      if (url.pathname === '/mcp' || url.pathname === '/mcp-legacy') {
        const legacy = url.pathname === '/mcp-legacy';
        const { id, method, params } = body;
        trace({ service: legacy ? 'mcp-legacy' : 'mcp', method, params, headers: { 'mcp-method': req.headers['mcp-method'], 'mcp-session-id': req.headers['mcp-session-id'] } });
        if (id === undefined) {
          res.writeHead(202, cors).end();
          return;
        }
        if (legacy && method !== 'initialize' && !legacySessions.has(req.headers['mcp-session-id'])) {
          json(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
          return;
        }
        if (legacy && method === 'initialize') {
          const sid = `fake-session-${legacySessions.size + 1}`;
          legacySessions.add(sid);
          json(200, { jsonrpc: '2.0', id, result: mcpResult(method, params) }, { 'Mcp-Session-Id': sid });
          return;
        }
        json(200, { jsonrpc: '2.0', id, result: mcpResult(method, params) });
        return;
      }
      trace({ service: 'unknown', method: req.method, path: url.pathname });
      json(404, { error: 'fake services: unknown path' });
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, traceFile, url: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const traceDir = process.argv[2] ?? path.resolve('e2e/.out/traces');
  startFakeServices({ port: Number(process.env.FAKE_PORT ?? 8787), traceDir }).then(s => console.log(`fake services on ${s.url}, trace ${s.traceFile}`));
}
