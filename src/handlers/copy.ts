import fs from 'node:fs/promises';
import path from 'node:path';
import {
  blobUrl,
  defineHandler,
  fileExists,
  normalizeBlobPathname,
  pathnameFromRequest,
  readJsonFile,
  storeFilePath,
  storeMetaPath,
  writeText,
} from './common.ts';

export default defineHandler({
  name: 'copy',
  test (url: URL, request: Request): boolean {
    return request.method === 'PUT' && url.searchParams.has('fromUrl');
  },
  async handle (url: URL, request) {
    const fromPath = normalizeBlobPathname(url.searchParams.get('fromUrl'));
    const toPath = pathnameFromRequest(url);
    const metaFile = storeMetaPath(fromPath);
    const file = storeFilePath(fromPath);
    if (await fileExists(metaFile) && await fileExists(file)) {
      const meta = await readJsonFile(metaFile);
      meta.url = blobUrl(url.origin, toPath);
      const downloadUrl = new URL(meta.url);
      downloadUrl.searchParams.set('download', '1');
      meta.downloadUrl = downloadUrl.toString();
      meta.pathname = toPath;
      meta.uploadedAt = new Date();
      const destinationPath = storeFilePath(toPath);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await writeText(storeMetaPath(toPath), JSON.stringify(meta, undefined, 2));
      await fs.cp(storeFilePath(fromPath), destinationPath);

      return Response.json(meta);
    } else {
      return new Response(null, { status: 404 });
    }
  },
});
