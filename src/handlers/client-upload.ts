import { handleUpload } from '@vercel/blob/client';
import { defineHandler } from './common.ts';

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
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const body = await request.json();
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
