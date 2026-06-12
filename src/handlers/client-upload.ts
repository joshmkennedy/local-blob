import { handleUpload } from '@vercel/blob/client';
import { blobErrorResponse, defineHandler } from './common.ts';
import { issueLocalSignedToken } from '../signed-token.ts';
import { signPresignedUrl } from '../presign.ts';

const completedUploads: any[] = [];

export default defineHandler({
  name: 'client-upload',
  test(ctx): boolean {
    return ctx.url.pathname === '/client-upload' || ctx.url.pathname === '/client-upload-events';
  },
  async handle(ctx) {
    const { url, request } = ctx;
    if (url.pathname === '/client-upload-events') {
      return Response.json({ completedUploads });
    }

    if (request.method !== 'POST') {
      return blobErrorResponse(405, 'Method not allowed');
    }

    const body = await request.json();
    if (body?.type === 'blob.generate-presigned-url') {
      const { pathname, clientPayload, multipart } = body.payload;
      const token = issueLocalSignedToken({
        pathname,
        operations: ['put'],
        validUntil: Date.now() + 60 * 60 * 1000,
        allowedContentTypes: ['text/plain'],
        maximumSizeInBytes: 20 * 1024 * 1024,
      });
      const entries: [string, string][] = [
        ['vercel-blob-allowed-content-types', 'text/plain'],
        ['vercel-blob-allow-overwrite', 'true'],
        ['vercel-blob-cache-control-max-age', '60'],
        ['vercel-blob-callback-url', `${url.origin}/client-upload`],
        ['vercel-blob-callback-token-payload', JSON.stringify({ pathname, clientPayload, multipart })],
      ];

      return Response.json({
        type: 'blob.generate-presigned-url',
        presignedUrlPayload: {
          delegationToken: token.delegationToken,
          signature: signPresignedUrl(token.clientSigningToken, pathname, 'put', entries),
          params: Object.fromEntries(entries),
        },
      });
    }

    if (body?.type === 'blob.upload-completed' && !request.headers.has('x-vercel-signature')) {
      completedUploads.push({
        receivedAt: new Date().toISOString(),
        payload: body.payload,
      });
      return Response.json({ type: 'blob.upload-completed', response: 'ok' });
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
