# Private Blobs and Presigned URLs ARD

Research date: 2026-06-12

ARD means Architecture Requirements and Decisions for this upgrade. It complements the PRD by mapping the Vercel Blob protocol to `local-blob` modules, handlers, tests, and implementation phases.

## Research Summary

Official Vercel docs now describe private storage and signed URLs as first-class Blob features:

- Private Blob stores require authentication for all reads and writes. Private blob object URLs use `https://<store-id>.private.blob.vercel-storage.com/<pathname>` and can be fetched with `get()` or a direct bearer token request.
- Public Blob stores keep unauthenticated object URL reads.
- Vercel Signed URLs use `issueSignedToken()` to obtain delegation material, then `presignUrl()` to sign concrete `get`, `head`, `put`, or `delete` URLs.
- Presigned `get` and `head` use object URLs. Presigned `put`, multipart upload, and delete use control-plane URLs.
- `handleUploadPresigned()` and `uploadPresigned()` are the presigned counterparts to the current client-token upload flow.

The SDK source checkout adds protocol specifics not fully visible in the high-level docs:

- Delegation operations are `get`, `head`, `put`, and `delete`.
- Delegation tokens encode store ID, owner ID, pathname scope, allowed operations, expiry, issue time, and optional upload constraints.
- The client signing token is derived from the store signing secret and delegation token.
- The presigned URL signature is an HMAC over a canonical string containing operation, pathname, and selected `vercel-blob-*` query constraints.
- Canonical query keys include valid-until, maximum size, allowed content types, random suffix, overwrite, cache max age, `ifMatch`, callback URL, and callback token payload.
- `presignUrl()` accepts full URL strings for object reads, but the canonical pathname scope must match whatever was embedded in the delegation token.
- The SDK's `get()` helper builds production object URLs from pathnames and rejects arbitrary non-`.blob.vercel-storage.com` URL hosts.

## Current Local Architecture

The repo already has the lightweight context and middleware foundation described in `docs/dev-review-middleware.md`.

Current request flow:

- The server converts Node HTTP requests into Web `Request` objects.
- A `BlobContext` carries the URL and request into handlers.
- Handlers expose `test(ctx)` and `handle(ctx)`.
- A middleware runner can prepare context before handlers run.
- Blobs and sidecar metadata are stored on disk.

Current behavior to preserve:

- Public/local direct object fetches.
- `head`, `put`, multipart `put`, manual multipart, `copy`, `createFolder`, `del`, `list`.
- Existing overwrite, random suffix, `ifMatch`, folded listing, Vercel-style JSON error, and callback behavior.
- Existing client-token upload flow through `handleUpload`.

Current behavior to replace:

- Global rejection of `vercel-blob-delegation` and `vercel-blob-signature`.
- Metadata-only private blobs.
- Unsupported `handleUploadPresigned`, `uploadPresigned`, and `presignUrl()` flows.

## Architectural Goals

- Preserve current public Blob compatibility.
- Enforce private reads locally.
- Support Vercel Signed URL protocol locally.
- Keep handler behavior storage-focused.
- Centralize auth, presign, local URL, and token logic in deep modules.
- Test protocol logic in isolation and handler behavior through public HTTP/SDK flows.
- Make local behavior honest where the stock SDK cannot be redirected to localhost by environment variables alone.

## Non-Goals

- Replacing the server framework.
- Emulating Vercel CDN caching, regional storage, billing, or propagation delay.
- Emulating OIDC in the first implementation.
- Supporting transparent production host interception.
- Migrating existing local object storage.

## Recommended Local URL Model

Use two URL families:

- Control plane: `http://localhost:<port>`
- Object plane: `http://<store-id>.<access>.localhost:<port>/<pathname>`

Examples:

- `http://localstore.public.localhost:3000/avatar.png`
- `http://localstore.private.localhost:3000/documents/report.pdf`

Reasons:

