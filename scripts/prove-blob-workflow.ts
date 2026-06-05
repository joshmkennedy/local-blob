import { existsSync, rmSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? '9966');
const BASE_URL = `http://localhost:${PORT}`;
const STORE_PATH = '.prototype-vercel-blob-store';
const TOKEN = 'vercel_blob_rw_localstore_nonce';

type State = Record<string, unknown>;

function printState(label: string, state: State) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(state, null, 2));
}

async function main() {
  if (existsSync(STORE_PATH)) {
    rmSync(STORE_PATH, { recursive: true, force: true });
  }

  process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
  process.env.VERCEL_BLOB_API_URL = BASE_URL;
  process.env.VERCEL_STORE_PATH = STORE_PATH;

  const server = Bun.spawn(['bun', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BLOB_READ_WRITE_TOKEN: TOKEN,
      VERCEL_BLOB_API_URL: BASE_URL,
      VERCEL_STORE_PATH: STORE_PATH,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  try {
    await waitForServer();

    const { put, head, list, copy, del } = await import('@vercel/blob');
    const { upload } = await import('@vercel/blob/client');
    const pathname = `message-attachments/${Date.now()}-demo.txt`;

    const uploaded = await put(pathname, 'Hello from the local Vercel Blob prototype.', {
      access: 'public',
      allowOverwrite: true,
      contentType: 'text/plain',
      cacheControlMaxAge: 60,
    });
    printState('1. put()', uploaded);

    const headByPathname = await head(uploaded.pathname);
    printState('2. head(pathname)', headByPathname);

    const headByUrl = await head(uploaded.url);
    printState('3. head(returned local url)', headByUrl);

    const downloadResponse = await fetch(uploaded.url);
    printState('4. direct fetch(returned local url)', {
      status: downloadResponse.status,
      contentType: downloadResponse.headers.get('content-type'),
      body: await downloadResponse.text(),
    });

    const multipartPathname = pathname.replace('-demo.txt', '-multipart.txt');
    const multipartBody = `${'A'.repeat(8 * 1024 * 1024)}${'B'.repeat(1024 * 1024)}`;
    const multipartUploaded = await put(multipartPathname, multipartBody, {
      access: 'public',
      allowOverwrite: true,
      contentType: 'text/plain',
      multipart: true,
    });
    const multipartHead = await head(multipartUploaded.pathname);
    const multipartFetch = await fetch(multipartUploaded.url);
    const multipartText = await multipartFetch.text();
    printState('5. put({ multipart: true })', {
      uploaded: multipartUploaded,
      head: multipartHead,
      fetched: {
        status: multipartFetch.status,
        length: multipartText.length,
        startsWith: multipartText.slice(0, 3),
        endsWith: multipartText.slice(-3),
      },
    });

    const clientUploadPathname = pathname.replace('-demo.txt', '-client-upload.txt');
    const clientUploaded = await upload(
      clientUploadPathname,
      new Blob(['Hello from client upload.'], { type: 'text/plain' }),
      {
        access: 'public',
        handleUploadUrl: `${BASE_URL}/client-upload`,
        clientPayload: 'messageAttachmentDraftId=demo',
        contentType: 'text/plain',
      }
    );
    await Bun.sleep(100);
    const clientUploadEvents = await fetch(`${BASE_URL}/client-upload-events`).then((response) => response.json());
    printState('6. client upload + onUploadCompleted callback', {
      uploaded: clientUploaded,
      events: clientUploadEvents,
    });

    const clientMultipartPathname = pathname.replace('-demo.txt', '-client-multipart.txt');
    const clientMultipartUploaded = await upload(
      clientMultipartPathname,
      new Blob([multipartBody], { type: 'text/plain' }),
      {
        access: 'public',
        handleUploadUrl: `${BASE_URL}/client-upload`,
        clientPayload: 'messageAttachmentDraftId=large-demo',
        contentType: 'text/plain',
        multipart: true,
      }
    );
    await Bun.sleep(100);
    const clientMultipartEvents = await fetch(`${BASE_URL}/client-upload-events`).then((response) => response.json());
    printState('7. client multipart upload + onUploadCompleted callback', {
      uploaded: clientMultipartUploaded,
      events: clientMultipartEvents,
    });

    const listed = await list({ prefix: 'message-attachments/' });
    printState('8. list({ prefix })', listed);

    const firstPage = await list({ prefix: 'message-attachments/', limit: 2 });
    const secondPage = firstPage.cursor
      ? await list({ prefix: 'message-attachments/', limit: 2, cursor: firstPage.cursor })
      : null;
    printState('8a. list({ prefix, limit }) cursor pagination', {
      firstPage,
      secondPage,
    });

    const copied = await copy(
      uploaded.pathname,
      uploaded.pathname.replace('-demo.txt', '-copy.txt'),
      {
        access: 'public',
        allowOverwrite: true,
      }
    );
    printState('9. copy()', copied);

    await del([
      uploaded.pathname,
      multipartUploaded.pathname,
      clientUploaded.pathname,
      clientMultipartUploaded.pathname,
      copied.pathname,
    ]);
    const afterDelete = await Promise.all([
      fetch(uploaded.url),
      fetch(multipartUploaded.url),
      fetch(clientUploaded.url),
      fetch(clientMultipartUploaded.url),
      fetch(copied.url),
    ]);
    printState('10. del() then direct fetch()', {
      originalStatus: afterDelete[0].status,
      multipartStatus: afterDelete[1].status,
      clientUploadStatus: afterDelete[2].status,
      clientMultipartStatus: afterDelete[3].status,
      copiedStatus: afterDelete[4].status,
    });

    console.log('\nPrototype verdict: local server supports SDK put/head/list/copy/del, multipart put, client upload callbacks, client multipart callbacks, and direct local URL downloads.');
    console.log('Known gap: @vercel/blob get(pathname) is not locally emulated because it fetches *.blob.vercel-storage.com directly.');
  } finally {
    server.kill();
  }
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
