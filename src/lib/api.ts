export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function api<T>(path: string, options: { signal?: AbortSignal; method?: "POST" | "PATCH"; body?: unknown } = {}): Promise<T> {
  const result = await fetch(`/api/${path}`, {
    credentials: "same-origin", cache: "no-store", signal: options.signal,
    ...(options.method ? { method: options.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {}),
  });
  const value = await result.json().catch(() => null);
  if (!result.ok) throw new ApiFailure(result.status, value?.error?.code ?? "SERVICE_UNAVAILABLE",
    result.status >= 500 ? "The service is temporarily unavailable. Please try again." : value?.error?.message ?? "The request could not be completed.");
  if (!value || !("data" in value)) throw new ApiFailure(503, "INVALID_RESPONSE", "The service returned an incomplete response. Please try again.");
  return value.data as T;
}
