# local-blob

Local development emulator for the Vercel Blob API.

This package runs on Node.js only. No Bun runtime is required.

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

The CLI defaults to:

```dotenv
PORT=3000
VERCEL_STORE_PATH=.store
```

In the app you are testing, set:

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

## Docker

```shell
npm install
npm run build
npm run build:docker
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
