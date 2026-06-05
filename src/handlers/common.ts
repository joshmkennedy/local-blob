import path from 'node:path';
import { createHmac } from 'node:crypto';

export const storePath = process.env.VERCEL_STORE_PATH ?? '.store';
const META_SUFFIX = '._vercel_mock_meta_';
const PATHNAME_SEPARATOR = /[/\\]+/;

export interface Handler {
  name: string;

  test (url: URL, request: Request): boolean;

  handle (url: URL, request: Request): Response | Promise<Response>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status = 500
  ) {
    super(message);
  }
}

export function defineHandler (handler: Handler) {
  return handler;
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
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new HttpError(`Invalid blob pathname: ${value}`, 400);
  }

  return segments.join('/');
}

export function pathnameFromRequest(url: URL) {
  return normalizeBlobPathname(url.searchParams.get('pathname') ?? url.pathname);
}

export function storeFilePath(pathname: string) {
  return path.join(storePath, 'objects', encodeStoredPathname(pathname));
}

export function storeMetaPath(pathname: string) {
  return `${storeFilePath(pathname)}${META_SUFFIX}`;
}

export function blobUrl(origin: string, pathname: string) {
  return new URL(`/${normalizeBlobPathname(pathname)}`, origin).toString();
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
  const urlString = blobUrl(origin, pathname);
  const downloadUrl = new URL(urlString);
  downloadUrl.searchParams.set('download', '1');
  const cacheControlRaw = headers.get('x-cache-control-max-age');

  return {
    url: urlString,
    downloadUrl: downloadUrl.toString(),
    pathname: normalizeBlobPathname(pathname),
    size: blob.size,
    contentType:
      headers.get('X-Content-Type') ||
      blob.type ||
      'application/octet-stream',
    cacheControl: cacheControlRaw
      ? `max-age=${cacheControlRaw}`
      : 'max-age=31536000',
    uploadedAt,
    contentDisposition: headers.get('Content-Disposition') || 'attachment',
    etag: `"local-${blob.size}-${uploadedAt.getTime()}"`,
  };
}

export async function persistBlob(pathname: string, blob: Blob, metadata: any) {
  const filePath = storeFilePath(pathname);
  await Bun.write(filePath, blob, { createPath: true });
  await Bun.write(storeMetaPath(pathname), JSON.stringify(metadata, undefined, 2), {
    createPath: true,
  });
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

  const body = {
    type: 'blob.upload-completed',
    payload: {
      blob: blobResult,
      tokenPayload: callback.tokenPayload ?? null,
    },
  };
  const bodyText = JSON.stringify(body);
  const readWriteToken = process.env.BLOB_READ_WRITE_TOKEN;

  if (!readWriteToken) {
    throw new HttpError('BLOB_READ_WRITE_TOKEN is required to sign client upload callbacks', 500);
  }

  const response = await fetch(callback.callbackUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vercel-signature': createHmac('sha256', readWriteToken)
        .update(bodyText)
        .digest('hex'),
    },
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

function bearerTokenFromRequest(request: Request) {
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
