/**
 * Sources that run inside the code mode sandbox, shared by both engines:
 * - djs (https://github.com/earendil-works/djs): a WebAssembly JavaScript engine made to
 *   replace QuickJS in pi's code mode. Preferred when its module is available.
 * - A locked-down Web Worker, used when the djs module is missing.
 *
 * `CODEMODE_PRELUDE` builds the script's globals from tool metadata and a host object with
 * `call(name, args)` (a promise) and `store(key, json)`. It is plain ES2020 so both engines
 * (and djs's TypeScript mode) accept it.
 */
export const CODEMODE_PRELUDE = String.raw`
function __fmt(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

function __tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function __bm25(allTools, query, limit, namespace) {
  const docs = allTools
    .filter(t => !namespace || t.name.startsWith(namespace))
    .map(t => ({ t, toks: __tokenize(t.name.replace(/_/g, ' ') + ' ' + t.description) }));
  const q = __tokenize(query);
  const N = docs.length || 1;
  const avg = docs.reduce((n, d) => n + d.toks.length, 0) / N || 1;
  const df = {};
  for (const term of q) df[term] = docs.filter(d => d.toks.includes(term)).length;
  return docs
    .map(d => {
      let score = 0;
      for (const term of q) {
        const tf = d.toks.filter(x => x === term).length;
        if (!tf) continue;
        const idf = Math.log(1 + (N - df[term] + 0.5) / (df[term] + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.toks.length / avg));
      }
      if (d.t.name.toLowerCase().includes(String(query).toLowerCase())) score += 2;
      return { name: d.t.name, description: d.t.description, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 8);
}

const __EXIT = { exit: true };

function __makeApi(meta, host) {
  const storeMap = Object.assign({}, meta.store || {});
  const outputs = [];
  const consoleLines = [];
  const consoleObj = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleObj[level] = (...args) => {
      consoleLines.push((level === 'log' ? '' : '[' + level + '] ') + args.map(__fmt).join(' '));
    };
  }
  const allTools = meta.tools;
  const tools = {};
  for (const t of allTools) {
    const call = (args) => host.call(t.name, args || {});
    tools[t.name] = call;
    tools[t.id] = call;
  }
  tools.call = (name, args) => host.call(name, args || {});
  const api = {
    tools,
    console: consoleObj,
    text: (v) => { outputs.push(__fmt(v)); },
    store: (key, value) => {
      const json = JSON.stringify(value);
      storeMap[key] = json;
      host.store(String(key), json);
    },
    load: (key) => (key in storeMap ? JSON.parse(storeMap[key]) : undefined),
    exit: () => { throw __EXIT; },
    ALL_TOOLS: allTools.map(t => ({ name: t.name, description: t.description })),
    searchTools: (query, opts) => __bm25(allTools, query, opts && opts.limit, opts && opts.namespace),
    describeTool: (name) => {
      const t = allTools.find(x => x.name === name || x.id === name);
      return t ? { name: t.name, description: t.description, parameters: t.parameters } : undefined;
    },
    describeNamespace: (ns) => allTools.filter(t => t.name.startsWith(ns)).map(t => ({ name: t.name, description: t.description })),
  };
  return { api, outputs, consoleLines };
}

async function __finish(state, run) {
  try {
    const ret = await run();
    return { ok: true, ret: ret === undefined ? undefined : __fmt(ret), outputs: state.outputs, console: state.consoleLines };
  } catch (error) {
    if (error === __EXIT) return { ok: true, outputs: state.outputs, console: state.consoleLines };
    const text = error && error.stack ? String(error.stack) : String(error);
    return { ok: false, error: text, outputs: state.outputs, console: state.consoleLines };
  }
}
`;

/** Names the script sees, in the order the engines pass them. */
export const CODEMODE_GLOBALS = [
  'tools',
  'console',
  'text',
  'store',
  'load',
  'exit',
  'ALL_TOOLS',
  'searchTools',
  'describeTool',
  'describeNamespace',
];

/**
 * Source of the Web Worker engine.
 *
 * The worker has no DOM, no Obsidian API, no Node APIs and (after the lock-down below) no network:
 * fetch, XMLHttpRequest, WebSocket, EventSource, importScripts, nested workers and storage APIs are
 * shadowed before user code runs. Scripts reach the outside world only through `tools.*`, which
 * round-trip to the plugin over postMessage. The host kills the worker on timeout.
 */
export const CODEMODE_WORKER_SOURCE = String.raw`
'use strict';
const post = self.postMessage.bind(self);
const BLOCKED = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts',
  'Worker', 'SharedWorker', 'indexedDB', 'caches', 'BroadcastChannel', 'Request', 'Response',
  'navigator', 'location', 'open', 'close', 'webkitRequestFileSystem', 'requestFileSystem',
  'FileReaderSync', 'storageFoundation', 'RTCPeerConnection'
];
for (const name of BLOCKED) {
  try {
    Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false });
  } catch (e) { /* ignore */ }
}
${CODEMODE_PRELUDE}
let seq = 0;
const pending = new Map();
const host = {
  call(name, args) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ type: 'call', id, name, args });
    });
  },
  store(key, value) { post({ type: 'store', key, value }); },
};
const GLOBALS = ${JSON.stringify(CODEMODE_GLOBALS)};

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'reply') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.value);
    return;
  }
  if (msg.type !== 'run') return;
  const state = __makeApi({ tools: msg.tools, store: msg.store }, host);
  const result = await __finish(state, () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(...GLOBALS, msg.code);
    return fn(...GLOBALS.map(n => state.api[n]));
  });
  post(Object.assign({ type: 'done' }, result));
};
`;

/**
 * The script djs runs: the prelude, then the model's code as the body of an inner async
 * function whose parameters are the code mode globals. `__meta` (tool metadata and store) is a
 * run parameter; `__host.call` and `__host.store` are host functions.
 * @param code - The model's script.
 */
export function buildDjsScript(code: string): string {
  return `${CODEMODE_PRELUDE}
const __state = __makeApi(__meta, { call: (n, a) => __host.call(n, JSON.stringify(a)).then(r => JSON.parse(r)), store: (k, v) => __host.store(k, v) });
const __user = async (${CODEMODE_GLOBALS.join(', ')}) => {
${code}
};
return JSON.stringify(await __finish(__state, () => __user(${CODEMODE_GLOBALS.map(g => `__state.api.${g}`).join(', ')})));
`;
}
