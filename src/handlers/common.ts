import path from 'node:path';
import fs from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { resolveLocalConfig } from '../local-config.ts';
import { objectUrl, type ObjectRequestInfo } from '../local-url.ts';

export const storePath = resolveLocalConfig().storePath;
const META_SUFFIX = '._vercel_mock_meta_';
const PATHNAME_SEPARATOR = /[/\\]+/;

export type BlobContext = {
  url: URL;
  request: Request;
  objectRequest?: ObjectRequestInfo | null;
  presign?: any;
  route?: string;
  pathname?: string;
};

export const PRESIGNED_UNSUPPORTED_MESSAGE =
  'Presigned URL verification is not supported for this route yet.';

export type Middleware = (
  ctx: BlobContext,
  next: () => Promise<Response>
) => Promise<Response>;

export interface Handler {
  name: string;
  middleware?: Middleware[];

  test (ctx: BlobContext): boolean;

  handle (ctx: BlobContext): Response | Promise<Response>;
}

export type BlobErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'precondition_failed'
  | 'forbidden'
  | 'unknown_error';

export class HttpError extends Error {
  status: number;
  code: BlobErrorCode;

  constructor(
    message: string,
    status = 500,
    code: BlobErrorCode = blobErrorCodeFromStatus(status)
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function blobErrorResponse(
  status: number,
  message?: string,
  code: BlobErrorCode = blobErrorCodeFromStatus(status)
) {
  return Response.json(
    {
      error: {
        code,
        message: message ?? defaultBlobErrorMessage(code),
      },
    },
    { status }
  );
}

export function blobErrorCodeFromStatus(status: number): BlobErrorCode {
  if (status === 400 || status === 405) return 'bad_request';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 412) return 'precondition_failed';
  return 'unknown_error';
}

function defaultBlobErrorMessage(code: BlobErrorCode) {
  switch (code) {
    case 'bad_request':
      return 'Bad request';
    case 'not_found':
      return 'The requested blob does not exist';
    case 'precondition_failed':
      return 'Precondition failed: ETag mismatch.';
    case 'forbidden':
      return 'Access denied, please provide a valid token for this resource.';
    case 'unknown_error':
      return 'Unknown error, please visit https://vercel.com/help.';
  }
}

export function defineHandler (handler: Handler) {
  return handler;
}

export async function runHandler(ctx: BlobContext, handler: Handler): Promise<Response> {
  const middleware = handler.middleware ?? [];
  let index = -1;

  async function dispatch(i: number): Promise<Response> {
    if (i <= index) {
      throw new Error('next() called multiple times');
    }
    index = i;

    const fn = middleware[i];
    if (!fn) {
      return handler.handle(ctx);
    }

    return fn(ctx, () => dispatch(i + 1));
  }

  return dispatch(0);
}

export function normalizeBlobPathname(value: string | null | undefined) {
  if (!value) {
    throw new HttpError('Missing blob pathname', 400);
  }

  let pathname = value;

  if (value.startsWith('http://') || value.startsWith('https://')) {
    pathname = new URL(value).pathname;
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(`Invalid blob pathname encoding: ${value}`, 400);
  }

  const normalized = decodedPathname.replace(/^[/\\]+/, '');
  const segments = normalized.split(PATHNAME_SEPARATOR);

  if (
    !normalized ||
    normalized.includes('\0') ||
    path.isAbsolute(normalized) ||
    segments.some((segment, index) =>
      segment === '.' ||
      segment === '..' ||
      (segment === '' && index !== segments.length - 1)
    )
  ) {
    throw new HttpError(`Invalid blob pathname: ${value}`, 400);
  }

  return segments.join('/');
}

export function pathnameFromRequest(url: URL) {
  return normalizeBlobPathname(url.searchParams.get('pathname') ?? url.pathname);
}

export async function withPathnameFromRequest(
  ctx: BlobContext,
  next: () => Promise<Response>
) {
  ctx.pathname = pathnameFromRequest(ctx.url);
  return next();
}

export function isPresignedUrlRequest(url: URL) {
  return url.searchParams.has('vercel-blob-delegation') || url.searchParams.has('vercel-blob-signature');
}

export async function withUnsupportedPresignedRequest(
  ctx: BlobContext,
  next: () => Promise<Response>
) {
  if (isPresignedUrlRequest(ctx.url)) {
    return blobErrorResponse(400, PRESIGNED_UNSUPPORTED_MESSAGE);
  }

  return next();
}

export function hasReadWriteAccess(request: Request) {
  return bearerTokenFromRequest(request) === resolveLocalConfig().readWriteToken;
}

export function authorizeReadWriteRequest(request: Request) {
  return hasReadWriteAccess(request) ? null : blobErrorResponse(403);
}

export function authorizeBlobRead(metadata: any, request: Request, presign?: any) {
  if (metadata?.access !== 'private' || hasReadWriteAccess(request) || presign) {
    return null;
  }

  return blobErrorResponse(403);
}

export function requirePathname(ctx: BlobContext) {
  if (!ctx.pathname) {
    throw new Error('ctx.pathname is required; add withPathnameFromRequest middleware to this handler');
  }

  return ctx.pathname;
}

export function applyRandomSuffix(pathname: string, headers: Headers) {
  const normalizedPathname = normalizeBlobPathname(pathname);
  if (headers.get('x-add-random-suffix') !== '1') {
    return normalizedPathname;
  }

  const slashIndex = normalizedPathname.lastIndexOf('/');
  const directory = slashIndex === -1 ? '' : `${normalizedPathname.slice(0, slashIndex + 1)}`;
  const filename = slashIndex === -1 ? normalizedPathname : normalizedPathname.slice(slashIndex + 1);
  const dotIndex = filename.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? filename.slice(0, dotIndex) : filename;
  const extension = hasExtension ? filename.slice(dotIndex) : '';
  const suffix = randomBytes(8).toString('base64url');

  return `${directory}${stem}-${suffix}${extension}`;
}

export function storeFilePath(pathname: string) {
  return path.join(storePath, 'objects', encodeStoredPathname(pathname));
}

export function storeMetaPath(pathname: string) {
  return `${storeFilePath(pathname)}${META_SUFFIX}`;
}

export function blobUrl(_origin: string, pathname: string, access: string = 'public') {
  return objectUrl(access, normalizeBlobPathname(pathname));
}

export function createBlobMetadata({
  origin,
  pathname,
  blob,
  headers,
}: {
  origin: string;
  pathname: string;
  blob: Blob;
  headers: Headers;
}) {
  const uploadedAt = new Date();
  const normalizedPathname = normalizeBlobPathname(pathname);
  const access = headers.get('x-vercel-blob-access') || 'public';
  const urlString = blobUrl(origin, normalizedPathname, access);
  const downloadUrl = new URL(urlString);
  downloadUrl.searchParams.set('download', '1');
  const cacheControlRaw = headers.get('x-cache-control-max-age');

  return {
    url: urlString,
    downloadUrl: downloadUrl.toString(),
    pathname: normalizedPathname,
    size: blob.size,
    contentType:
      headers.get('X-Content-Type') ||
      blob.type ||
      'application/octet-stream',
    cacheControl: cacheControlRaw
      ? `max-age=${cacheControlRaw}`
      : 'max-age=31536000',
    access,
    uploadedAt,
    contentDisposition: headers.get('Content-Disposition') || contentDispositionForPathname(normalizedPathname, 'inline'),
    etag: `"local-${blob.size}-${uploadedAt.getTime()}"`,
  };
}

export function contentDispositionForPathname(pathname: string, disposition: 'inline' | 'attachment') {
  const normalizedPathname = normalizeBlobPathname(pathname);
  const filename = normalizedPathname.split('/').filter(Boolean).at(-1) || 'download';
  const escapedFilename = filename.replace(/["\\]/g, '_');

  return `${disposition}; filename="${escapedFilename}"`;
}

export async function writeBlob(filePath: string, blob: Blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(await blob.arrayBuffer()));
}

export async function writeText(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
}

export async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function validateIfMatch(pathname: string, request: Request) {
  return validateIfMatchHeaders(pathname, request.headers);
}

export async function validateIfMatchHeaders(pathname: string, headers: Headers) {
  const ifMatch = headers.get('x-if-match');
  if (!ifMatch) return null;

  const metaPath = storeMetaPath(pathname);
  if (!await fileExists(metaPath)) {
    return blobErrorResponse(412);
  }

  const metadata = await readJsonFile(metaPath);
  if (metadata?.etag !== ifMatch) {
    return blobErrorResponse(412);
  }

  return null;
}

export async function persistBlob(pathname: string, blob: Blob, metadata: any) {
  await writeBlob(storeFilePath(pathname), blob);
  await writeText(storeMetaPath(pathname), JSON.stringify(metadata, undefined, 2));
}

export function putResultFromMetadata(metadata: any) {
  return {
    url: metadata.url,
    downloadUrl: metadata.downloadUrl,
    pathname: metadata.pathname,
    contentType: metadata.contentType,
    contentDisposition: metadata.contentDisposition,
    etag: metadata.etag,
  };
}

export async function notifyClientUploadCompleted(
  request: Request,
  blobResult: ReturnType<typeof putResultFromMetadata>
) {
  const token = bearerTokenFromRequest(request);
  if (!token?.startsWith('vercel_blob_client_')) return;

  const payload = decodeClientTokenPayload(token);
  const callback = payload?.onUploadCompleted;
  if (!callback?.callbackUrl) return;

  await sendUploadCompletedCallback(callback.callbackUrl, blobResult, callback.tokenPayload ?? null, true);
}

export async function notifyPresignedUploadCompleted(
  url: URL,
  blobResult: ReturnType<typeof putResultFromMetadata>
) {
  const callbackUrl = url.searchParams.get('vercel-blob-callback-url');
  if (!callbackUrl) return;

  await sendUploadCompletedCallback(
    callbackUrl,
    blobResult,
    url.searchParams.get('vercel-blob-callback-token-payload'),
    false
  );
}

async function sendUploadCompletedCallback(
  callbackUrl: string,
  blobResult: ReturnType<typeof putResultFromMetadata>,
  tokenPayload: string | null,
  signWithReadWriteToken: boolean
) {
  const body = {
    type: 'blob.upload-completed',
    payload: {
      blob: blobResult,
      tokenPayload,
    },
  };
  const bodyText = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (signWithReadWriteToken) {
    const readWriteToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!readWriteToken) {
      throw new HttpError('BLOB_READ_WRITE_TOKEN is required to sign client upload callbacks', 500);
    }
    headers['x-vercel-signature'] = createHmac('sha256', readWriteToken)
      .update(bodyText)
      .digest('hex');
  }

  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers,
    body: bodyText,
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new HttpError(
      `Client upload callback failed: ${response.status} ${response.statusText}${responseBody ? ` - ${responseBody}` : ''}`,
      502
    );
  }
}

export function bearerTokenFromRequest(request: Request) {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function decodeClientTokenPayload(token: string): any | null {
  const [, , , , encodedToken] = token.split('_');
  if (!encodedToken) return null;

  const [, encodedPayload] = Buffer.from(encodedToken, 'base64')
    .toString()
    .split('.');
  if (!encodedPayload) return null;

  return JSON.parse(Buffer.from(encodedPayload, 'base64').toString());
}

function encodeStoredPathname(pathname: string) {
  return Buffer.from(normalizeBlobPathname(pathname), 'utf8').toString(
    'base64url'
  );
}
