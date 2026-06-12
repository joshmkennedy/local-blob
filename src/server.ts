#!/usr/bin/env node

import http from 'node:http';
import { Readable } from 'node:stream';
import type { BlobContext, Handler } from './handlers/common.ts';

type CliOptions = {
  port: number;
  storePath: string;
  token: string;
};

const CORS_ALLOW_METHODS = 'GET, HEAD, PUT, POST, DELETE, OPTIONS';
const CORS_DEFAULT_ALLOW_HEADERS = [
  'authorization',
  'content-disposition',
  'content-type',
  'if-none-match',
  'x-add-random-suffix',
  'x-allow-overwrite',
  'x-api-version',
  'x-cache-control-max-age',
  'x-content-type',
  'x-forwarded-host',
  'x-if-match',
  'x-mpu-action',
  'x-mpu-part-number',
  'x-mpu-upload-id',
  'x-vercel-blob-access',
  'x-vercel-signature',
].join(', ');
const CORS_EXPOSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-length',
  'etag',
  'last-modified',
].join(', ');

void main();

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  process.env.PORT = String(options.port);
  process.env.VERCEL_STORE_PATH = options.storePath;
  process.env.BLOB_READ_WRITE_TOKEN = options.token;
  process.env.VERCEL_BLOB_API_URL = `http://localhost:${options.port}`;

  const [localConfig, localUrl, common, signedToken, clientUpload, multipart, head, list, get, copy, put, del, presignedUnsupported] = await Promise.all([
    import('./local-config.ts'),
    import('./local-url.ts'),
    import('./handlers/common.ts'),
    import('./handlers/signed-token.ts'),
    import('./handlers/client-upload.ts'),
    import('./handlers/multipart.ts'),
    import('./handlers/head.ts'),
    import('./handlers/list.ts'),
    import('./handlers/get.ts'),
    import('./handlers/copy.ts'),
    import('./handlers/put.ts'),
    import('./handlers/del.ts'),
    import('./handlers/presigned-unsupported.ts'),
  ]);

  const handlers: Handler[] = [
    signedToken.default,
    clientUpload.default,
    multipart.default,
    head.default,
    list.default,
    get.default,
    copy.default,
    put.default,
    del.default,
    presignedUnsupported.default,
  ];

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const forwardedHost = incoming.headers['x-forwarded-host'];
      const host = headerValue(forwardedHost) ?? incoming.headers.host ?? `localhost:${options.port}`;
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
      const ctx: BlobContext = { url, request, objectRequest: localUrl.parseObjectRequest(url) };

      if (request.method === 'OPTIONS') {
        await sendResponse(outgoing, corsPreflightResponse(request), request);
        return;
      }

      for (const handler of handlers) {
        if (handler.test(ctx)) {
          await sendResponse(outgoing, await common.runHandler(ctx, handler), request);
          return;
        }
      }

      await sendResponse(outgoing, common.blobErrorResponse(404), request);
    } catch (e) {
      console.error(e);
      if (e instanceof common.HttpError) {
        await sendResponse(outgoing, common.blobErrorResponse(e.status, e.message, e.code), incoming);
        return;
      }

      const status = Number.isInteger((e as any)?.status) ? (e as any).status : 500;
      await sendResponse(outgoing, common.blobErrorResponse(status, String((e as any)?.message ?? e)), incoming);
    }
  });

  server.listen(options.port, () => {
    const config = localConfig.resolveLocalConfig();
    console.log(`local-blob control plane listening on http://localhost:${options.port}`);
    console.log(`local-blob object plane using http://${config.storeId}.<public|private>.localhost:${options.port}/<pathname>`);
    console.log(`storing blobs in ${options.storePath}`);
    console.log('');
    console.log('Add to your app .env.local:');
    console.log(`BLOB_READ_WRITE_TOKEN=${options.token}`);
    console.log(`VERCEL_BLOB_API_URL=http://localhost:${options.port}`);
  });
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function sendResponse(outgoing: http.ServerResponse, response: Response, request: Request | http.IncomingMessage) {
  applyCorsHeaders(response.headers, request);
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));

  if (!response.body) {
    outgoing.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  outgoing.end(buffer);
}

function corsPreflightResponse(request: Request) {
  const headers = new Headers();
  applyCorsHeaders(headers, request);
  return new Response(null, { status: 204, headers });
}

function applyCorsHeaders(headers: Headers, request: Request | http.IncomingMessage) {
  const requestedHeaders = headerValue(
    request instanceof Request
      ? request.headers.get('access-control-request-headers') ?? undefined
      : request.headers['access-control-request-headers']
  );

  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  headers.set('Access-Control-Allow-Headers', requestedHeaders || CORS_DEFAULT_ALLOW_HEADERS);
  headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  headers.set('Access-Control-Max-Age', '86400');
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
