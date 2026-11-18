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
// are used up the fake model answers with `final`. Optional: `delays` (ms before answering each
// round), `finalDelayMs`, and `drop: true` (every request is cut off with no answer, to simulate a
// network failure).
// Reviewer requests (the write reviewers' system prompts) get a JSON approve verdict, or reject
// when the change contains the marker REVIEW-REJECT. REVIEW-SLOW-<ms> in the change delays the
// verdict, so a test can act while a review is pending.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const FAKE_MARKER = /<<FAKE:([A-Za-z0-9_-]+=*)>>/g;

// The write reviewers' system prompts (old and reworked wording).
const REVIEWER = /You review one proposed change|You check (?:one|whether one) proposed change/;

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

/**
 * Picks the reply for one chat completions request. Exported for the self-test.
 * @param body - The request body.
 * @param fallback - A script set through `/__default-script`, used when the request carries none
 *   (so a typed panel message can stay free of script text). Scripted requests ignore it.
 */
export function planReply(body, fallback = null) {
  return planFor(body, fallback);
}

function planFor(body, fallback) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).join('\n');
  if (REVIEWER.test(system)) {
    const change = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n');
    const reject = change.includes('REVIEW-REJECT');
    const slow = /REVIEW-SLOW-(\d+)/.exec(change);
    return {
      kind: 'reviewer',
      delayMs: slow ? Number(slow[1]) : 0,
      message: {
        role: 'assistant',
        content: JSON.stringify(
          reject
            ? { verdict: 'reject', reason: 'Fake reviewer: the change carries the REVIEW-REJECT test marker.' }
            : { verdict: 'approve', reason: 'Fake reviewer: no reject marker in the change.' },
        ),
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
  let fromDefault = false;
  if (!script && fallback) {
    script = fallback;
    fromDefault = true;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        at = i;
        break;
      }
    }
  }
  if (!script) {
    return {
      kind: 'unscripted',
      message: { role: 'assistant', content: 'FAKE MODEL: no script in this conversation, so nothing to do.' },
    };
  }
  if (script.fail) {
    // A model error: every request of this script gets an HTTP error reply.
    return {
      kind: 'error',
      fromDefault,
      script: script.id,
      status: script.fail.status ?? 400,
      message: { error: { message: script.fail.message ?? `FAKE MODEL: scenario ${script.id} fails on purpose.`, type: 'invalid_request_error' } },
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
    return {
      kind: 'tool_calls',
      fromDefault,
      script: script.id,
      round: done,
      delayMs: script.delays?.[done] ?? 0,
      drop: !!script.drop,
      message: { role: 'assistant', content: null, tool_calls: calls },
    };
  }
  return {
    kind: 'final',
    fromDefault,
    script: script.id,
    delayMs: script.finalDelayMs ?? 0,
    drop: !!script.drop,
    message: { role: 'assistant', content: script.final ?? `FAKE MODEL: scenario ${script.id} finished.` },
  };
}

/** Maps a Responses request body back to chat messages so the same scripts drive it. */
export function responsesToMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item.type === 'function_call') {
      const last = messages[messages.length - 1];
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } };
      if (last?.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: textOf(item.output) });
    } else if (item.role) {
      messages.push({ role: item.role, content: textOf(item.content) });
    }
  }
  return messages;
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
  // A script for requests that carry none; set and cleared by the test through /__default-script.
  let defaultScript = null;

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
      if (url.pathname === '/__default-script') {
        defaultScript = body && body.script ? body.script : null;
        trace({ service: 'control', default_script: defaultScript ? defaultScript.id ?? 'unnamed' : null });
        json(200, { ok: true, script: defaultScript ? defaultScript.id ?? 'unnamed' : null });
        return;
      }
      if (url.pathname.endsWith('/models')) {
        trace({ service: 'llm-models', origin: req.headers.origin ?? null });
        json(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
        return;
      }
      if (url.pathname.endsWith('/responses')) {
        // OpenAI Responses API (streamed), mapped onto the same scripts as chat completions.
        const messages = responsesToMessages(body);
        const plan = planReply({ messages }, defaultScript);
        trace({
          service: 'llm',
          api: 'responses',
          host: req.headers.host ?? null,
          path: url.pathname,
          kind: plan.kind,
          script: plan.script,
          round: plan.round,
          default_script: plan.fromDefault || undefined,
          model: body.model,
          stream: !!body.stream,
          tools_offered: (body.tools ?? []).map(t => t.name ?? t.function?.name),
          tools: body.tools ?? [],
          messages,
          reply: plan.message,
          delay_ms: plan.delayMs || undefined,
        });
        const answer = () => {
          if (plan.kind === 'error') {
            json(plan.status, plan.message);
            return;
          }
          const items = plan.message.tool_calls
            ? plan.message.tool_calls.map(c => ({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.function.name, arguments: c.function.arguments }))
            : [{ type: 'message', id: 'msg_fake', role: 'assistant', content: [{ type: 'output_text', text: plan.message.content ?? '' }] }];
          res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const send = ev => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          send({ type: 'response.created', response: { id: 'resp_fake', model: body.model, status: 'in_progress' } });
          for (const item of items) send({ type: 'response.output_item.done', item });
          send({ type: 'response.completed', response: { id: 'resp_fake', model: body.model, status: 'completed', output: items } });
          res.end();
        };
        if (plan.delayMs) setTimeout(() => !res.destroyed && answer(), plan.delayMs);
        else answer();
        return;
      }
      if (url.pathname.endsWith('/chat/completions')) {
        const plan = planReply(body, defaultScript);
        let closed = false;
        res.on('close', () => (closed = !res.writableFinished));
        trace({
          service: 'llm',
          kind: plan.kind,
          script: plan.script,
          round: plan.round,
          model: body.model,
          stream: !!body.stream,
          tools_offered: (body.tools ?? []).map(t => t.function?.name ?? t.name),
          default_script: plan.fromDefault || undefined,
          messages: body.messages,
          reply: plan.message,
          delay_ms: plan.delayMs || undefined,
          dropped: plan.drop || undefined,
        });
        const answer = () => {
          if (plan.kind === 'error') {
            json(plan.status, plan.message);
            return;
          }
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
        };
        if (plan.drop) {
          // Simulated network failure: cut the connection without an answer.
          req.socket.destroy();
          return;
        }
        if (plan.delayMs) {
          setTimeout(() => {
            if (closed || res.destroyed) {
              trace({ service: 'llm-aborted', kind: plan.kind, script: plan.script, round: plan.round, after_ms: plan.delayMs });
              return;
            }
            answer();
          }, plan.delayMs);
          return;
        }
        answer();
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
  // A second loopback address, so a test can use an endpoint the plugin does not treat as local
  // (it skips the API key check for localhost and 127.0.0.1).
  const alt = http.createServer((req, res) => server.emit('request', req, res));
  alt.on('error', () => {});
  alt.listen(port, '127.0.0.2');
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, traceFile, url: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const traceDir = process.argv[2] ?? path.resolve('e2e/.out/traces');
  startFakeServices({ port: Number(process.env.FAKE_PORT ?? 8787), traceDir }).then(s => console.log(`fake services on ${s.url}, trace ${s.traceFile}`));
}
