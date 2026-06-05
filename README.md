# local-blob

Local development emulator for the Vercel Blob API.

The npm package is `local-blobtastic`; it installs the `local-blob` CLI.

This package runs on Node.js only. No Bun or Docker runtime is required.

## Current status

Works with `@vercel/blob@2.4.0` for common local development flows. It stores objects on disk and serves a local HTTP API compatible with the Vercel Blob client when `VERCEL_BLOB_API_URL` points at this server.

Compatibility is tested with `@vercel/blob@2.4.0`.

Supported API:

- direct blob reads with `fetch(blob.url)` and download reads with `fetch(blob.downloadUrl)`
- `head`
- `put`, including default no-overwrite behavior, `allowOverwrite`, `addRandomSuffix`, `ifMatch`, and Vercel Blob-style `downloadUrl`
- multipart `put` via `{ multipart: true }`, with the same overwrite, suffix, and `ifMatch` behavior as regular `put`
- `copy`, including `allowOverwrite`, `addRandomSuffix`, `ifMatch`, and copy-request metadata semantics
- `createFolder`
- `del`, including single-URL `ifMatch`
- `list`, including cursor pagination and `mode: 'folded'`
- Vercel Blob-style JSON errors for common SDK error mapping
- client-token uploads via `@vercel/blob/client.upload`
- client-token multipart uploads
- upload-completed callbacks through `handleUpload`

## Run

From npm once published:

```shell
npx local-blobtastic
```

With options:

```shell
npx local-blobtastic --port 9966 --store .local-blob-store
```

Options:

```text
-p, --port <port>    Port to listen on. Defaults to PORT or 3000.
-s, --store <path>   Blob store directory. Defaults to VERCEL_STORE_PATH or .store.
-t, --token <token>  Read/write token. Defaults to BLOB_READ_WRITE_TOKEN or vercel_blob_rw_localstore_nonce.
-h, --help           Show help.
```

On startup, `local-blob` prints the environment variables to add to your app, for example:

```dotenv
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_localstore_nonce
VERCEL_BLOB_API_URL=http://localhost:3000
```

Then use `@vercel/blob` as usual.

## Reading blobs locally

Use the local URL returned by write commands and fetch it directly:

```js
import { put } from '@vercel/blob';

const blob = await put('hello.txt', 'Hello, World!', { access: 'public' });
const response = await fetch(blob.url);
const text = await response.text();
```

Use `blob.downloadUrl` for download-style local reads. It is `blob.url` with `?download=1` and returns `Content-Disposition: attachment; filename="..."`:

```js
const downloadResponse = await fetch(blob.downloadUrl);
```

Do not use `@vercel/blob.get()` with the local emulator. `get(blob.url, ...)` rejects `localhost` URLs because they are not `*.blob.vercel-storage.com`, and `get('hello.txt', ...)` builds a production Vercel Blob URL rather than using `VERCEL_BLOB_API_URL`.

## Writing and overwriting blobs locally

Like Vercel Blob, local writes do not overwrite existing blobs by default. Pass `allowOverwrite: true` when replacing an existing pathname:

```js
await put('hello.txt', 'First version', { access: 'public' });
await put('hello.txt', 'Replacement', {
  access: 'public',
  allowOverwrite: true,
});
```

Use `ifMatch` for optimistic concurrency when you have a current ETag.

## Private blobs locally

`access: 'private'` is accepted so code that writes private blobs can run locally, and the access value is stored in local metadata. The emulator does **not** enforce private reads, signed URLs, cache bypass policies, or token checks for direct blob URLs. **Private blobs are not secure locally.** Treat local private blobs as ordinary files on your machine, not as secure secrets.

## Presigned uploads locally

Presigned upload flows are intentionally unsupported in this Node-only MVP. Do not use `handleUploadPresigned`, `@vercel/blob/client.uploadPresigned`, or `presignUrl()` URLs against `local-blob`. Requests that include Vercel Blob presigned query parameters return an explicit `bad_request` JSON error. For local browser uploads, use the supported client-token upload flow via `@vercel/blob/client.upload` and `handleUpload`.

## Known gaps

- `@vercel/blob.get(...)` is not supported against the local emulator. Use direct `fetch(blob.url)` instead.
- Presigned upload flows are unsupported: `handleUploadPresigned`, `@vercel/blob/client.uploadPresigned`, and `presignUrl()` URLs against the emulator.
- Private/signed read enforcement is unsupported; `access: 'private'` is metadata-only locally.
- Full provider policy enforcement is not implemented beyond common Vercel Blob-style JSON errors (`bad_request`, `not_found`, `precondition_failed`, `forbidden`, `unknown_error`).

## Local development

```shell
npm install
npm run build
npm start
```

For a local server on port `9966` with a named store path:

```shell
npm run serve:local
```

## Demo workflow

```shell
npm run demo
```