- Mirrors production object host shape closely.
- Keeps public and private object reads distinguishable at the URL level.
- Works locally because `*.localhost` resolves to the loopback interface in modern environments.
- Keeps `VERCEL_BLOB_API_URL` dedicated to SDK control-plane calls.

Compatibility caveat:

- Stock `@vercel/blob.get(pathname, { access })` constructs production object URLs and does not use `VERCEL_BLOB_API_URL`.
- Stock `@vercel/blob.get(url, ...)` rejects local object URLs because the host is not `*.blob.vercel-storage.com`.
- Therefore the first implementation should support direct fetches and presigned URLs against local object URLs, while documenting that full stock `get()` support needs a companion SDK-local mode or shim.

## Deep Modules To Add Or Expand

### Local Configuration

Responsibilities:

- Resolve port, store path, read-write token, store ID, owner ID, and signing secret.
- Normalize `store_`-prefixed and bare store IDs.
- Provide stable defaults for local development.
- Keep startup output aligned with supported environment variables.

Recommended defaults:

- Continue default token: `vercel_blob_rw_localstore_nonce`.
- Resolve bare local store ID to `localstore` from the default token.
- Use a deterministic local signing secret derived from the read-write token unless an explicit internal env var is added later.

### Local URL Helpers

Responsibilities:

- Construct object URLs for public and private blobs.
- Parse object host access and store ID.
- Parse pathnames safely from object and control-plane requests.
- Decide whether a request is object-plane or control-plane.

Public interface shape:

- `objectUrl(access, pathname): string`
- `parseObjectRequest(url): { storeId, access, pathname } | null`
- `isControlPlaneRequest(url): boolean`

### Auth Context

Responsibilities:

- Parse `Authorization: Bearer ...`.
- Validate read-write bearer tokens against local config.
- Recognize client tokens for existing upload callback behavior.
- Attach auth state to request context.

Public interface shape:

- `withBearerAuth(optional | required)`
- `hasReadWriteAccess(ctx): boolean`
- `bearerTokenFromRequest(request): string | null`

### Signed Token Service

Responsibilities:

- Implement local `POST /signed-token`.
- Validate read-write auth.
- Accept `pathname`, `operations`, `validUntil`, `allowedContentTypes`, and `maximumSizeInBytes`.
- Apply production-like defaults: wildcard pathname, `get` operation, one-hour expiry.
- Apply production-like limits: future expiry and maximum seven-day lifetime.
- Return `delegationToken`, `clientSigningToken`, and `validUntil`.

Public interface shape:

- `issueLocalSignedToken(options): IssuedSignedToken`
- `decodeDelegationToken(token): DelegationPayload`
- `verifyDelegationToken(token): DelegationPayload`

### Presign Verification

Responsibilities:

- Detect `vercel-blob-delegation` and `vercel-blob-signature`.
- Verify delegation token signature.
- Derive client signing token.
- Resolve expected operation from method and route.
- Rebuild canonical query entries from the incoming URL.
- Verify the URL signature.
- Validate delegation expiry and URL-level expiry.
- Validate store ID and pathname scope.
- Validate upload constraints before mutation.
- Attach presign state to context.

Public interface shape:

- `withPresignedVerification(operation)`
- `presignContextFromRequest(ctx, operation): PresignContext`
- `assertPresignedUploadConstraints(ctx, bodyMetadata)`

### Write Options Normalization

Responsibilities:

- Convert normal SDK headers and presigned query constraints into one upload-options object.
- Feed existing write, copy, multipart complete, and callback behavior from the same normalized options.

Public interface shape:

- `resolveWriteOptions(ctx): WriteOptions`
- `headersForWriteOptions(options): Headers`

This prevents regular writes and presigned writes from diverging.

### Private Read Guard

Responsibilities:

