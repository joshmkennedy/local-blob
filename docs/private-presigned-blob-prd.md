# Private Blobs and Presigned URLs PRD

Research date: 2026-06-12

## Problem Statement

`local-blob` is useful for public Vercel Blob workflows, but it does not yet model the security and URL flows now expected by private Blob stores and Vercel Signed URLs. Developers can currently write `access: 'private'` metadata locally, but local object reads are still unauthenticated, presigned query parameters are rejected, and browser-to-blob presigned upload helpers cannot be exercised against the emulator.

This creates a gap between local development and production for applications that use private documents, authenticated media delivery, time-limited sharing, direct browser uploads, multipart uploads, conditional writes, and upload-completed callbacks.

## Solution

Build full local protocol support for private Blob and signed URL workflows while preserving the current public Blob behavior. The emulator should validate local read-write bearer tokens, enforce private read access, issue local signed-token material, verify presigned URL signatures, and route presigned `GET`, `HEAD`, `PUT`, multipart `POST /mpu`, and `DELETE` requests to the existing disk-backed storage handlers.

The initial scope should target protocol fidelity with the current `@vercel/blob` SDK and official Vercel Blob docs. Where the stock SDK constructs production object hosts that cannot be redirected by `VERCEL_BLOB_API_URL`, the emulator should make that limitation explicit and provide a deliberate local compatibility strategy instead of silently pretending unsupported flows work.

## User Stories

1. As a developer using private Blob stores, I want local private blob reads to require authentication, so that local tests catch accidental public exposure.
2. As a developer using public Blob stores, I want existing public reads to keep working without tokens, so that the upgrade does not break current projects.
3. As a developer using server-side `put`, I want `access: 'private'` writes to return private-shaped local object URLs, so that local data resembles production data.
4. As a developer using server-side `put`, I want `access: 'public'` writes to return public-shaped local object URLs, so that public blob behavior remains easy to inspect.
5. As a developer using direct `fetch(blob.url)`, I want public blob URLs to fetch without authorization, so that existing public media workflows keep working.
6. As a developer using direct `fetch(blob.url)`, I want private blob URLs to return `403` without valid authorization, so that private access mistakes surface locally.
7. As a developer using direct authenticated fetches, I want `Authorization: Bearer <BLOB_READ_WRITE_TOKEN>` to read private blobs, so that production-style private object access can be tested.
8. As a developer using conditional private reads, I want `If-None-Match` to return `304` when the local ETag matches, so that browser cache behavior can be tested.
9. As a developer using `downloadUrl`, I want private download URLs to enforce the same auth rules as private normal URLs, so that downloads are not a bypass.
10. As a developer using SDK `head`, I want existing control-plane metadata lookup to continue working, so that current tests and workflows stay stable.
11. As a developer using object `HEAD`, I want private object headers to require auth or a valid presigned URL, so that metadata inspection follows production access rules.
12. As a developer using object `HEAD`, I want public object headers to remain available without auth, so that public asset checks remain simple.
13. As a developer issuing signed URLs, I want `issueSignedToken()` to work locally through `POST /signed-token`, so that server routes can mint local delegation material.
14. As a developer issuing signed URLs, I want local signed tokens to support pathname scope, wildcard scope, operation scope, expiry, content type limits, and size limits, so that local authorization matches production intent.
15. As a developer issuing signed URLs, I want expired signed tokens to be rejected locally, so that stale sharing links fail during development.
16. As a developer issuing signed URLs, I want tokens scoped to one pathname to fail against another pathname, so that access leaks are caught.
17. As a developer using presigned `GET`, I want a valid signed URL to fetch a private blob without a bearer token, so that time-limited private sharing can be tested.
18. As a developer using presigned `GET`, I want a tampered signature to return `403`, so that signature validation is meaningful.
19. As a developer using presigned `GET`, I want an expired URL-level expiry to return `403`, so that short-lived URLs are enforced.
20. As a developer using presigned `HEAD`, I want `HEAD` signatures to be distinct from `GET` signatures, so that operation replay does not pass.
21. As a developer using presigned `PUT`, I want a valid presigned upload URL to write a blob without a bearer token, so that browser and third-party upload flows can be tested.
22. As a developer using presigned `PUT`, I want allowed content types to be enforced from both delegation and URL constraints, so that local validation matches production safety controls.
23. As a developer using presigned `PUT`, I want maximum upload size to be enforced, so that oversized uploads fail locally before production.
24. As a developer using presigned `PUT`, I want `allowOverwrite`, `addRandomSuffix`, `cacheControlMaxAge`, and `ifMatch` query constraints to map to the same behavior as normal writes, so that presigned writes are not a separate behavior path.
25. As a developer using presigned `DELETE`, I want a signed delete URL to delete one scoped blob, so that delegated deletion can be tested without a read-write token.
26. As a developer using presigned `DELETE`, I want `ifMatch` to prevent deleting a changed blob, so that optimistic concurrency applies to destructive delegated operations.
27. As a developer using multipart uploads, I want presigned multipart create, part upload, and complete calls to work with the existing local multipart storage, so that large direct uploads can be tested.
28. As a developer using multipart uploads, I want presigned multipart completion to enforce overwrite and conditional-write rules at completion, so that multipart semantics match normal uploads.
29. As a developer using `uploadPresigned`, I want the browser helper to request a presigned URL from my route and upload to `local-blob`, so that I can test modern client upload flows locally.
30. As a developer using `handleUploadPresigned`, I want upload-completed callbacks to be delivered and verifiable locally, so that database update code can be exercised.
31. As a developer using callbacks, I want callback token payloads to round-trip unchanged, so that application-specific upload metadata works locally.
32. As a developer running integration tests, I want deterministic local signing helpers, so that signature tests are stable.
33. As a maintainer, I want clear error responses for forbidden, bad request, not found, and precondition failed cases, so that SDK error mapping remains useful.
34. As a maintainer, I want the current disk layout to remain compatible, so that existing local stores do not need migration for this upgrade.
35. As a maintainer, I want shared auth and presign validation to live behind narrow testable interfaces, so that handlers do not each reimplement security rules.
36. As a maintainer, I want public behavior covered by regression tests, so that private support does not regress the current package.
37. As a maintainer, I want docs to explain any SDK host-routing limitation, so that users understand which flows require local URLs or a companion SDK strategy.

