import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { silentPluginLogger, type ProviderConnection, type ProviderHandler } from "@viateai/sdk";
import {
  chatCompletions,
  embeddings,
  listModels,
  normalizeCredentials,
  parseCredentials,
  plugin,
  responses,
} from "./index.js";

describe("openai-compatible plugin", () => {
  it("registers one provider with credential metadata", async () => {
    let handler: ProviderHandler | undefined;
    await plugin.register({
      registerProvider(registered) {
        handler = registered;
      },
      log: silentPluginLogger(),
    });
    assert.equal(handler?.id, "openai-compatible");
    assert.deepEqual(handler?.credentialsForm, [
      { key: "baseUrl", label: "Base URL", kind: "url", required: true },
      { key: "apiKey", label: "API Key", kind: "secret" },
    ]);
    assert.equal(typeof handler?.responses, "function");
  });

  it("parses and normalizes plugin-owned credentials", () => {
    assert.deepEqual(parseCredentials("https://api.example/v1"), {
      baseUrl: "https://api.example/v1",
    });
    assert.deepEqual(normalizeCredentials({
      baseUrl: " https://api.example/v1/ ",
      apiKey: " secret ",
    }), {
      credentials: { baseUrl: "https://api.example/v1", apiKey: "secret" },
      displayLabel: "api.example",
    });
    assert.throws(() => normalizeCredentials({ baseUrl: "file:///tmp/socket" }), /http or https/);
  });

  it("passes through a non-stream JSON completion", async () => {
    const body = { id: "chatcmpl-1", object: "chat.completion", choices: [] };
    const server = await listen(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer test-key");
      assert.equal(req.headers["openai-beta"], "assistants=v2");
      const payload = JSON.parse(await readBody(req)) as { model: string };
      assert.equal(payload.model, "demo");
      res.writeHead(200, { "content-type": "application/json", "x-private": "no" });
      res.end(JSON.stringify(body));
    });
    try {
      const result = await chatCompletions(
        { body: { model: "demo", messages: [] }, headers: { "openai-beta": "assistants=v2" } },
        connection(server.url, "test-key"),
      );
      assert.equal(result.status, 200);
      assert.match(result.headers["content-type"] ?? "", /application\/json/);
      assert.equal(result.headers["x-private"], undefined);
      assert.deepEqual(JSON.parse(await readStream(result.body)), body);
    } finally {
      await server.close();
    }
  });

  it("passes through an SSE stream", async () => {
    const frames = ["data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n", "data: [DONE]\n\n"];
    const server = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) {
        res.write(frame);
      }
      res.end();
    });
    try {
      const result = await chatCompletions(
        { body: { model: "demo", stream: true, messages: [] }, headers: {} },
        connection(server.url),
      );
      assert.equal(result.status, 200);
      assert.match(result.headers["content-type"] ?? "", /text\/event-stream/);
      assert.equal(await readStream(result.body), frames.join(""));
    } finally {
      await server.close();
    }
  });

  it("propagates upstream HTTP errors", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key", type: "invalid_request_error" } }));
    });
    try {
      const result = await chatCompletions(
        { body: { model: "demo", messages: [] }, headers: {} },
        connection(server.url, "bad"),
      );
      assert.equal(result.status, 401);
      const payload = JSON.parse(await readStream(result.body)) as { error: { message: string } };
      assert.equal(payload.error.message, "invalid api key");
    } finally {
      await server.close();
    }
  });

  it("aborts the upstream request when the signal fires", async () => {
    const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<void>();
    const { promise: received, resolve: resolveReceived } = Promise.withResolvers<void>();
    const server = await listen((req, res) => {
      resolveReceived();
      const markAborted = () => resolveAborted();
      req.on("aborted", markAborted);
      req.on("close", markAborted);
      res.writeHead(200, { "content-type": "text/event-stream" });
    });
    const abort = new AbortController();
    try {
      const pending = chatCompletions(
        { body: { model: "demo", stream: true, messages: [] }, headers: {}, signal: abort.signal },
        connection(server.url),
      );
      await received;
      abort.abort();
      await assert.rejects(pending, (error: unknown) => {
        assert.equal(error instanceof Error && error.name === "AbortError", true);
        return true;
      });
      await aborted;
    } finally {
      await server.close();
    }
  });

  it("passes through models, embeddings, and responses", async () => {
    const paths: string[] = [];
    const server = await listen(async (req, res) => {
      paths.push(`${req.method} ${req.url}`);
      const requestBody = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ object: "list", data: [{ id: "demo" }] }));
        return;
      }
      res.end(requestBody || "{}");
    });
    try {
      const models = await listModels({ headers: {} }, connection(server.url));
      assert.deepEqual(models, {
        object: "list",
        data: [{ id: "demo", object: "model" }],
      });
      const embedded = await embeddings(
        { body: { input: "hello" }, headers: {} },
        connection(server.url),
      );
      assert.equal(embedded.status, 200);
      await readStream(embedded.body);
      const replied = await responses(
        { body: { model: "demo", input: "hello" }, headers: {} },
        connection(server.url),
      );
      assert.equal(replied.status, 200);
      await readStream(replied.body);
      assert.deepEqual(paths, ["GET /v1/models", "POST /v1/embeddings", "POST /v1/responses"]);
    } finally {
      await server.close();
    }
  });
});

function connection(baseUrl: string, apiKey?: string): ProviderConnection {
  return {
    connectionId: "c1",
    providerId: "openai-compatible",
    credentials: { baseUrl, ...(apiKey ? { apiKey } : {}) },
  };
}

type TestServer = {
  url: string;
  close(): Promise<void>;
};

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
  const { promise, resolve, reject } = Promise.withResolvers<TestServer>();
  const server: Server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("expected tcp address"));
      return;
    }
    resolve({
      url: `http://127.0.0.1:${address.port}`,
      close() {
        const { promise: closed, resolve: done } = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => done());
        return closed;
      },
    });
  });
  server.on("error", reject);
  return promise;
}

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
  return promise;
}

async function readStream(body: ReadableStream<Uint8Array> | null): Promise<string> {
  assert.ok(body);
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}
