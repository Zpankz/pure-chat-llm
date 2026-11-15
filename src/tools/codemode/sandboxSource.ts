/**
 * Source of the Web Worker that runs code mode scripts.
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

let seq = 0;
const pending = new Map();
let storeMap = {};

function callHost(payload) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post(Object.assign({ type: 'call', id }, payload));
  });
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function bm25(allTools, query, limit, namespace) {
  const docs = allTools
    .filter(t => !namespace || t.name.startsWith(namespace))
    .map(t => ({ t, toks: tokenize(t.name.replace(/_/g, ' ') + ' ' + t.description) }));
  const q = tokenize(query);
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

const EXIT = { exit: true };

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

  storeMap = msg.store || {};
  const outputs = [];
  const consoleLines = [];
  const consoleObj = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleObj[level] = (...args) => {
      consoleLines.push((level === 'log' ? '' : '[' + level + '] ') + args.map(fmt).join(' '));
    };
  }
  const allTools = msg.tools;
  const tools = {};
  for (const t of allTools) {
    const call = (args) => callHost({ name: t.name, args: args || {} });
    tools[t.name] = call;
    tools[t.id] = call;
  }
  tools.call = (name, args) => callHost({ name, args: args || {} });

  const api = {
    tools,
    console: consoleObj,
    text: (v) => { outputs.push(fmt(v)); },
    store: (key, value) => {
      const json = JSON.stringify(value);
      storeMap[key] = json;
      post({ type: 'store', key, value: json });
    },
    load: (key) => (key in storeMap ? JSON.parse(storeMap[key]) : undefined),
    exit: () => { throw EXIT; },
    ALL_TOOLS: allTools.map(t => ({ name: t.name, description: t.description })),
    searchTools: (query, opts) => bm25(allTools, query, opts && opts.limit, opts && opts.namespace),
    describeTool: (name) => {
      const t = allTools.find(x => x.name === name || x.id === name);
      return t ? { name: t.name, description: t.description, parameters: t.parameters } : undefined;
    },
    describeNamespace: (ns) => allTools.filter(t => t.name.startsWith(ns)).map(t => ({ name: t.name, description: t.description })),
  };

  const names = Object.keys(api);
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(...names, msg.code);
    const ret = await fn(...names.map(n => api[n]));
    post({ type: 'done', ok: true, ret: ret === undefined ? undefined : fmt(ret), outputs, console: consoleLines });
  } catch (error) {
    if (error === EXIT) {
      post({ type: 'done', ok: true, outputs, console: consoleLines });
    } else {
      const text = error && error.stack ? String(error.stack) : String(error);
      post({ type: 'done', ok: false, error: text, outputs, console: consoleLines });
    }
  }
};
`;
