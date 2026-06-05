#!/usr/bin/env node

import http from 'node:http';
import { Readable } from 'node:stream';
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
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const host = incoming.headers.host ?? `localhost:${port}`;
    const url = new URL(incoming.url ?? '/', `http://${host}`);
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming) as ReadableStream,
      duplex: 'half',
    } as RequestInit);

    for (const handler of handlers) {
      if (handler.test(url, request)) {
        await sendResponse(outgoing, await handler.handle(url, request));
        return;
      }
    }

    await sendResponse(outgoing, Response.json(null, { status: 404 }));
  } catch (e) {
    console.error(e);
    const status = Number.isInteger((e as any)?.status) ? (e as any).status : 500;
    await sendResponse(outgoing, new Response(String((e as any)?.message ?? e), { status }));
  }
});

server.listen(port, () => {
  console.log(`local-blob listening on http://localhost:${port}`);
});

async function sendResponse(outgoing: http.ServerResponse, response: Response) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));

  if (!response.body) {
    outgoing.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  outgoing.end(buffer);
}
