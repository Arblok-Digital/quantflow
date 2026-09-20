import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 4589;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath;
    if (urlPath === '/' || urlPath === '/index.html') {
      filePath = path.join(__dirname, 'index.html');
    } else {
      const uiFile = path.join(__dirname, urlPath.replace(/^\//, ''));
      filePath = fs.existsSync(uiFile) ? uiFile : path.join(ROOT, urlPath);
    }
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      if (urlPath.startsWith('/api/report')) {
        const reportPath = path.join(ROOT, 'output', 'report.json');
        const data = fs.readFileSync(reportPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('tidak ditemukan: ' + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const bytes = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch (e) {
      res.writeHead(500);
      res.end('server error: ' + e.message);
    }
  })
  .listen(PORT, () => {
    console.log(`Solana Scout UI → http://localhost:${PORT}`);
    console.log(`  report  → http://localhost:${PORT}/api/report`);
    console.log('  (jalankan `npm run scan` / `--discovery` dulu agar report tersedia)');
  });