import fs from 'node:fs/promises';
import { authorizeBlobRead, blobErrorResponse, contentDispositionForPathname, defineHandler, fileExists, isPresignedUrlRequest, normalizeBlobPathname, readJsonFile, storeFilePath, storeMetaPath } from './common.ts';
import { verifyPresignedRequest } from '../presign.ts';

export default defineHandler({
  name: 'get',
  test (ctx) {
    return (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') && !ctx.url.searchParams.has('url');
  },
  async handle (ctx) {
    const { url, request } = ctx;
    const isDownload = url.searchParams.get('download') === '1';
    const pathname = normalizeBlobPathname(url.pathname);
    const metaFile = storeMetaPath(pathname);
    const file = storeFilePath(pathname);
    if (await fileExists(metaFile) && await fileExists(file)) {
      const data = await readJsonFile(metaFile);
      if (isPresignedUrlRequest(url)) {
        ctx.presign = verifyPresignedRequest(url, request.method === 'HEAD' ? 'head' : 'get', {
          pathname: data.url === data.pathname ? data.pathname : undefined,
        });
      }
      const forbidden = authorizeBlobRead(data, request, ctx.presign);
      if (forbidden) return forbidden;

      const headers = new Headers({
        'Content-Type': data.contentType,
        'Content-Length': String(data.size),
        'Cache-Control': data.cacheControl,
        'Last-Modified': new Date(data.uploadedAt).toUTCString(),
        'ETag': data.etag,
        'Content-Disposition': isDownload
          ? contentDispositionForPathname(data.pathname, 'attachment')
          : data.contentDisposition,
      });

      if (matchesIfNoneMatch(request.headers.get('if-none-match'), data.etag)) {
        headers.delete('Content-Length');
        return new Response(null, { status: 304, headers });
      }

      if (request.method === 'HEAD') {
        return new Response(null, { headers });
      }

      return new Response(await fs.readFile(file), { headers });
    } else {
      return blobErrorResponse(404);
    }
  },
});

function matchesIfNoneMatch(value: string | null, etag: string | undefined) {
  if (!value || !etag) return false;

  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === etag);
}
