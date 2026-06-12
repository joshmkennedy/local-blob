import {
  applyRandomSuffix,
  blobErrorResponse,
  createBlobMetadata,
  defineHandler,
  fileExists,
  notifyClientUploadCompleted,
  notifyPresignedUploadCompleted,
  persistBlob,
  putResultFromMetadata,
  requirePathname,
  storeMetaPath,
  validateIfMatchHeaders,
  withPathnameFromRequest,
  isPresignedUrlRequest,
  authorizeBlobWriteRequest,
} from './common.ts';
import { assertPresignedPutConstraints, headersForPresignedPut, verifyPresignedRequest } from '../presign.ts';

export default defineHandler({
  name: 'put',
  middleware: [withPathnameFromRequest],
  test (ctx): boolean {
    return ctx.request.method === 'PUT' && !ctx.url.searchParams.has('fromUrl');
  },
  async handle (ctx) {
    const { url, request } = ctx;
    const requestedPathname = requirePathname(ctx);
    const isPresigned = isPresignedUrlRequest(url);
    if (isPresigned) {
      ctx.presign = verifyPresignedRequest(url, 'put', { pathname: requestedPathname });
    } else {
      const forbidden = authorizeBlobWriteRequest(request, requestedPathname);
      if (forbidden) return forbidden;
    }
    const headers = isPresigned ? headersForPresignedPut(url, request.headers) : request.headers;
    const pathname = applyRandomSuffix(requestedPathname, headers);
    const ifMatchFailure = await validateIfMatchHeaders(pathname, headers);
    if (ifMatchFailure) return ifMatchFailure;

    if (!headers.has('x-if-match') && headers.get('x-allow-overwrite') !== '1' && await fileExists(storeMetaPath(pathname))) {
      return blobErrorResponse(
        412,
        'Blob already exists. Pass allowOverwrite: true to overwrite it.',
        'precondition_failed'
      );
    }

    const blob = await request.blob();
    if (ctx.presign) {
      assertPresignedPutConstraints(ctx.presign, url, blob, headers);
    }
    const data = createBlobMetadata({
      origin: url.origin,
      pathname,
      blob,
      headers,
    });

    await persistBlob(pathname, blob, data);

    const result = putResultFromMetadata(data);
    await notifyClientUploadCompleted(request, result);
    await notifyPresignedUploadCompleted(url, result);

    return Response.json(result);
  },
});
