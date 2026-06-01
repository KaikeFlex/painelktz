const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 8765);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const CACHE_TTL = 5 * 60_000;
const STALE_CACHE_TTL = 60 * 60_000;
const cache = new Map();

// Caminho para salvar as chaves no computador
const FILE_CHAVES = path.join(ROOT, 'chaves.txt');

// Banco de dados na memória. Formato: 'nome_da_key' => timestamp_expiracao (em milissegundos)
let CHAVES_ATIVAS = new Map();

// --- ADICIONADO: Memória de quem está usando cada chave ---
const SESSAO_KEYS = new Map(); 

// Chaves padrão eternas (nunca expiram - timestamp muito alto)
CHAVES_ATIVAS.set('ktz', 9999999999999);
CHAVES_ATIVAS.set('KTZ-Kaploc1', 9999999999999);
CHAVES_ATIVAS.set('KTZ-gsw', 9999999999999);
CHAVES_ATIVAS.set('KTZ-moreira13', 9999999999999);

// Função para carregar as chaves salvas do arquivo ao iniciar
async function carregarChavesDoArquivo() {
  try {
    const conteudo = await fs.readFile(FILE_CHAVES, 'utf8');
    const linhas = conteudo.split(/\r?\n/);
    const agora = Date.now();

    for (const linha of linhas) {
      if (!linha.trim()) continue;
      const [key, expStr] = linha.split(':');
      if (key && expStr) {
        const expiracao = Number(expStr);
        // Só carrega se a chave ainda não tiver expirado
        if (expiracao > agora) {
          CHAVES_ATIVAS.set(key.trim(), expiracao);
        }
      }
    }
    await salvarChavesNoArquivo(); // Limpa as expiradas do arquivo
    console.log('📦 Chaves ativas carregadas:', Array.from(CHAVES_ATIVAS.keys()));
  } catch {
    await salvarChavesNoArquivo();
  }
}

// Função para salvar a lista atual no arquivo chaves.txt
async function salvarChavesNoArquivo() {
  try {
    const linhas = [];
    for (const [key, expiracao] of CHAVES_ATIVAS.entries()) {
      linhas.push(`${key}:${expiracao}`);
    }
    await fs.writeFile(FILE_CHAVES, linhas.join('\n'), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar chaves.txt:', err);
  }
}

// Verifica e remove chaves expiradas a cada 10 segundos automaticamente
setInterval(async () => {
  const agora = Date.now();
  let mudou = false;

  for (const [key, expiracao] of CHAVES_ATIVAS.entries()) {
    if (agora >= expiracao) {
      CHAVES_ATIVAS.delete(key);
      SESSAO_KEYS.delete(key); // Limpa também a sessão de uso
      mudou = true;
      console.log(`⏰ A chave "${key}" expirou e foi removida automaticamente.`);
    }
  }

  if (mudou) {
    await salvarChavesNoArquivo();
  }
}, 10000);

async function readDotEnv() {
  const envPath = path.join(ROOT, '.env');
  const values = {};
  try {
    const content = await fs.readFile(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {}
  return values;
}

function validUsername(value) {
  return /^[A-Za-z0-9_]{3,20}$/.test(value);
}

async function getLocalSettings() {
  const env = await readDotEnv();
  const username = String(env.ROBLOX_USERNAME || process.env.ROBLOX_USERNAME || 'toxicyofc').trim();
  const initialBalance = Number(env.INITIAL_ROBUX || process.env.INITIAL_ROBUX || 25000);
  return {
    username: validUsername(username) ? username : 'toxicyofc',
    initialBalance: Number.isFinite(initialBalance) && initialBalance >= 0 ? Math.floor(initialBalance) : 25000
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function safeKeyword(value) {
  return String(value || '').trim().replace(/^@/, '').slice(0, 20);
}

async function robloxJson(url, options = {}) {
  const attempts = Number(options.attempts || 2);
  const requestOptions = { ...options };
  delete requestOptions.attempts;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'RobuxLocalLookup/1.0',
        ...(requestOptions.headers || {})
      }
    });
    if (response.ok) return response.json();
    const error = new Error(`Roblox API returned ${response.status}`);
    error.status = response.status;
    lastError = error;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) break;
    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
  }
  throw lastError;
}

async function lookupExactUsername(keyword) {
  const body = JSON.stringify({ usernames: [keyword], excludeBannedUsers: false });
  const payload = await robloxJson('https://users.roblox.com/v1/usernames/users', { method: 'POST', body });
  return Array.isArray(payload.data) ? payload.data : [];
}

