import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { copy, del, head, list, put } from '@vercel/blob';

const port = 9966;
const token = 'vercel_blob_rw_localstore_nonce';
const server = spawn('node', ['dist/server.cjs'], {
  env: {
    ...process.env,
    PORT: String(port),
    VERCEL_STORE_PATH: '.local-blob-store',
    BLOB_READ_WRITE_TOKEN: token,
    VERCEL_BLOB_API_URL: `http://localhost:${port}`,
  },
  stdio: 'inherit',
});

try {
  await waitForServer(`http://localhost:${port}`);

  const uploaded = await put('demo/hello.txt', 'hello local blob', {
    access: 'public',
    token,
  });
  console.log('put', uploaded);
  console.log('head', await head(uploaded.pathname, { token }));
  const getResponse = await fetch(uploaded.url);
  if (!getResponse.ok) {
    throw new Error(`Failed to fetch uploaded blob: ${getResponse.status} ${getResponse.statusText}`);
  }
  console.log('get', await getResponse.text());
  console.log('list', await list({ prefix: 'demo/', token }));
  console.log('copy', await copy(uploaded.pathname, 'demo/copied.txt', { access: 'public', token }));
  await del([uploaded.pathname, 'demo/copied.txt'], { token });
  console.log('deleted demo blobs');
} finally {
  server.kill();
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('Timed out waiting for local-blob server');
}
