import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  completeMultipartUpload,
  copy,
  createFolder,
  createMultipartUpload,
  del,
  get as getBlob,
  head,
  list,
  put,
  uploadPart,
} from '@vercel/blob';

const TEST_PORT = 3001;
const TEST_STORE_PATH = '.test-store';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_TOKEN = 'vercel_blob_rw_test';
let server;

before(async () => {
  process.env.BLOB_READ_WRITE_TOKEN = TEST_TOKEN;
  process.env.VERCEL_BLOB_API_URL = BASE_URL;

  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  server = spawn('node', ['dist/server.cjs'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      VERCEL_STORE_PATH: TEST_STORE_PATH,
      BLOB_READ_WRITE_TOKEN: TEST_TOKEN,
    },
    stderr: 'inherit',
  });
  await waitForServer();
});

after(() => {
  server?.kill();
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
});

test('uploads and downloads a blob', async () => {
  const response = await fetch(`${BASE_URL}/hello.txt`, {
    method: 'PUT',
    body: new Blob(['Hello, World!'], { type: 'text/plain' }),
    headers: { 'X-Content-Type': 'text/plain' },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pathname, 'hello.txt');

  const getResponse = await fetch(`${BASE_URL}/hello.txt`);
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), 'Hello, World!');
});

test('returns metadata for head endpoint', async () => {
  await fetch(`${BASE_URL}/meta.txt`, { method: 'PUT', body: 'metadata' });
  const response = await fetch(`${BASE_URL}/?url=/meta.txt`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pathname, 'meta.txt');
  assert.equal(data.size, 8);
});

test('returns Vercel Blob-style JSON for missing blobs', async () => {
  const response = await fetch(`${BASE_URL}/missing.txt`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'not_found',
      message: 'The requested blob does not exist',
    },
  });
});

test('real SDK maps not_found responses to BlobNotFoundError', async () => {
  await assert.rejects(
    () => head('sdk-missing.txt', { token: TEST_TOKEN }),
    BlobNotFoundError
  );
});

test('real SDK enforces allowOverwrite for put', async () => {
  const first = await put('sdk-overwrite.txt', 'first', {
    access: 'public',
    token: TEST_TOKEN,
  });
  assert.equal(first.pathname, 'sdk-overwrite.txt');

  await assert.rejects(
    () => put('sdk-overwrite.txt', 'second', { access: 'public', token: TEST_TOKEN }),
    BlobPreconditionFailedError
  );

  const overwritten = await put('sdk-overwrite.txt', 'second', {
    access: 'public',
    allowOverwrite: true,
    token: TEST_TOKEN,
  });
  assert.equal(overwritten.pathname, 'sdk-overwrite.txt');

  const response = await fetch(overwritten.url);
  assert.equal(await response.text(), 'second');
});

test('real SDK applies addRandomSuffix for put', async () => {
  const suffixed = await put('sdk-random-suffix.txt', 'randomized', {
    access: 'public',
    addRandomSuffix: true,
    token: TEST_TOKEN,
  });
  assert.notEqual(suffixed.pathname, 'sdk-random-suffix.txt');
  assert.match(suffixed.pathname, /^sdk-random-suffix-[A-Za-z0-9_-]+\.txt$/);

  const response = await fetch(suffixed.url);
  assert.equal(await response.text(), 'randomized');

  const exact = await put('sdk-no-random-suffix.txt', 'exact', {
    access: 'public',
    addRandomSuffix: false,
    token: TEST_TOKEN,
  });
  assert.equal(exact.pathname, 'sdk-no-random-suffix.txt');
});

