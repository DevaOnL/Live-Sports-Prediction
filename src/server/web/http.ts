import { PublicApiError } from "../api/error";

export class HttpError extends PublicApiError {}

export function response(data: unknown, status = 200, headers?: HeadersInit): Response {
  const outgoing = new Headers(headers);
  outgoing.set("Cache-Control", "no-store");
  outgoing.set("Vary", "Cookie");
  outgoing.set("X-Content-Type-Options", "nosniff");
  return Response.json(data, { status, headers: outgoing });
}

export function failure(status: number, code: string, message: string, headers?: HeadersInit) {
  return response({ error: { code, message } }, status, headers);
}

export function enforceOrigin(request: Request, origin: string) {
  if (request.headers.get("host") !== new URL(origin).host) {
    throw new HttpError(403, "UNTRUSTED_HOST", "This request host is not allowed.");
  }
  const supplied = request.headers.get("origin");
  if ((supplied !== null && supplied !== origin) || (!["GET", "HEAD"].includes(request.method) && supplied !== origin)) {
    throw new HttpError(403, "UNTRUSTED_ORIGIN", "This request origin is not allowed.");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "JSON_REQUIRED", "Send an application/json body.");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 16_384)) {
    throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }
  if (!request.body) throw new HttpError(400, "INVALID_JSON", "Send a JSON object.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16_384) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large.");
      }
      chunks.push(next.value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON", "Send a valid JSON object.");
  } finally { reader.releaseLock(); }
}

export function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new HttpError(400, "INVALID_FIELDS", "Unsupported or missing request fields.");
  }
}

export function query(request: Request, allowed: readonly string[], repeated: readonly string[] = []) {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) {
    if (!allowed.includes(key) || (!repeated.includes(key) && values.getAll(key).length !== 1)) {
      throw new HttpError(400, "INVALID_QUERY", "Unsupported or repeated query parameters.");
    }
  }
  return values;
}

export function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new HttpError(400, "INVALID_QUERY", "Pagination must use positive integers.");
  return Number(value);
}