async function searchUsers(keyword) {
  const url = `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(keyword)}&limit=10`;
  const payload = await robloxJson(url);
  return Array.isArray(payload.data) ? payload.data : [];
}

async function getHeadshots(userIds) {
  if (!userIds.length) return new Map();
  const ids = userIds.join(',');
  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids}&size=150x150&format=Png&isCircular=false`;
  const payload = await robloxJson(url);
  const map = new Map();
  for (const item of payload.data || []) {
    map.set(Number(item.targetId), item.imageUrl || '');
  }
  return map;
}

async function handleUserSearch(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const keyword = safeKeyword(requestUrl.searchParams.get('keyword'));
  if (!/^[A-Za-z0-9_]{3,20}$/.test(keyword)) {
    sendJson(res, 200, { users: [] });
    return;
  }
  const cacheKey = keyword.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    sendJson(res, 200, cached.payload);
    return;
  }
  const warnings = [];
  let exact = [];
  let searched = [];
  try { exact = await lookupExactUsername(keyword); } catch (e) { warnings.push('exact:failed'); }
  try { searched = await searchUsers(keyword); } catch (e) { warnings.push('search:failed'); }
  const byId = new Map();
  for (const user of [...exact, ...searched]) {
    if (!user || !user.id || byId.has(Number(user.id))) continue;
    byId.set(Number(user.id), {
      id: Number(user.id),
      name: user.name || '',
      displayName: user.displayName || user.name || '',
      hasVerifiedBadge: Boolean(user.hasVerifiedBadge)
    });
  }
  const users = Array.from(byId.values()).slice(0, 10);
  const headshots = await getHeadshots(users.map(u => u.id)).catch(() => new Map());
  const payload = {
    users: users.map(u => ({ ...u, avatarUrl: headshots.get(u.id) || '' })),
    warnings
  };
  cache.set(cacheKey, { createdAt: Date.now(), payload });
  sendJson(res, 200, payload);
}

async function handleLocalUser(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const userKey = requestUrl.searchParams.get('userKey');
  const customNick = requestUrl.searchParams.get('customNick');
  const customRobux = requestUrl.searchParams.get('customRobux');
  
  // --- Lógica de Checagem Corrigida ---
  if (userKey && customNick) {
    if (SESSAO_KEYS.has(userKey) && SESSAO_KEYS.get(userKey) !== customNick) {
      return sendJson(res, 401, { error: 'Desconectado' });
    }
    SESSAO_KEYS.set(userKey, customNick);
  }
  // -------------------------------------

  const settings = await getLocalSettings();
  const activeUsername = customNick ? String(customNick).trim() : settings.username;
  const activeBalance = customRobux && !isNaN(customRobux) ? Math.floor(Number(customRobux)) : settings.initialBalance;
  const warnings = [];
  let users = [];
  
  try { 
      users = await lookupExactUsername(activeUsername); 
  } catch (e) { 
      warnings.push('exact:failed'); 
  }
  
  const user = users.find(item => item.name && item.name.toLowerCase() === activeUsername.toLowerCase()) || users[0];
  let avatarUrl = '';
  
  if (user && user.id) {
    const headshots = await getHeadshots([Number(user.id)]).catch(() => new Map());
    avatarUrl = headshots.get(Number(user.id)) || '';
  }
  
  sendJson(res, 200, {
    username: user?.name || activeUsername,
    displayName: user?.displayName || user?.name || activeUsername,
    userId: user?.id || null,
    avatarUrl,
    initialBalance: activeBalance,
    warnings
  });
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  // 🔑 NOVO PAINEL COM SELEÇÃO DE TEMPO
  if (pathname === '/painel-admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Painel Gerenciador de Keys Temporárias</title>
        <style>
          body { font-family: Arial, sans-serif; background: #111; color: #fff; text-align: center; padding: 50px; }
          .box { background: #222; padding: 30px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.5); width: 450px; }
          input, select { padding: 12px; border-radius: 5px; border: 1px solid #444; background: #333; color: #fff; font-size: 16px; margin: 10px 5px; box-sizing: border-box; }
          input[type="text"] { width: 60%; }
          select { width: 35%; }
          button { padding: 12px 20px; background: #28a745; border: none; border-radius: 5px; color: white; font-weight: bold; cursor: pointer; font-size: 16px; width: 98%; margin-top: 10px; }
          button:hover { background: #218838; }
          .list { margin-top: 25px; text-align: left; background: #333; padding: 15px; border-radius: 5px; }
          ul { padding-left: 20px; }
          li { margin-bottom: 8px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🔑 Gerenciador de Keys Temporárias</h2>
          <p>Configure a chave e o tempo de validade do cliente</p>
          
          <div style="text-align: left;">
            <input type="text" id="keyInput" placeholder="Nome da Chave (Ex: vip30)">
            <select id="timeInput">
              <option value="1">1 Minuto (Teste)</option>
              <option value="5">5 Minutos</option>
              <option value="30">30 Minutos</option>
              <option value="60">1 Hora</option>
              <option value="180">3 Horas</option>
              <option value="1440">24 Horas (1 Dia)</option>
            </select>
          </div>
          
          <button onclick="gerarKey()">Ativar Chave com Tempo</button>
          
          <div class="list">
            <strong>Chaves Ativas e Tempo Restante:</strong>
            <ul id="listaKeys"></ul>
          </div>
        </div>
        <script>
          function carregarKeys() {
            fetch('/api/listar-keys').then(r => r.json()).then(data => {
              const ul = document.getElementById('listaKeys');
              ul.innerHTML = '';
              data.keys.forEach(item => {
                ul.innerHTML += '<li>🔑 <strong>' + item.key + '</strong> - ' + item.tempo + ' <a href="#" onclick="deletarKey(\\''+item.key+'\\')" style="color:#ff4d4d;margin-left:15px;text-decoration:none;">[Remover]</a></li>';
              });
            });
          }
          function gerarKey() {
            const key = document.getElementById('keyInput').value.trim();
            const minutos = document.getElementById('timeInput').value;
            if(!key) return alert('Por favor, digite o nome da chave!');
            
            fetch('/api/ativar-key?key=' + encodeURIComponent(key) + '&minutos=' + minutos).then(() => {
              document.getElementById('keyInput').value = '';
              carregarKeys();
            });
          }
          function deletarKey(key) {
            fetch('/api/remover-key?key=' + encodeURIComponent(key)).then(() => carregarKeys());
          }
          
          carregarKeys();
          setInterval(carregarKeys, 5000);
        </script>
      </body>
      </html>
    `);
    return;
  }

  const fileName = pathname === '/' || pathname === '/pt/robuxcomprar.html' ? 'robuxcomprar.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, fileName);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  // Valida se a chave existe E se ainda não expirado
  if (req.url.startsWith('/api/verificar-key')) {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const key = requestUrl.searchParams.get('key');
    
    const expiracao = CHAVES_ATIVAS.get(key);
    const valida = expiracao && expiracao > Date.now();
    
    sendJson(res, 200, { valida: !!valida });
    return;
  }
  
  if (req.url.startsWith('/api/ativar-key')) {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const key = requestUrl.searchParams.get('key');
    const minutos = Number(requestUrl.searchParams.get('minutos') || 60);
    
    if (key) {
      const tempoExpiracao = Date.now() + (minutos * 60 * 1000);
      CHAVES_ATIVAS.set(key, tempoExpiracao);
      salvarChavesNoArquivo().then(() => sendJson(res, 200, { ok: true }));
    }
    return;
  }
  
  if (req.url.startsWith('/api/remover-key')) {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const key = requestUrl.searchParams.get('key');
    if (key) {
      CHAVES_ATIVAS.delete(key);
      SESSAO_KEYS.delete(key); // Limpa também
      salvarChavesNoArquivo().then(() => sendJson(res, 200, { ok: true }));
    }
    return;
  }
  
  if (req.url.startsWith('/api/listar-keys')) {
    const agora = Date.now();
    const lista = [];
    
    for (const [key, expiracao] of CHAVES_ATIVAS.entries()) {
      if (expiracao > 9000000000000) {
        lista.push({ key, tempo: 'Infinita (Padrão)' });
      } else {
        const restanteMs = expiracao - agora;
        if (restanteMs > 0) {
          const minutosRestantes = Math.ceil(restanteMs / 60000);
          lista.push({ key, tempo: `Expira em ${minutosRestantes} min` });
        }
      }
    }
    sendJson(res, 200, { keys: lista });
    return;
  }
  
  if (req.url.startsWith('/api/local-user')) {
    handleLocalUser(req, res).catch(error => sendJson(res, 500, { error: error.message }));
    return;
  }
  if (req.url.startsWith('/api/roblox-users')) {
    handleUserSearch(req, res).catch(error => sendJson(res, 500, { users: [], error: error.message }));
    return;
  }
  serveStatic(req, res);
});

carregarChavesDoArquivo().then(() => {
  server.listen(PORT, () => {
    console.log(`Robux local server running at http://${HOST}:${PORT}/robuxcomprar.html`);
  });
});