- Load blob metadata.
- Allow unauthenticated reads for public blobs.
- Require read-write bearer auth or valid presigned auth for private blobs.
- Preserve `404` for missing blobs.
- Return `403` for forbidden private access.

Public interface shape:

- `withPrivateReadAccess`
- `authorizeBlobRead(ctx, metadata, operation)`

## Handler Mapping

### Object `GET`

Current route: `GET /<pathname>` without `url` query.

New behavior:

- Parse object host and pathname.
- Load metadata and object bytes.
- Enforce private read guard.
- For presigned URLs, verify `get` operation before returning bytes.
- Preserve `download=1` content disposition behavior.
- Preserve `If-None-Match` behavior.

### Object `HEAD`

New route: `HEAD /<pathname>`.

Behavior:

- Share metadata lookup and private read guard with object `GET`.
- Verify `head` operation for presigned URLs.
- Return headers only.
- Do not route this through current control-plane `head` JSON behavior.

### Control-Plane `head`

Current route: `GET /?url=...`.

Behavior:

- Preserve current SDK `head` behavior.
- Enforce bearer auth consistently when auth enforcement is introduced.
- Do not require private object read logic because this is an authenticated control-plane metadata operation.

### Control-Plane `PUT`

Current route: `PUT /?pathname=...` or `PUT /<pathname>`.

New behavior:

- Accept read-write bearer auth or valid presigned `put`.
- Remove global presigned rejection.
- Normalize write options from headers or presigned query params.
- Enforce content type, max size, overwrite, random suffix, cache max age, and `ifMatch`.
- Return object URLs using the local object URL model.

### Multipart `POST /mpu`

Current route: `POST /mpu` with `x-mpu-action`.

New behavior:

- Accept read-write bearer auth or valid presigned `put`.
- Verify presigned `put` for create, part upload, and complete.
- Carry normalized write options from create through complete.
- Enforce final overwrite, size, content type, and callback behavior.

### Control-Plane `DELETE /?pathname=...`

New route for presigned delete.

Behavior:

- Require valid presigned `delete`.
- Apply URL-level `ifMatch` if present.
- Delete one scoped blob.

### Existing SDK Delete

Current route: `POST /delete`.

Behavior:

- Preserve existing `del()` compatibility.
- Enforce read-write bearer auth when auth enforcement is introduced.
- Keep multi-delete support for bearer-auth SDK calls.

### Client Upload Handler

Current route: local test helper for `handleUpload`.

New behavior:

- Preserve current client-token tests.
- Add presigned generation handling instead of returning unsupported error.
- Exercise `handleUploadPresigned()` in tests with a local callback route.

## Protocol Verification Details

### Delegation Token

Local token format should match SDK tests:

- Payload JSON is base64url encoded.
- Signature is `HMAC-SHA256(localSigningSecret, payloadSegment)` in base64url.
- Token is `<payloadSegment>.<signature>`.

Payload fields:

- `storeId`
- `ownerId`
- `pathname`
- `operations`
- `validUntil`
- `iat`
- `maximumSizeInBytes`, optional
- `allowedContentTypes`, optional

### Client Signing Token

Derive as:

- `HMAC-SHA256(localSigningSecret, delegationToken)` in base64url.

### Presigned URL Signature

Verify as:

- Resolve operation from route and method.
- Build canonical lines for `operation=<operation>`, `pathname=<delegation-scoped value>`, and signed canonical query keys present in the request.
- Sort lines by UTF-8 byte order.
- Join with newline.
- Verify `HMAC-SHA256(clientSigningToken, canonicalString)` matches `vercel-blob-signature`.

Canonical query keys:

- `vercel-blob-add-random-suffix`
- `vercel-blob-allow-overwrite`
- `vercel-blob-allowed-content-types`
- `vercel-blob-cache-control-max-age`
- `vercel-blob-callback-token-payload`
- `vercel-blob-callback-url`
- `vercel-blob-if-match`
- `vercel-blob-maximum-size-in-bytes`
- `vercel-blob-valid-until`

