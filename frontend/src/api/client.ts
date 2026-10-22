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
