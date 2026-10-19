/**
 * Browser-targeted root-entry smoke test (issue #325).
 *
 * Bundles `src/index.ts` for `platform: "browser"` with no `node:*` externals
 * and asserts the metafile contains no Node built-in inputs. This is the
 * source-tree half of the gate; `npm run test:browser` runs the same check
 * against the built `dist/index.js`, which is what consumers actually import.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";

describe("browser-safe root entry (issue #325)", () => {
  it("bundles the public root entry for the browser without node:* imports", async () => {
    const result = await build({
      entryPoints: [resolve("src/index.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
    });

    const builtins = Object.keys(result.metafile.inputs).filter((path) =>
      path.startsWith("node:"),
    );
    assert.deepEqual(
      builtins,
      [],
      `the root entry graph reaches Node built-ins: ${builtins.join(", ")}`,
    );
  });
});
