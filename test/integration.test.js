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
  issueSignedToken,
  list,
  presignUrl,
  put,
  uploadPart,
} from '@vercel/blob';
import { generateClientTokenFromReadWriteToken, upload as clientUpload, uploadPresigned } from '@vercel/blob/client';
import {
  decodeDelegationToken,
  issueLocalSignedToken,
  verifyDelegationToken,
} from '../src/signed-token.ts';
import { resolveLocalConfig } from '../src/local-config.ts';
import {
  canonicalString,
  PRESIGN_CANONICAL_QUERY_KEYS,
  signPresignedUrl,
  verifyPresignedRequest,
} from '../src/presign.ts';

const TEST_PORT = 3001;
const TEST_STORE_PATH = '.test-store';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_TOKEN = 'vercel_blob_rw_test';
const TEST_STORE_ID = 'test';
let server;
const originalFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = fetchWithLocalhostObjectPlane;

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
  globalThis.fetch = originalFetch;
  server?.kill();
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
});

test('uploads and downloads a blob', async () => {
  const response = await fetch(`${BASE_URL}/hello.txt`, {
    method: 'PUT',
    body: new Blob(['Hello, World!'], { type: 'text/plain' }),
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'X-Content-Type': 'text/plain',
    },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pathname, 'hello.txt');

  const getResponse = await fetch(`${BASE_URL}/hello.txt`);
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), 'Hello, World!');
});

test('public and private writes return access-qualified local object URLs', async () => {
  const publicBlob = await put('sdk-public-url-shape.txt', 'public url shape', {
    access: 'public',
    token: TEST_TOKEN,
  });
  assert.equal(publicBlob.url, objectUrl('public', 'sdk-public-url-shape.txt'));
  assert.equal(publicBlob.downloadUrl, `${publicBlob.url}?download=1`);
  assert.equal(await (await fetch(publicBlob.url)).text(), 'public url shape');

  const privateBlob = await put('sdk-private-url-shape.txt', 'private url shape', {
    access: 'private',
    token: TEST_TOKEN,
  });
  assert.equal(privateBlob.url, objectUrl('private', 'sdk-private-url-shape.txt'));
  assert.equal(privateBlob.downloadUrl, `${privateBlob.url}?download=1`);
  const privateRead = await fetch(privateBlob.url, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(privateRead.status, 200);
  assert.equal(await privateRead.text(), 'private url shape');
});

test('direct blob reads return ETag and support conditional 304 responses', async () => {
  const uploaded = await put('sdk-conditional-read.txt', 'cache me', {
    access: 'public',
    token: TEST_TOKEN,
  });

  const firstResponse = await fetch(uploaded.url);
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get('etag'), uploaded.etag);
  assert.equal(await firstResponse.text(), 'cache me');

  const conditionalResponse = await fetch(uploaded.url, {
    headers: {
      'if-none-match': uploaded.etag,
    },
  });
  assert.equal(conditionalResponse.status, 304);
  assert.equal(conditionalResponse.headers.get('etag'), uploaded.etag);
  assert.equal(await conditionalResponse.text(), '');
});

test('browser CORS preflight allows direct blob uploads and reads', async () => {
  const response = await fetch(objectUrl('public', 'cors-preflight.txt'), {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type,x-content-type,x-allow-overwrite',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods'), /\bPUT\b/);
  assert.equal(response.headers.get('access-control-allow-headers'), 'content-type,x-content-type,x-allow-overwrite');
  assert.match(response.headers.get('access-control-expose-headers'), /\betag\b/);
});

test('browser CORS preflight allows client uploads to the local control plane', async () => {
  const requestedHeaders = [
    'authorization',
    'content-type',
    'x-api-blob-request-attempt',
    'x-api-blob-request-id',
    'x-api-version',
    'x-content-length',
    'x-content-type',
    'x-vercel-blob-access',
    'x-vercel-blob-store-id',
  ].join(',');
  const url = new URL(BASE_URL);
  url.searchParams.set('pathname', 'profile-images/originals/browser-upload.png');

  const response = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': requestedHeaders,
      'access-control-request-private-network': 'true',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods'), /\bPUT\b/);
  assert.equal(response.headers.get('access-control-allow-headers'), requestedHeaders);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
});

