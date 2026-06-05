import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const TEST_PORT = 3001;
const TEST_STORE_PATH = '.test-store';
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server;

before(async () => {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  server = spawn('node', ['dist/server.cjs'], {
    env: { ...process.env, PORT: String(TEST_PORT), VERCEL_STORE_PATH: TEST_STORE_PATH },
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
