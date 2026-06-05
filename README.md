# local-blob

Local development emulator for the Vercel Blob API.

This project was extracted from the APSCA prototype so it can grow into a standalone `npx local-blob` package.

## Current status

Works with `@vercel/blob@2.4.0` for common local development flows. It stores objects on disk and serves a local HTTP API compatible with the Vercel Blob client when `VERCEL_BLOB_API_URL` points at this server.

Supported API:

- `get`
- `head`
- `put`
- `put` with `multipart: true`
- `copy`
- `del`
- `list`, including cursor pagination and `mode: 'folded'`
- client-token uploads via `@vercel/blob/client.upload`
- client-token multipart uploads
- upload-completed callbacks through `handleUpload`

Known gaps:

- `@vercel/blob.get(pathname, { access })` still constructs and fetches a real `*.blob.vercel-storage.com` URL. Directly fetch the local URL returned by `put()` instead.
- `handleUploadPresigned`
- private/signed read URLs
- full provider error and policy enforcement

## Run locally

This CLI is packaged like a normal npm executable: `package.json` exposes a `bin/local-blob` entry with a Node shebang. The wrapper checks for Bun, then starts the TypeScript server with Bun. A future milestone is removing the Bun runtime requirement or shipping a compiled Node server.

From npm once published:

```shell
npx local-blob
```

From a local checkout:

```shell
bun install
bun run serve:local
```

`npx local-blob` and `serve:local` use:

```dotenv
PORT=3000 by default, or set PORT yourself
VERCEL_STORE_PATH=.store by default, or set VERCEL_STORE_PATH yourself
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_localstore_nonce
VERCEL_BLOB_API_URL=http://localhost:<PORT>
```

In the app you are testing, set:

```dotenv
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_localstore_nonce
VERCEL_BLOB_API_URL=http://localhost:9966
```

Then use `@vercel/blob` as usual.

## Demo workflow

With the local server running:

```shell
bun run demo
```

## Docker

```shell
bun install
bun run build
bun run build:docker
```

Example compose service:

```yaml
local-blob:
  ports:
    - '9966:3000'
  image: local-blob
  volumes:
    - ./dev/local-blob-store:/var/vercel-blob-store
```

## Publishing direction

The package is intentionally not polished yet. The next milestone is making `npx local-blob` a simple zero-config dev server with documented flags for port, store path, and token.
