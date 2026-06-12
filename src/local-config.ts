import { createHash } from 'node:crypto';

export type LocalConfig = {
  port: number;
  storePath: string;
  readWriteToken: string;
  storeId: string;
  ownerId: string;
  signingSecret: string;
};

const DEFAULT_READ_WRITE_TOKEN = 'vercel_blob_rw_localstore_nonce';
const DEFAULT_STORE_ID = 'localstore';

export function resolveLocalConfig(): LocalConfig {
  const readWriteToken = process.env.BLOB_READ_WRITE_TOKEN ?? DEFAULT_READ_WRITE_TOKEN;
  const storeId = normalizeStoreId(
    process.env.BLOB_STORE_ID ?? storeIdFromReadWriteToken(readWriteToken) ?? DEFAULT_STORE_ID
  );

  return {
    port: parsePort(process.env.PORT ?? '3000'),
    storePath: process.env.VERCEL_STORE_PATH ?? '.store',
    readWriteToken,
    storeId,
    ownerId: process.env.BLOB_OWNER_ID ?? `local_${storeId}_owner`,
    signingSecret:
      process.env.LOCAL_BLOB_SIGNING_SECRET ??
      createHash('sha256').update(`local-blob-signing:${readWriteToken}`).digest('hex'),
  };
}

export function normalizeStoreId(value: string): string {
  const normalized = value.trim().replace(/^store_/, '');
  return normalized || DEFAULT_STORE_ID;
}

export function storeIdFromReadWriteToken(token: string): string | null {
  const prefix = 'vercel_blob_rw_';
  if (!token.startsWith(prefix)) return null;

  const remainder = token.slice(prefix.length);
  const [storeId] = remainder.split('_');
  return storeId ? normalizeStoreId(storeId) : null;
}

function parsePort(value: string): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3000;
}
