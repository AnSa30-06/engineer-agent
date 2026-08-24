/**
 * Build-time bundling of transformers.js + onnxruntime-web into one ES module.
 *
 * The published web build imports "onnxruntime-web/webgpu" as a bare specifier,
 * which a plain browser context cannot resolve. An import map would need inline
 * <script>, which the renderer's CSP forbids. Bundling once at build time is
 * simpler than either, and it makes packaging a single file instead of a tree
 * of .mjs and .wasm paths.
 *
 *   npm run vendor
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'src', 'sprite', 'vendor');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // The package's "." export resolves to the Node build, which pulls in fs/path
  // and cannot run in a renderer. The web build is the right entry point.
  // (both packages block deep require.resolve via their exports map)
  const NM = path.join(__dirname, '..', 'node_modules');
  const webEntry = path.join(NM, '@huggingface', 'transformers', 'dist', 'transformers.web.js');

  await esbuild.build({
    entryPoints: [webEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(OUT_DIR, 'transformers.mjs'),
    // the .wasm binaries are copied beside the bundle and loaded at runtime
    external: ['*.wasm'],
    legalComments: 'none',
    logLevel: 'info',
  });

  // ONNX runtime loads its wasm by URL at runtime, so ship the binaries too.
  const ortDist = path.join(NM, 'onnxruntime-web', 'dist');
  let copied = 0;
  for (const f of fs.readdirSync(ortDist)) {
    if (f.endsWith('.wasm') || f.endsWith('.mjs')) {
      fs.copyFileSync(path.join(ortDist, f), path.join(OUT_DIR, f));
      copied++;
    }
  }
  const size = (fs.statSync(path.join(OUT_DIR, 'transformers.mjs')).size / 1048576).toFixed(1);
  console.log(`transformers.mjs ${size} MB + ${copied} onnxruntime files -> ${OUT_DIR}`);
})().catch((e) => { console.error(e); process.exit(1); });