## Implementation Decisions

- Treat private and presigned support as protocol emulation, not a storage rewrite.
- Keep the existing Web `Request` and `Response` handler model.
- Use the existing middleware/context foundation for auth, presign parsing, pathname extraction, and private read checks.
- Keep blob persistence, metadata writing, listing, copying, deletion, and multipart assembly in handlers and helper modules.
- Add a local token/signing module that owns store ID resolution, local read-write token validation, delegation token creation, client signing token derivation, and signature verification.
- Add a local URL module that owns object URL construction and parsing for control-plane routes, public object hosts, and private object hosts.
- Prefer `http://<store-id>.<access>.localhost:<port>/<pathname>` for local object URLs because `*.localhost` resolves locally and mirrors production host shape.
- Keep `VERCEL_BLOB_API_URL` pointed at the control-plane origin such as `http://localhost:<port>`.
- Use the local read-write token as the root credential for local bearer auth and local signing secret derivation.
- Use the default local token's embedded store ID when possible; expose a clear fallback/default store ID for tokens that do not encode one.
- Implement `POST /signed-token` with local read-write bearer auth first; OIDC emulation is out of scope unless a later need appears.
- Verify presigned requests by validating the delegation token, operation, pathname scope, URL-level constraints, and HMAC signature before reaching storage mutation.
- Map presigned upload query constraints into request context or synthetic headers so existing write paths keep one source of behavior.
- Make private read enforcement metadata-driven: public metadata permits unauthenticated object reads, private metadata requires bearer or valid presigned authorization.
- Support presigned `DELETE /?pathname=...` in addition to the current SDK delete route.
- Preserve the existing client-token upload flow while adding presigned upload flow support separately.
- Do not attempt to spoof production `*.blob.vercel-storage.com` hosts from this package alone.
- Document the stock SDK limitation: `get(pathname, { access })` constructs production object URLs, and `get(url, ...)` rejects non-Vercel hosts. Solving that requires an SDK-local mode, a shim, or an application-level local URL strategy.

## Testing Decisions

- Test external behavior through the SDK and HTTP requests, not middleware implementation details.
- Keep current integration coverage as the public-behavior regression suite.
- Add targeted unit tests for token issuance, delegation token verification, canonical presign string verification, query constraint parsing, store ID parsing, and local object URL parsing.
- Add integration tests for unauthenticated public reads, unauthenticated private read denial, bearer-auth private reads, direct private `HEAD`, and conditional private reads.
- Add integration tests for `issueSignedToken()` against the local control plane.
- Add integration tests for presigned `GET`, `HEAD`, `PUT`, multipart `POST /mpu`, and `DELETE`.
- Add negative tests for expired delegation tokens, expired URL constraints, wrong operation, wrong pathname, wrong store ID, tampered query parameter, tampered signature, oversized body, disallowed content type, overwrite denial, and ETag mismatch.
- Add browser-helper-level integration for `uploadPresigned` and server-helper-level integration for `handleUploadPresigned`.
- Use the Vercel Blob SDK source contract tests as prior art for canonical signing and URL shape.
- Keep callback tests local and deterministic by using a local callback endpoint and generated key material where webhook public key verification is required.

## Out of Scope

- Production-grade cryptographic key management beyond local emulation.
- Real Vercel OIDC auth emulation.
- Multi-store isolation on disk.
- CDN behavior, propagation delays, regional behavior, billing semantics, and cache invalidation timing.
- Transparent interception of production `*.blob.vercel-storage.com` URLs.
- A full alternate SDK implementation.
- Changing the package runtime to Hono, Express, Fastify, Bun, or Docker.
- Reworking the existing on-disk object layout unless a specific compatibility bug requires it.

## Further Notes

Relevant current references:

- Vercel Private Storage docs: https://vercel.com/docs/vercel-blob/private-storage
- Vercel Signed URLs docs: https://vercel.com/docs/vercel-blob/vercel-signed-urls
- Vercel Blob SDK docs: https://vercel.com/docs/vercel-blob/using-blob-sdk
- Local source checkout used for SDK contract research: `.repos/vercel-storage/packages/blob/src`
- Existing middleware review: `docs/dev-review-middleware.md`

The most important review question is how far the first release should go on stock `@vercel/blob.get()` compatibility. The emulator can support local private object URLs and presigned URLs, but the stock SDK's private `get(pathname, { access })` path currently builds production object URLs instead of honoring `VERCEL_BLOB_API_URL`.
