import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createBlobMetadata,
  defineHandler,
  notifyClientUploadCompleted,
  pathnameFromRequest,
  persistBlob,
  putResultFromMetadata,
  storePath,
  writeBlob,
  writeText,
} from './common.ts';

const MPU_DIR = '.mpu';

export default defineHandler({
  name: 'multipart',
  test(url: URL, request: Request): boolean {
    return request.method === 'POST' && url.pathname === '/mpu';
  },
  async handle(url: URL, request: Request) {
    const action = request.headers.get('x-mpu-action');

    if (action === 'create') {
      const pathname = pathnameFromRequest(url);
      const uploadId = `local-mpu-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const key = pathname;
      await fs.mkdir(uploadPath(uploadId), { recursive: true });
      await writeText(path.join(uploadPath(uploadId), 'meta.json'), JSON.stringify({ pathname, key }, null, 2));

      return Response.json({ key, uploadId });
    }

    if (action === 'upload') {
      const uploadId = requireHeader(request, 'x-mpu-upload-id');
      const partNumber = Number(requireHeader(request, 'x-mpu-part-number'));
      const blob = await request.blob();
      const partPath = path.join(uploadPath(uploadId), `${partNumber}.part`);

      await writeBlob(partPath, blob);

      return Response.json({
        etag: `"local-mpu-${uploadId}-${partNumber}-${blob.size}"`,
        partNumber,
      });
    }

    if (action === 'complete') {
      const uploadId = requireHeader(request, 'x-mpu-upload-id');
      const pathname = pathnameFromRequest(url);
      const parts: Array<{ partNumber: number }> = await request.json();
      const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const partBlobs = await Promise.all(
        sortedParts.map((part) => fs.readFile(path.join(uploadPath(uploadId), `${part.partNumber}.part`)))
      );
      const blob = new Blob(partBlobs, {
        type: request.headers.get('X-Content-Type') || 'application/octet-stream',
      });
      const metadata = createBlobMetadata({
        origin: url.origin,
        pathname,
        blob,
        headers: request.headers,
      });

      await persistBlob(pathname, blob, metadata);
      await fs.rm(uploadPath(uploadId), { recursive: true, force: true });

      const result = putResultFromMetadata(metadata);
      await notifyClientUploadCompleted(request, result);

      return Response.json(result);
    }

    return Response.json({ error: `Unsupported multipart action: ${action}` }, { status: 400 });
  },
});

function uploadPath(uploadId: string) {
  return path.join(storePath, MPU_DIR, uploadId);
}

function requireHeader(request: Request, name: string) {
  const value = request.headers.get(name);
  if (!value) {
    throw new Error(`Missing required multipart header: ${name}`);
  }

  return decodeURIComponent(value);
}