### Pathname Scope

For normal pathname scopes:

- Delegation `pathname: "*"` allows any pathname.
- Otherwise request pathname must exactly match delegation `pathname`.

For local explicit URL scopes:

- Preserve support for signing a full local object URL as the `pathname` value, because the SDK supports full URL strings for object presigning.
- Verification must canonicalize using the exact same value that was signed, not a lossy normalized path.

This area needs careful tests because it affects local presigned object reads.

## Implementation Phases

### Phase 1: Baseline And Guardrails

- Confirm current middleware/context conversion is intentional and covered by tests.
- Add focused public-regression tests for current supported flows.
- Remove or move the global presigned rejection behind future presign verification tests.

Risk: low. This is mostly test and routing setup.

### Phase 2: Local Config And URL Model

- Add store ID resolution.
- Add local object URL construction.
- Return access-qualified object URLs from writes.
- Teach server request parsing to accept `*.localhost` hosts.
- Update README startup output and examples.

Risk: medium. Returned URL shape changes can affect tests and users.

Review decision needed: apply access-qualified local URLs to all blobs, or only private blobs. Recommendation: all blobs.

### Phase 3: Bearer Auth And Private Read Enforcement

- Add auth context.
- Enforce private object `GET` and `HEAD`.
- Preserve public unauthenticated reads.
- Add private direct bearer fetch tests.
- Preserve current control-plane SDK behavior.

Risk: medium. This is the first behavior/security change.

### Phase 4: Signed Token Endpoint

- Implement `POST /signed-token`.
- Validate local read-write auth.
- Issue local delegation tokens and client signing tokens.
- Add unit tests against SDK-compatible helpers.
- Add SDK integration test for `issueSignedToken()`.

Risk: medium. Correct token shape is essential for later phases.

### Phase 5: Presigned Verification Core

- Add presign parsing and verification middleware.
- Port canonical query and canonical string logic from SDK contract.
- Add negative tests for tampering, expiry, operation mismatch, and path mismatch.

Risk: high. This is security-sensitive and should be heavily unit tested.

### Phase 6: Presigned Object Reads

- Support presigned `GET`.
- Support presigned `HEAD`.
- Add tests for full local URL presigning and pathname presigning limitations.
- Document stock SDK `get()` behavior clearly.

Risk: medium. Most complexity is URL compatibility.

### Phase 7: Presigned Single-Part Writes

- Support presigned `PUT`.
- Normalize query constraints into write options.
- Enforce content type, max size, suffix, overwrite, cache max age, and `ifMatch`.
- Add positive and negative SDK/fetch tests.

Risk: high. This changes mutation behavior and must share logic with normal writes.

### Phase 8: Presigned Multipart Writes

- Support presigned `POST /mpu`.
- Persist write constraints from create to complete.
- Enforce final size/content/overwrite conditions.
- Add `uploadPresigned(..., { multipart: true })` tests.

Risk: high. Multipart has multi-step state and callback timing.

### Phase 9: Presigned Delete

- Add `DELETE /?pathname=...`.
- Verify `delete` operation.
- Enforce `ifMatch`.
- Preserve existing `POST /delete` behavior.

Risk: medium. Destructive route, but scoped.

### Phase 10: Presigned Upload Helper And Callbacks

- Support `handleUploadPresigned()` request bodies in the local client-upload test handler or a dedicated route.
- Verify callback signatures using local test key material or configured webhook public key.
- Ensure callback token payloads round-trip.
- Add README guidance for local callback behavior.

Risk: high. This crosses SDK helper behavior, local callback delivery, and signature verification.

### Phase 11: Docs And Compatibility Matrix

- Update README supported API and known gaps.
- Add examples for private direct fetch, signed read, signed upload, multipart signed upload, and signed delete.
- Document the `get()` local compatibility limitation and recommended local workflows.

