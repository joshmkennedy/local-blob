import { blobErrorResponse, defineHandler, isPresignedUrlRequest, PRESIGNED_UNSUPPORTED_MESSAGE } from './common.ts';

export default defineHandler({
  name: 'presigned-unsupported',
  test(ctx): boolean {
    return isPresignedUrlRequest(ctx.url);
  },
  handle() {
    return blobErrorResponse(400, PRESIGNED_UNSUPPORTED_MESSAGE);
  },
});
