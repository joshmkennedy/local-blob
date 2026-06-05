#!/usr/bin/env node

import http from 'node:http';
import { Readable } from 'node:stream';
import type { Handler } from './handlers/common.ts';

type CliOptions = {
  port: number;
  storePath: string;
  token: string;
};

void main();

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  process.env.PORT = String(options.port);
  process.env.VERCEL_STORE_PATH = options.storePath;
  process.env.BLOB_READ_WRITE_TOKEN = options.token;
  process.env.VERCEL_BLOB_API_URL = `http://localhost:${options.port}`;

  const [clientUpload, multipart, head, list, get, copy, put, del] = await Promise.all([
    import('./handlers/client-upload.ts'),
    import('./handlers/multipart.ts'),
    import('./handlers/head.ts'),
    import('./handlers/list.ts'),
    import('./handlers/get.ts'),
    import('./handlers/copy.ts'),
    import('./handlers/put.ts'),
    import('./handlers/del.ts'),
  ]);

  const handlers: Handler[] = [
    clientUpload.default,
    multipart.default,
    head.default,
    list.default,
    get.default,
    copy.default,
    put.default,
    del.default,
  ];

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? `localhost:${options.port}`;
      const url = new URL(incoming.url ?? '/', `http://${host}`);
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        body:
          incoming.method === 'GET' || incoming.method === 'HEAD'
            ? undefined
            : (Readable.toWeb(incoming) as ReadableStream),
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

  server.listen(options.port, () => {
    console.log(`local-blob listening on http://localhost:${options.port}`);
    console.log(`storing blobs in ${options.storePath}`);
    console.log('');
    console.log('Add to your app .env.local:');
    console.log(`BLOB_READ_WRITE_TOKEN=${options.token}`);
    console.log(`VERCEL_BLOB_API_URL=http://localhost:${options.port}`);
  });
}

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

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    storePath: process.env.VERCEL_STORE_PATH ?? '.store',
    token: process.env.BLOB_READ_WRITE_TOKEN ?? 'vercel_blob_rw_localstore_nonce',
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [name, inlineValue] = arg.split('=', 2);
    const value = inlineValue ?? args[index + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (name === '--port' || name === '-p') {
      if (!value) fail(`Missing value for ${name}`);
      options.port = parsePort(value);
      if (!inlineValue) index++;
      continue;
    }

    if (name === '--store' || name === '--store-path' || name === '-s') {
      if (!value) fail(`Missing value for ${name}`);
      options.storePath = value;
      if (!inlineValue) index++;
      continue;
    }

    if (name === '--token' || name === '-t') {
      if (!value) fail(`Missing value for ${name}`);
      options.token = value;
      if (!inlineValue) index++;
      continue;
    }

    fail(`Unknown option: ${arg}`);
  }

  options.port = parsePort(String(options.port));
  return options;
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port: ${value}`);
  }
  return port;
}

function printHelp() {
  console.log(`local-blob

Usage:
  local-blob [options]

Options:
  -p, --port <port>          Port to listen on. Defaults to PORT or 3000.
  -s, --store <path>         Blob store directory. Defaults to VERCEL_STORE_PATH or .store.
  -t, --token <token>        Read/write token. Defaults to BLOB_READ_WRITE_TOKEN or vercel_blob_rw_localstore_nonce.
  -h, --help                 Show help.
`);
}

function fail(message: string): never {
  console.error(message);
  console.error('Run local-blob --help for usage.');
  process.exit(1);
}
