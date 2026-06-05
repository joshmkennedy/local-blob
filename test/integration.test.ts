import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const TEST_PORT = 3001;
const TEST_STORE_PATH = '.test-store';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TOKEN = 'vercel_blob_rw_teststore_nonce';

let server: any;

beforeAll(async () => {
  // Clean up test store if it exists
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }

  // Start server with test configuration
  process.env.VERCEL_STORE_PATH = TEST_STORE_PATH;
  server = Bun.spawn(['bun', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      VERCEL_STORE_PATH: TEST_STORE_PATH,
      BLOB_READ_WRITE_TOKEN: TOKEN,
    },
    stderr: 'inherit',
  });

  await waitForServer();
});

afterAll(() => {
  // Kill server
  server?.kill();
  
  // Clean up test store
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
});

describe('Vercel Blob Server Integration Tests', () => {
  test('PUT - should upload a file', async () => {
    const content = 'Hello, World!';
    const blob = new Blob([content], { type: 'text/plain' });
    
    const response = await fetch(`${BASE_URL}/test-file.txt`, {
      method: 'PUT',
      body: blob,
      headers: {
        'X-Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="test-file.txt"',
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pathname).toBe('test-file.txt');
    expect(data.contentType).toBe('text/plain');
  });

  test('GET - should retrieve an uploaded file', async () => {
    // First upload a file
    const content = 'Test content for GET';
    const blob = new Blob([content], { type: 'text/plain' });
    
    await fetch(`${BASE_URL}/get-test.txt`, {
      method: 'PUT',
      body: blob,
    });

    // Now GET the file
    const response = await fetch(`${BASE_URL}/get-test.txt`);
    
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain;charset=utf-8');
    const text = await response.text();
    expect(text).toBe(content);
  });

  test('GET with download=1 - should include Content-Disposition header', async () => {
    // First upload a file
    const content = 'Download test';
    const blob = new Blob([content], { type: 'text/plain' });
    
    await fetch(`${BASE_URL}/download-test.txt`, {
      method: 'PUT',
      body: blob,
      headers: {
        'Content-Disposition': 'attachment; filename="download-test.txt"',
      },
    });

    // GET with download parameter
    const response = await fetch(`${BASE_URL}/download-test.txt?download=1`);
    
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBeTruthy();
  });

  test('HEAD - should return file metadata', async () => {
    // First upload a file
    const content = 'HEAD test content';
    const blob = new Blob([content], { type: 'text/plain' });
    
    await fetch(`${BASE_URL}/head-test.txt`, {
      method: 'PUT',
      body: blob,
    });

    // HEAD request using the API format
    const response = await fetch(`${BASE_URL}/?url=/head-test.txt`);
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pathname).toBe('head-test.txt');
    expect(data.size).toBe(content.length);
  });

  test('COPY - should copy a file to a new location', async () => {
    // First upload a file
    const content = 'File to be copied';
    const blob = new Blob([content], { type: 'text/plain' });
    
    await fetch(`${BASE_URL}/original.txt`, {
      method: 'PUT',
      body: blob,
    });

    // Copy the file
    const response = await fetch(`${BASE_URL}/copied.txt?fromUrl=/original.txt`, {
      method: 'PUT',
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pathname).toBe('copied.txt');

    // Verify the copied file exists
    const getResponse = await fetch(`${BASE_URL}/copied.txt`);
    expect(getResponse.status).toBe(200);
    const copiedContent = await getResponse.text();
    expect(copiedContent).toBe(content);
  });

  test('DELETE - should delete a file', async () => {
    // First upload a file
    const content = 'File to be deleted';
    const blob = new Blob([content], { type: 'text/plain' });
    
    await fetch(`${BASE_URL}/delete-me.txt`, {
      method: 'PUT',
      body: blob,
    });

    // Verify file exists
    let response = await fetch(`${BASE_URL}/delete-me.txt`);
    expect(response.status).toBe(200);

    // Delete the file using the API format
    response = await fetch(`${BASE_URL}/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        urls: [`${BASE_URL}/delete-me.txt`]
      }),
    });
    expect(response.status).toBe(200);

    // Verify file is deleted
    response = await fetch(`${BASE_URL}/delete-me.txt`);
    expect(response.status).toBe(404);
  });

  test('GET - should return 404 for non-existent file', async () => {
    const response = await fetch(`${BASE_URL}/non-existent.txt`);
    expect(response.status).toBe(404);
  });

  test('COPY - should return 404 when source file does not exist', async () => {
    const response = await fetch(`${BASE_URL}/destination.txt?fromUrl=/non-existent-source.txt`, {
      method: 'PUT',
    });
    expect(response.status).toBe(404);
  });

  test('PUT - should handle cache control headers', async () => {
    const content = 'Cache control test';
    const blob = new Blob([content], { type: 'text/plain' });
    
    const response = await fetch(`${BASE_URL}/cache-test.txt`, {
      method: 'PUT',
      body: blob,
      headers: {
        'x-cache-control-max-age': '3600',
      },
    });

    expect(response.status).toBe(200);

    // Verify cache control is set
    const getResponse = await fetch(`${BASE_URL}/cache-test.txt`);
    expect(getResponse.headers.get('Cache-Control')).toBe('max-age=3600');
  });

  test('PUT - should create nested directories', async () => {
    const content = 'Nested directory test';
    const blob = new Blob([content], { type: 'text/plain' });
    
    const response = await fetch(`${BASE_URL}/nested/dir/test.txt`, {
      method: 'PUT',
      body: blob,
    });

    expect(response.status).toBe(200);

    // Verify file exists in nested directory
    const getResponse = await fetch(`${BASE_URL}/nested/dir/test.txt`);
    expect(getResponse.status).toBe(200);
    const text = await getResponse.text();
    expect(text).toBe(content);
  });

  test('LIST - should paginate blobs with a cursor', async () => {
    await Promise.all([
      putText('list-page/a.txt', 'a'),
      putText('list-page/b.txt', 'b'),
      putText('list-page/c.txt', 'c'),
    ]);

    const firstResponse = await fetch(`${BASE_URL}/?prefix=list-page/&limit=2`);
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json();

    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.cursor).toBeTruthy();
    expect(firstPage.blobs.map((blob: any) => blob.pathname)).toEqual([
      'list-page/a.txt',
      'list-page/b.txt',
    ]);

    const secondResponse = await fetch(`${BASE_URL}/?prefix=list-page/&limit=2&cursor=${encodeURIComponent(firstPage.cursor)}`);
    expect(secondResponse.status).toBe(200);
    const secondPage = await secondResponse.json();

    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.cursor).toBeUndefined();
    expect(secondPage.blobs.map((blob: any) => blob.pathname)).toEqual(['list-page/c.txt']);
  });

  test('LIST folded - should return direct blobs and child folders', async () => {
    await Promise.all([
      putText('folded/root.txt', 'root'),
      putText('folded/child/a.txt', 'a'),
      putText('folded/child/b.txt', 'b'),
      putText('folded/other/c.txt', 'c'),
    ]);

    const response = await fetch(`${BASE_URL}/?prefix=folded/&mode=folded`);
    expect(response.status).toBe(200);
    const page = await response.json();

    expect(page.hasMore).toBe(false);
    expect(page.folders).toEqual(['folded/child/', 'folded/other/']);
    expect(page.blobs.map((blob: any) => blob.pathname)).toEqual(['folded/root.txt']);
  });

  test('PUT with client token - should call upload-completed callback', async () => {
    const before = await fetch(`${BASE_URL}/client-upload-events`).then((response) => response.json());
    const token = createClientToken(`${BASE_URL}/client-upload`, 'callback-ok');

    const response = await fetch(`${BASE_URL}/client-callback-ok.txt`, {
      method: 'PUT',
      body: new Blob(['callback ok'], { type: 'text/plain' }),
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);

    const after = await fetch(`${BASE_URL}/client-upload-events`).then((response) => response.json());
    expect(after.completedUploads.length).toBe(before.completedUploads.length + 1);
    expect(after.completedUploads.at(-1).payload.tokenPayload).toBe('callback-ok');
  });

  test('PUT with client token - should fail when upload-completed callback fails', async () => {
    const token = createClientToken(`${BASE_URL}/missing-callback`, 'callback-fail');

    const response = await fetch(`${BASE_URL}/client-callback-fail.txt`, {
      method: 'PUT',
      body: new Blob(['callback fail'], { type: 'text/plain' }),
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Client upload callback failed');
  });

  test('Path normalization - should reject encoded traversal', async () => {
    const response = await fetch(`${BASE_URL}/?pathname=safe%2F..%2Fevil.txt`, {
      method: 'PUT',
      body: new Blob(['evil'], { type: 'text/plain' }),
    });

    expect(response.status).toBe(400);
  });

  test('LIST - should reject invalid cursors', async () => {
    const response = await fetch(`${BASE_URL}/?cursor=not-a-valid-cursor`);

    expect(response.status).toBe(400);
  });
});

async function putText(pathname: string, content: string) {
  const response = await fetch(`${BASE_URL}/${pathname}`, {
    method: 'PUT',
    body: new Blob([content], { type: 'text/plain' }),
  });

  expect(response.status).toBe(200);
}

function createClientToken(callbackUrl: string, tokenPayload: string) {
  const payload = {
    onUploadCompleted: {
      callbackUrl,
      tokenPayload,
    },
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const encodedToken = Buffer.from(`local-header.${encodedPayload}.local-signature`, 'utf8').toString('base64url');

  return `vercel_blob_client_local_${encodedToken}`;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      await Bun.sleep(100);
    }
  }

  throw new Error(`Prototype server did not start at ${BASE_URL}`);
}
