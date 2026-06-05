import {
  applyRandomSuffix,
  blobErrorResponse,
  createBlobMetadata,
  defineHandler,
  fileExists,
  notifyClientUploadCompleted,
  pathnameFromRequest,
  persistBlob,
  putResultFromMetadata,
  storeMetaPath,
  validateIfMatch,
} from './common.ts';

export default defineHandler({
  name: 'put',
  test (url: URL, request: Request): boolean {
    return request.method === 'PUT' && !url.searchParams.has('fromUrl');
  },
  async handle (url: URL, request) {
    const requestedPathname = pathnameFromRequest(url);
    const pathname = applyRandomSuffix(requestedPathname, request.headers);
    const ifMatchFailure = await validateIfMatch(pathname, request);
    if (ifMatchFailure) return ifMatchFailure;

    if (!request.headers.has('x-if-match') && request.headers.get('x-allow-overwrite') !== '1' && await fileExists(storeMetaPath(pathname))) {
      return blobErrorResponse(
        412,
        'Blob already exists. Pass allowOverwrite: true to overwrite it.',
        'precondition_failed'
      );
    }

    const blob = await request.blob();
    const data = createBlobMetadata({
      origin: url.origin,
      pathname,
      blob,
      headers: request.headers,
    });

    await persistBlob(pathname, blob, data);

    const result = putResultFromMetadata(data);
    await notifyClientUploadCompleted(request, result);

    return Response.json(result);
  },
});