test('presigned URL flows return explicit unsupported errors', async () => {
  const uploadResponse = await fetch(`${BASE_URL}/?pathname=presigned.txt&vercel-blob-delegation=demo&vercel-blob-signature=demo`, {
    method: 'PUT',
    body: 'presigned',
  });
  assert.equal(uploadResponse.status, 400);
  assert.deepEqual(await uploadResponse.json(), {
    error: {
      code: 'bad_request',
      message: 'Presigned URL flows are not supported by local-blob. Use read/write tokens or client-token uploads for local development.',
    },
  });

  const clientUploadResponse = await fetch(`${BASE_URL}/client-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'blob.generate-presigned-url' }),
  });
  assert.equal(clientUploadResponse.status, 400);
  assert.deepEqual(await clientUploadResponse.json(), {
    error: {
      code: 'bad_request',
      message: 'handleUploadPresigned and presigned client uploads are not supported by local-blob. Use @vercel/blob/client.upload with client tokens for local development.',
    },
  });
});

test('private blobs are metadata-only locally and are not access-controlled', async () => {
  const blob = await put('sdk-private-local.txt', 'not secret locally', {
    access: 'private',
    token: TEST_TOKEN,
  });

  const metadataResponse = await fetch(`${BASE_URL}/?url=/sdk-private-local.txt`);
  assert.equal(metadataResponse.status, 200);
  assert.equal((await metadataResponse.json()).access, 'private');

  const readResponse = await fetch(blob.url);
  assert.equal(readResponse.status, 200);
  assert.equal(await readResponse.text(), 'not secret locally');
});

test('@vercel/blob get() rejects local emulator URLs; direct fetch reads local blobs', async () => {
  const blob = await put('sdk-get-local-url.txt', 'read me locally', {
    access: 'public',
    token: TEST_TOKEN,
  });

  await assert.rejects(
    () => getBlob(blob.url, { access: 'public', token: TEST_TOKEN }),
    (error) => error instanceof BlobError && /Invalid URL/.test(error.message)
  );

  const response = await fetch(blob.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'read me locally');
});

test('real SDK completes a manual multipart upload', async () => {
  const pathname = 'sdk-manual-multipart.txt';
  const upload = await createMultipartUpload(pathname, {
    access: 'public',
    token: TEST_TOKEN,
  });

  const firstPart = await uploadPart(pathname, 'hello ', {
    access: 'public',
    uploadId: upload.uploadId,
    key: upload.key,
    partNumber: 1,
    token: TEST_TOKEN,
  });
  const secondPart = await uploadPart(pathname, 'multipart', {
    access: 'public',
    uploadId: upload.uploadId,
    key: upload.key,
    partNumber: 2,
    token: TEST_TOKEN,
  });

  const completed = await completeMultipartUpload(pathname, [secondPart, firstPart], {
    access: 'public',
    uploadId: upload.uploadId,
    key: upload.key,
    contentType: 'text/plain',
    token: TEST_TOKEN,
  });
  assert.equal(completed.pathname, pathname);
  assert.equal(completed.contentType, 'text/plain');
  assert.equal(await (await fetch(completed.url)).text(), 'hello multipart');
});

test('real SDK multipart put enforces overwrite options', async () => {
  const pathname = 'sdk-multipart-overwrite.txt';
  const first = await put(pathname, 'multipart first', {
    access: 'public',
    multipart: true,
    token: TEST_TOKEN,
  });
  assert.equal(first.pathname, pathname);

  await assert.rejects(
    () => put(pathname, 'multipart second', {
      access: 'public',
      multipart: true,
      token: TEST_TOKEN,
    }),
    BlobPreconditionFailedError
  );

  const overwritten = await put(pathname, 'multipart second', {
    access: 'public',
    multipart: true,
    allowOverwrite: true,
    token: TEST_TOKEN,
  });
  assert.equal(overwritten.pathname, pathname);
  assert.equal(await (await fetch(overwritten.url)).text(), 'multipart second');
});

test('real SDK multipart put enforces ifMatch', async () => {
  const pathname = 'sdk-multipart-ifmatch.txt';
  const initial = await put(pathname, 'multipart ifmatch one', {
    access: 'public',
    multipart: true,
    token: TEST_TOKEN,
  });

  await assert.rejects(
    () => put(pathname, 'multipart ifmatch stale', {
      access: 'public',
      multipart: true,
      ifMatch: '"bogus"',
      token: TEST_TOKEN,
    }),
    BlobPreconditionFailedError
  );
  assert.equal(await (await fetch(initial.url)).text(), 'multipart ifmatch one');

  const updated = await put(pathname, 'multipart ifmatch two', {
    access: 'public',
    multipart: true,
    ifMatch: initial.etag,
    token: TEST_TOKEN,
  });
  assert.equal(updated.pathname, pathname);
  assert.equal(await (await fetch(updated.url)).text(), 'multipart ifmatch two');
});

test('real SDK multipart put applies addRandomSuffix consistently', async () => {
  const suffixed = await put('sdk-multipart-random.txt', 'multipart randomized', {
    access: 'public',
    multipart: true,
    addRandomSuffix: true,
    token: TEST_TOKEN,
  });
  assert.notEqual(suffixed.pathname, 'sdk-multipart-random.txt');
  assert.match(suffixed.pathname, /^sdk-multipart-random-[A-Za-z0-9_-]+\.txt$/);
  assert.equal(suffixed.url, `${BASE_URL}/${suffixed.pathname}`);
  assert.equal(await (await fetch(suffixed.url)).text(), 'multipart randomized');

  const upload = await createMultipartUpload('sdk-manual-multipart-random.txt', {
    access: 'public',
    addRandomSuffix: true,
    token: TEST_TOKEN,
  });
  assert.notEqual(upload.key, 'sdk-manual-multipart-random.txt');
  assert.match(upload.key, /^sdk-manual-multipart-random-[A-Za-z0-9_-]+\.txt$/);

  const part = await uploadPart('sdk-manual-multipart-random.txt', 'manual randomized', {
    access: 'public',
    uploadId: upload.uploadId,
    key: upload.key,
    partNumber: 1,
    token: TEST_TOKEN,
  });
  const completed = await completeMultipartUpload('sdk-manual-multipart-random.txt', [part], {
    access: 'public',
    uploadId: upload.uploadId,
    key: upload.key,
    token: TEST_TOKEN,
  });
  assert.equal(completed.pathname, upload.key);
  assert.equal(await (await fetch(completed.url)).text(), 'manual randomized');
});

test('downloadUrl is fetchable and forces attachment disposition', async () => {
  const uploaded = await put('sdk-download-url-put.txt', 'put download', {
    access: 'public',
    token: TEST_TOKEN,
  });
  assert.equal(uploaded.contentDisposition, 'inline; filename="sdk-download-url-put.txt"');
  await assertDownloadUrl(uploaded, 'put download');

  const copied = await copy(uploaded.url, 'sdk-download-url-copy.txt', {
    access: 'public',
    token: TEST_TOKEN,
  });
  assert.equal(copied.contentDisposition, 'inline; filename="sdk-download-url-copy.txt"');
  await assertDownloadUrl(copied, 'put download');

  const multipart = await put('sdk-download-url-multipart.txt', 'multipart download', {
    access: 'public',
    multipart: true,
    token: TEST_TOKEN,
  });
  assert.equal(multipart.contentDisposition, 'inline; filename="sdk-download-url-multipart.txt"');
  await assertDownloadUrl(multipart, 'multipart download');
});

test('real SDK creates folder placeholders with trailing slash', async () => {
  const folder = await createFolder('sdk-folder/', { token: TEST_TOKEN });
  assert.equal(folder.pathname, 'sdk-folder/');
  assert.equal(folder.url, `${BASE_URL}/sdk-folder/`);

  const metadata = await head(folder.url, { token: TEST_TOKEN });
  assert.equal(metadata.pathname, 'sdk-folder/');
  assert.equal(metadata.size, 0);

  const folded = await list({ mode: 'folded', token: TEST_TOKEN });
  assert.ok(folded.folders.includes('sdk-folder/'));
});

test('real SDK enforces ifMatch for put', async () => {
  const initial = await put('sdk-ifmatch-put.txt', 'one', {
    access: 'public',
    token: TEST_TOKEN,
  });

  await assert.rejects(
    () => put('sdk-ifmatch-put.txt', 'two', {
      access: 'public',
      ifMatch: '"bogus"',
      token: TEST_TOKEN,
    }),
    BlobPreconditionFailedError
  );

  const updated = await put('sdk-ifmatch-put.txt', 'two', {
    access: 'public',
    ifMatch: initial.etag,
    token: TEST_TOKEN,
  });
  assert.equal(updated.pathname, 'sdk-ifmatch-put.txt');

  const response = await fetch(updated.url);
  assert.equal(await response.text(), 'two');
});

test('real SDK uses copy request metadata and overwrite options', async () => {
  const source = await put('sdk-copy-metadata-source.txt', 'copied bytes', {
    access: 'public',
    contentType: 'text/plain',
    cacheControlMaxAge: 60,
    token: TEST_TOKEN,
  });

  const copiedWithDefaults = await copy(source.url, 'sdk-copy-metadata-destination.txt', {
    access: 'public',
    token: TEST_TOKEN,
  });
  const defaultHead = await head(copiedWithDefaults.url, { token: TEST_TOKEN });
  assert.equal(defaultHead.contentType, 'application/octet-stream');
  assert.equal(defaultHead.cacheControl, 'max-age=31536000');

  await assert.rejects(
    () => copy(source.url, 'sdk-copy-metadata-destination.txt', {
      access: 'public',
      token: TEST_TOKEN,
    }),
    BlobPreconditionFailedError
  );

  const overwritten = await copy(source.url, 'sdk-copy-metadata-destination.txt', {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 120,
    token: TEST_TOKEN,
  });
  const overwrittenHead = await head(overwritten.url, { token: TEST_TOKEN });
  assert.equal(overwrittenHead.contentType, 'application/json');
  assert.equal(overwrittenHead.cacheControl, 'max-age=120');
  assert.equal(await (await fetch(overwritten.url)).text(), 'copied bytes');

  const suffixed = await copy(source.url, 'sdk-copy-random.txt', {
    access: 'public',
    addRandomSuffix: true,
    token: TEST_TOKEN,
  });
  assert.notEqual(suffixed.pathname, 'sdk-copy-random.txt');
  assert.match(suffixed.pathname, /^sdk-copy-random-[A-Za-z0-9_-]+\.txt$/);
});

test('real SDK enforces ifMatch for copy', async () => {
  const source = await put('sdk-ifmatch-copy-source.txt', 'copied bytes', {
    access: 'public',
    token: TEST_TOKEN,
  });
  const destination = await put('sdk-ifmatch-copy-destination.txt', 'old bytes', {
    access: 'public',
    token: TEST_TOKEN,
  });

  await assert.rejects(
    () => copy(source.url, 'sdk-ifmatch-copy-destination.txt', {
      access: 'public',
      ifMatch: '"bogus"',
      token: TEST_TOKEN,
    }),
    BlobPreconditionFailedError
  );

  const copied = await copy(source.url, 'sdk-ifmatch-copy-destination.txt', {
    access: 'public',
    ifMatch: destination.etag,
    token: TEST_TOKEN,
  });
  assert.equal(copied.pathname, 'sdk-ifmatch-copy-destination.txt');

  const response = await fetch(copied.url);
  assert.equal(await response.text(), 'copied bytes');
});

test('real SDK enforces ifMatch for del', async () => {
  const target = await put('sdk-ifmatch-del.txt', 'delete me', {
    access: 'public',
    token: TEST_TOKEN,
  });

  await assert.rejects(
    () => del(target.url, { ifMatch: '"bogus"', token: TEST_TOKEN }),
    BlobPreconditionFailedError
  );

  await del(target.url, { ifMatch: target.etag, token: TEST_TOKEN });

  await assert.rejects(
    () => head(target.url, { token: TEST_TOKEN }),
    BlobNotFoundError
  );
});

test('real SDK surfaces bad_request error messages', async () => {
  await assert.rejects(
    () => list({ cursor: 'not-a-valid-cursor', token: TEST_TOKEN }),
    (error) => error instanceof BlobError && /Invalid list cursor/.test(error.message)
  );
});

async function assertDownloadUrl(blob, expectedText) {
  assert.equal(blob.downloadUrl, `${blob.url}?download=1`);
  const filename = blob.pathname.split('/').filter(Boolean).at(-1);
  const response = await fetch(blob.downloadUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${filename}"`);
  assert.equal(await response.text(), expectedText);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(BASE_URL);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('Timed out waiting for test server');
}
