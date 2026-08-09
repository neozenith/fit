#!/usr/bin/env bun
/**
 * Run the whole application locally: the API and the SPA, side by side.
 *
 * Both are the REAL implementations (ADR-0016) — the same router the Lambda
 * wraps, and the same SPA bundle the deploy uploads. Only the transport and the
 * backing store differ.
 *
 * Ctrl-C stops both. That is worth saying explicitly because the naive version
 * of this script leaves an orphaned Vite process holding port 5173, and the
 * next `make dev` fails with an error that names neither cause nor cure.
 */

import type { Subprocess } from "bun";

const API_PORT = 8787;
const SPA_PORT = 5173;

const children: Subprocess[] = [];

const spawn = (name: string, cmd: string[], env: Record<string, string>): Subprocess => {
  const child = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
    onExit(_proc, exitCode, signalCode) {
      // Bun reports the signal as a NUMBER, not a name — comparing it to
      // "SIGTERM" is always false, so the shutdown path would cascade into
      // itself and report a spurious failure on every clean Ctrl-C.
      //
      // Any non-null signal here means we killed it, which is the normal exit.
      if (signalCode !== null || shuttingDown) return;

      // A child dying on its own is not something to survive: half the stack
      // running is more confusing than none of it. Take it all down, and say why.
      console.error(`\n[dev] ${name} exited with code ${exitCode} — stopping everything.`);
      shutdown(exitCode ?? 1);
    },
  });
  children.push(child);
  return child;
};

let shuttingDown = false;
const shutdown = (code: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone. Nothing to do, and throwing here would mask the original
      // reason we are shutting down.
    }
  }
  process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[dev] api  http://localhost:${API_PORT}`);
console.log(`[dev] spa  http://localhost:${SPA_PORT}`);
console.log(`[dev] mint a session with:  make token ENV=local\n`);

spawn("api", ["bun", "run", "--hot", "api/src/server.ts"], {
  ENVIRONMENT: "local",
  PORT: String(API_PORT),
  DYNAMODB_ENDPOINT: "http://localhost:8000",
  TABLE_PREFIX: "fit-local",
  AWS_REGION: "ap-southeast-2",
  // An absolute path rather than a bucket name, which `parquetGlob` reads as a
  // filesystem source. That makes the History page run its REAL DuckDB queries
  // against the REAL curated Parquet locally — the alternative is a page whose
  // SQL is first executed in a deployed environment.
  //
  // `reference/` is gitignored and may simply not exist; the history routes
  // then answer `available: false`, which is the same thing a fresh
  // environment answers, so the empty state is exercised too.
  ARCHIVE_BUCKET: `${import.meta.dir}/../reference`,
});

spawn("spa", ["bun", "run", "--cwd", "frontend", "dev"], {
  VITE_API_ORIGIN: `http://localhost:${API_PORT}`,
});

// Keep the parent alive; the children own the lifetime.
await new Promise(() => {});
