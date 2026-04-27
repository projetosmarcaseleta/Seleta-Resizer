const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

let sharp;
try { sharp = require('sharp'); } catch { console.warn('⚠️  sharp não instalado. Execute: npm install sharp'); }

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const PORT        = 8080;
const N8N_HOST    = 'api.marcaseleta.shop';
const N8N_PORT    = 80;
const N8N_PATH    = '/webhook/resizer/buscar-imagens';
const AM_HOST     = 'api.anymarket.com.br';
const SELF_BASE   = 'https://app.marcaseleta.shop/resizer';
const RATE_MS     = 700;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
};

// ── Job store (SSE) ──────────────────────────────────────────
const jobs = new Map();

function createJob() {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  jobs.set(id, { clients: [], done: false });
  setTimeout(() => jobs.delete(id), 60 * 60 * 1000); // limpar após 1h
  return id;
}

function emit(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  job.clients.forEach(r => { try { r.write(msg); } catch {} });
  if (data.event === 'complete' || data.event === 'error') {
    job.done = true;
    setTimeout(() => job.clients.forEach(r => { try { r.end(); } catch {} }), 200);
  }
}

// ── Helpers HTTP ─────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const doGet = (u, hops = 0) => {
      if (hops > 5) return reject(new Error('Too many redirects'));

      const parsedUrl = new URL(u);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7'
        }
      };

      protocol.get(u, options, res => {
        console.log(`[DEBUG] Download: ${u} | Status: ${res.statusCode}`);
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const next = new URL(res.headers.location, u).href;
          console.log(`[DEBUG] Redirecionando para: ${next}`);
          return doGet(next, hops + 1);
        }

        if (res.statusCode === 403) {
          console.error(`[ERROR] 403 Forbidden na URL: ${u}`);
          console.error(`[ERROR] Headers de resposta:`, JSON.stringify(res.headers));
        }

        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }).on('error', err => {
        console.error(`[ERROR] Erro na requisição HTTPS: ${err.message}`);
        reject(err);
      });
    };
    doGet(url);
  });
}

