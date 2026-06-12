# local-blob

Local development emulator for the Vercel Blob API.

The npm package is `local-blobtastic`; it installs the `local-blob` CLI.

This package runs on Node.js only. No Bun or Docker runtime is required.

## Current status

Works with `@vercel/blob@2.4.0` for common local development flows. It stores objects on disk and serves a local HTTP API compatible with the Vercel Blob client when `VERCEL_BLOB_API_URL` points at this server.

Compatibility is tested with `@vercel/blob@2.4.0`.

Supported API:

- direct public blob reads with `fetch(blob.url)` and download reads with `fetch(blob.downloadUrl)`
- direct private blob `GET`, `HEAD`, and `downloadUrl` reads with `Authorization: Bearer <BLOB_READ_WRITE_TOKEN>`
- presigned private object `GET` and `HEAD`
- control-plane `head`
- `put`, including default no-overwrite behavior, `allowOverwrite`, `addRandomSuffix`, `ifMatch`, cache max age, and Vercel Blob-style `downloadUrl`
- presigned single-part `PUT`, including allowed content type, maximum size, overwrite, random suffix, cache max age, and `ifMatch` constraints
- multipart `put` via `{ multipart: true }`, with the same overwrite, suffix, and `ifMatch` behavior as regular `put`
- presigned multipart create, part upload, and complete
- `copy`, including `allowOverwrite`, `addRandomSuffix`, `ifMatch`, and copy-request metadata semantics
- `createFolder`
- `del`, including single-URL `ifMatch`
- presigned `DELETE /?pathname=...`, including `vercel-blob-if-match`
- `list`, including cursor pagination and `mode: 'folded'`
- `issueSignedToken()` and SDK-compatible local delegation/client signing tokens
- `presignUrl()` URLs for local `get`, `head`, `put`, multipart `put`, and `delete` workflows
- client-token uploads via `@vercel/blob/client.upload`
- client-token multipart uploads
- presigned browser uploads via `@vercel/blob/client.uploadPresigned`
- upload-completed callbacks through `handleUpload` and local presigned callback handling
- Vercel Blob-style JSON errors for common SDK error mapping

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

On startup, `local-blob` prints the control-plane URL, object-plane URL shape, and the environment variables to add to your app, for example:

```text
local-blob control plane listening on http://localhost:3000
local-blob object plane using http://localstore.<public|private>.localhost:3000/<pathname>
```

```dotenv
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_localstore_nonce
VERCEL_BLOB_API_URL=http://localhost:3000
```

Keep `VERCEL_BLOB_API_URL` pointed at the control plane. Blob write responses return object-plane URLs shaped like `http://<store-id>.<access>.localhost:<port>/<pathname>`.

## URL model

`local-blob` uses two local URL families:

| URL family | Shape | Purpose |
| --- | --- | --- |
| Control plane | `http://localhost:<port>` | SDK API calls such as `put`, `head`, `list`, `copy`, `del`, multipart, `issueSignedToken`, and presigned upload/delete control routes. |
| Object plane | `http://<store-id>.<access>.localhost:<port>/<pathname>` | Direct object `fetch`, private bearer reads, and presigned object `GET`/`HEAD`. |

Examples:

- `http://localstore.public.localhost:3000/avatar.png`
- `http://localstore.private.localhost:3000/documents/report.pdf`

`*.localhost` normally resolves to loopback in modern environments. If your HTTP client or test runner does not resolve wildcard localhost names, proxy the request to `localhost:<port>` while preserving the original object-plane host in the `Host` or `x-forwarded-host` header.

## Reading blobs locally

Use the object-plane URL returned by write commands and fetch it directly:

```js
import { put } from '@vercel/blob';

const blob = await put('hello.txt', 'Hello, World!', { access: 'public' });
// blob.url is similar to http://localstore.public.localhost:3000/hello.txt
const response = await fetch(blob.url);
const text = await response.text();
```

Use `blob.downloadUrl` for download-style local reads. It is `blob.url` with `?download=1` and returns `Content-Disposition: attachment; filename="..."`:

```js
const downloadResponse = await fetch(blob.downloadUrl);
```

### Private direct reads

Private writes return private-shaped object-plane URLs such as `http://localstore.private.localhost:3000/document.txt`. Direct private object `GET`, `HEAD`, and `downloadUrl` reads require the local read-write bearer token:

```js
const blob = await put('documents/report.txt', 'secret', {
  access: 'private',
});

const response = await fetch(blob.url, {
  headers: {
    Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
  },
});

const headResponse = await fetch(blob.url, {
  method: 'HEAD',
  headers: {
    Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
  },
});
```

Missing blobs return `404`; existing private blobs without valid bearer or presigned auth return `403`.

### SDK `get()` limitation

Do not use `@vercel/blob.get()` with the local emulator. `get(blob.url, ...)` rejects `localhost` URLs because they are not `*.blob.vercel-storage.com`, and `get('hello.txt', ...)` builds a production Vercel Blob URL rather than using `VERCEL_BLOB_API_URL`.

Recommended local workflow: use SDK control-plane helpers for writes/listing/metadata, then use direct `fetch(blob.url)` or a presigned local URL for object reads.

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

## Signed URLs locally

Use `issueSignedToken()` and `presignUrl()` against the local control plane. Local signed tokens support pathname scope, wildcard scope, operation scope, expiry, allowed content types, and maximum upload size.

### Presigned private read

```js
import { issueSignedToken, presignUrl } from '@vercel/blob';

const blob = await put('private/note.txt', 'secret', { access: 'private' });

const token = await issueSignedToken({
  pathname: blob.url,
  operations: ['get'],
});

const { presignedUrl } = await presignUrl(token, {
  operation: 'get',
  pathname: blob.url,
  access: 'private',
});

const response = await fetch(presignedUrl);
```