test('browser CORS headers are returned on object reads and errors', async () => {
  const uploaded = await put('sdk-cors-read.txt', 'cors body', {
    access: 'public',
    token: TEST_TOKEN,
  });

  const readResponse = await fetch(uploaded.url, {
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(readResponse.status, 200);
  assert.equal(readResponse.headers.get('access-control-allow-origin'), '*');
  assert.match(readResponse.headers.get('access-control-expose-headers'), /\betag\b/);
  assert.equal(readResponse.headers.get('etag'), uploaded.etag);

  const missingResponse = await fetch(`${BASE_URL}/missing-cors.txt`, {
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.headers.get('access-control-allow-origin'), '*');
});

test('returns metadata for head endpoint', async () => {
  await fetch(`${BASE_URL}/meta.txt`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    body: 'metadata',
  });
  const response = await fetch(`${BASE_URL}/?url=/meta.txt`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pathname, 'meta.txt');
  assert.equal(data.size, 8);
});

test('control-plane put copy list head and delete require read-write bearer auth', async () => {
  const source = await put('sdk-control-auth-source.txt', 'source', {
    access: 'public',
    token: TEST_TOKEN,
  });

  const unauthenticatedPut = await fetch(`${BASE_URL}/control-auth-direct.txt`, {
    method: 'PUT',
    body: 'direct',
  });
  assert.equal(unauthenticatedPut.status, 403);
  assert.equal((await unauthenticatedPut.json()).error.code, 'forbidden');

  const wrongBearerPut = await fetch(`${BASE_URL}/control-auth-wrong.txt`, {
    method: 'PUT',
    headers: { authorization: 'Bearer wrong-token' },
    body: 'direct',
  });
  assert.equal(wrongBearerPut.status, 403);

  const fakeClientTokenPut = await fetch(`${BASE_URL}/control-auth-fake-client.txt`, {
    method: 'PUT',
    headers: { authorization: 'Bearer vercel_blob_client_test_fake' },
    body: 'direct',
  });
  assert.equal(fakeClientTokenPut.status, 403);

  const copyUrl = new URL(BASE_URL);
  copyUrl.searchParams.set('pathname', 'control-auth-copy.txt');
  copyUrl.searchParams.set('fromUrl', source.url);
  assert.equal((await fetch(copyUrl, { method: 'PUT' })).status, 403);

  assert.equal((await fetch(BASE_URL)).status, 403);
  assert.equal((await fetch(`${BASE_URL}/?url=${encodeURIComponent(source.url)}`)).status, 403);
  assert.equal((await fetch(`${BASE_URL}/?pathname=${encodeURIComponent(source.pathname)}`, { method: 'DELETE' })).status, 403);

  const deleteResponse = await fetch(`${BASE_URL}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [source.url] }),
  });
  assert.equal(deleteResponse.status, 403);
});

test('multipart create upload and complete require write auth without presigned URL', async () => {
  const createUrl = `${BASE_URL}/mpu?pathname=sdk-control-auth-mpu.txt`;
  const unauthenticatedCreate = await fetch(createUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'create' },
  });
  assert.equal(unauthenticatedCreate.status, 403);

  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'x-mpu-action': 'create',
    },
  });
  assert.equal(createResponse.status, 200);
  const upload = await createResponse.json();

  const unauthenticatedUpload = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'x-mpu-action': 'upload',
      'x-mpu-upload-id': upload.uploadId,
      'x-mpu-part-number': '1',
    },
    body: 'part',
  });
  assert.equal(unauthenticatedUpload.status, 403);

  const unauthenticatedComplete = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'x-mpu-action': 'complete',
      'x-mpu-upload-id': upload.uploadId,
    },
    body: JSON.stringify([]),
  });
  assert.equal(unauthenticatedComplete.status, 403);
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

test('invalid presigned route signatures fail while presigned client upload generation works', async () => {
  await put('presigned-existing-public.txt', 'public baseline', {
    access: 'public',
    token: TEST_TOKEN,
  });

  const readResponse = await fetch(`${BASE_URL}/presigned-existing-public.txt?vercel-blob-delegation=demo&vercel-blob-signature=demo`);
  assert.equal(readResponse.status, 403);
  assert.equal((await readResponse.json()).error.code, 'forbidden');

  const uploadResponse = await fetch(`${BASE_URL}/?pathname=presigned.txt&vercel-blob-delegation=demo&vercel-blob-signature=demo`, {
    method: 'PUT',
    body: 'presigned',
  });
  assert.equal(uploadResponse.status, 403);
  assert.equal((await uploadResponse.json()).error.code, 'forbidden');

  const deleteResponse = await fetch(`${BASE_URL}/?pathname=presigned-existing-public.txt&vercel-blob-delegation=demo&vercel-blob-signature=demo`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 403);
  assert.equal((await deleteResponse.json()).error.code, 'forbidden');

  const clientUploadResponse = await fetch(`${BASE_URL}/client-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'blob.generate-presigned-url',
      payload: {
        pathname: 'presigned-client-generation.txt',
        clientPayload: 'generation-payload',
        multipart: false,
      },
    }),
  });
  assert.equal(clientUploadResponse.status, 200);
  const clientUploadBody = await clientUploadResponse.json();
  assert.equal(clientUploadBody.type, 'blob.generate-presigned-url');
  assert.ok(clientUploadBody.presignedUrlPayload.delegationToken);
  assert.ok(clientUploadBody.presignedUrlPayload.signature);
});

test('local signed token endpoint requires bearer auth and supports SDK issueSignedToken', async () => {
  const unauthorized = await fetch(`${BASE_URL}/signed-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pathname: 'private.txt' }),
  });
  assert.equal(unauthorized.status, 403);
  assert.equal((await unauthorized.json()).error.code, 'forbidden');

  const invalidLifetime = await fetch(`${BASE_URL}/signed-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ validUntil: Date.now() + 8 * 24 * 60 * 60 * 1000 }),
  });
  assert.equal(invalidLifetime.status, 400);

  const validUntil = Date.now() + 60_000;
  const issued = await issueSignedToken({
    pathname: 'signed/private.txt',
    operations: ['get', 'head', 'put', 'delete'],
    validUntil,
    allowedContentTypes: ['text/plain'],
    maximumSizeInBytes: 1024,
    token: TEST_TOKEN,
  });

  assert.equal(issued.validUntil, validUntil);
  assert.ok(issued.delegationToken.includes('.'));
  assert.match(issued.clientSigningToken, /^[A-Za-z0-9_-]+$/);

  const payload = verifyDelegationToken(issued.delegationToken);
  assert.equal(payload.storeId, TEST_STORE_ID);
  assert.equal(payload.ownerId, `local_${TEST_STORE_ID}_owner`);
  assert.equal(payload.pathname, 'signed/private.txt');
  assert.deepEqual(payload.operations, ['get', 'head', 'put', 'delete']);
  assert.equal(payload.validUntil, validUntil);
  assert.equal(payload.maximumSizeInBytes, 1024);
  assert.deepEqual(payload.allowedContentTypes, ['text/plain']);
});

