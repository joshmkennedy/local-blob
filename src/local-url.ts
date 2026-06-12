import { normalizeStoreId, resolveLocalConfig, type LocalConfig } from './local-config.ts';

export type BlobAccess = 'public' | 'private';

export type ObjectRequestInfo = {
  storeId: string;
  access: BlobAccess;
  pathname: string;
};

export function objectUrl(access: BlobAccess | string, pathname: string, config: LocalConfig = resolveLocalConfig()): string {
  const safeAccess = access === 'private' ? 'private' : 'public';
  const objectOrigin = `http://${config.storeId}.${safeAccess}.localhost:${config.port}`;
  return new URL(`/${normalizeObjectPathname(pathname)}`, objectOrigin).toString();
}

export function parseObjectRequest(url: URL): ObjectRequestInfo | null {
  const suffix = '.localhost';
  if (!url.hostname.endsWith(suffix)) return null;

  const prefix = url.hostname.slice(0, -suffix.length);
  const parts = prefix.split('.').filter(Boolean);
  if (parts.length < 2) return null;

  const access = parts.at(-1);
  if (access !== 'public' && access !== 'private') return null;

  const storeId = normalizeStoreId(parts.slice(0, -1).join('.'));
  return {
    storeId,
    access,
    pathname: normalizeObjectPathname(url.pathname),
  };
}

export function isControlPlaneRequest(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

function normalizeObjectPathname(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }

  return decoded.replace(/^[/\\]+/, '');
}
