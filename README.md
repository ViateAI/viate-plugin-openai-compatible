# @viateai/plugin-openai-compatible

Viate provider for an OpenAI-shaped HTTP API. Provider id: `openai-compatible`.

The package name stays `openai-compatible` because this is not a chat-completions-only adapter. It relays:

- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `POST /v1/responses`
- `GET /v1/models`

Request bodies are forwarded as JSON. Response bodies, including SSE streams, are passed through. Usage is not parsed. `anthropic-beta`, `anthropic-version`, and `openai-beta` are forwarded. `content-type` and `cache-control` are returned.

## Connection

| Field | Required | Notes |
| --- | --- | --- |
| `baseUrl` | yes | `http` or `https`. A trailing slash is removed. |
| `apiKey` | no | Sent as `Authorization: Bearer`. Omit it for a server with no key. |

A raw credential string is treated as `baseUrl`. JSON may use those two fields.

Path joining:

- `https://api.example/v1` serves `https://api.example/v1/chat/completions`.
- A base URL that does not end in `/v1` gets `/v1` inserted.
- A base URL that already ends with the request path is used as given.

## Install

From npm, after a release is published:

```bash
viate plugin add @viateai/plugin-openai-compatible
```

From a tarball, for a container that should not depend on the registry at install time:

```bash
npm pack
viate plugin add ./<tarball>.tgz
```

`viate.entry` is `dist/index.js`. The published tarball contains the built `dist`. `@viateai/sdk` is a peer of `1.0.1`; the gateway removes it at install and loads its own copy.

Plugins run in-process. Install only packages you trust. See [Viate](https://github.com/ViateAI/viate).

## Development

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Release Please on `main` owns the version and changelog. Do not edit either by hand.

MIT. See [LICENSE](LICENSE).
