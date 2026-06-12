import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, normalizeBlobPathname } from './handlers/common.ts';
import { parseObjectRequest } from './local-url.ts';
import {
  deriveClientSigningToken,
  verifyDelegationToken,
  type DelegationOperation,
  type DelegationPayload,
} from './signed-token.ts';

export const PRESIGN_DELEGATION_PARAM = 'vercel-blob-delegation';
export const PRESIGN_SIGNATURE_PARAM = 'vercel-blob-signature';
export const PRESIGN_CANONICAL_QUERY_KEYS = [
  'vercel-blob-add-random-suffix',
  'vercel-blob-allow-overwrite',
  'vercel-blob-allowed-content-types',
  'vercel-blob-cache-control-max-age',
  'vercel-blob-callback-token-payload',
  'vercel-blob-callback-url',
  'vercel-blob-if-match',
  'vercel-blob-maximum-size-in-bytes',
  'vercel-blob-valid-until',
] as const;

export type PresignContext = {
  operation: DelegationOperation;
  pathname: string;
  delegation: DelegationPayload;
  urlValidUntil: number;
};

export function verifyPresignedRequest(
  url: URL,
  operation: DelegationOperation,
  options: { pathname?: string; storeId?: string; now?: number } = {},
): PresignContext {
  const delegationToken = url.searchParams.get(PRESIGN_DELEGATION_PARAM);
  const signature = url.searchParams.get(PRESIGN_SIGNATURE_PARAM);
  if (!delegationToken) {
    throw forbidden('Missing presigned delegation token.');
  }
  if (!signature) {
    throw forbidden('Missing presigned URL signature.');
  }

  const delegation = verifyDelegationToken(delegationToken);
  if (!delegation.operations.includes(operation)) {
    throw forbidden(`Delegation token is not valid for ${operation} requests.`);
  }

  const objectRequest = parseObjectRequest(url);
  const storeId = options.storeId ?? objectRequest?.storeId;
  if (storeId && storeId !== delegation.storeId) {
    throw forbidden('Presigned URL store does not match delegation token.');
  }

  const requestPathname = options.pathname ?? url.searchParams.get('pathname') ?? objectRequest?.pathname ?? normalizeBlobPathname(url.pathname);
  const canonicalPathname = canonicalPathnameForRequest(url, delegation.pathname, requestPathname);
  if (delegation.pathname !== '*' && delegation.pathname !== canonicalPathname) {
    throw forbidden('Presigned URL pathname is outside delegation scope.');
  }

  const now = options.now ?? Date.now();
  const urlValidUntil = resolveUrlValidUntil(url, delegation.validUntil, now);
  const canonical = canonicalString(canonicalPathname, canonicalQueryEntriesFromUrl(url), operation);
  const expectedSignature = hmacBase64Url(deriveClientSigningToken(delegationToken), canonical);
  if (!safeEqual(signature, expectedSignature)) {
    throw forbidden('Invalid presigned URL signature.');
  }

  return { operation, pathname: requestPathname, delegation, urlValidUntil };
}

function canonicalPathnameForRequest(url: URL, delegationPathname: string, requestPathname: string) {
  if (delegationPathname === '*') return requestPathname;
  if (!isUrl(delegationPathname)) return requestPathname;

  const scopedUrl = new URL(delegationPathname);
  if (normalizeBlobPathname(scopedUrl.pathname) !== requestPathname) {
    return requestPathname;
  }

  return delegationPathname;
}

function isUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function canonicalQueryEntriesFromUrl(url: URL): [string, string][] {
  const entries: [string, string][] = [];
  for (const key of PRESIGN_CANONICAL_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value) {
      entries.push([key, value]);
    }
  }
  return entries;
}

export function canonicalString(
  pathname: string,
  presignEntries: [string, string][],
  operation: DelegationOperation,
): string {
  const lines = [`operation=${operation}`, `pathname=${pathname}`];
  for (const key of PRESIGN_CANONICAL_QUERY_KEYS) {
    const value = presignEntries.find(([entryKey]) => entryKey === key)?.[1];
    if (value) {
      lines.push(`${key}=${value}`);
    }
  }
  lines.sort(compareUtf8);
  return lines.join('\n');
}

