import fs from 'node:fs/promises';
import {
  applyRandomSuffix,
  authorizeReadWriteRequest,
  blobErrorResponse,
  createBlobMetadata,
  defineHandler,
  fileExists,
  normalizeBlobPathname,
  persistBlob,
  putResultFromMetadata,
  requirePathname,
  storeFilePath,
  storeMetaPath,
  validateIfMatch,
  withPathnameFromRequest,
} from './common.ts';

export default defineHandler({
  name: 'copy',
  middleware: [withPathnameFromRequest],
  test (ctx): boolean {
    return ctx.request.method === 'PUT' && ctx.url.searchParams.has('fromUrl');
  },
  async handle (ctx) {
    const { url, request } = ctx;
    const forbidden = authorizeReadWriteRequest(request);
    if (forbidden) return forbidden;

    const fromPath = normalizeBlobPathname(url.searchParams.get('fromUrl'));
    const requestedToPath = requirePathname(ctx);
    const toPath = applyRandomSuffix(requestedToPath, request.headers);
    const metaFile = storeMetaPath(fromPath);
    const file = storeFilePath(fromPath);

    if (!await fileExists(metaFile) || !await fileExists(file)) {
      return blobErrorResponse(404);
    }

    const ifMatchFailure = await validateIfMatch(toPath, request);
    if (ifMatchFailure) return ifMatchFailure;

    if (!request.headers.has('x-if-match') && request.headers.get('x-allow-overwrite') !== '1' && await fileExists(storeMetaPath(toPath))) {
      return blobErrorResponse(
        412,
        'Blob already exists. Pass allowOverwrite: true to overwrite it.',
        'precondition_failed'
      );
    }

    const blob = new Blob([await fs.readFile(file)], {
      type: request.headers.get('x-content-type') || 'application/octet-stream',
    });
    const metadata = createBlobMetadata({
      origin: url.origin,
      pathname: toPath,
      blob,
      headers: request.headers,
    });

    await persistBlob(toPath, blob, metadata);

    return Response.json(putResultFromMetadata(metadata));
  },
});
