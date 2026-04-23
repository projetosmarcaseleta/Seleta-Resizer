const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Helper: faz GET HTTPS e retorna Buffer ──────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const doGet = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return doGet(res.headers.location, redirects + 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

// ── Helper: faz POST multipart HTTPS ────────────────────────
function httpsPostMultipart(url, fields, fileField, fileBuffer, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '-----BridgeBoundary' + Date.now();
    let body = '';
    for (const [key, val] of Object.entries(fields)) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
    }
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const bodyStart = Buffer.from(body + fileHeader, 'utf-8');
    const bodyEnd = Buffer.from(fileFooter, 'utf-8');
    const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error('Invalid JSON response from bridge'));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

// ── Recebe o body completo do request ───────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ── Servidor ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // ── CORS headers para todas as respostas ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /api/bridge ── Baixa do weserv + upload pro FreeImage ──
  if (req.method === 'POST' && req.url === '/api/bridge') {
    try {
      const body = await readBody(req);
      const { weservUrl } = JSON.parse(body.toString());

      if (!weservUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'weservUrl is required' }));
        return;
      }

      // 1) Baixa a imagem do weserv (server-side, sem CORS)
      const imgResp = await httpsGet(weservUrl);
      if (imgResp.status !== 200) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Weserv returned ${imgResp.status}` }));
        return;
      }

      // 2) Upload pro FreeImage.host (server-side, sem CORS)
      const result = await httpsPostMultipart(
        'https://freeimage.host/api/1/upload',
        { key: '6d207e02198a847aa98d0a2a901485a5', action: 'upload', format: 'json' },
        'source',
        imgResp.body,
        'photo.jpg'
      );

      if (result && result.image && result.image.url) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: result.image.url }));
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'FreeImage upload failed', detail: result }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Arquivo estático ──────────────────────────────────────
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✅ Seleta Resizer rodando em:');
  console.log('');
  console.log(`     http://localhost:${PORT}`);
  console.log('');
  console.log('  Bridge de imagens ativo em /api/bridge');
  console.log('  Pressione Ctrl+C para parar.');
  console.log('');
});