`HEAD` uses `operations: ['head']` and `operation: 'head'`. A `GET` signature cannot be replayed as `HEAD`, or vice versa.

### Presigned single-part upload

```js
const token = await issueSignedToken({
  pathname: 'uploads/file.txt',
  operations: ['put'],
  allowedContentTypes: ['text/plain'],
  maximumSizeInBytes: 1024 * 1024,
});

const { presignedUrl } = await presignUrl(token, {
  operation: 'put',
  pathname: 'uploads/file.txt',
  access: 'public',
  allowOverwrite: true,
  cacheControlMaxAge: 60,
});

const response = await fetch(presignedUrl, {
  method: 'PUT',
  headers: { 'content-type': 'text/plain' },
  body: 'hello',
});
const blob = await response.json();
```

Presigned PUT enforces delegation and URL-level content type and size constraints, overwrite behavior, random suffix, cache max age, and `ifMatch`.

### Presigned multipart upload

Presigned multipart uses the control-plane `/mpu` route and the same `put` operation signature. The SDK handles this automatically for `uploadPresigned(..., { multipart: true })`. Manual tests can also use the SDK multipart helpers once they have a presigned payload.

```js
import { uploadPresigned } from '@vercel/blob/client';

const blob = await uploadPresigned('videos/demo.txt', file, {
  access: 'public',
  handleUploadUrl: '/client-upload',
  multipart: true,
});
```

### Presigned delete

```js
const token = await issueSignedToken({
  pathname: 'uploads/file.txt',
  operations: ['delete'],
});

const { presignedUrl } = await presignUrl(token, {
  operation: 'delete',
  pathname: 'uploads/file.txt',
  access: 'public',
  ifMatch: currentEtag,
});

const response = await fetch(presignedUrl, { method: 'DELETE' });
```

A missing blob returns `404`; a stale `ifMatch` returns `412 precondition_failed`; invalid signatures or scope violations return `403 forbidden`.

## Browser uploads and callbacks

Two browser upload flows are supported locally:

| Flow | Client helper | Server route helper |
| --- | --- | --- |
| Client-token upload | `@vercel/blob/client.upload` | `handleUpload` |
| Presigned upload | `@vercel/blob/client.uploadPresigned` | local presigned generation handling compatible with `handleUploadPresigned` request bodies |

The built-in demo route at `/client-upload` supports both flows for local tests. It records upload-completed callbacks at `/client-upload-events`.

```js
import { uploadPresigned } from '@vercel/blob/client';

const blob = await uploadPresigned('avatar.txt', file, {
  access: 'public',
  handleUploadUrl: 'http://localhost:3000/client-upload',
  clientPayload: JSON.stringify({ userId: '123' }),
});
```

For presigned uploads, callback token payloads are round-tripped through the signed URL query and delivered to the local callback route. In the local demo route, the callback payload includes the pathname, client payload, and multipart flag.

## Compatibility matrix

| Feature | Local status | Notes |
| --- | --- | --- |
| Public `put` + direct fetch | Supported | Returns `.public.localhost` object URL. |
| Private `put` + bearer fetch | Supported | Private direct reads require read-write bearer auth. |
| Object `HEAD` | Supported | Public unauthenticated; private bearer or presigned auth. |
| Control-plane `head` | Supported | SDK metadata lookup remains through `VERCEL_BLOB_API_URL`. |
| `list`, `copy`, `createFolder`, `del` | Supported | Existing SDK compatibility preserved. |
| Multipart SDK upload | Supported | Includes overwrite, random suffix, and `ifMatch`. |
| `issueSignedToken()` | Supported | Local read-write bearer auth; OIDC is not emulated. |
| `presignUrl()` GET/HEAD | Supported | Use local object URLs for best compatibility. |
| `presignUrl()` PUT | Supported | Includes upload constraints and callbacks. |
| Presigned multipart | Supported | Used by `uploadPresigned(..., { multipart: true })`. |
| Presigned DELETE | Supported | Uses `DELETE /?pathname=...`. |
| `upload` / `handleUpload` | Supported | Client-token upload flow. |
| `uploadPresigned` | Supported | Single-part and multipart tested locally. |
| Upload-completed callbacks | Supported | Client-token callbacks are HMAC-signed; local presigned callbacks are delivered to the local route for app-test inspection. |
| `@vercel/blob.get()` | Not supported locally | `get(url)` rejects localhost; `get(pathname)` builds production URLs. Use direct `fetch`. |
| OIDC auth | Not supported | Use `BLOB_READ_WRITE_TOKEN` locally. |
| CDN/cache propagation semantics | Not supported | Local emulator only. |

## Error behavior

The emulator returns Vercel Blob-style JSON errors for common cases:

- `400 bad_request` for malformed requests and unsupported actions
- `403 forbidden` for missing/invalid bearer auth, invalid presigned signatures, expired presigned URLs, wrong operation, wrong pathname, or wrong store
- `404 not_found` for missing blobs
- `412 precondition_failed` for overwrite denial and stale `ifMatch`
- `500 unknown_error` for unexpected failures

## Known gaps

- `@vercel/blob.get(...)` is not supported against the local emulator. Use direct `fetch(blob.url)` or `fetch(presignedUrl)` instead.
- Real Vercel OIDC auth is not emulated; use local read-write bearer auth.
- Transparent interception of production `*.blob.vercel-storage.com` hosts is not supported.
- CDN behavior, propagation delays, regional storage behavior, billing semantics, and production cache invalidation are not emulated.
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
