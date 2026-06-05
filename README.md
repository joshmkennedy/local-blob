# local-blob

Local development emulator for the Vercel Blob API.

This package runs on Node.js only. No Bun or Docker runtime is required.

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

## Run

From npm once published:

```shell
npx local-blob
```

With options:

```shell
npx local-blob --port 9966 --store .local-blob-store
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
