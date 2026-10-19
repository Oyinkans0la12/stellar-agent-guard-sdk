#!/usr/bin/env node
/**
 * Packed-consumer TypeScript declaration smoke test (issue #327).
 *
 * Source-tree typechecks can pass while the published tarball points at a
 * declaration file that was never emitted, or omits one from `files`. This
 * script validates the public declaration boundary the way a consumer sees it:
 *
 *   1. `npm pack` the built package;
 *   2. install the tarball into a throwaway consumer;
 *   3. compile a small fixture that imports the package's public values and
 *      types through the installed package name only (no `src/` imports);
 *   4. run the compiler from the repo's own devDependency, against the
 *      consumer's `node_modules`.
 *
 * A failure names the diagnostic output, so a missing declaration path is
 * visible rather than inferred.
 *
 * Usage: npm run build && npm run test:types:packed
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const TSC = resolve(ROOT, "node_modules/typescript/bin/tsc");

class PackedTypesFailure extends Error {}

function fail(message: string): never {
  throw new PackedTypesFailure(message);
}

function runNpm(args: string[], cwd: string, capture = false): string {
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  if (capture) {
    return execFileSync(command, commandArgs, { cwd, encoding: "utf8" });
  }
  execFileSync(command, commandArgs, { cwd, stdio: "inherit" });
  return "";
}

interface PackResult {
  filename: string;
  files?: Array<{ path: string }>;
}

function pack(packDir: string): PackResult {
  const output = runNpm(["pack", "--json", "--pack-destination", packDir], ROOT, true);
  const parsed = JSON.parse(output) as PackResult[] | Record<string, PackResult>;
  const packed = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const first = packed[0];
  if (!first) fail("npm pack produced no tarball");
  return first;
}

const CONSUMER_SOURCE = `/**
 * External-consumer fixture for the published declarations.
 *
 * It imports only from the package name — never from \`src/\` — and exercises
 * both value exports and the public types, so a missing declaration file or a
 * wrong \`types\` path fails the compile instead of slipping through.
 */
import {
  PreFlightInterceptor,
  blockedInfoForBatch,
  createGuardValidator,
  createLangChainGuardMiddleware,
  createVercelAIGuard,
  guardMcpToolHandler,
  mapContractCalls,
  preflightBatch,
  runBlockedHook,
  type ContractCall,
  type ElizaGuardOptions,
  type GuardBlockedInfo,
  type LangChainGuardOptions,
  type McpGuardOptions,
  type PreFlightBatchDecision,
  type PreFlightDecision,
  type VercelAIGuardOptions,
} from "stellar-agent-guard-sdk";

declare const interceptor: PreFlightInterceptor;
declare const call: ContractCall;

const decision: PreFlightDecision = {
  allowed: false,
  kind: "undetermined",
  detail: "fixture",
};

const batch: PreFlightBatchDecision = {
  admissible: false,
  overallAdmissible: false,
  verdicts: [decision],
  calls: [decision],
  totalEstimatedResourceFee: 0n,
};

const info: GuardBlockedInfo = blockedInfoForBatch("mcp", [call], [decision]);
const calls: ContractCall[] = mapContractCalls(
  { name: "fixture", arguments: {} },
  { toContractCalls: () => [call] },
);

const langchain: LangChainGuardOptions = {
  interceptor,
  toContractCalls: () => [call],
};
const mcp: McpGuardOptions = { interceptor, toContractCalls: () => [call] };
const eliza: ElizaGuardOptions = { interceptor, toContractCall: () => call };
const vercel: VercelAIGuardOptions = { interceptor, toContractCalls: () => [call] };

const guarded = guardMcpToolHandler("fixture", async () => ({ content: [] }), mcp);
runBlockedHook(undefined, info, { error: () => {} });

void [
  preflightBatch,
  createLangChainGuardMiddleware,
  createGuardValidator,
  createVercelAIGuard,
  batch,
  calls,
  langchain,
  eliza,
  vercel,
  guarded,
];
`;

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    lib: ["ES2023"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  },
  include: ["consumer.ts"],
};

function run(): void {
  if (!existsSync(resolve(ROOT, "dist/index.d.ts"))) {
    fail("dist/index.d.ts is missing; run `npm run build` first");
  }
  if (!existsSync(TSC)) {
    fail("TypeScript is not installed; run `npm ci` first");
  }

  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const workDir = mkdtempSync(join(tmpdir(), "stellar-agent-guard-packed-types-"));
  try {
    const packDir = join(workDir, "pack");
    mkdirSync(packDir);
    const tarball = pack(packDir);

    const declaredTypes = "dist/index.d.ts";
    const packedPaths = new Set((tarball.files ?? []).map((file) => file.path));
    if (!packedPaths.has(declaredTypes)) {
      fail(`the packed tarball does not contain ${declaredTypes}`);
    }

    const consumerDir = join(workDir, "consumer");
    mkdirSync(consumerDir);
    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "packed-types-consumer", private: true, type: "module" }, null, 2),
    );
    writeFileSync(join(consumerDir, "tsconfig.json"), JSON.stringify(CONSUMER_TSCONFIG, null, 2));
    writeFileSync(join(consumerDir, "consumer.ts"), CONSUMER_SOURCE);

    runNpm(
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--prefer-offline",
        join(packDir, tarball.filename),
      ],
      consumerDir,
    );

    try {
      execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], {
        cwd: consumerDir,
        stdio: "inherit",
      });
    } catch {
      fail(
        `the external consumer does not compile against the packed ${manifest.name} declarations ` +
          `(see the compiler diagnostics above)`,
      );
    }

    console.log(
      `packed-types check OK: external consumer compiled against ${manifest.name}@${manifest.version} from ${tarball.filename}`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function main(): void {
  try {
    run();
  } catch (error) {
    if (error instanceof PackedTypesFailure) {
      console.error(`packed-types check FAILED: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main();
