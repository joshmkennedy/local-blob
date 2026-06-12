# Dev Review: Middleware Conversion

## Context

`local-blob` currently uses a small handler model:

- `src/server.ts` converts Node `IncomingMessage` objects into Web `Request` objects.
- It imports handlers from `src/handlers/*`.
- Each handler exposes `test(url, request)` and `handle(url, request)`.
- Shared storage, pathname, metadata, and error helpers live in `src/handlers/common.ts`.

This is simple and has worked for public blob behavior. The next feature area, full private blob and presigned URL support, adds repeated cross-cutting checks across `get`, `head`, `put`, `copy`, `del`, and multipart routes. Keeping those checks inside each handler will make inconsistent behavior likely.

Introduce a small local middleware/context layer before implementing private and presigned behavior.

## Recommendation

Add a lightweight middleware pattern owned by this package. Do not introduce Hono or another framework for this refactor.

The goal is not to make a general web framework. The goal is to centralize request preparation and protocol validation while keeping blob storage behavior inside the existing handlers.

## Goals

- Preserve current public blob behavior.
- Make per-request state explicit through a shared context object.
- Allow handlers to declare reusable preconditions.
- Move repeated request setup into middleware.
- Prepare for private blob access checks.
- Prepare for presigned URL parsing and verification.
- Keep route matching and handler ownership easy to read.
- Keep Web `Request`/`Response` as the handler API.

## Non-Goals

- Do not add Hono, Express, Fastify, or another routing framework.
- Do not implement private blob behavior in the middleware refactor PR.
- Do not implement presigned URL verification in the middleware refactor PR.
- Do not change the storage layout.
- Do not change returned URL shapes as part of this refactor.
- Do not reorganize all helper functions unless the move is necessary for middleware.

## Proposed Shape

Create a request context and middleware runner in `src/handlers/common.ts` or a new nearby module such as `src/handlers/context.ts`.

Suggested types:

```ts
export type BlobContext = {
  url: URL;
  request: Request;
  route?: string;
  pathname?: string;
  auth?: AuthContext;
  presign?: PresignContext;
};

export type Middleware = (
  ctx: BlobContext,
  next: () => Promise<Response>
) => Promise<Response>;

export interface Handler {
  name: string;
  test(ctx: BlobContext): boolean;
  middleware?: Middleware[];
  handle(ctx: BlobContext): Response | Promise<Response>;
}
```

For the first refactor, `AuthContext` and `PresignContext` can be placeholders or omitted until private/presigned work begins. Do not invent fields before they are needed.

## Dispatcher Change

Update `src/server.ts` so it creates one context per request:

```ts
const ctx: BlobContext = { url, request };
```

Then dispatch with:

```ts
for (const handler of handlers) {
  if (handler.test(ctx)) {
    await sendResponse(outgoing, await runHandler(ctx, handler));
    return;
  }
}
```

The middleware runner should be small and deterministic:

```ts
export async function runHandler(
  ctx: BlobContext,
  handler: Handler
): Promise<Response> {
  const middleware = handler.middleware ?? [];
  let index = -1;

  async function dispatch(i: number): Promise<Response> {
    if (i <= index) {
      throw new Error('next() called multiple times');
    }
    index = i;

    const fn = middleware[i];
    if (!fn) {
      return handler.handle(ctx);
    }

    return fn(ctx, () => dispatch(i + 1));
  }

  return dispatch(0);
}
```

Keep existing `HttpError` handling in `src/server.ts` until there is a clear reason to move it.

## Handler Migration

Convert each existing handler mechanically:

Before:

```ts
test(url: URL, request: Request): boolean {
  return request.method === 'PUT' && !url.searchParams.has('fromUrl');
},
async handle(url: URL, request: Request) {
  // ...
}
```

After:

```ts
test(ctx: BlobContext): boolean {
  return ctx.request.method === 'PUT' && !ctx.url.searchParams.has('fromUrl');
},
async handle(ctx: BlobContext) {
  const { url, request } = ctx;
  // ...
}
```

Do this for:

- `src/handlers/client-upload.ts`
- `src/handlers/multipart.ts`
- `src/handlers/head.ts`
- `src/handlers/list.ts`
- `src/handlers/get.ts`
- `src/handlers/copy.ts`
- `src/handlers/put.ts`
- `src/handlers/del.ts`

