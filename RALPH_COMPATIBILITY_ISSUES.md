# Ralph Compatibility Issues: Vercel Blob SDK

Tracker for the next Ralph loop. Goal: tighten `local-blob` compatibility with the cloned Vercel storage/blob package in `.repos/vercel-storage`, especially real `@vercel/blob@2.4.0` SDK behavior.

## Direction

Work in compatibility slices. Prefer proving behavior with real SDK integration tests first, then implementation. When Vercel behavior is unclear, inspect `.repos/vercel-storage/packages/blob/src` and relevant tests before deciding. Do not guess.

## Constraints

- No new runtime dependencies unless explicitly justified and approved.
- Keep the emulator a lightweight Node-only MVP.
- Do not implement full presigned URL flows or private/signed read enforcement in this loop.
- Keep unsupported behavior explicit in README and errors.
- Use real `@vercel/blob` SDK tests where possible.

## Validation

Run before marking complete:

```sh
npm test
npm run build
npm pack --dry-run
```

## Issues

### 1. Multipart default no-overwrite compatibility

**Status:** Done in iteration 1.

**Problem:** `put(pathname, body, { multipart: true })` routes through `/mpu`, but multipart completion currently overwrites existing blobs unconditionally.

**Expected:** Match regular `put`: if destination exists and neither `allowOverwrite: true` nor valid `ifMatch` is supplied, SDK should receive `BlobPreconditionFailedError`.

**Done when:** Real SDK test proves duplicate multipart put fails by default.

**Validation:** `real SDK multipart put enforces overwrite options` covers duplicate multipart failure via `BlobPreconditionFailedError`.

---

### 2. Multipart `allowOverwrite: true`

**Status:** Done in iteration 1.

**Problem:** Multipart ignores `x-allow-overwrite`.

**Expected:** Multipart completion overwrites existing blob only when `x-allow-overwrite: 1` or valid `ifMatch` allows it.

**Done when:** Real SDK test proves multipart overwrite succeeds with `allowOverwrite: true` and content changes.

**Validation:** `real SDK multipart put enforces overwrite options` covers `allowOverwrite: true` and verifies content changes.

---

### 3. Multipart `ifMatch`

**Status:** Done in iteration 2.

**Problem:** Multipart ignores `x-if-match`.

**Expected:** Multipart completion validates destination ETag before writing. Mismatch/missing target returns Vercel Blob-style `precondition_failed` JSON so SDK maps to `BlobPreconditionFailedError`.

**Done when:** Real SDK tests prove stale multipart `ifMatch` fails and current ETag succeeds.

**Validation:** `real SDK multipart put enforces ifMatch` covers stale ETag failure, unchanged stale-write content, and current ETag success.

---

### 4. Multipart `addRandomSuffix`

**Status:** Done in iteration 3.

**Problem:** Multipart create/complete does not apply `x-add-random-suffix`.

**Expected:** Match Vercel as closely as possible. Inspect `.repos/vercel-storage` if needed. Final returned pathname/url/downloadUrl should use the suffixed pathname, and all multipart stages should agree on the same final pathname.

**Done when:** Real SDK test proves multipart `addRandomSuffix: true` returns a different pathname ending with the original extension and the blob is fetchable.

**Validation:** `real SDK multipart put applies addRandomSuffix consistently` covers uncontrolled multipart `put(..., { multipart: true, addRandomSuffix: true })` returning/fetching a suffixed pathname.

---

### 5. Multipart pathname/key consistency

**Status:** Done in iteration 3 for pathname/key consistency needed by suffixing.

**Problem:** Multipart currently uses the requested pathname as `key`, and completion recomputes pathname from the request. This can break once suffixing/preconditions are introduced.

**Expected:** Store multipart session metadata at create time including requested pathname, final pathname, key, relevant headers/options, and use that metadata consistently during upload/complete.

**Done when:** Multipart create/upload/complete tests cover out-of-order parts, suffixed paths, and final metadata correctness.

**Validation:** Existing manual multipart test covers out-of-order completion. `real SDK multipart put applies addRandomSuffix consistently` covers create-time suffixed key, upload/complete using that key, final pathname matching the session key, and fetchable completed content.

---

### 6. `downloadUrl` behavior matches Vercel as closely as practical

**Status:** Done in iteration 4.

**Problem:** Current `downloadUrl` behavior feels accidental and should be verified rather than assumed.

**Expected:** Inspect Vercel package/docs/tests and implement the closest local equivalent. Keep `downloadUrl = url + ?download=1`, ensure it is fetchable locally, and ensure direct fetch of `downloadUrl` returns appropriate download headers/content disposition.

**Done when:** Tests assert `downloadUrl` returned by `put`, `copy`, and multipart is fetchable and exposes download-style behavior matching Vercel as closely as local emulator can.

**Validation:** `downloadUrl is fetchable and forces attachment disposition` covers returned `downloadUrl` from `put`, `copy`, and multipart. It verifies `?download=1`, fetchability, bytes, and `Content-Disposition: attachment; filename="..."`.

---

### 7. SDK compatibility tests for all fixed slices

**Status:** Done for the compatibility slices fixed so far. Iteration 1 added real SDK coverage for multipart default no-overwrite and `allowOverwrite: true`. Iteration 2 added real SDK coverage for multipart `ifMatch`. Iteration 3 added real SDK coverage for multipart `addRandomSuffix` and session pathname/key consistency. Iteration 4 added `downloadUrl` coverage for `put`, `copy`, and multipart.

**Problem:** Existing tests cover many SDK paths but not multipart overwrite/precondition/suffix/downloadUrl edge cases.

**Expected:** Add focused integration tests using real `@vercel/blob` imports.

**Done when:** Tests fail before fixes and pass after fixes.

---

### 8. README accuracy after compatibility fixes

**Status:** Done in iteration 5.

**Problem:** README must reflect supported and unsupported compatibility clearly.

**Expected:** Update supported API/gaps/read guidance after code changes. Keep presigned and private enforcement limitations explicit.

**Done when:** README matches behavior proven by tests.

**Validation:** README now lists multipart overwrite/`addRandomSuffix`/`ifMatch`, copy and delete `ifMatch`, Vercel Blob-style errors, direct `blob.url` reads, and `blob.downloadUrl` attachment behavior while preserving `get()`, presigned, and private-read limitations.

## Completion Criteria

**Status:** Done in iteration 5. All issues above are fixed or documented as unsupported, README is updated, and validation passed.

Mark loop complete only when all issues above are fixed or explicitly documented as out of scope, and all validation commands pass.
