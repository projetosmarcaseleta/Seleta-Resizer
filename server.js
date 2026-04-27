const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); } catch (e) { console.warn('⚠️  sharp não instalado. Execute: npm install sharp'); }

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

  // ── POST /api/resize ── Baixa imagem original + redimensiona para 1000x1000 ──
  if (req.method === 'POST' && req.url === '/api/resize') {
    try {
      if (!sharp) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sharp não instalado no servidor' }));
        return;
      }
      const body = await readBody(req);
      const { originalUrl } = JSON.parse(body.toString());
      if (!originalUrl || !originalUrl.startsWith('http')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'originalUrl inválida ou ausente' }));
        return;
      }

      // 1) Baixar imagem original
      const imgResp = await httpsGet(originalUrl);
      if (imgResp.status !== 200) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Download falhou: HTTP ${imgResp.status}` }));
        return;
      }
      const originalBuffer = imgResp.body;
      if (!originalBuffer || originalBuffer.length < 512) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Imagem muito pequena: ${originalBuffer ? originalBuffer.length : 0} bytes` }));
        return;
      }

      // 2) Validar magic bytes (JPEG ou PNG)
      const header = originalBuffer.slice(0, 4).toString('hex');
      const isJpeg = header.startsWith('ffd8ff');
      const isPng  = header.startsWith('89504e47');
      const isWebp = originalBuffer.slice(0, 4).toString('ascii') === 'RIFF';
      if (!isJpeg && !isPng && !isWebp) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Formato não suportado. Header: ${header}` }));
        return;
      }

      // 3) Redimensionar para 1000x1000 (contain + fundo branco)
      const resizedBuffer = await sharp(originalBuffer)
        .resize(1000, 1000, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .jpeg({ quality: 95 })
        .toBuffer();

      // 4) Validar imagem gerada
      const resizedMeta = await sharp(resizedBuffer).metadata();
      if (resizedMeta.width !== 1000 || resizedMeta.height !== 1000) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Dimensão inválida: ${resizedMeta.width}x${resizedMeta.height}` }));
        return;
      }

      // 5) Salvar arquivo temporário
      const filename = `resize_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const filepath = path.join(TEMP_DIR, filename);
      fs.writeFileSync(filepath, resizedBuffer);

      // Limpeza automática após 10 minutos
      setTimeout(() => { try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {} }, 10 * 60 * 1000);

      const baseUrl = `https://app.marcaseleta.shop/resizer/temp/${filename}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: baseUrl, filename, width: 1000, height: 1000 }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── DELETE /api/temp/:filename ── Limpa arquivo temporário ──
  if (req.method === 'DELETE' && req.url.startsWith('/api/temp/')) {
    const filename = path.basename(req.url.replace('/api/temp/', ''));
    const filepath = path.join(TEMP_DIR, filename);
    try {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Servir arquivos da pasta /temp/ ──────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/temp/')) {
    const filename = path.basename(req.url.split('?')[0]);
    const filepath = path.join(TEMP_DIR, filename);
    if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(filepath).pipe(res);
    return;
  }

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
