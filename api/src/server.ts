import { handleRequest } from "./app.js";
import { LOCAL_SESSION_KEY, PORT } from "./const.js";

/**
 * Local HTTP adapter over the same router the Lambda entry point wraps.
 *
 * The ONLY differences from deployed are transport (Bun.serve rather than a
 * Function URL) and backing store (DynamoDB Local rather than DynamoDB).
 * Authentication runs identically — `make token ENV=local` mints a session
 * against `LOCAL_SESSION_KEY`, and the same signature verification applies.
 * There is deliberately no `if (isLocal) skipAuth` branch (ADR-0016).
 */

const server = Bun.serve({
  port: PORT,
  fetch: (request) => handleRequest(request, LOCAL_SESSION_KEY),
});

console.log(`fit api listening on http://localhost:${server.port}`);
