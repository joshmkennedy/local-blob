import { handleUpload } from '@vercel/blob/client';
import { blobErrorResponse, defineHandler } from './common.ts';

const completedUploads: any[] = [];

export default defineHandler({
  name: 'client-upload',
  test(url: URL, request: Request): boolean {
    return url.pathname === '/client-upload' || url.pathname === '/client-upload-events';
  },
  async handle(url: URL, request: Request) {
    if (url.pathname === '/client-upload-events') {
      return Response.json({ completedUploads });
    }

    if (request.method !== 'POST') {
      return blobErrorResponse(405, 'Method not allowed');
    }

    const body = await request.json();
    if (body?.type === 'blob.generate-presigned-url') {
      return blobErrorResponse(
        400,
        'handleUploadPresigned and presigned client uploads are not supported by local-blob. Use @vercel/blob/client.upload with client tokens for local development.'
      );
    }

    const result = await handleUpload({
      request,
      body,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      async onBeforeGenerateToken(pathname, clientPayload, multipart) {
        return {
          allowedContentTypes: ['text/plain'],
          maximumSizeInBytes: 20 * 1024 * 1024,
          allowOverwrite: true,
          cacheControlMaxAge: 60,
          callbackUrl: `${url.origin}/client-upload`,
          tokenPayload: JSON.stringify({
            pathname,
            clientPayload,
            multipart,
          }),
        };
      },
      async onUploadCompleted(payload) {
        completedUploads.push({
          receivedAt: new Date().toISOString(),
          payload,
        });
      },
    });

    return Response.json(result);
  },
});
