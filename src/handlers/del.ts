import { unlink } from 'node:fs/promises';
import { blobErrorResponse, defineHandler, fileExists, normalizeBlobPathname, storeFilePath, storeMetaPath, validateIfMatch } from './common.ts';

export default defineHandler({
  name: 'del',

  test(requestUrl, request) {
    return request.method === 'POST' && requestUrl.pathname === '/delete';
  },

  async handle(requestUrl, request) {
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
