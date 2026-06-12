import { unlink } from 'node:fs/promises';
import { authorizeReadWriteRequest, blobErrorResponse, defineHandler, fileExists, isPresignedUrlRequest, normalizeBlobPathname, pathnameFromRequest, storeFilePath, storeMetaPath, validateIfMatch, validateIfMatchHeaders } from './common.ts';
import { headersForPresignedPut, verifyPresignedRequest } from '../presign.ts';

export default defineHandler({
  name: 'del',

  test(ctx) {
    return (ctx.request.method === 'POST' && ctx.url.pathname === '/delete') ||
      (ctx.request.method === 'DELETE' && ctx.url.pathname === '/' && ctx.url.searchParams.has('pathname'));
  },

  async handle(ctx) {
    const { url, request } = ctx;

    if (request.method === 'DELETE') {
      const pathname = pathnameFromRequest(url);
      if (isPresignedUrlRequest(url)) {
        ctx.presign = verifyPresignedRequest(url, 'delete', { pathname });
      } else {
        const forbidden = authorizeReadWriteRequest(request);
        if (forbidden) return forbidden;
      }

      const fileUrl = storeFilePath(pathname);
      const metaFileUrl = storeMetaPath(pathname);
      if (!await fileExists(fileUrl) && !await fileExists(metaFileUrl)) {
        return blobErrorResponse(404);
      }

      const headers = ctx.presign ? headersForPresignedPut(url, request.headers) : request.headers;
      const ifMatchFailure = await validateIfMatchHeaders(pathname, headers);
      if (ifMatchFailure) return ifMatchFailure;

      if (await fileExists(fileUrl)) await unlink(fileUrl);
      if (await fileExists(metaFileUrl)) await unlink(metaFileUrl);
      return Response.json(null, { status: 200 });
    }

    const forbidden = authorizeReadWriteRequest(request);
    if (forbidden) return forbidden;

    const body: { urls: string[] } = await request.json();

    const urlsArray = body.urls;

    if (request.headers.has('x-if-match')) {
      if (urlsArray.length !== 1) {
        return blobErrorResponse(400, 'ifMatch can only be used when deleting a single URL.');
      }

      const ifMatchFailure = await validateIfMatch(normalizeBlobPathname(urlsArray[0]), request);
      if (ifMatchFailure) return ifMatchFailure;
    }

    if (urlsArray.length) {
      for (let url of urlsArray) {
        const pathname = normalizeBlobPathname(url);
        const fileUrl = storeFilePath(pathname);
        const metaFileUrl = storeMetaPath(pathname);

        if (await fileExists(fileUrl)) {
          await unlink(fileUrl);
        }
        if (await fileExists(metaFileUrl)) {
          await unlink(metaFileUrl);
        }
      }
    }
    return Response.json(null, { status: 200 });
  },
});
