import fs from 'node:fs/promises';
import path from 'node:path';
import {
  blobUrl,
  defineHandler,
  normalizeBlobPathname,
  pathnameFromRequest,
  storeFilePath,
} from './common.ts';

export default defineHandler({
  name: 'copy',
  test (url: URL, request: Request): boolean {
    return request.method === 'PUT' && url.searchParams.has('fromUrl');
  },
  async handle (url: URL, request) {
    const fromPath = normalizeBlobPathname(url.searchParams.get('fromUrl'));
    const toPath = pathnameFromRequest(url);
    const metaFile = Bun.file(`${storeFilePath(fromPath)}._vercel_mock_meta_`);
    const file = Bun.file(storeFilePath(fromPath));
    if (await metaFile.exists() && await file.exists()) {
      const meta = await metaFile.json();
      meta.url = blobUrl(url.origin, toPath);
      const downloadUrl = new URL(meta.url);
      downloadUrl.searchParams.set('download', '1');
      meta.downloadUrl = downloadUrl.toString();
      meta.pathname = toPath;
      meta.uploadedAt = new Date();
      const destinationPath = storeFilePath(toPath);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await Bun.write(`${destinationPath}._vercel_mock_meta_`, JSON.stringify(meta, undefined, 2));
      await fs.cp(storeFilePath(fromPath), destinationPath);

      return Response.json(meta);
    } else {
      return new Response(null, { status: 404 });
    }
  },
});