test('local delegation token verification rejects malformed expired wrong-store and wrong-signature tokens', () => {
  assert.throws(() => decodeDelegationToken('not-a-token'), /Malformed delegation token/);
  assert.throws(() => verifyDelegationToken('not-a-token'), /Malformed delegation token/);

  assert.throws(
    () => issueLocalSignedToken({ validUntil: Date.now() + 8 * 24 * 60 * 60 * 1000 }),
    /seven days/
  );

  const issued = issueLocalSignedToken({
    pathname: '*',
    operations: ['get'],
    validUntil: Date.now() + 60_000,
  });
  const tampered = `${issued.delegationToken.slice(0, -1)}${issued.delegationToken.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => verifyDelegationToken(tampered), /signature/);

  assert.throws(
    () => verifyDelegationToken(issued.delegationToken, {
      ...resolveLocalConfig(),
      storeId: 'otherstore',
    }),
    /store/
  );

  const realNow = Date.now;
  try {
    const baseNow = realNow();
    Date.now = () => baseNow;
    const shortLived = issueLocalSignedToken({ validUntil: baseNow + 1 });
    Date.now = () => baseNow + 2;
    assert.throws(() => verifyDelegationToken(shortLived.delegationToken), /expired/);
  } finally {
    Date.now = realNow;
  }
});

test('presigned verification core accepts supported operations and canonical query constraints', () => {
  const now = Date.now();
  const operations = ['get', 'head', 'put', 'delete'];
  for (const operation of operations) {
    const pathname = `presigned-core-${operation}.txt`;
    const issued = issueLocalSignedToken({
      pathname,
      operations: [operation],
      validUntil: now + 60_000,
      allowedContentTypes: ['text/plain'],
      maximumSizeInBytes: 2048,
    });
    const entries = [
      ['vercel-blob-valid-until', String(now + 30_000)],
      ['vercel-blob-if-match', '"etag"'],
    ];
    if (operation === 'put') {
      entries.push(
        ['vercel-blob-maximum-size-in-bytes', '1024'],
        ['vercel-blob-allowed-content-types', 'text/plain'],
        ['vercel-blob-add-random-suffix', 'false'],
        ['vercel-blob-allow-overwrite', 'true'],
        ['vercel-blob-cache-control-max-age', '60'],
        ['vercel-blob-callback-url', 'http://localhost/callback'],
        ['vercel-blob-callback-token-payload', 'payload']
      );
    }

    const url = presignedUrlFor(operation, pathname, issued, entries);
    const context = verifyPresignedRequest(url, operation, { now });
    assert.equal(context.operation, operation);
    assert.equal(context.pathname, pathname);
    assert.equal(context.delegation.pathname, pathname);
    assert.equal(context.urlValidUntil, now + 30_000);
  }

  assert.deepEqual([...PRESIGN_CANONICAL_QUERY_KEYS].sort(), [...PRESIGN_CANONICAL_QUERY_KEYS]);
  assert.equal(
    canonicalString('z.txt', [['vercel-blob-valid-until', '1'], ['vercel-blob-allow-overwrite', 'true']], 'put'),
    'operation=put\npathname=z.txt\nvercel-blob-allow-overwrite=true\nvercel-blob-valid-until=1'
  );
});

test('presigned verification core rejects invalid signatures scopes expiry and missing params', () => {
  const now = Date.now();
  const exact = issueLocalSignedToken({
    pathname: 'exact.txt',
    operations: ['get'],
    validUntil: now + 60_000,
  });
  const exactUrl = presignedUrlFor('get', 'exact.txt', exact);
  assert.equal(verifyPresignedRequest(exactUrl, 'get', { now }).pathname, 'exact.txt');

  const wildcard = issueLocalSignedToken({
    pathname: '*',
    operations: ['get'],
    validUntil: now + 60_000,
  });
  assert.equal(
    verifyPresignedRequest(presignedUrlFor('get', 'wildcard.txt', wildcard), 'get', { now }).pathname,
    'wildcard.txt'
  );

  const missingSignature = new URL(exactUrl);
  missingSignature.searchParams.delete('vercel-blob-signature');
  assert.throws(() => verifyPresignedRequest(missingSignature, 'get', { now }), /signature/i);

  const missingDelegation = new URL(exactUrl);
  missingDelegation.searchParams.delete('vercel-blob-delegation');
  assert.throws(() => verifyPresignedRequest(missingDelegation, 'get', { now }), /delegation/i);

  assert.throws(() => verifyPresignedRequest(presignedUrlFor('get', 'other.txt', exact), 'get', { now }), /pathname/);
  assert.throws(() => verifyPresignedRequest(exactUrl, 'head', { now }), /head/);

  const wrongStoreUrl = new URL(exactUrl);
  wrongStoreUrl.hostname = `other.public.localhost`;
  assert.throws(() => verifyPresignedRequest(wrongStoreUrl, 'get', { now }), /store/);

  const expiredUrl = presignedUrlFor('get', 'exact.txt', exact, [['vercel-blob-valid-until', String(now - 1)]]);
  assert.throws(() => verifyPresignedRequest(expiredUrl, 'get', { now }), /expired/);

  const tooLongUrl = presignedUrlFor('get', 'exact.txt', exact, [['vercel-blob-valid-until', String(now + 120_000)]]);
  assert.throws(() => verifyPresignedRequest(tooLongUrl, 'get', { now }), /exceeds/);

  const tampered = presignedUrlFor('get', 'exact.txt', exact, [['vercel-blob-valid-until', String(now + 30_000)]]);
  tampered.searchParams.set('vercel-blob-valid-until', String(now + 30_001));
  assert.throws(() => verifyPresignedRequest(tampered, 'get', { now }), /signature/);

  const realNow = Date.now;
  try {
    Date.now = () => now;
    const expiredDelegation = issueLocalSignedToken({ pathname: 'expired.txt', operations: ['get'], validUntil: now + 1 });
    Date.now = () => now + 2;
    assert.throws(() => verifyPresignedRequest(presignedUrlFor('get', 'expired.txt', expiredDelegation), 'get'), /expired/);
  } finally {
    Date.now = realNow;
  }
});

test('real SDK client-token upload writes blobs and records upload-completed callbacks', async () => {
  const beforeEventsResponse = await fetch(`${BASE_URL}/client-upload-events`);
  assert.equal(beforeEventsResponse.status, 200);
  const beforeEvents = (await beforeEventsResponse.json()).completedUploads.length;

  const uploaded = await clientUpload('sdk-client-upload.txt', 'client upload body', {
    access: 'public',
    handleUploadUrl: `${BASE_URL}/client-upload`,
    contentType: 'text/plain',
    clientPayload: 'client-payload-baseline',
  });

  assert.equal(uploaded.pathname, 'sdk-client-upload.txt');
  assert.equal(uploaded.contentType, 'text/plain');
  assert.equal(await (await fetch(uploaded.url)).text(), 'client upload body');

  const afterEventsResponse = await fetch(`${BASE_URL}/client-upload-events`);
  assert.equal(afterEventsResponse.status, 200);
  const afterEvents = (await afterEventsResponse.json()).completedUploads;
  assert.equal(afterEvents.length, beforeEvents + 1);
  assert.equal(afterEvents.at(-1).payload.blob.pathname, 'sdk-client-upload.txt');
  assert.equal(
    JSON.parse(afterEvents.at(-1).payload.tokenPayload).clientPayload,
    'client-payload-baseline'
  );
});

test('real SDK multipart client-token upload writes blobs and records upload-completed callbacks', async () => {
  const beforeEvents = (await (await fetch(`${BASE_URL}/client-upload-events`)).json()).completedUploads.length;

  const uploaded = await clientUpload('sdk-client-upload-multipart.txt', 'client multipart body', {
    access: 'public',
    handleUploadUrl: `${BASE_URL}/client-upload`,
    contentType: 'text/plain',
    clientPayload: 'client-multipart-payload',
    multipart: true,
  });

  assert.equal(uploaded.pathname, 'sdk-client-upload-multipart.txt');
  assert.equal(uploaded.contentType, 'text/plain');
  assert.equal(await (await fetch(uploaded.url)).text(), 'client multipart body');

  const afterEvents = (await (await fetch(`${BASE_URL}/client-upload-events`)).json()).completedUploads;
  assert.equal(afterEvents.length, beforeEvents + 1);
  const latestPayload = afterEvents.at(-1).payload;
  assert.equal(latestPayload.blob.pathname, 'sdk-client-upload-multipart.txt');
  assert.equal(JSON.parse(latestPayload.tokenPayload).clientPayload, 'client-multipart-payload');
  assert.equal(JSON.parse(latestPayload.tokenPayload).multipart, true);
});

test('multipart client-token auth rejects fake expired and wrong-path tokens', async () => {
  const fakeResponse = await fetch(`${BASE_URL}/mpu?pathname=sdk-client-mpu-fake.txt`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer vercel_blob_client_test_fake',
      'x-mpu-action': 'create',
    },
  });
  assert.equal(fakeResponse.status, 403);

  const expiredToken = await generateClientTokenFromReadWriteToken({
    token: TEST_TOKEN,
    pathname: 'sdk-client-mpu-expired.txt',
    validUntil: Date.now() - 1,
  });
  const expiredResponse = await fetch(`${BASE_URL}/mpu?pathname=sdk-client-mpu-expired.txt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${expiredToken}`,
      'x-mpu-action': 'create',
    },
  });
  assert.equal(expiredResponse.status, 403);

  const wrongPathToken = await generateClientTokenFromReadWriteToken({
    token: TEST_TOKEN,
    pathname: 'sdk-client-mpu-other.txt',
    validUntil: Date.now() + 60_000,
  });
  const wrongPathResponse = await fetch(`${BASE_URL}/mpu?pathname=sdk-client-mpu-wrong-path.txt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${wrongPathToken}`,
      'x-mpu-action': 'create',
    },
  });
  assert.equal(wrongPathResponse.status, 403);
});

test('uploadPresigned single-part uploads and records callback payloads', async () => {
  const beforeEvents = (await (await fetch(`${BASE_URL}/client-upload-events`)).json()).completedUploads.length;

  const uploaded = await uploadPresigned('sdk-upload-presigned-single.txt', 'presigned single body', {
    access: 'public',
    handleUploadUrl: `${BASE_URL}/client-upload`,
    contentType: 'text/plain',
    clientPayload: 'presigned-single-payload',
  });

  assert.equal(uploaded.pathname, 'sdk-upload-presigned-single.txt');
  assert.equal(uploaded.contentType, 'text/plain');
  assert.equal(await (await fetch(uploaded.url)).text(), 'presigned single body');

  const afterEvents = (await (await fetch(`${BASE_URL}/client-upload-events`)).json()).completedUploads;
  assert.equal(afterEvents.length, beforeEvents + 1);
  const latestPayload = afterEvents.at(-1).payload;
  assert.equal(latestPayload.blob.pathname, 'sdk-upload-presigned-single.txt');
  assert.equal(JSON.parse(latestPayload.tokenPayload).clientPayload, 'presigned-single-payload');
  assert.equal(JSON.parse(latestPayload.tokenPayload).multipart, false);
});

test('uploadPresigned multipart uploads and records callback payloads', async () => {
  const beforeEvents = (await (await fetch(`${BASE_URL}/client-upload-events`)).json()).completedUploads.length;

  const uploaded = await uploadPresigned('sdk-upload-presigned-multipart.txt', 'presigned multipart body', {
    access: 'public',
    handleUploadUrl: `${BASE_URL}/client-upload`,
    contentType: 'text/plain',
    clientPayload: 'presigned-multipart-payload',
    multipart: true,
  });

  assert.equal(uploaded.pathname, 'sdk-upload-presigned-multipart.txt');
  assert.equal(uploaded.contentType, 'text/plain');
  assert.equal(await (await fetch(uploaded.url)).text(), 'presigned multipart body');

  const afterEvents = (await (await fetch(`${BASE_URL}/client-upload-events`)).json()).completedUploads;
  assert.equal(afterEvents.length, beforeEvents + 1);
  const latestPayload = afterEvents.at(-1).payload;
  assert.equal(latestPayload.blob.pathname, 'sdk-upload-presigned-multipart.txt');
  assert.equal(JSON.parse(latestPayload.tokenPayload).clientPayload, 'presigned-multipart-payload');
  assert.equal(JSON.parse(latestPayload.tokenPayload).multipart, true);
});

test('public object GET, HEAD, and downloadUrl remain unauthenticated', async () => {
  const blob = await put('sdk-public-object-auth.txt', 'public object auth', {
    access: 'public',
    token: TEST_TOKEN,
  });

  const getResponse = await fetch(blob.url);
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), 'public object auth');

  const headResponse = await fetch(blob.url, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('etag'), blob.etag);
  assert.equal(headResponse.headers.get('content-length'), String('public object auth'.length));
  assert.equal(await headResponse.text(), '');

  const downloadResponse = await fetch(blob.downloadUrl);
  assert.equal(downloadResponse.status, 200);
  assert.equal(await downloadResponse.text(), 'public object auth');
});

test('private object GET, HEAD, and downloadUrl require read-write bearer auth', async () => {
  const blob = await put('sdk-private-local.txt', 'secret locally', {
    access: 'private',
    token: TEST_TOKEN,
  });

  const metadataResponse = await fetch(`${BASE_URL}/?url=/sdk-private-local.txt`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(metadataResponse.status, 200);
  assert.equal((await metadataResponse.json()).access, 'private');

  const unauthenticatedRead = await fetch(blob.url);
  assert.equal(unauthenticatedRead.status, 403);
  assert.equal((await unauthenticatedRead.json()).error.code, 'forbidden');

  const wrongBearerRead = await fetch(blob.url, {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(wrongBearerRead.status, 403);

  const authenticatedRead = await fetch(blob.url, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(authenticatedRead.status, 200);
  assert.equal(authenticatedRead.headers.get('etag'), blob.etag);
  assert.equal(await authenticatedRead.text(), 'secret locally');

  const unauthenticatedHead = await fetch(blob.url, { method: 'HEAD' });
  assert.equal(unauthenticatedHead.status, 403);

  const authenticatedHead = await fetch(blob.url, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(authenticatedHead.status, 200);
  assert.equal(authenticatedHead.headers.get('etag'), blob.etag);
  assert.equal(await authenticatedHead.text(), '');

  const unauthenticatedDownload = await fetch(blob.downloadUrl);
  assert.equal(unauthenticatedDownload.status, 403);

  const authenticatedDownload = await fetch(blob.downloadUrl, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(authenticatedDownload.status, 200);
  assert.equal(authenticatedDownload.headers.get('content-disposition'), 'attachment; filename="sdk-private-local.txt"');
  assert.equal(await authenticatedDownload.text(), 'secret locally');

  const conditionalRead = await fetch(blob.url, {
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'if-none-match': blob.etag,
    },
  });
  assert.equal(conditionalRead.status, 304);
  assert.equal(conditionalRead.headers.get('etag'), blob.etag);
  assert.equal(await conditionalRead.text(), '');

  const missingPrivateResponse = await fetch(objectUrl('private', 'missing-private-object.txt'));
  assert.equal(missingPrivateResponse.status, 404);
  assert.equal((await missingPrivateResponse.json()).error.code, 'not_found');
});

test('presigned PUT writes blobs and maps write constraints', async () => {
  const pathname = 'sdk-presigned-put.txt';
  const token = issueLocalSignedToken({
    pathname,
    operations: ['put'],
    validUntil: Date.now() + 60_000,
    allowedContentTypes: ['text/plain'],
    maximumSizeInBytes: 100,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'public',
    allowedContentTypes: ['text/plain'],
    maximumSizeInBytes: 50,
    allowOverwrite: true,
    addRandomSuffix: true,
    cacheControlMaxAge: 120,
  });

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: new Blob(['presigned put body'], { type: 'text/plain' }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.notEqual(data.pathname, pathname);
  assert.match(data.pathname, /^sdk-presigned-put-[A-Za-z0-9_-]+\.txt$/);
  assert.equal(data.contentType, 'text/plain');
  assert.equal(await (await fetch(data.url)).text(), 'presigned put body');
  const metadata = await head(data.url, { token: TEST_TOKEN });
  assert.equal(metadata.cacheControl, 'max-age=120');

  const overwriteToken = issueLocalSignedToken({ pathname: data.pathname, operations: ['put'], validUntil: Date.now() + 60_000 });
  const { presignedUrl: overwriteUrl } = await presignUrl(overwriteToken, {
    operation: 'put',
    pathname: data.pathname,
    access: 'public',
    allowOverwrite: true,
    ifMatch: data.etag,
  });
  const overwriteResponse = await fetch(overwriteUrl, {
    method: 'PUT',
    body: 'overwritten via presign',
  });
  assert.equal(overwriteResponse.status, 200);
  assert.equal((await overwriteResponse.json()).pathname, data.pathname);
  assert.equal(await (await fetch(data.url)).text(), 'overwritten via presign');
});

test('presigned PUT rejects oversized disallowed overwrite etag tampered and expired URLs', async () => {
  const constrained = issueLocalSignedToken({
    pathname: 'sdk-presigned-put-negative.txt',
    operations: ['put'],
    validUntil: Date.now() + 60_000,
    allowedContentTypes: ['text/plain'],
    maximumSizeInBytes: 4,
  });
  const { presignedUrl: oversizedUrl } = await presignUrl(constrained, {
    operation: 'put',
    pathname: 'sdk-presigned-put-negative.txt',
    access: 'public',
    allowOverwrite: true,
  });
  assert.equal((await fetch(oversizedUrl, { method: 'PUT', body: 'too large', headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await fetch(oversizedUrl, { method: 'PUT', body: 'json', headers: { 'content-type': 'application/json' } })).status, 403);

  const existing = await put('sdk-presigned-put-existing.txt', 'existing', { access: 'public', token: TEST_TOKEN });
  const noOverwriteToken = issueLocalSignedToken({ pathname: existing.pathname, operations: ['put'], validUntil: Date.now() + 60_000 });
  const { presignedUrl: noOverwriteUrl } = await presignUrl(noOverwriteToken, {
    operation: 'put',
    pathname: existing.pathname,
    access: 'public',
  });
  assert.equal((await fetch(noOverwriteUrl, { method: 'PUT', body: 'new' })).status, 412);

  const staleToken = issueLocalSignedToken({ pathname: existing.pathname, operations: ['put'], validUntil: Date.now() + 60_000 });
  const { presignedUrl: staleUrl } = await presignUrl(staleToken, {
    operation: 'put',
    pathname: existing.pathname,
    access: 'public',
    allowOverwrite: true,
    ifMatch: '"stale"',
  });
  assert.equal((await fetch(staleUrl, { method: 'PUT', body: 'new' })).status, 412);

  const now = Date.now();
  const tamperToken = issueLocalSignedToken({ pathname: 'sdk-presigned-put-tamper.txt', operations: ['put'], validUntil: now + 60_000 });
  const tampered = presignedUrlFor('put', 'sdk-presigned-put-tamper.txt', tamperToken, [['vercel-blob-allow-overwrite', 'true']]);
  tampered.searchParams.set('vercel-blob-allow-overwrite', 'false');
  assert.equal((await fetch(tampered, { method: 'PUT', body: 'tampered' })).status, 403);

  const expired = presignedUrlFor('put', 'sdk-presigned-put-expired.txt', tamperToken, [['vercel-blob-valid-until', String(now - 1)]]);
  assert.equal((await fetch(expired, { method: 'PUT', body: 'expired' })).status, 403);
});

test('presigned GET and HEAD read private objects without bearer auth', async () => {
  const getBlobResult = await put('sdk-presigned-get-private.txt', 'presigned get body', {
    access: 'private',
    token: TEST_TOKEN,
  });
  const headBlobResult = await put('sdk-presigned-head-private.txt', 'presigned head body', {
    access: 'private',
    token: TEST_TOKEN,
  });

  const getToken = issueLocalSignedToken({
    pathname: getBlobResult.url,
    operations: ['get'],
    validUntil: Date.now() + 60_000,
  });
  const { presignedUrl: fullLocalPresignedGetUrl } = await presignUrl(getToken, {
    operation: 'get',
    pathname: getBlobResult.url,
    access: 'private',
  });

  const getResponse = await fetch(fullLocalPresignedGetUrl);
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), 'presigned get body');

  const headToken = issueLocalSignedToken({
    pathname: 'sdk-presigned-head-private.txt',
    operations: ['head'],
    validUntil: Date.now() + 60_000,
  });
  const headUrl = presignedUrlFor('head', 'sdk-presigned-head-private.txt', headToken);
  const headResponse = await fetch(headUrl, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('etag'), headBlobResult.etag);
  assert.equal(await headResponse.text(), '');
});

test('presigned GET and HEAD reject tampering expiry wrong operation pathname and store', async () => {
  const target = await put('sdk-presigned-negative-target.txt', 'negative target', {
    access: 'private',
    token: TEST_TOKEN,
  });
  await put('sdk-presigned-negative-other.txt', 'negative other', {
    access: 'private',
    token: TEST_TOKEN,
  });

  const now = Date.now();
  const getToken = issueLocalSignedToken({
    pathname: target.pathname,
    operations: ['get'],
    validUntil: now + 60_000,
  });

  const tampered = presignedUrlFor('get', target.pathname, getToken, [['vercel-blob-valid-until', String(now + 30_000)]]);
  tampered.searchParams.set('vercel-blob-valid-until', String(now + 30_001));
  const tamperedResponse = await fetch(tampered);
  assert.equal(tamperedResponse.status, 403);

  const expired = presignedUrlFor('get', target.pathname, getToken, [['vercel-blob-valid-until', String(now - 1)]]);
  const expiredResponse = await fetch(expired);
  assert.equal(expiredResponse.status, 403);

  const wrongOperationResponse = await fetch(presignedUrlFor('get', target.pathname, getToken), { method: 'HEAD' });
  assert.equal(wrongOperationResponse.status, 403);

  const wrongPathResponse = await fetch(presignedUrlFor('get', 'sdk-presigned-negative-other.txt', getToken));
  assert.equal(wrongPathResponse.status, 403);

  const wrongStoreUrl = presignedUrlFor('get', target.pathname, getToken);
  wrongStoreUrl.hostname = `other.private.localhost`;
  const wrongStoreResponse = await fetch(wrongStoreUrl);
  assert.equal(wrongStoreResponse.status, 403);
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

test('presigned multipart create upload and complete works without bearer auth', async () => {
  const pathname = 'sdk-presigned-multipart.txt';
  const entries = [
    ['vercel-blob-allowed-content-types', 'text/plain'],
    ['vercel-blob-maximum-size-in-bytes', '50'],
    ['vercel-blob-allow-overwrite', 'true'],
    ['vercel-blob-cache-control-max-age', '90'],
  ];
  const token = issueLocalSignedToken({
    pathname,
    operations: ['put'],
    validUntil: Date.now() + 60_000,
    allowedContentTypes: ['text/plain'],
    maximumSizeInBytes: 100,
  });
  const url = presignedMultipartUrlFor(pathname, token, entries);

  const createResponse = await fetch(url, {
    method: 'POST',
    headers: { 'x-mpu-action': 'create', 'content-type': 'text/plain' },
  });
  assert.equal(createResponse.status, 200);
  const upload = await createResponse.json();
  assert.equal(upload.key, pathname);

  const firstPart = await fetch(url, {
    method: 'POST',
    headers: {
      'x-mpu-action': 'upload',
      'x-mpu-upload-id': upload.uploadId,
      'x-mpu-part-number': '1',
    },
    body: 'hello ',
  });
  assert.equal(firstPart.status, 200);
  const first = await firstPart.json();

  const secondPart = await fetch(url, {
    method: 'POST',
    headers: {
      'x-mpu-action': 'upload',
      'x-mpu-upload-id': upload.uploadId,
      'x-mpu-part-number': '2',
    },
    body: 'presigned multipart',
  });
  assert.equal(secondPart.status, 200);
  const second = await secondPart.json();

  const completeResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'x-mpu-action': 'complete',
      'x-mpu-upload-id': upload.uploadId,
    },
    body: JSON.stringify([second, first]),
  });
  assert.equal(completeResponse.status, 200);
  const completed = await completeResponse.json();
  assert.equal(completed.pathname, pathname);
  assert.equal(completed.contentType, 'text/plain');
  assert.equal(await (await fetch(completed.url)).text(), 'hello presigned multipart');
  assert.equal((await head(completed.url, { token: TEST_TOKEN })).cacheControl, 'max-age=90');
});

test('presigned multipart completion enforces overwrite ifMatch content type and size constraints', async () => {
  const existing = await put('sdk-presigned-multipart-existing.txt', 'existing', { access: 'public', token: TEST_TOKEN });
  const noOverwriteToken = issueLocalSignedToken({ pathname: existing.pathname, operations: ['put'], validUntil: Date.now() + 60_000 });
  const noOverwriteUrl = presignedMultipartUrlFor(existing.pathname, noOverwriteToken);
  const noOverwriteUpload = await (await fetch(noOverwriteUrl, { method: 'POST', headers: { 'x-mpu-action': 'create' } })).json();
  const noOverwritePart = await (await fetch(noOverwriteUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'upload', 'x-mpu-upload-id': noOverwriteUpload.uploadId, 'x-mpu-part-number': '1' },
    body: 'new',
  })).json();
  assert.equal((await fetch(noOverwriteUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'complete', 'x-mpu-upload-id': noOverwriteUpload.uploadId },
    body: JSON.stringify([noOverwritePart]),
  })).status, 412);

  const staleUrl = presignedMultipartUrlFor(existing.pathname, noOverwriteToken, [
    ['vercel-blob-allow-overwrite', 'true'],
    ['vercel-blob-if-match', '"stale"'],
  ]);
  const staleUpload = await (await fetch(staleUrl, { method: 'POST', headers: { 'x-mpu-action': 'create' } })).json();
  const stalePart = await (await fetch(staleUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'upload', 'x-mpu-upload-id': staleUpload.uploadId, 'x-mpu-part-number': '1' },
    body: 'new',
  })).json();
  assert.equal((await fetch(staleUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'complete', 'x-mpu-upload-id': staleUpload.uploadId },
    body: JSON.stringify([stalePart]),
  })).status, 412);

  const constrained = issueLocalSignedToken({
    pathname: 'sdk-presigned-multipart-constrained.txt',
    operations: ['put'],
    validUntil: Date.now() + 60_000,
    allowedContentTypes: ['text/plain'],
    maximumSizeInBytes: 4,
  });
  const constrainedUrl = presignedMultipartUrlFor('sdk-presigned-multipart-constrained.txt', constrained);
  const constrainedUpload = await (await fetch(constrainedUrl, { method: 'POST', headers: { 'x-mpu-action': 'create', 'content-type': 'application/json' } })).json();
  const constrainedPart = await (await fetch(constrainedUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'upload', 'x-mpu-upload-id': constrainedUpload.uploadId, 'x-mpu-part-number': '1' },
    body: 'too large',
  })).json();
  assert.equal((await fetch(constrainedUrl, {
    method: 'POST',
    headers: { 'x-mpu-action': 'complete', 'x-mpu-upload-id': constrainedUpload.uploadId },
    body: JSON.stringify([constrainedPart]),
  })).status, 403);
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
  assert.equal(suffixed.url, objectUrl('public', suffixed.pathname));
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
  assert.equal(folder.url, objectUrl('public', 'sdk-folder/'));

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

test('presigned DELETE deletes scoped blob and honors ifMatch', async () => {
  const target = await put('sdk-presigned-delete.txt', 'delete me', {
    access: 'public',
    token: TEST_TOKEN,
  });
  const staleToken = issueLocalSignedToken({ pathname: target.pathname, operations: ['delete'], validUntil: Date.now() + 60_000 });
  const staleUrl = presignedUrlFor('delete', target.pathname, staleToken, [['vercel-blob-if-match', '"stale"']]);
  const staleResponse = await fetch(staleUrl, { method: 'DELETE' });
  assert.equal(staleResponse.status, 412);
  assert.equal((await staleResponse.json()).error.code, 'precondition_failed');

  const token = issueLocalSignedToken({ pathname: target.pathname, operations: ['delete'], validUntil: Date.now() + 60_000 });
  const deleteUrl = presignedUrlFor('delete', target.pathname, token, [['vercel-blob-if-match', target.etag]]);
  const response = await fetch(deleteUrl, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);

  await assert.rejects(
    () => head(target.url, { token: TEST_TOKEN }),
    BlobNotFoundError
  );
});

test('presigned DELETE rejects wrong operation pathname expiry tampering and missing blobs', async () => {
  const target = await put('sdk-presigned-delete-negative.txt', 'delete negative', {
    access: 'public',
    token: TEST_TOKEN,
  });
  await put('sdk-presigned-delete-other.txt', 'delete other', {
    access: 'public',
    token: TEST_TOKEN,
  });

  const now = Date.now();
  const token = issueLocalSignedToken({ pathname: target.pathname, operations: ['delete'], validUntil: now + 60_000 });
  const wrongOperationToken = issueLocalSignedToken({ pathname: target.pathname, operations: ['get'], validUntil: now + 60_000 });
  const wrongOperationUrl = addPresignedParams(new URL(`${BASE_URL}/?pathname=${encodeURIComponent(target.pathname)}`), 'get', target.pathname, wrongOperationToken, []);
  assert.equal((await fetch(wrongOperationUrl, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(presignedUrlFor('delete', 'sdk-presigned-delete-other.txt', token), { method: 'DELETE' })).status, 403);

  const expired = presignedUrlFor('delete', target.pathname, token, [['vercel-blob-valid-until', String(now - 1)]]);
  assert.equal((await fetch(expired, { method: 'DELETE' })).status, 403);

  const tampered = presignedUrlFor('delete', target.pathname, token, [['vercel-blob-if-match', target.etag]]);
  tampered.searchParams.set('vercel-blob-if-match', '"tampered"');
  assert.equal((await fetch(tampered, { method: 'DELETE' })).status, 403);

  const missingToken = issueLocalSignedToken({ pathname: 'sdk-presigned-delete-missing.txt', operations: ['delete'], validUntil: now + 60_000 });
  const missingResponse = await fetch(presignedUrlFor('delete', 'sdk-presigned-delete-missing.txt', missingToken), { method: 'DELETE' });
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'not_found');
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

function objectUrl(access, pathname) {
  return `http://${TEST_STORE_ID}.${access}.localhost:${TEST_PORT}/${pathname}`;
}

function presignedUrlFor(operation, pathname, issued, entries = []) {
  const url = operation === 'get' || operation === 'head'
    ? new URL(objectUrl('private', pathname))
    : new URL(`${BASE_URL}/?pathname=${encodeURIComponent(pathname)}`);

  return addPresignedParams(url, operation, pathname, issued, entries);
}

function presignedMultipartUrlFor(pathname, issued, entries = []) {
  return addPresignedParams(new URL(`${BASE_URL}/mpu?pathname=${encodeURIComponent(pathname)}`), 'put', pathname, issued, entries);
}

function addPresignedParams(url, operation, pathname, issued, entries) {
  for (const [key, value] of entries) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('vercel-blob-delegation', issued.delegationToken);
  url.searchParams.set(
    'vercel-blob-signature',
    signPresignedUrl(issued.clientSigningToken, pathname, operation, entries)
  );
  return url;
}

function fetchWithLocalhostObjectPlane(input, init) {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
  if (!url.hostname.endsWith('.localhost')) {
    return originalFetch(input, init);
  }

  const originalHost = url.host;
  url.hostname = 'localhost';
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('host', originalHost);
  headers.set('x-forwarded-host', originalHost);

  if (input instanceof Request) {
    return originalFetch(new Request(url, input), { ...init, headers });
  }

  return originalFetch(url, { ...init, headers });
}

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
