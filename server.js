// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const MAX_BODY_BYTES = 20 * 1024; // 20 KB sınırı

const ADMIN_KEY = process.env.ADMIN_KEY && process.env.ADMIN_KEY.trim().length > 0
  ? process.env.ADMIN_KEY.trim()
  : crypto.randomBytes(16).toString('hex');

const DEFAULT_POOLS = {
  '5star': [
    'Paris Saint-Germain', 'Real Madrid', 'FC Barcelona', 'Arsenal', 'Bayern München',
    'Manchester City', 'Liverpool', 'Atlético de Madrid', 'İspanya', 'Fransa',
    'Portekiz', 'İngiltere', 'Brezilya', 'Almanya', 'İtalya'
  ],
  '4.5star': [
    'Inter (Lombardia FC)', 'Borussia Dortmund', 'Chelsea', 'Tottenham Hotspur', 'Napoli',
    'AS Roma', 'Manchester United', 'Milano FC (AC Milan)', 'Juventus', 'Galatasaray',
    'Fenerbahçe', 'Bayer 04 Leverkusen', 'Newcastle United', 'Athletic Club (Bilbao)',
    'Aston Villa', 'Nottingham Forest', 'Crystal Palace', 'Real Betis',
    'Atalanta (Bergamo Calcio)', 'RB Leipzig', 'Sunderland', 'FC Porto'
  ]
};

const DEFAULT_PLAYERS = {
  '5star': ['Mustafa', 'Ali', 'İskender', 'Enes', 'Yasin'],
  '4.5star': ['Lokman', 'Ekrem', 'Serhat', 'Sefa', 'Emre']
};

function createInitialState() {
  const groups = {
    '5star': { id: '5star', title: '5★ Grubu', players: [...DEFAULT_PLAYERS['5star']] },
    '4.5star': { id: '4.5star', title: '4.5★ Grubu', players: [...DEFAULT_PLAYERS['4.5star']] }
  };

  const players = {};
  for (const [groupId, grp] of Object.entries(groups)) {
    grp.players.forEach((name, idx) => {
      players[name] = {
        name,
        group: groupId,
        order: idx + 1,
        token: null,
        claimedAt: null,
        picks: [],
        submittedAt: null
      };
    });
  }

  return {
    phase: 'lobby',
    groups,
    pools: {
      '5star': [...DEFAULT_POOLS['5star']],
      '4.5star': [...DEFAULT_POOLS['4.5star']]
    },
    players,
    results: null,
    updatedAt: new Date().toISOString()
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, DATA_FILE);
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.players && parsed.pools && parsed.phase && parsed.groups) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('data.json yükleme hatası:', err.message);
  }
  const initial = createInitialState();
  saveState(initial);
  return initial;
}

let state = loadState();

function verifyAdminKey(providedKey) {
  if (typeof providedKey !== 'string' || providedKey.length === 0) return false;
  const h1 = crypto.createHash('sha256').update(providedKey, 'utf8').digest();
  const h2 = crypto.createHash('sha256').update(ADMIN_KEY, 'utf8').digest();
  return crypto.timingSafeEqual(h1, h2);
}

function findPlayerByToken(token) {
  if (!token || typeof token !== 'string') return null;
  return Object.values(state.players).find(p => p.token === token) || null;
}

function buildPublicState(playerToken, isAdmin) {
  const me = findPlayerByToken(playerToken);
  const publicPlayers = {};

  for (const [name, p] of Object.entries(state.players)) {
    publicPlayers[name] = {
      name: p.name,
      group: p.group,
      order: p.order,
      claimed: Boolean(p.token),
      submitted: Array.isArray(p.picks) && p.picks.length === p.order
    };
  }

  return {
    phase: state.phase,
    groups: state.groups,
    pools: state.pools,
    players: publicPlayers,
    me: me ? {
      name: me.name,
      group: me.group,
      order: me.order,
      submitted: me.picks.length === me.order,
      picks: me.picks
    } : null,
    isAdmin: Boolean(isAdmin),
    results: state.phase === 'revealed' ? state.results : null,
    updatedAt: state.updatedAt
  };
}

