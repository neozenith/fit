import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handleRequest } from "./app.js";
import { REGION, SSM_PREFIX } from "./const.js";

/**
 * Lambda entry point — a thin adapter, deliberately.
 *
 * Everything real is in `app.ts`, which takes a `Request` and returns a
 * `Response`. The local server is the other adapter over the same code, so
 * there is no second implementation that can drift (ADR-0016).
 */

const ssm = new SSMClient({ region: REGION });

/**
 * The session key, cached across invocations.
 *
 * Module scope, not handler scope: a warm container reuses it, so the SSM call
 * happens once per cold start rather than once per request. The promise itself
 * is cached rather than the value, so concurrent first requests share one call
 * instead of racing.
 */
let sessionKeyPromise: Promise<string> | null = null;

const sessionKey = (): Promise<string> => {
  sessionKeyPromise ??= ssm
    .send(
      new GetParameterCommand({
        Name: `${SSM_PREFIX}/auth/session_hmac_key`,
        WithDecryption: true,
      }),
    )
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) throw new Error(`${SSM_PREFIX}/auth/session_hmac_key is empty`);
      return value;
    })
    .catch((error) => {
      // Clear the cache so the NEXT cold start retries. Caching a rejected
      // promise would make one transient SSM failure permanent for the life of
      // the container.
      sessionKeyPromise = null;
      throw error;
    });
  return sessionKeyPromise;
};

interface FunctionUrlEvent {
  requestContext: { http: { method: string; path: string } };
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export const handler = async (event: FunctionUrlEvent) => {
  const key = await sessionKey();

  const url = `https://${event.headers["host"] ?? "localhost"}${event.rawPath}${
    event.rawQueryString ? `?${event.rawQueryString}` : ""
  }`;

  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body
    : undefined;

  const method = event.requestContext.http.method;
  const response = await handleRequest(
    new Request(url, {
      method,
      headers: event.headers,
      // GET and HEAD must not carry a body; passing one throws in undici.
      ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
    }),
    key,
  );

  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
};
