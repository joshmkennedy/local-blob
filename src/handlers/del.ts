import { unlink } from 'node:fs/promises';
import { defineHandler, normalizeBlobPathname, storeFilePath } from './common.ts';

export default defineHandler({
  name: 'del',

  test(requestUrl, request) {
    return request.method === 'POST' && requestUrl.pathname === '/delete';
  },

  async handle(requestUrl, request) {
    const body: { urls: string[] } = await request.json();

    const urlsArray = body.urls;

    if (urlsArray.length) {
      for (let url of urlsArray) {
        const pathname = normalizeBlobPathname(url);
        const fileUrl = storeFilePath(pathname);
        const metaFileUrl = `${fileUrl}._vercel_mock_meta_`;

        const file = Bun.file(fileUrl);
        const metaFile = Bun.file(metaFileUrl);

        if (await file.exists()) {
          await unlink(fileUrl);
        }
        if (await metaFile.exists()) {
          await unlink(metaFileUrl);
        }
      }
    }
    return Response.json(null, { status: 200 });
  },
});
