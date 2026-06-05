import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, defineHandler, storePath } from './common.ts';

const META_SUFFIX = '._vercel_mock_meta_';
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;
const PATHNAME_SEPARATOR = /[/\\]+/;

export default defineHandler({
  name: 'list',
  test(url: URL, request: Request): boolean {
    return request.method === 'GET' && url.pathname === '/' && !url.searchParams.has('url');
  },
  async handle(url: URL) {
    const prefix = normalizeListPrefix(url.searchParams.get('prefix'));
    const limit = parseLimit(url.searchParams.get('limit'));
    const offset = parseCursor(url.searchParams.get('cursor'));
    const mode = url.searchParams.get('mode');
    const allBlobs = await readBlobMetadata(storePath);
    const matchingBlobs = allBlobs
      .filter((blob) => blob.pathname.startsWith(prefix))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));

    if (mode === 'folded') {
      const foldedItems = foldBlobItems(matchingBlobs, prefix);
      const page = foldedItems.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const hasMore = nextOffset < foldedItems.length;

      return Response.json({
        folders: page.filter(isFolderItem).map((item) => item.pathname),
        blobs: page.filter(isBlobItem).map((item) => item.blob),
        cursor: hasMore ? encodeCursor(nextOffset) : undefined,
        hasMore,
      });
    }

    const blobs = matchingBlobs.slice(offset, offset + limit);
    const nextOffset = offset + blobs.length;
    const hasMore = nextOffset < matchingBlobs.length;

    return Response.json({
      blobs,
      cursor: hasMore ? encodeCursor(nextOffset) : undefined,
      hasMore,
    });
  },
});

type BlobMetadata = {
  pathname: string;
  [key: string]: unknown;
};

type FoldedItem =
  | { type: 'blob'; pathname: string; blob: BlobMetadata }
  | { type: 'folder'; pathname: string };

async function readBlobMetadata(directory: string): Promise<BlobMetadata[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const blobs: BlobMetadata[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.name === '.mpu') continue;

    if (entry.isDirectory()) {
      blobs.push(...await readBlobMetadata(fullPath));
      continue;
    }

    if (!entry.name.endsWith(META_SUFFIX)) continue;

    const raw = await fs.readFile(fullPath, 'utf8');
    blobs.push(JSON.parse(raw));
  }

  return blobs;
}

function parseLimit(rawLimit: string | null) {
  if (!rawLimit) return DEFAULT_LIMIT;

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;

  return Math.min(limit, MAX_LIMIT);
}

function parseCursor(rawCursor: string | null) {
  if (!rawCursor) return 0;

  const numericCursor = Number(rawCursor);
  if (Number.isInteger(numericCursor) && numericCursor >= 0) {
    return numericCursor;
  }

  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
    if (Number.isInteger(decoded?.offset) && decoded.offset >= 0) {
      return decoded.offset;
    }
  } catch {
    // Fall through to the clear error below.
  }

  throw new HttpError(`Invalid list cursor: ${rawCursor}`, 400);
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function normalizeListPrefix(value: string | null) {
  if (!value) return '';

  let decodedPrefix: string;
  try {
    decodedPrefix = decodeURIComponent(value);
  } catch {
    throw new HttpError(`Invalid list prefix encoding: ${value}`, 400);
  }

  const normalized = decodedPrefix.replace(/^[/\\]+/, '');
  if (!normalized) return '';

  const hadTrailingSlash = /[/\\]$/.test(normalized);
  const segments = normalized.split(PATHNAME_SEPARATOR).filter(Boolean);

  if (
    normalized.includes('\0') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new HttpError(`Invalid list prefix: ${value}`, 400);
  }

  return `${segments.join('/')}${hadTrailingSlash ? '/' : ''}`;
}

function foldBlobItems(blobs: BlobMetadata[], prefix: string): FoldedItem[] {
  const folders = new Map<string, FoldedItem>();
  const items: FoldedItem[] = [];

  for (const blob of blobs) {
    const remainder = blob.pathname.slice(prefix.length);
    const separatorIndex = remainder.indexOf('/');

    if (separatorIndex === -1) {
      items.push({ type: 'blob', pathname: blob.pathname, blob });
      continue;
    }

    const folderPathname = `${prefix}${remainder.slice(0, separatorIndex + 1)}`;
    if (!folders.has(folderPathname)) {
      folders.set(folderPathname, { type: 'folder', pathname: folderPathname });
    }
  }

  return [...items, ...folders.values()].sort((a, b) => a.pathname.localeCompare(b.pathname));
}

function isBlobItem(item: FoldedItem): item is Extract<FoldedItem, { type: 'blob' }> {
  return item.type === 'blob';
}

function isFolderItem(item: FoldedItem): item is Extract<FoldedItem, { type: 'folder' }> {
  return item.type === 'folder';
}
