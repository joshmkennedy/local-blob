import { blobErrorResponse, defineHandler, fileExists, normalizeBlobPathname, readJsonFile, storeMetaPath } from './common.ts';

export default defineHandler({
  name: 'head',
  test (url: URL, request: Request) {
    return request.method === 'GET' && url.pathname === '/' && url.searchParams.has('url');
  },
  async handle (url: URL, request) {
    const headPathname = normalizeBlobPathname(url.searchParams.get('url'));
    const file = storeMetaPath(headPathname);

    if (await fileExists(file)) {
      const data = await readJsonFile(file);
      return Response.json(data);
    } else {
      return blobErrorResponse(404);
    }
  },
});
