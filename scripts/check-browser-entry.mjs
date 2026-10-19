#!/usr/bin/env node
/**
 * Browser root-entry smoke test (issue #325).
 *
 * Design principle 5 promises a browser-safe core. Typechecking the source tree
 * cannot prove that: a `node:*` import resolves fine in Node and only fails
 * when a browser bundler walks the real entry graph. This check bundles the
 * **built** root entry with esbuild for `platform: "browser"` and fails if any
 * Node built-in appears in the graph — so a future `node:crypto`, `node:fs`, or
 * `node:http` import cannot land in the published root entry unnoticed.
 *
 * No `external: ["node:*"]` escape hatch: externalising a built-in is exactly
 * the failure this gate exists to catch.
 *
 * Usage:
 *   npm run build && npm run test:browser
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const entry = resolve(ROOT, process.argv[2] ?? "dist/index.js");

if (!existsSync(entry)) {
  console.error(`browser-entry check FAILED: ${entry} does not exist; run \`npm run build\` first`);
  process.exit(1);
}

let result;
try {
  result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
} catch (error) {
  console.error(
    "browser-entry check FAILED: the root entry cannot be bundled for the browser without Node built-ins",
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const inputs = Object.keys(result.metafile.inputs);
const builtins = inputs.filter((path) => path.startsWith("node:"));
if (builtins.length > 0) {
  console.error("browser-entry check FAILED: node:* imports are reachable from the root entry:");
  for (const path of builtins) console.error(`  ${path}`);
  process.exit(1);
}

console.log(
  `browser-entry check OK: ${entry.replace(`${ROOT}/`, "")} bundles for the browser with no node:* imports ` +
    `(${inputs.length} inputs, ${result.outputFiles[0]?.contents.length ?? 0} bytes)`,
);
