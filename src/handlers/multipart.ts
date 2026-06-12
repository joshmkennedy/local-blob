import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyRandomSuffix,
  authorizeBlobWriteRequest,
  blobErrorResponse,
  createBlobMetadata,
  defineHandler,
  fileExists,
  notifyClientUploadCompleted,
  notifyPresignedUploadCompleted,
  pathnameFromRequest,
  persistBlob,
  putResultFromMetadata,
  readJsonFile,
  storeMetaPath,
  storePath,
  validateIfMatchHeaders,
  isPresignedUrlRequest,
  writeBlob,
  writeText,
} from './common.ts';
import { assertPresignedPutConstraints, headersForPresignedPut, verifyPresignedRequest } from '../presign.ts';

const MPU_DIR = '.mpu';

export default defineHandler({
  name: 'multipart',
  test(ctx): boolean {
    return ctx.request.method === 'POST' && ctx.url.pathname === '/mpu';
  },
  async handle(ctx) {
    const { url, request } = ctx;
    const action = request.headers.get('x-mpu-action');

    if (action === 'create') {
      const requestedPathname = pathnameFromRequest(url);
      const isPresigned = isPresignedUrlRequest(url);
      if (isPresigned) {
        ctx.presign = verifyPresignedRequest(url, 'put', { pathname: requestedPathname });
      } else {
        const forbidden = authorizeBlobWriteRequest(request, requestedPathname);
        if (forbidden) return forbidden;
      }
      const headers = isPresigned ? headersForPresignedPut(url, request.headers) : request.headers;
      const pathname = applyRandomSuffix(requestedPathname, headers);
      const uploadId = `local-mpu-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const key = pathname;
      await fs.mkdir(uploadPath(uploadId), { recursive: true });
      await writeText(path.join(uploadPath(uploadId), 'meta.json'), JSON.stringify({
        requestedPathname,
        pathname,
        key,
        presigned: isPresigned,
        headers: headersToObject(headers),
      }, null, 2));

      return Response.json({ key, uploadId });
    }

    if (action === 'upload') {
      const requestedPathname = pathnameFromRequest(url);
      if (isPresignedUrlRequest(url)) {
        ctx.presign = verifyPresignedRequest(url, 'put', { pathname: requestedPathname });
      } else {
        const forbidden = authorizeBlobWriteRequest(request, requestedPathname);
        if (forbidden) return forbidden;
      }
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
      const requestedPathname = pathnameFromRequest(url);
      if (isPresignedUrlRequest(url)) {
        ctx.presign = verifyPresignedRequest(url, 'put', { pathname: requestedPathname });
      } else {
        const forbidden = authorizeBlobWriteRequest(request, requestedPathname);
        if (forbidden) return forbidden;
      }
      const uploadId = requireHeader(request, 'x-mpu-upload-id');
      const uploadMetadata = await readJsonFile(path.join(uploadPath(uploadId), 'meta.json'));
      const pathname = uploadMetadata.pathname;
      const headers = headersFromStoredOptions(uploadMetadata.headers, request.headers);
      const ifMatchFailure = await validateIfMatchHeaders(pathname, headers);
      if (ifMatchFailure) return ifMatchFailure;

      if (!headers.has('x-if-match') && headers.get('x-allow-overwrite') !== '1' && await fileExists(storeMetaPath(pathname))) {
        return blobErrorResponse(
          412,
          'Blob already exists. Pass allowOverwrite: true to overwrite it.',
          'precondition_failed'
        );
      }

      const parts: Array<{ partNumber: number }> = await request.json();
      const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const partBlobs = await Promise.all(
        sortedParts.map((part) => fs.readFile(path.join(uploadPath(uploadId), `${part.partNumber}.part`)))
      );
      const blob = new Blob(partBlobs, {
        type: headers.get('X-Content-Type') || 'application/octet-stream',
      });
      if (ctx.presign) {
        assertPresignedPutConstraints(ctx.presign, url, blob, headers);
      }
      const metadata = createBlobMetadata({
        origin: url.origin,
        pathname,
        blob,
        headers,
      });

      await persistBlob(pathname, blob, metadata);
      await fs.rm(uploadPath(uploadId), { recursive: true, force: true });

      const result = putResultFromMetadata(metadata);
      await notifyClientUploadCompleted(request, result);
      await notifyPresignedUploadCompleted(url, result);

      return Response.json(result);
    }

    return blobErrorResponse(400, `Unsupported multipart action: ${action}`);
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

function headersToObject(headers: Headers) {
  const object: Record<string, string> = {};
  headers.forEach((value, key) => {
    object[key] = value;
  });
  return object;
}

function headersFromStoredOptions(storedHeaders: Record<string, string> | undefined, requestHeaders: Headers) {
  const headers = new Headers(storedHeaders);
  requestHeaders.forEach((value, key) => {
    if (!headers.has(key)) headers.set(key, value);
  });
  return headers;
}
