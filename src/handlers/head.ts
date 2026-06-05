import { defineHandler, normalizeBlobPathname, storeFilePath } from './common.ts';

export default defineHandler({
  name: 'head',
  test (url: URL, request: Request) {
    return request.method === 'GET' && url.pathname === '/' && url.searchParams.has('url');
  },
  async handle (url: URL, request) {
    const headPathname = normalizeBlobPathname(url.searchParams.get('url'));
    const file = Bun.file(`${storeFilePath(headPathname)}._vercel_mock_meta_`);

    if (await file.exists()) {
      const data = await file.json();
      return Response.json(data);
    } else {
      return new Response(null, { status: 404 });
    }
  },
});