Risk: low, but necessary before release.

## Test Plan

Unit tests:

- Store ID parsing.
- Local object URL construction and parsing.
- Bearer token parsing and validation.
- Delegation token creation and verification.
- Client signing token derivation.
- Canonical presign string construction.
- Presign query validation.
- Upload option normalization.

Integration tests:

- Public direct read remains unauthenticated.
- Private direct read without auth returns `403`.
- Private direct read with bearer auth returns bytes.
- Private object `HEAD` auth behavior.
- Conditional private object read returns `304`.
- `issueSignedToken()` returns SDK-usable token material.
- Presigned `GET`, `HEAD`, `PUT`, multipart upload, and `DELETE`.
- `uploadPresigned()` single and multipart.
- `handleUploadPresigned()` callback path.
- Regression suite for existing `put`, `copy`, `del`, `list`, multipart, and client-token upload flows.

Negative tests:

- Missing bearer token for private object read.
- Wrong bearer token.
- Expired delegation.
- Expired URL.
- Wrong operation.
- Wrong pathname.
- Wrong store ID.
- Tampered signed query value.
- Missing signature.
- Missing delegation.
- Oversized upload.
- Disallowed content type.
- Overwrite denied.
- `ifMatch` mismatch.
- Malformed delegation payload.

## Open Review Questions

1. Should the first release change returned URLs for all blobs to `http://<store-id>.<access>.localhost:<port>/...`, or only for private blobs?
2. Should full stock `@vercel/blob.get(pathname, { access })` compatibility be part of this upgrade, or should it be a later SDK-local-mode project?
3. Should the local signing secret be derived from `BLOB_READ_WRITE_TOKEN`, or should we add an explicit hidden/internal signing-secret env var for deterministic tests?
4. Should local `POST /signed-token` accept only read-write bearer auth, or should it also emulate OIDC plus `BLOB_STORE_ID`?
5. Should wildcard delegation scopes be supported in the first implementation, or held until exact-path flows pass?
6. Should private metadata be enforced for control-plane `head`, `list`, `copy`, and `del` immediately through bearer auth, or should the first behavior change focus only on object reads and presigned routes?
7. How much production error-body fidelity do we need before calling the feature complete?

## Recommended Decisions

- Use access-qualified local object URLs for both public and private blobs.
- Keep `VERCEL_BLOB_API_URL` as control plane only.
- Support direct fetch and presigned local object URLs in the first release.
- Defer full stock `get(pathname, { access })` compatibility unless we are willing to add an SDK shim or patch.
- Derive local signing secret from the configured read-write token for deterministic local behavior.
- Implement read-write bearer auth and presigned auth first; defer OIDC.
- Support wildcard scope from the start because the SDK and docs expose it, but test exact-path scope more heavily.
- Centralize write-option normalization before adding presigned writes.

## Release Criteria

- Existing integration tests pass.
- New private read tests pass.
- New signed-token and presign unit tests pass.
- SDK `issueSignedToken()` works against local control plane.
- Presigned `GET`, `HEAD`, `PUT`, multipart upload, and `DELETE` work through HTTP/fetch tests.
- `uploadPresigned()` works for single and multipart local uploads.
- README documents supported flows, env setup, URL shape, and remaining SDK limitations.

## References

- Private Storage docs: https://vercel.com/docs/vercel-blob/private-storage
- Vercel Signed URLs docs: https://vercel.com/docs/vercel-blob/vercel-signed-urls
- Blob SDK docs: https://vercel.com/docs/vercel-blob/using-blob-sdk
- SDK source contract files: `.repos/vercel-storage/packages/blob/src/signed-token.ts`, `.repos/vercel-storage/packages/blob/src/presign-query-params.ts`, `.repos/vercel-storage/packages/blob/src/get.ts`, `.repos/vercel-storage/packages/blob/src/client.ts`
- Existing design note: `docs/dev-review-middleware.md`
