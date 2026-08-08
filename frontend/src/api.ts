import type { BlockConfig, MeasurementRecord, Session, SetRecord } from "@fit/program";

/**
 * The API client.
 *
 * Same-origin by construction: locally Vite proxies `/api`, and deployed
 * CloudFront serves both the SPA and the API from one hostname. That means no
 * CORS configuration exists anywhere, and the session cookie is simply sent —
 * which is exactly why the dev server proxies rather than pointing at another
 * origin (ADR-0016).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    // Sends the __session cookie. Without it every request is anonymous and the
    // edge answers 401 to the fetch rather than redirecting it — see below.
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (response.status === 401) {
    // The edge answers /api/* with 401 rather than a 302 to the IdP, because
    // following a cross-origin redirect from fetch produces an opaque CORS
    // failure the SPA cannot act on. A full-page navigation CAN follow it, so
    // that is what happens here.
    window.location.href = `/oauth2/start?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, "not authenticated — redirecting to sign in");
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body["error"] === "string" ? body["error"] : `request failed (${response.status})`,
      body["issues"],
    );
  }

  return body as T;
};

export interface Identity {
  email: string;
  actor: string;
  environment: string;
}

export interface WeeklyMedian {
  weekStart: string;
  bodyWeight?: number;
  waistCircumference?: number;
}

export interface PersonalBest {
  weight: number;
  reps: number;
  estimated: number;
  timestamp: string;
}

export const api = {
  me: () => request<Identity>("/api/me"),

  currentBlock: () =>
    request<{ block: BlockConfig | null; sessions: Session[] }>("/api/blocks/current"),

  blocks: () => request<{ blocks: BlockConfig[] }>("/api/blocks"),

  sessions: (blockId: string, week6?: string) =>
    request<{ block: BlockConfig; sessions: Session[] }>(
      `/api/blocks/${encodeURIComponent(blockId)}/sessions${week6 ? `?week6=${week6}` : ""}`,
    ),

  createBlock: (body: unknown) =>
    request<{ block: BlockConfig }>("/api/blocks", { method: "POST", body: JSON.stringify(body) }),

  projectNextBlock: (body: unknown) =>
    request<{
      config: BlockConfig;
      projections: unknown[];
      carriedForward: string[];
      note: string;
    }>("/api/blocks/project", { method: "POST", body: JSON.stringify(body) }),

  sets: (since?: string) =>
    request<{ sets: SetRecord[]; personalBests: Record<string, PersonalBest> }>(
      `/api/sets${since ? `?since=${encodeURIComponent(since)}` : ""}`,
    ),

  logSets: (sets: unknown[]) =>
    request<{ written: number }>("/api/sets", {
      method: "POST",
      body: JSON.stringify({ sets }),
    }),

  measurements: () =>
    request<{ measurements: MeasurementRecord[]; weekly: WeeklyMedian[] }>("/api/measurements"),

  logMeasurement: (body: unknown) =>
    request<{ measurement: MeasurementRecord }>("/api/measurements", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  season: () => request<{ plan: unknown; weeks: unknown[] }>("/api/season"),

  progress: () =>
    request<{
      series: Record<string, Array<{ date: string; estimated: number }>>;
      personalBests: Record<string, PersonalBest>;
    }>("/api/progress"),

  finops: (params: Record<string, string> = {}) =>
    request<{
      available: boolean;
      reason?: string;
      groupBy?: string;
      from?: string;
      to?: string;
      rows: Array<{ period: string; key: string; cost: number }>;
    }>(`/api/finops?${new URLSearchParams(params)}`),
};
