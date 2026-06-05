import fs from 'node:fs/promises';
import { blobErrorResponse, contentDispositionForPathname, defineHandler, fileExists, normalizeBlobPathname, readJsonFile, storeFilePath, storeMetaPath } from './common.ts';

export default defineHandler({
  name: 'get',
  test (url, request) {
    return (request.method === 'GET') && !url.searchParams.has('url');
  },
  async handle (url, request) {
    const isDownload = url.searchParams.get('download') === '1';
    const pathname = normalizeBlobPathname(url.pathname);
    const metaFile = storeMetaPath(pathname);
    const file = storeFilePath(pathname);
    if (await fileExists(metaFile) && await fileExists(file)) {
      const data = await readJsonFile(metaFile);
      const headers = new Headers({
        'Content-Type': data.contentType,
        'Content-Length': String(data.size),
        'Cache-Control': data.cacheControl,
        'Last-Modified': String(new Date(data.uploadedAt)),
        'Content-Disposition': isDownload
          ? contentDispositionForPathname(data.pathname, 'attachment')
          : data.contentDisposition,
      });
      return new Response(await fs.readFile(file), { headers });
    } else {
      return blobErrorResponse(404);
    }
  },
});
