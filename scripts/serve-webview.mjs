import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, URL as NodeUrl } from 'node:url';

const root = resolve(fileURLToPath(new NodeUrl('..', import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
};

const server = createServer(async (request, response) => {
  const requestUrl = new NodeUrl(request.url ?? '/', `http://${request.headers.host}`);
  const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ShowDocx webview test server listening on http://127.0.0.1:${port}`);
});
