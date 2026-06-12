import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './handlers/common.ts';
import { normalizeStoreId, resolveLocalConfig, type LocalConfig } from './local-config.ts';

export type DelegationOperation = 'get' | 'head' | 'put' | 'delete';

export type DelegationPayload = {
  storeId: string;
  ownerId: string;
  pathname: string;
  operations: DelegationOperation[];
  validUntil: number;
  iat: number;
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
};

export type IssueLocalSignedTokenOptions = {
  pathname?: string;
  operations?: DelegationOperation[];
  validUntil?: number;
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_OPERATIONS = new Set<DelegationOperation>(['get', 'head', 'put', 'delete']);

export function issueLocalSignedToken(
  options: IssueLocalSignedTokenOptions = {},
  config: LocalConfig = resolveLocalConfig(),
) {
  const now = Date.now();
  const validUntil = options.validUntil ?? now + ONE_HOUR_MS;
  validateValidUntil(validUntil, now);

  const operations = normalizeOperations(options.operations);
  const payload: DelegationPayload = {
    storeId: config.storeId,
    ownerId: config.ownerId,
    pathname: options.pathname ?? '*',
    operations,
    validUntil,
    iat: now,
  };

  if (options.maximumSizeInBytes !== undefined) {
    payload.maximumSizeInBytes = options.maximumSizeInBytes;
  }
  if (options.allowedContentTypes !== undefined) {
    payload.allowedContentTypes = options.allowedContentTypes;
  }

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(config.signingSecret, payloadSegment);
  const delegationToken = `${payloadSegment}.${signature}`;

  return {
    delegationToken,
    clientSigningToken: deriveClientSigningToken(delegationToken, config),
    validUntil,
  };
}

export function decodeDelegationToken(token: string): DelegationPayload {
  const [payloadSegment, signature, extra] = token.split('.');
  if (!payloadSegment || !signature || extra !== undefined) {
    throw new HttpError('Malformed delegation token', 403, 'forbidden');
  }

  try {
    return JSON.parse(base64UrlDecode(payloadSegment)) as DelegationPayload;
  } catch {
    throw new HttpError('Malformed delegation token', 403, 'forbidden');
  }
}

export function verifyDelegationToken(
  token: string,
  config: LocalConfig = resolveLocalConfig(),
): DelegationPayload {
  const [payloadSegment, signature, extra] = token.split('.');
  if (!payloadSegment || !signature || extra !== undefined) {
    throw new HttpError('Malformed delegation token', 403, 'forbidden');
  }

  const expected = sign(config.signingSecret, payloadSegment);
  if (!safeEqual(signature, expected)) {
    throw new HttpError('Invalid delegation token signature', 403, 'forbidden');
  }

  const payload = decodeDelegationToken(token);
  validateDelegationPayload(payload, config);
  return payload;
}

export function deriveClientSigningToken(
  delegationToken: string,
  config: LocalConfig = resolveLocalConfig(),
) {
  return sign(config.signingSecret, delegationToken);
}

function validateValidUntil(validUntil: number, now = Date.now()) {
  if (!Number.isInteger(validUntil) || !Number.isFinite(validUntil)) {
    throw new HttpError('validUntil must be an integer milliseconds timestamp.', 400);
  }
  if (validUntil <= now) {
    throw new HttpError('validUntil must be in the future.', 400);
  }
  if (validUntil > now + SEVEN_DAYS_MS) {
    throw new HttpError('validUntil must be no more than seven days in the future.', 400);
  }
}

function validateDelegationPayload(payload: DelegationPayload, config: LocalConfig) {
  if (normalizeStoreId(payload.storeId) !== config.storeId) {
    throw new HttpError('Delegation token store does not match this local store.', 403, 'forbidden');
  }
  if (!payload.validUntil || payload.validUntil <= Date.now()) {
    throw new HttpError('Delegation token has expired.', 403, 'forbidden');
  }
  if (!Array.isArray(payload.operations) || payload.operations.length === 0) {
    throw new HttpError('Delegation token has no allowed operations.', 403, 'forbidden');
  }
  for (const operation of payload.operations) {
    if (!VALID_OPERATIONS.has(operation)) {
      throw new HttpError(`Invalid delegation operation: ${operation}`, 403, 'forbidden');
    }
  }
}

function normalizeOperations(operations: DelegationOperation[] | undefined): DelegationOperation[] {
  const normalized = operations ? Array.from(new Set(operations)) : ['get'];
  if (normalized.length === 0) {
    throw new HttpError('operations must be a non-empty array if provided.', 400);
  }
  for (const operation of normalized) {
    if (!VALID_OPERATIONS.has(operation)) {
      throw new HttpError(`Invalid delegation operation: ${operation}`, 400);
    }
  }
  return normalized;
}

function sign(secret: string, data: string) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function safeEqual(value: string, expected: string) {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}
