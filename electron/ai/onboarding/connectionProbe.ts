import type { ProviderKind } from "./types";

type ConnectionProbePayload = {
  providerKind?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  modelId?: unknown;
  headers?: unknown;
};

function providerKindFromPayload(payload: ConnectionProbePayload): ProviderKind {
  return payload?.providerKind === "anthropic" ? "anthropic" : "openai-compatible";
}

function extraHeadersFromPayload(payload: ConnectionProbePayload): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!payload?.headers || typeof payload.headers !== "object") return headers;
  for (const [k, v] of Object.entries(payload.headers as Record<string, unknown>)) {
    const key = String(k).trim();
    const value = String(v ?? "").trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

function baseUrlFromPayload(payload: ConnectionProbePayload, providerKind: ProviderKind): string {
  const rawBaseUrl = String(payload?.baseUrl || "").trim().replace(/\/+$/, "");
  return providerKind === "anthropic" && !rawBaseUrl ? "https://api.anthropic.com" : rawBaseUrl;
}

export async function testOnboardingConnection(payload: ConnectionProbePayload): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  const providerKind = providerKindFromPayload(payload);
  const baseUrl = baseUrlFromPayload(payload, providerKind);
  const apiKey = String(payload?.apiKey || "").trim();
  const modelId = String(payload?.modelId || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: "接入地址需以 http:// 或 https:// 开头" };
  const extraHeaders = extraHeadersFromPayload(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const url = providerKind === "anthropic" ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = providerKind === "anthropic"
      ? {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...extraHeaders,
        }
      : {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...extraHeaders,
        };
    const body = providerKind === "anthropic"
      ? {
          model: modelId || "claude-3-5-haiku-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }
      : {
          model: modelId || "gpt-3.5-turbo",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 300) || `HTTP ${res.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listOnboardingModels(payload: ConnectionProbePayload): Promise<{
  ok: boolean;
  models?: string[];
  status?: number;
  error?: string;
}> {
  const providerKind = providerKindFromPayload(payload);
  const baseUrl = baseUrlFromPayload(payload, providerKind);
  const apiKey = String(payload?.apiKey || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: "接入地址需以 http:// 或 https:// 开头" };
  const extraHeaders = extraHeadersFromPayload(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const url = providerKind === "anthropic" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
    const headers: Record<string, string> = providerKind === "anthropic"
      ? {
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...extraHeaders,
        }
      : {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...extraHeaders,
        };
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 300) || `HTTP ${res.status}` };
    }
    const json = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const models = Array.isArray(json?.data)
      ? json.data.map((model) => String(model?.id || "").trim()).filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

