import { blobErrorResponse, defineHandler, fileExists, normalizeBlobPathname, readJsonFile, storeMetaPath } from './common.ts';

export default defineHandler({
  name: 'head',
  test (ctx) {
    return ctx.request.method === 'GET' && ctx.url.pathname === '/' && ctx.url.searchParams.has('url');
  },
  async handle (ctx) {
    const { url } = ctx;
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
