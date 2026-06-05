import {
  createBlobMetadata,
  defineHandler,
  notifyClientUploadCompleted,
  pathnameFromRequest,
  persistBlob,
  putResultFromMetadata,
} from './common.ts';

export default defineHandler({
  name: 'put',
  test (url: URL, request: Request): boolean {
    return request.method === 'PUT' && !url.searchParams.has('fromUrl');
  },
  async handle (url: URL, request) {
    const pathname = pathnameFromRequest(url);
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