function computeResults() {
  const results = { '5star': [], '4.5star': [] };

  for (const groupId of ['5star', '4.5star']) {
    const takenTeams = new Set();
    const groupPlayers = state.groups[groupId].players;

    for (const name of groupPlayers) {
      const p = state.players[name];
      if (!p) continue;
      const hasSubmitted = Array.isArray(p.picks) && p.picks.length === p.order;
      let assignedTeam = null;
      let matchedChoiceIndex = null;

      if (hasSubmitted) {
        for (let i = 0; i < p.picks.length; i++) {
          const candidate = p.picks[i];
          if (!takenTeams.has(candidate)) {
            assignedTeam = candidate;
            matchedChoiceIndex = i + 1;
            takenTeams.add(candidate);
            break;
          }
        }
      }

      results[groupId].push({
        name: p.name,
        order: p.order,
        submitted: hasSubmitted,
        assignedTeam,
        matchedChoiceIndex,
        picks: hasSubmitted ? [...p.picks] : []
      });
    }
  }
  return results;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject({ status: 413, message: 'İstek boyutu çok büyük (En fazla 20 KB).' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return reject({ status: 400, message: 'Geçersiz JSON formatı.' });
        }
        resolve(parsed);
      } catch {
        reject({ status: 400, message: 'Geçersiz JSON verisi.' });
      }
    });

    req.on('error', () => reject({ status: 400, message: 'İstek okunamadı.' }));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function validateList(arr, minCount, maxCount, maxLen, label) {
  if (!Array.isArray(arr)) return `${label} liste formatında olmalıdır.`;
  const seen = new Set();
  const cleaned = [];

  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s) continue;
    if (s.length > maxLen) return `"${s.slice(0, 15)}..." ismi ${maxLen} karakterden uzun olamaz.`;
    const norm = s.toLocaleLowerCase('tr-TR');
    if (seen.has(norm)) return `${label} içinde tekrar eden isim var: "${s}".`;
    seen.add(norm);
    cleaned.push(s);
  }

  if (cleaned.length < minCount) return `${label} en az ${minCount} eleman içermelidir.`;
  if (cleaned.length > maxCount) return `${label} en fazla ${maxCount} eleman içerebilir.`;
  return { ok: true, cleaned };
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const playerToken = req.headers['x-player-token'] || '';
    const adminKeyHeader = req.headers['x-admin-key'] || '';
    const isAdmin = verifyAdminKey(adminKeyHeader);

    if (method === 'GET' && pathname === '/api/state') {
      sendJson(res, 200, buildPublicState(playerToken, isAdmin));
      return;
    }

    if (method === 'POST' && pathname === '/api/claim') {
      const body = await readJsonBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const target = state.players[name];
      if (!target) return sendJson(res, 400, { error: 'Geçersiz oyuncu seçimi.' });

      const existingMe = findPlayerByToken(playerToken);
      if (existingMe && existingMe.name !== name) {
        return sendJson(res, 400, { error: `Zaten "${existingMe.name}" olarak katıldınız.` });
      }
      if (target.token && (!existingMe || existingMe.name !== name)) {
        return sendJson(res, 409, { error: 'Bu isim az önce alındı.' });
      }

      if (!target.token) {
        target.token = crypto.randomBytes(24).toString('hex');
        target.claimedAt = new Date().toISOString();
        saveState(state);
      }
      sendJson(res, 200, { token: target.token, state: buildPublicState(target.token, isAdmin) });
      return;
    }

    if (method === 'POST' && pathname === '/api/unclaim') {
      const me = findPlayerByToken(playerToken);
      if (!me) return sendJson(res, 401, { error: 'Aktif oyuncu bulunamadı.' });
      if (me.picks && me.picks.length > 0) return sendJson(res, 400, { error: 'Tercih gönderdikten sonra ismini bırakamazsın.' });
      if (state.phase === 'revealed') return sendJson(res, 400, { error: 'Seçim açıklandıktan sonra bırakamazsın.' });

      me.token = null;
      me.claimedAt = null;
      saveState(state);
      sendJson(res, 200, { state: buildPublicState('', isAdmin) });
      return;
    }

    if (method === 'POST' && pathname === '/api/pick') {
      if (state.phase !== 'pick') return sendJson(res, 400, { error: 'Tercih aşamasında değiliz.' });
      const me = findPlayerByToken(playerToken);
      if (!me) return sendJson(res, 401, { error: 'Önce isminizi seçmelisiniz.' });

      const body = await readJsonBody(req);
      const picks = body.picks;
      const k = me.order;

      if (!Array.isArray(picks) || picks.length !== k) {
        return sendJson(res, 400, { error: `${k} takım seçmelisin.` });
      }

      const poolSet = new Set(state.pools[me.group] || []);
      const seen = new Set();
      for (const t of picks) {
        if (!poolSet.has(t)) return sendJson(res, 400, { error: `"${t}" takım havuzunda yok.` });
        if (seen.has(t)) return sendJson(res, 400, { error: 'Aynı takımı iki kez seçemezsin.' });
        seen.add(t);
      }

      me.picks = [...picks];
      me.submittedAt = new Date().toISOString();
      saveState(state);
      sendJson(res, 200, { state: buildPublicState(playerToken, isAdmin) });
      return;
    }

    // YÖNETİCİ ENDPOINT'LERİ
    if (pathname.startsWith('/api/admin/')) {
      if (!isAdmin) return sendJson(res, 403, { error: 'Yönetici yetkisi geçersiz.' });

      // OYUNCU LİSTESİNİ DÜZENLEME (Yeni Özellik)
      if (method === 'POST' && pathname === '/api/admin/players') {
        if (state.phase !== 'lobby') {
          return sendJson(res, 400, { error: 'Oyuncu listesi sadece hazırlık aşamasında düzenlenebilir.' });
        }
        const body = await readJsonBody(req);
        const res5 = validateList(body['5star'], 1, 20, 30, '5★ Oyuncu Listesi');
        if (typeof res5 === 'string') return sendJson(res, 400, { error: res5 });

        const res45 = validateList(body['4.5star'], 1, 20, 30, '4.5★ Oyuncu Listesi');
        if (typeof res45 === 'string') return sendJson(res, 400, { error: res45 });

        state.groups['5star'].players = res5.cleaned;
        state.groups['4.5star'].players = res45.cleaned;

        // Oyuncu durumlarını senkronize et
        const oldPlayers = state.players;
        const newPlayers = {};

        for (const gid of ['5star', '4.5star']) {
          state.groups[gid].players.forEach((name, idx) => {
            const old = oldPlayers[name];
            newPlayers[name] = {
              name,
              group: gid,
              order: idx + 1,
              token: old ? old.token : null,
              claimedAt: old ? old.claimedAt : null,
              picks: [],
              submittedAt: null
            };
          });
        }

        state.players = newPlayers;
        saveState(state);
        sendJson(res, 200, { state: buildPublicState(playerToken, true) });
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/pools') {
        if (state.phase !== 'lobby') return sendJson(res, 400, { error: 'Havuzlar sadece hazırlıkta düzenlenir.' });
        const body = await readJsonBody(req);
        const res5 = validateList(body['5star'], state.groups['5star'].players.length, 80, 40, '5★ Havuzu');
        if (typeof res5 === 'string') return sendJson(res, 400, { error: res5 });

        const res45 = validateList(body['4.5star'], state.groups['4.5star'].players.length, 80, 40, '4.5★ Havuzu');
        if (typeof res45 === 'string') return sendJson(res, 400, { error: res45 });

        state.pools['5star'] = res5.cleaned;
        state.pools['4.5star'] = res45.cleaned;
        saveState(state);
        sendJson(res, 200, { state: buildPublicState(playerToken, true) });
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/release') {
        const body = await readJsonBody(req);
        const target = state.players[body.name?.trim()];
        if (target) {
          target.token = null;
          target.claimedAt = null;
          target.picks = [];
          target.submittedAt = null;
          saveState(state);
        }
        sendJson(res, 200, { state: buildPublicState(playerToken, true) });
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/start') {
        if (state.phase !== 'lobby') return sendJson(res, 400, { error: 'Seçim zaten başlatılmış.' });
        for (const gid of ['5star', '4.5star']) {
          if ((state.pools[gid] || []).length < state.groups[gid].players.length) {
            return sendJson(res, 400, { error: `${state.groups[gid].title} havuzundaki takım sayısı oyuncu sayısından az olamaz.` });
          }
        }
        state.phase = 'pick';
        saveState(state);
        sendJson(res, 200, { state: buildPublicState(playerToken, true) });
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/reveal') {
        if (state.phase !== 'pick') return sendJson(res, 400, { error: 'Önce seçim aşamasında olunmalıdır.' });
        const body = await readJsonBody(req);
        const missing = Object.values(state.players).filter(p => p.picks.length !== p.order);

        if (missing.length > 0 && !body.force) {
          return sendJson(res, 409, {
            error: `Henüz tercih göndermeyen ${missing.length} kişi var. Yine de açıklamak istiyor musunuz?`,
            needsConfirm: true,
            missingCount: missing.length
          });
        }
        state.results = computeResults();
        state.phase = 'revealed';
        saveState(state);
        sendJson(res, 200, { state: buildPublicState(playerToken, true) });
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/reset') {
        for (const p of Object.values(state.players)) {
          p.picks = [];
          p.submittedAt = null;
        }
        state.results = null;
        state.phase = 'lobby';
        saveState(state);
        sendJson(res, 200, { state: buildPublicState(playerToken, true) });
        return;
      }
    }

    sendJson(res, 404, { error: 'Bulunamadı.' });
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message || 'Sunucu hatası.' });
  }
});

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`⚽ FC27 Turnuva Sunucusu çalışıyor: http://localhost:${PORT}`);
  console.log(`🔑 Yönetici Anahtarı (ADMIN_KEY): ${ADMIN_KEY}`);
  console.log(`🛠️  Yönetici Giriş Bağlantısı: http://localhost:${PORT}/?admin=${ADMIN_KEY}`);
  console.log('====================================================');
});