export function signPresignedUrl(
  clientSigningToken: string,
  pathname: string,
  operation: DelegationOperation,
  presignEntries: [string, string][] = [],
) {
  return hmacBase64Url(clientSigningToken, canonicalString(pathname, presignEntries, operation));
}

export function headersForPresignedPut(url: URL, originalHeaders: Headers) {
  const headers = new Headers(originalHeaders);
  copyQueryToHeader(url, 'vercel-blob-add-random-suffix', 'x-add-random-suffix', (value) => value === 'true' ? '1' : '0', headers);
  copyQueryToHeader(url, 'vercel-blob-allow-overwrite', 'x-allow-overwrite', (value) => value === 'true' ? '1' : '0', headers);
  copyQueryToHeader(url, 'vercel-blob-cache-control-max-age', 'x-cache-control-max-age', undefined, headers);
  copyQueryToHeader(url, 'vercel-blob-if-match', 'x-if-match', undefined, headers);
  if (!headers.has('x-content-type') && headers.has('content-type')) {
    headers.set('x-content-type', headers.get('content-type')!);
  }
  return headers;
}

export function assertPresignedPutConstraints(ctx: PresignContext, url: URL, blob: Blob, headers: Headers) {
  const contentType = headers.get('x-content-type') || blob.type || 'application/octet-stream';
  const urlAllowedContentTypes = url.searchParams.get('vercel-blob-allowed-content-types')?.split(',').filter(Boolean);
  for (const allowedContentTypes of [ctx.delegation.allowedContentTypes, urlAllowedContentTypes]) {
    if (allowedContentTypes?.length && !contentTypeAllowed(contentType, allowedContentTypes)) {
      throw forbidden('Content type is not allowed by this presigned URL.');
    }
  }

  const urlMaximumSize = numberConstraint(url.searchParams.get('vercel-blob-maximum-size-in-bytes'));
  const maximumSize = Math.min(...[ctx.delegation.maximumSizeInBytes, urlMaximumSize].filter((value) => value !== undefined));
  if (Number.isFinite(maximumSize) && blob.size > maximumSize) {
    throw forbidden('Blob exceeds maximum size allowed by this presigned URL.');
  }
}

function copyQueryToHeader(
  url: URL,
  queryName: string,
  headerName: string,
  map: ((value: string) => string) | undefined,
  headers: Headers,
) {
  const value = url.searchParams.get(queryName);
  if (value !== null) headers.set(headerName, map ? map(value) : value);
}

function contentTypeAllowed(contentType: string, allowed: string[]) {
  const [type] = contentType.split('/');
  return allowed.includes(contentType) || Boolean(type && allowed.includes(`${type}/*`));
}

function numberConstraint(value: string | null) {
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw forbidden('Invalid numeric presigned URL constraint.');
  return Math.trunc(number);
}

function resolveUrlValidUntil(url: URL, delegationValidUntil: number, now: number) {
  const value = url.searchParams.get('vercel-blob-valid-until');
  if (!value) return delegationValidUntil;

  const validUntil = Number(value);
  if (!Number.isInteger(validUntil) || !Number.isFinite(validUntil)) {
    throw forbidden('Invalid presigned URL expiry.');
  }
  if (validUntil <= now) {
    throw forbidden('Presigned URL has expired.');
  }
  if (validUntil > delegationValidUntil) {
    throw forbidden('Presigned URL expiry exceeds delegation expiry.');
  }
  return validUntil;
}

function hmacBase64Url(secret: string, data: string) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(value: string, expected: string) {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}

function compareUtf8(a: string, b: string) {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const diff = ab[i]! - bb[i]!;
    if (diff !== 0) return diff;
  }
  return ab.length - bb.length;
}

function forbidden(message: string) {
  return new HttpError(message, 403, 'forbidden');
}
