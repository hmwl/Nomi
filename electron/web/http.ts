import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;

export type JsonRecord = Record<string, unknown>;

export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url || "/", "http://127.0.0.1");
}

export function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

export function handleOptions(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  setCorsHeaders(req, res);
  res.writeHead(204);
  res.end();
  return true;
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  setCorsHeaders(req, res);
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendRpcValue(req: IncomingMessage, res: ServerResponse, value: unknown): void {
  sendJson(req, res, 200, { ok: true, value: encodeTransportValue(value) });
}

export function sendRpcError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || "Request failed");
  sendJson(req, res, 200, { ok: false, error: message });
}

export function sendError(req: IncomingMessage, res: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || "Request failed");
  sendJson(req, res, status, { ok: false, error: message });
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) as unknown : null;
}

function isTransportBytes(value: unknown): value is { __nomiBytesBase64: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { __nomiBytesBase64?: unknown }).__nomiBytesBase64 === "string",
  );
}

export function decodeTransportValue(value: unknown): unknown {
  if (isTransportBytes(value)) return Buffer.from(value.__nomiBytesBase64, "base64");
  if (Array.isArray(value)) return value.map((item) => decodeTransportValue(item));
  if (!value || typeof value !== "object") return value;
  const out: JsonRecord = {};
  for (const [key, item] of Object.entries(value as JsonRecord)) out[key] = decodeTransportValue(item);
  return out;
}

export function encodeTransportValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __nomiBytesBase64: value.toString("base64") };
  if (ArrayBuffer.isView(value)) {
    const view = value as Uint8Array;
    return { __nomiBytesBase64: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64") };
  }
  if (value instanceof ArrayBuffer) return { __nomiBytesBase64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map((item) => encodeTransportValue(item));
  if (!value || typeof value !== "object") return value;
  const out: JsonRecord = {};
  for (const [key, item] of Object.entries(value as JsonRecord)) out[key] = encodeTransportValue(item);
  return out;
}

