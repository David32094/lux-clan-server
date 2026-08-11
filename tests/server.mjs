import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';

const root = resolve('.site');
const port = Number(process.env.PORT || 4173);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(root, relative));
    if (!file.startsWith(root)) throw new Error('Ruta no permitida');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('No es un archivo');
    response.writeHead(200, { 'content-type':types[extname(file)] || 'application/octet-stream', 'cache-control':'no-store' });
    createReadStream(file).pipe(response);
  } catch (_) {
    response.writeHead(404, { 'content-type':'text/plain; charset=utf-8' });
    response.end('No encontrado');
  }
}).listen(port, '127.0.0.1', () => console.log(`Servidor de pruebas en http://127.0.0.1:${port}`));
