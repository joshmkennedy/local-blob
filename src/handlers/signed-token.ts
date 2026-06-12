import { authorizeReadWriteRequest, blobErrorResponse, defineHandler } from './common.ts';
import { issueLocalSignedToken } from '../signed-token.ts';

export default defineHandler({
  name: 'signed-token',
  test(ctx): boolean {
    return ctx.request.method === 'POST' && ctx.url.pathname === '/signed-token';
  },
  async handle(ctx) {
    const forbidden = authorizeReadWriteRequest(ctx.request);
    if (forbidden) return forbidden;

    let body: any;
    try {
      body = await ctx.request.json();
    } catch {
      return blobErrorResponse(400, 'Invalid signed token request body.');
    }

    return Response.json(issueLocalSignedToken(body ?? {}));
  },
});
