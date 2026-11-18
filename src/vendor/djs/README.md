# djs JavaScript host (vendored)

Source: https://github.com/earendil-works/djs, directory `js/src`, commit 0e58f62c80252fc3f4156ab7a3744746434ed860.
License: MIT or Apache-2.0 (LICENSE-MIT, LICENSE-APACHE in this folder).

Changes: `.ts` extensions removed from relative imports, and one `as unknown as` cast in `reader.ts`, so the plugin's TypeScript setup accepts them; `defaultWasmPath` in `sandbox.ts` no longer reads `import.meta.url`, which a CommonJS bundle does not have (the plugin always passes the module).

The WebAssembly module (`djs.wasm`) is not in the repository. `.github/workflows/djs-wasm.yml` builds it from the same commit, and release builds embed it in `main.js` with its SHA-256 (see `esbuild.config.mjs`). When you update these files to a newer commit, update `DJS_COMMIT` in that workflow too.