This first conversion should have no behavior change.

## First Useful Middleware

Start with only middleware that is clearly useful and low-risk.

### `withPathnameFromRequest`

For write/copy/delete-like routes that currently call `pathnameFromRequest(url)` inside handlers, add a middleware that sets `ctx.pathname`.

Keep the first pass conservative. If a handler has special path behavior, leave it inside that handler until private/presigned work clarifies the abstraction.

Example:

```ts
export async function withPathnameFromRequest(
  ctx: BlobContext,
  next: () => Promise<Response>
) {
  ctx.pathname = pathnameFromRequest(ctx.url);
  return next();
}
```

### `withJsonErrors`

Optional. The server already catches `HttpError` and unexpected errors. Only move error conversion into middleware if doing so simplifies `server.ts` without changing behavior. This is not required for the first pass.

## Middleware To Add Later

These should be introduced with the private/presigned feature, not in the mechanical refactor.

### `withBearerAuth`

Responsibilities:

- Parse `Authorization: Bearer ...`.
- Identify read-write token vs client token.
- Compare against `BLOB_READ_WRITE_TOKEN` where local enforcement is required.
- Store parsed auth in `ctx.auth`.

### `withPresignedVerification(operation)`

Responsibilities:

- Detect `vercel-blob-delegation` and `vercel-blob-signature`.
- Decode the delegation payload.
- Verify the URL signature using the local signing secret.
- Validate operation: `get`, `head`, `put`, or `delete`.
- Validate pathname scope.
- Validate delegation expiry.
- Validate URL-level `vercel-blob-valid-until`.
- Store parsed presigned state in `ctx.presign`.

### `withPrivateReadAccess`

Responsibilities:

- Read blob metadata.
- If `access` is `public`, allow direct reads.
- If `access` is `private`, require valid bearer or presigned access.
- Return Vercel-style `403 forbidden` for invalid access.

### `withPresignedUploadOptions`

Responsibilities:

- Convert presigned query constraints into the same local behavior currently driven by SDK headers:
  - `vercel-blob-add-random-suffix`
  - `vercel-blob-allow-overwrite`
  - `vercel-blob-cache-control-max-age`
  - `vercel-blob-if-match`
  - `vercel-blob-allowed-content-types`
  - `vercel-blob-maximum-size-in-bytes`
  - callback URL and callback token payload
- Avoid duplicating upload rules between regular bearer-auth writes and presigned writes.

## Compatibility Notes

The current emulator returns localhost object URLs. The newer Vercel Blob SDK constructs production-shaped object URLs for private reads:

```text
https://<store-id>.private.blob.vercel-storage.com/<pathname>
```

A later private/presigned PR should decide the local object URL shape, likely:

```text
http://<store-id>.public.localhost:<port>/<pathname>
http://<store-id>.private.localhost:<port>/<pathname>
```

Do not mix that decision into the middleware conversion. Middleware should make this later work easier by centralizing URL and pathname parsing.

## Review Checklist

The middleware conversion is acceptable when:

- `npm test` passes.
- Handler matching order remains unchanged.
- Existing response bodies and status codes remain unchanged.
- Existing Vercel Blob SDK integration tests remain unchanged except for imports/types required by the refactor.
- `server.ts` still owns Node HTTP adaptation and response sending.
- Storage behavior remains in handlers.
- Middleware does not hide route-specific business logic.
- `next()` cannot be called twice without an explicit error.
- The refactor does not add new runtime dependencies.

## Suggested Commit Sequence

1. Add `BlobContext`, `Middleware`, updated `Handler`, and `runHandler`.
2. Update `src/server.ts` to create and dispatch context.
3. Mechanically convert all handlers from `(url, request)` to `(ctx)`.
4. Run `npm test`.
5. Add only the safest first middleware, such as `withPathnameFromRequest`, if it reduces duplicated code without changing behavior.
6. Run `npm test` again.

## Risks

- Over-abstracting too early could make simple handlers harder to read.
- Middleware order bugs can be subtle.
- Mutating `ctx` is pragmatic, but the fields must remain small and well-named.
- A middleware layer can obscure which handler owns behavior if it starts doing storage work.

The mitigation is to keep middleware focused on request context, auth, and protocol validation. Blob persistence, metadata creation, listing, copying, and deletion should stay in handlers.

