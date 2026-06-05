# local-blob compatibility TODO issues

These are local implementation issues to feed into a Ralph loop. They are ordered to improve compatibility with `@vercel/blob` while keeping the package focused on a lightweight Node-only `npx local-blob` workflow.

## 1. Return Vercel Blob-style error responses

**Problem:** The emulator returns plain text or `null` for many failures. `@vercel/blob` expects JSON error bodies with stable error codes.

**Implement:**
- Add shared error response helper.
- Return bodies shaped like:
  ```json
  { "error": { "code": "not_found", "message": "The requested blob does not exist" } }
  ```
- Map local errors to SDK-known codes where possible: `bad_request`, `not_found`, `precondition_failed`, `forbidden`, `unknown_error`.

**Validate:** Real SDK calls should throw the expected Blob SDK error classes for common failures.

## 2. Enforce `allowOverwrite` for `put`

**Problem:** Production defaults to no overwrite. The emulator overwrites existing blobs unconditionally.

**Implement:**
- Read `x-allow-overwrite`.
- If target exists and overwrite is not allowed, return a client error compatible with SDK behavior.
- Preserve explicit overwrite when `x-allow-overwrite: 1`.

**Validate:**
- First `put()` succeeds.
- Second `put()` to same pathname fails by default.
- Second `put()` succeeds with `allowOverwrite: true`.

## 3. Enforce `ifMatch` preconditions

**Problem:** SDK sends `x-if-match` for optimistic concurrency. Emulator ignores it.

**Implement:**
- For `put`, `copy`, and single `del`, compare `x-if-match` to stored metadata `etag`.
- On mismatch, return `precondition_failed`.
- Ensure `ifMatch` permits overwrite only when ETag matches.

**Validate:** Matching ETag succeeds; stale or bogus ETag throws SDK precondition error.

## 4. Implement `addRandomSuffix`

**Problem:** SDK sends `x-add-random-suffix: 1`; emulator ignores it.

**Implement:**
- Apply random suffix before extension similarly to production expectations.
- Store and return the final pathname and URLs.
- Ensure `x-add-random-suffix: 0` preserves exact pathname.

**Validate:** `put('file.txt', ..., { addRandomSuffix: true })` returns a pathname different from `file.txt` but ending in `.txt`.

## 5. Fix `copy` metadata semantics

**Problem:** Production `copy()` does not preserve all source metadata unless supplied again. Emulator currently copies most source metadata.

**Implement:**
- Use source object bytes.
- Build new metadata from copy request headers/options.
- Respect `x-content-type`, `x-cache-control-max-age`, `x-vercel-blob-access`, `x-add-random-suffix`, `x-allow-overwrite`, and `x-if-match`.

**Validate:** Copied blob gets new metadata from copy options and does not accidentally retain overridden source metadata.

## 6. Make `createFolder()` compatible

**Problem:** `createFolder()` performs a `PUT` with a trailing slash pathname. Current pathname normalization rejects empty path segments and likely rejects `folder/`.

**Implement:**
- Allow trailing slash pathnames for folder placeholders.
- Persist valid metadata for folder objects.
- Ensure list/folded behavior remains stable.

**Validate:** `createFolder('foo/')` succeeds and returns `pathname: 'foo/'`.

## 7. Add real SDK compatibility tests

**Problem:** Existing tests hit HTTP endpoints directly. They do not fully exercise `@vercel/blob` client behavior.

**Implement:**
- Add Node tests that import real `@vercel/blob` commands.
- Cover `put`, `head`, `list`, `copy`, `del`, multipart upload, and `createFolder`.
- Keep tests local and deterministic.

**Validate:** `npm test` runs endpoint tests plus SDK compatibility tests.

## 8. Document unsupported `get(pathname, { access })`

**Problem:** SDK `get()` with a pathname constructs a real `*.blob.vercel-storage.com` URL instead of using `VERCEL_BLOB_API_URL`.

**Implement:**
- Document clearly in README.
- Recommend direct `fetch(blob.url)` for local emulator reads.
- Add a test or note showing `get(localReturnedUrl, ...)` behavior if usable, and pathname get limitation if not.

**Validate:** README has explicit local read guidance and no misleading `get(pathname)` examples.

## 9. Document and/or stub private/signed read behavior

**Problem:** `access: 'private'` is accepted locally but auth, signed URLs, cache bypass, and private read policies are not enforced.

**Implement:**
- Decide MVP behavior: either reject private access with a clear error or store it as metadata but document no enforcement.
- Prefer explicit README warning for now.
- Avoid pretending local private blobs are secure.

**Validate:** README explains private blob limitations clearly.

## 10. Document presigned upload gaps

**Problem:** Presigned URL flows and `handleUploadPresigned` are not implemented.

**Implement:**
- Add unsupported-feature documentation.
- Optionally return explicit `not_allowed`/`bad_request` for presigned-only paths if detected.

**Validate:** README lists presigned flows as unsupported, and emulator errors are explicit where possible.

## Ralph loop suggested stop condition

Stop when:
- All 10 issues are implemented or explicitly documented as out-of-scope for MVP.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` contains only intended publish files.
- README accurately describes supported and unsupported compatibility.
