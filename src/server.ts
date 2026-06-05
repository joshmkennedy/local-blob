#!/usr/bin/env bun

import type { Handler } from './handlers/common.ts';
import clientUpload from './handlers/client-upload.ts';
import copy from './handlers/copy.ts';
import get from './handlers/get.ts';
import del from './handlers/del.ts';
import head from './handlers/head.ts';
import list from './handlers/list.ts';
import multipart from './handlers/multipart.ts';
import put from './handlers/put.ts';

const handlers: Handler[] = [clientUpload, multipart, head, list, get, copy, put, del];

Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  fetch: async (request) => {
    try {
      const url = new URL(request.url);
      for (let handler of handlers) {
        if (handler.test(url, request)) {
          return await handler.handle(url, request);
        }
      }

      return Response.json(null, { status: 404 });
    } catch (e) {
      console.error(e);
      const status = Number.isInteger((e as any)?.status) ? (e as any).status : 500;
      return new Response(String((e as any)?.message ?? e), { status });
    }
  },
});
