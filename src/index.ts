import {
  toModelList,
  type CredentialsWrite,
  type HttpExchange,
  type JsonGetRequest,
  type JsonPostRequest,
  type ModelList,
  type PluginContext,
  type ProviderConnection,
  type ViatePlugin,
} from "@viateai/sdk";

const INBOUND_HEADERS: Record<string, true> = {
  "anthropic-beta": true,
  "anthropic-version": true,
  "openai-beta": true,
};
const OUTBOUND_HEADERS: Record<string, true> = {
  "content-type": true,
  "cache-control": true,
};

const PROVIDER_ID = "openai-compatible";

export type OpenAiCompatibleCredentials = {
  baseUrl: string;
  apiKey?: string;
};

export const plugin: ViatePlugin = {
  id: PROVIDER_ID,
  register(ctx: PluginContext) {
    ctx.registerProvider({
      id: PROVIDER_ID,
      credentialsForm: [
        { key: "baseUrl", label: "Base URL", kind: "url", required: true },
        { key: "apiKey", label: "API Key", kind: "secret" },
      ],
      parseCredentials,
      normalizeCredentials,
      chatCompletions,
      listModels,
      embeddings,
      responses,
    });
  },
};

export default plugin;

export function parseCredentials(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("credentials are required");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }
  return { baseUrl: trimmed };
}

export function normalizeCredentials(input: unknown): CredentialsWrite {
  if (!input || typeof input !== "object") {
    throw new Error("credentials must be an object");
  }
  const baseUrl = "baseUrl" in input && typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) {
    throw new Error("baseUrl is required");
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  const apiKey = "apiKey" in input && typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const credentials: OpenAiCompatibleCredentials = {
    baseUrl: url.toString().replace(/\/$/, ""),
    ...(apiKey ? { apiKey } : {}),
  };
  return { credentials, displayLabel: url.host };
}

export async function chatCompletions(
  request: JsonPostRequest,
  connection: ProviderConnection,
): Promise<HttpExchange> {
  return jsonRequest("POST", "chat/completions", request, connection);
}

export async function embeddings(
  request: JsonPostRequest,
  connection: ProviderConnection,
): Promise<HttpExchange> {
  return jsonRequest("POST", "embeddings", request, connection);
}

export async function responses(
  request: JsonPostRequest,
  connection: ProviderConnection,
): Promise<HttpExchange> {
  return jsonRequest("POST", "responses", request, connection);
}

export async function listModels(
  request: JsonGetRequest,
  connection: ProviderConnection,
): Promise<ModelList> {
  const exchange = await jsonRequest("GET", "models", request, connection);
  if (exchange.status >= 400) {
    throw Object.assign(new Error(`upstream models request failed (${exchange.status})`), { statusCode: 502 });
  }
  if (!exchange.body) {
    throw Object.assign(new Error("upstream models response was empty"), { statusCode: 502 });
  }
  const payload = JSON.parse(await new Response(exchange.body).text()) as unknown;
  return toModelList(payload);
}

async function jsonRequest(
  method: "GET" | "POST",
  path: string,
  request: JsonGetRequest | JsonPostRequest,
  connection: ProviderConnection,
): Promise<HttpExchange> {
  const credentials = readCredentials(connection.credentials);
  const headers: Record<string, string> = {
    ...pickHeaders(request.headers, INBOUND_HEADERS),
    accept: "application/json, text/event-stream",
  };
  if (method === "POST") {
    headers["content-type"] = "application/json";
  }
  if (credentials.apiKey) {
    headers.authorization = `Bearer ${credentials.apiKey}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(providerUrl(credentials.baseUrl, path), {
      method,
      headers,
      ...(method === "POST" && "body" in request
        ? { body: JSON.stringify(request.body ?? {}) }
        : {}),
      signal: request.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error(`upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    status: upstream.status,
    headers: pickHeaders(upstream.headers, OUTBOUND_HEADERS),
    body: upstream.body,
  };
}

function readCredentials(input: unknown): OpenAiCompatibleCredentials {
  const normalized = normalizeCredentials(input);
  return normalized.credentials as OpenAiCompatibleCredentials;
}

function providerUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith(`/${path}`)) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/${path}`;
  }
  return `${trimmed}/v1/${path}`;
}

function pickHeaders(
  headers: Headers | Record<string, string>,
  allowed: Record<string, true>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) {
    if (allowed[name.toLowerCase()] && value) picked[name.toLowerCase()] = value;
  }
  return picked;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}