function jsonRequest(method, hostname, reqPath, body, extraHeaders = {}, port = 443) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const mod = port === 443 ? https : http;
    const opts = {
      hostname, port, path: reqPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
      },
    };
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch  { resolve({ status: res.statusCode, body: { _raw: text } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35000, () => req.destroy(new Error('Timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Resize + Save ────────────────────────────────────────────
async function resizeAndSave(srcUrl) {
  if (!sharp) throw new Error('sharp não instalado no servidor');

  const dl = await httpsGet(srcUrl);
  if (dl.status !== 200) throw new Error(`Download falhou: HTTP ${dl.status}`);
  if (!dl.body || dl.body.length < 512) throw new Error(`Imagem inválida (${dl.body?.length ?? 0} bytes)`);

  const resized = await sharp(dl.body)
    .resize(1000, 1000, { fit: 'contain', background: { r:255, g:255, b:255, alpha:1 } })
    .jpeg({ quality: 95 })
    .toBuffer();

  const meta = await sharp(resized).metadata();
  if (meta.width !== 1000 || meta.height !== 1000)
    throw new Error(`Dimensão incorreta: ${meta.width}x${meta.height}`);

  const filename = `resize_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const filepath = path.join(TEMP_DIR, filename);
  fs.writeFileSync(filepath, resized);
  setTimeout(() => { try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {} }, 10 * 60 * 1000);

  return { url: `${SELF_BASE}/temp/${filename}`, filename };
}

// ── Processamento do job ─────────────────────────────────────
async function procesarJob(jobId, { oi, skus, token, deleteOld }) {
  try {
    // 1. Buscar fotos via n8n
    emit(jobId, { event: 'log', tp: 'info', msg: '🔍 Consultando banco de dados via n8n...' });
    const n8nResp = await jsonRequest('POST', N8N_HOST, N8N_PATH, { oi, skus }, {}, N8N_PORT);

    if (n8nResp.status !== 200 || !n8nResp.body.ok) {
      emit(jobId, { event: 'error', msg: `Falha n8n (${n8nResp.status}): ${JSON.stringify(n8nResp.body).slice(0,200)}` });
      return;
    }

    const fotos = n8nResp.body.fotos || [];
    console.log(`[DEBUG] Resposta n8n: ${JSON.stringify(n8nResp.body)}`);
    if (fotos.length === 0) {
      emit(jobId, { event: 'log', tp: 'skip', msg: '⚠️ Nenhuma imagem encontrada fora de 1000×1000.' });
      emit(jobId, { event: 'complete', total: 0, ok: 0, erros: 0, results: [] });
      return;
    }

    emit(jobId, { event: 'log', tp: 'info', msg: `📸 ${fotos.length} foto(s) encontrada(s). Iniciando...` });
    emit(jobId, { event: 'progress', total: fotos.length, done: 0, ok: 0, erros: 0 });

    const results = [];

    for (let i = 0; i < fotos.length; i++) {
      const foto     = fotos[i];
      const srcUrl   = foto.standard_url || foto.original_url;
      const isMain   = foto.main_photo === '1' || foto.main_photo === 1;
      const idx      = foto.product_photo_index ?? 0;
      const variacao = foto.variacao || null;  // descrição da variação (ex: "Azul", "P")
      const temVariacaoVisual = foto.tem_variacao_visual ?? false;
      const label    = `[${i+1}/${fotos.length}] Foto ${foto.id_foto} — SKU ${foto.sku || '—'}${variacao ? ` — Var: ${variacao}` : ''}`;

      emit(jobId, { event: 'log', tp: 'info', msg: `⏳ ${label}` });

      const result = {
        sku: foto.sku, id_produto: foto.id_produto, id_foto: foto.id_foto,
        variacao: variacao, url_original: srcUrl, nova_url: null, status: 'ERRO', motivo_erro: null,
        // para rollback
        _isMain: isMain, _idx: idx, _variacao: variacao,
      };

      let tempFilename = null;
      let newPhotoId   = null;

      try {
        if (!srcUrl) throw new Error('URL da imagem ausente');

        // Resize
        emit(jobId, { event: 'log', tp: 'info', msg: '   📐 Redimensionando para 1000×1000...' });
        const resized = await resizeAndSave(srcUrl);
        tempFilename  = resized.filename;

        // POST nova foto
        emit(jobId, { event: 'log', tp: 'info', msg: `   📤 Enviando nova foto ao AnyMarket... (URL: ${resized.url})` });

        // Pequeno delay para garantir que o arquivo está acessível via HTTP
        await sleep(500);

        // Montar body do POST — incluir variation APENAS se tem_variacao_visual === true
        const postBody = { url: resized.url, index: idx, main: false };
        if (temVariacaoVisual && variacao) {
          postBody.variation = variacao;
          emit(jobId, { event: 'log', tp: 'info', msg: `   🏷️  Variação visual: ${variacao}` });
        }

        let postR;
        for (let attempt = 1; attempt <= 2; attempt++) {
          postR = await jsonRequest('POST', AM_HOST,
            `/v2/products/${foto.id_produto}/images`,
            postBody,
            { gumgaToken: token }
          );
          console.log(`[DEBUG] POST AnyMarket (tentativa ${attempt}): status=${postR.status} body=${JSON.stringify(postR.body).slice(0,200)}`);

          if (postR.status < 400 && postR.body.id) break; // sucesso

          if (attempt < 2) {
            emit(jobId, { event: 'log', tp: 'skip', msg: `   ⚠️ POST falhou (tentativa ${attempt}), aguardando 3s para retry...` });
            await sleep(3000);
          }
        }
        if (postR.status >= 400 || !postR.body.id)
          throw new Error(`POST ${postR.status}: ${JSON.stringify(postR.body).slice(0,200)}`);

        newPhotoId    = postR.body.id;
        result.nova_url = resized.url;
        result._newPhotoId = newPhotoId;

        // PUT index + main
        emit(jobId, { event: 'log', tp: 'info', msg: `   🔢 Ajustando índice (${idx}) e main (${isMain})...` });
        try {
          const putBody = { id: Number(newPhotoId), index: idx, main: isMain };
          if (temVariacaoVisual && variacao) putBody.variation = variacao;
          await jsonRequest('PUT', AM_HOST,
            `/v2/products/${foto.id_produto}/images`,
            putBody,
            { gumgaToken: token }
          );
        } catch (putErr) {
          emit(jobId, { event: 'log', tp: 'skip', msg: `   ⚠️ PUT ignorado: ${putErr.message}` });
        }

        // DELETE antiga
        if (deleteOld) {
          emit(jobId, { event: 'log', tp: 'info', msg: '   🗑️  Removendo foto antiga...' });
          try {
            await jsonRequest('DELETE', AM_HOST,
              `/v2/products/${foto.id_produto}/images/${foto.id_foto}`,
              null,
              { gumgaToken: token }
            );
            result._oldDeleted = true;
          } catch (delErr) {
            emit(jobId, { event: 'log', tp: 'skip', msg: `   ⚠️ DELETE ignorado: ${delErr.message}` });
          }
        }

        result.status = 'SUCESSO';
        emit(jobId, { event: 'log', tp: 'ok', msg: `   ✅ Concluída!` });

      } catch (err) {
        result.motivo_erro = err.message;
        emit(jobId, { event: 'log', tp: 'err', msg: `   ❌ ${err.message}` });
      }
      // NÃO deletar o arquivo temporário aqui!
      // O AnyMarket faz download assíncrono da URL fornecida.
      // O arquivo será limpo automaticamente após 10 minutos pelo setTimeout em resizeAndSave().

      results.push(result);
      const okN  = results.filter(r => r.status === 'SUCESSO').length;
      const errN = results.length - okN;
      emit(jobId, { event: 'progress', total: fotos.length, done: i + 1, ok: okN, erros: errN });

      if (i < fotos.length - 1) await sleep(RATE_MS);
    }

    const ok   = results.filter(r => r.status === 'SUCESSO').length;
    const erros = results.length - ok;
    emit(jobId, { event: 'complete', total: results.length, ok, erros, results });

  } catch (err) {
    emit(jobId, { event: 'error', msg: `Erro fatal: ${err.message}` });
  }
}

// ── Servidor ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  console.log(`[DEBUG] ${new Date().toISOString()} | ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Normalizar URL: 
  // 1. Remover query strings
  let pathname = req.url.split('?')[0];

  // 2. Normalizar: remover prefixo /resizer se existir
  if (pathname.startsWith('/resizer/')) {
    pathname = pathname.replace('/resizer', '');
  } else if (pathname === '/resizer') {
    pathname = '/';
  }

  // 3. Limpar barras duplicadas e remover barra final para padronizar
  pathname = pathname.replace(/\/+/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  console.log(`[DEBUG] Pathname Processado: ${pathname}`);

  // ── POST /api/processar ─────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/processar') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const oi       = (body.oi    ?? '').trim();
      const token    = (body.token ?? '').trim();
      const deleteOld = body.deleteOld !== false;
      let skus = Array.isArray(body.skus) ? body.skus
               : typeof body.skus === 'string' && body.skus.trim()
                 ? body.skus.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
                 : [];

      if (!oi)    throw new Error('Campo "oi" é obrigatório');
      if (!token) throw new Error('Campo "token" (gumgaToken) é obrigatório');
      if (!/^[\w.\-]+$/.test(oi)) throw new Error('OI contém caracteres inválidos');
      skus = skus.filter(s => /^[\w.\-]+$/.test(s));

      const jobId = createJob();
      // Processar em background (não bloqueia o response)
      procesarJob(jobId, { oi, skus, token, deleteOld });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── GET /api/progress/:jobId — SSE ─────────────────────────
  if (req.method === 'GET' && pathname.startsWith('/api/progress/')) {
    const jobId = pathname.replace('/api/progress/', '').split('/')[0];
    const job   = jobs.get(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job não encontrado' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type'  : 'text/event-stream',
      'Cache-Control' : 'no-cache',
      'Connection'    : 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx
    });
    res.write(': connected\n\n');

    job.clients.push(res);

    // Se o job já terminou, mandar evento de encerramento
    if (job.done) {
      res.write(`data: ${JSON.stringify({ event: 'done' })}\n\n`);
      res.end();
      return;
    }

    req.on('close', () => {
      job.clients = job.clients.filter(c => c !== res);
    });
    return;
  }

  // ── POST /api/resize ─────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/resize') {
    try {
      const { originalUrl } = JSON.parse((await readBody(req)).toString());
      if (!originalUrl?.startsWith('http')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'originalUrl inválida' }));
        return;
      }
      const result = await resizeAndSave(originalUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, width: 1000, height: 1000 }));
    } catch (e) {
      const code = e.message.includes('Formato') ? 422 : 500;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── DELETE /api/temp/:filename ────────────────────────────────
  if (req.method === 'DELETE' && pathname.startsWith('/api/temp/')) {
    const filename = path.basename(pathname.replace('/api/temp/', ''));
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

  // ── GET /temp/:filename ───────────────────────────────────────
  if (req.method === 'GET' && pathname.startsWith('/temp/')) {
    const filename = path.basename(pathname.split('?')[0]);
    const filepath = path.join(TEMP_DIR, filename);
    if (!fs.existsSync(filepath)) { 
      console.error(`[ERROR] File not found: ${filepath}`);
      res.writeHead(404); res.end('Not found'); return; 
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(filepath).pipe(res);
    return;
  }

  // ── POST /api/bridge (legado) ─────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/bridge') {
    try {
      const { weservUrl } = JSON.parse((await readBody(req)).toString());
      if (!weservUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'weservUrl required' })); return; }
      const imgResp = await httpsGet(weservUrl);
      if (imgResp.status !== 200) { res.writeHead(502); res.end(JSON.stringify({ error: `Weserv ${imgResp.status}` })); return; }
      // Reutiliza resizeAndSave internamente via buffer
      const resized = await sharp(imgResp.body)
        .resize(1000, 1000, { fit: 'contain', background: { r:255, g:255, b:255, alpha:1 } })
        .jpeg({ quality: 95 }).toBuffer();
      const filename = `bridge_${Date.now()}.jpg`;
      const filepath = path.join(TEMP_DIR, filename);
      fs.writeFileSync(filepath, resized);
      setTimeout(() => { try { fs.unlinkSync(filepath); } catch {} }, 10 * 60 * 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: `${SELF_BASE}/temp/${filename}` }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Arquivos estáticos ────────────────────────────────────────
  let filePath = pathname;
  if (filePath === '/') filePath = '/index.html';
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { 
      console.error(`[ERROR] Static file not found: ${filePath} (from pathname: ${pathname})`);
      res.writeHead(404); 
      res.end('Not found'); 
      return; 
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  ✅ Seleta Resizer rodando na porta ${PORT}\n`);
});
