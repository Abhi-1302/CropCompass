import { createParser } from "eventsource-parser";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CSRF_COOKIE = "af_csrf";

function readCookie(name: string): string | undefined {
  const entry = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : undefined;
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item: { loc?: unknown[]; msg?: string }) => {
          const field = item.loc?.filter((part) => part !== "body").join(".");
          return field ? `${field}: ${item.msg}` : (item.msg ?? "");
        })
        .join("; ");
    }
  }
  return fallback;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers["X-CSRF-Token"] = token;
  }
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, errorMessage(data, response.statusText || "Request failed"));
  return data as T;
}

export async function streamApi(
  path: string, body: unknown, signal: AbortSignal,
  onEvent: (kind: string, data: unknown) => void,
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream", "Content-Type": "application/json" };
  const token = readCookie(CSRF_COOKIE);
  if (token) headers["X-CSRF-Token"] = token;
  const response = await fetch(`/api/v1${path}`, {
    method: "POST", headers, credentials: "same-origin", body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, errorMessage(data, "provider_error"));
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new ApiError(502, "interrupted");
  }
  let finished = false;
  const parser = createParser({
    onEvent(event) {
      if (["done", "error", "existing"].includes(event.event ?? "")) finished = true;
      onEvent(event.event ?? "message", JSON.parse(event.data) as unknown);
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    if (!finished) throw new ApiError(502, "interrupted");
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
