#!/usr/bin/env node
/**
 * EA Sports FC 27 Turnuva Takım Seçim Sunucusu
 * Node.js 18+ (Harici paket gerektirmez)
 * Çalıştırma: node server.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

const MAX_BODY_BYTES = 20 * 1024; // 20 KB
const MAX_TEAM_NAME_LENGTH = 40;
const MAX_POOL_SIZE = 80;
const MAX_PLAYER_NAME_LENGTH = 40;
const MAX_PLAYERS_PER_GROUP = 30;

// Yönetici anahtarı: ADMIN_KEY ortam değişkeninden alınır, yoksa rastgele üretilir.
const ENV_ADMIN_KEY = typeof process.env.ADMIN_KEY === 'string' ? process.env.ADMIN_KEY.trim() : '';
const ADMIN_KEY = ENV_ADMIN_KEY || crypto.randomBytes(16).toString('hex');

const DEFAULT_GROUPS = {
  '5star': {
    id: '5star',
    label: '5★ Grubu',
    subtitle: 'En Kötü Oynayanlar',
    players: ['Mustafa', 'Ali', 'İskender', 'Enes', 'Yasin'],
    pool: [
      'Paris Saint-Germain',
      'Real Madrid',
      'FC Barcelona',
      'Arsenal',
      'Bayern München',
      'Manchester City',
      'Liverpool',
      'Atlético de Madrid',
      'İspanya',
      'Fransa',
      'Portekiz',
      'İngiltere',
      'Brezilya',
      'Almanya',
      'İtalya'
    ]
  },
  '4.5star': {
    id: '4.5star',
    label: '4.5★ Grubu',
    subtitle: 'En İyi Oynayanlar',
    players: ['Lokman', 'Ekrem', 'Serhat', 'Sefa', 'Emre'],
    pool: [
      'Inter (Lombardia FC)',
      'Borussia Dortmund',
      'Chelsea',
      'Tottenham Hotspur',
      'Napoli',
      'AS Roma',
      'Manchester United',
      'Milano FC (AC Milan)',
      'Juventus',
      'Galatasaray',
      'Fenerbahçe',
      'Bayer 04 Leverkusen',
      'Newcastle United',
      'Athletic Club (Bilbao)',
      'Aston Villa',
      'Nottingham Forest',
      'Crystal Palace',
      'Real Betis',
      'Atalanta (Bergamo Calcio)',
      'RB Leipzig',
      'Sunderland',
      'FC Porto'
    ]
  }
};

/**
 * Varsayılan başlangıç verisini oluşturur.
 */
function createInitialData() {
  const groups = {};
  for (const [key, def] of Object.entries(DEFAULT_GROUPS)) {
    groups[key] = {
      id: def.id,
      label: def.label,
      subtitle: def.subtitle,
      pool: [...def.pool],
      players: def.players.map((name) => ({
        name,
        token: null,
        claimedAt: null,
        picks: [],
        pickedAt: null
      }))
    };
  }
  return {
    version: 1,
    phase: 'prep', // 'prep' | 'pick' | 'reveal'
    updatedAt: new Date().toISOString(),
    groups,
    results: null
  };
}

/**
 * Geçici dosya üzerinden atomik yazma işlemi.
 */
function saveDataAtomic(data) {
  data.updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(data, null, 2);
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = path.join(
    dir,
    `.data.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
  );
  fs.writeFileSync(tmpFile, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, DATA_FILE);
}

/**
 * Diskten veriyi okur veya yoksa oluşturur.
 */
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = createInitialData();
    saveDataAtomic(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.groups) {
      throw new Error('Geçersiz data.json yapısı');
    }
    if (!['prep', 'pick', 'reveal'].includes(parsed.phase)) {
      parsed.phase = 'prep';
    }
    for (const key of ['5star', '4.5star']) {
      if (!parsed.groups[key]) {
        const def = DEFAULT_GROUPS[key];
        parsed.groups[key] = {
          id: def.id,
          label: def.label,
          subtitle: def.subtitle,
          pool: [...def.pool],
          players: def.players.map((name) => ({
            name,
            token: null,
            claimedAt: null,
            picks: [],
            pickedAt: null
          }))
        };
      } else {
        parsed.groups[key].pool = Array.isArray(parsed.groups[key].pool)
          ? parsed.groups[key].pool
          : [...DEFAULT_GROUPS[key].pool];
        parsed.groups[key].players = Array.isArray(parsed.groups[key].players)
          ? parsed.groups[key].players.map((p) => ({
              name: String(p.name || '').trim(),
              token: typeof p.token === 'string' && p.token ? p.token : null,
              claimedAt: p.claimedAt || null,
              picks: Array.isArray(p.picks) ? p.picks : [],
              pickedAt: p.pickedAt || null
            }))
          : [];
      }
    }
    return parsed;
  } catch (err) {
    console.error('[UYARI] data.json okunamadı, varsayılan veriyle başlatılıyor:', err.message);
    const initial = createInitialData();
    saveDataAtomic(initial);
    return initial;
  }
}

let state = loadData();

/**
 * Sabit zamanlı (constant-time) yönetici anahtarı doğrulaması.
 */
function verifyAdminKey(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  const expectedBuf = Buffer.from(ADMIN_KEY, 'utf8');
  const candidateBuf = Buffer.from(candidate, 'utf8');
  if (expectedBuf.length !== candidateBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

/**
 * İstekten oyuncu token bilgisini çıkarır.
 */
function extractPlayerToken(req, body) {
  const headerToken = req.headers['x-player-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  if (body && typeof body.token === 'string' && body.token.trim()) {
    return body.token.trim();
  }
  return null;
}

/**
 * İstekten yönetici anahtarını çıkarır.
 */
function extractAdminKey(req, body) {
  const headerKey = req.headers['x-admin-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  if (body && typeof body.adminKey === 'string' && body.adminKey.trim()) {
    return body.adminKey.trim();
  }
  return null;
}

/**
 * Token ile oyuncuyu bulur.
 */
function findPlayerByToken(token) {
  if (!token) return null;
  for (const groupKey of ['5star', '4.5star']) {
    const group = state.groups[groupKey];
    for (let i = 0; i < group.players.length; i++) {
      const p = group.players[i];
      if (p.token && p.token === token) {
        return { groupKey, group, player: p, index: i, requiredPicks: i + 1 };
      }
    }
  }
  return null;
}

/**
 * İstemciye gönderilecek güvenli durum nesnesini üretir.
 * - Başka hiçbir oyuncunun tercihi (picks) veya anahtarı (token) asla gönderilmez.
 * - Açıklama (reveal) öncesinde results alanı hiç dönmez.
 */
function buildClientState(playerToken, adminKey) {
  const meInfo = findPlayerByToken(playerToken);
  const isAdmin = adminKey ? verifyAdminKey(adminKey) : false;

  const groupsOut = {};
  let totalPlayers = 0;
  let claimedCount = 0;
  let pickedCount = 0;

  for (const groupKey of ['5star', '4.5star']) {
    const g = state.groups[groupKey];
    const playersOut = g.players.map((p, idx) => {
      const requiredPicks = idx + 1;
      const claimed = Boolean(p.token);
      const hasPicked = Array.isArray(p.picks) && p.picks.length === requiredPicks;
      totalPlayers++;
      if (claimed) claimedCount++;
      if (hasPicked) pickedCount++;
      return {
        name: p.name,
        order: requiredPicks,
        requiredPicks,
        claimed,
        hasPicked
      };
    });

    groupsOut[groupKey] = {
      id: g.id,
      label: g.label,
      subtitle: g.subtitle,
      pool: [...g.pool],
      players: playersOut
    };
  }

  const response = {
    phase: state.phase,
    updatedAt: state.updatedAt,
    summary: {
      totalPlayers,
      claimedCount,
      pickedCount
    },
    groups: groupsOut,
    me: meInfo
      ? {
          group: meInfo.groupKey,
          groupLabel: meInfo.group.label,
          name: meInfo.player.name,
          order: meInfo.requiredPicks,
          requiredPicks: meInfo.requiredPicks,
          hasPicked:
            Array.isArray(meInfo.player.picks) &&
            meInfo.player.picks.length === meInfo.requiredPicks,
          picks: [...meInfo.player.picks]
        }
      : null,
    isAdmin
  };

  // Gizlilik kuralı: Açıklama öncesinde sonuç alanı hiç dönmez.
  if (state.phase === 'reveal' && state.results) {
    response.results = state.results;
  }

  return response;
}

/**
 * Dağıtım algoritması:
 * Her grup için sırayla (1..N) oyuncunun tercih listesindeki ilk henüz alınmamış takımı verir.
 * Tercih göndermeyen kişi takım almaz.
 */
function computeRevealResults() {
  const groupsResult = {};
  for (const groupKey of ['5star', '4.5star']) {
    const group = state.groups[groupKey];
    const takenByMap = new Map(); // teamName -> playerName
    const allocations = [];

    for (let i = 0; i < group.players.length; i++) {
      const player = group.players[i];
      const order = i + 1;
      const validPicks =
        Array.isArray(player.picks) && player.picks.length === order ? [...player.picks] : [];

      let assignedTeam = null;
      let assignedPreferenceRank = null;

      if (validPicks.length === order) {
        for (let pIdx = 0; pIdx < validPicks.length; pIdx++) {
          const candidateTeam = validPicks[pIdx];
          if (!takenByMap.has(candidateTeam)) {
            assignedTeam = candidateTeam;
            assignedPreferenceRank = pIdx + 1;
            break;
          }
        }
      }

      const preferences = validPicks.map((team, pIdx) => {
        const prefRank = pIdx + 1;
        const previousOwner = takenByMap.get(team) || null;
        let status = 'unused';
        if (assignedPreferenceRank === prefRank) {
          status = 'assigned';
        } else if (assignedPreferenceRank === null || prefRank < assignedPreferenceRank) {
          status = 'taken';
        }
        return {
          rank: prefRank,
          team,
          status,
          takenBy: previousOwner
        };
      });

      if (assignedTeam) {
        takenByMap.set(assignedTeam, player.name);
      }

      allocations.push({
        name: player.name,
        order,
        requiredPicks: order,
        hasPicked: validPicks.length === order,
        assignedTeam,
        assignedPreferenceRank,
        picks: validPicks,
        preferences
      });
    }

    groupsResult[groupKey] = {
      id: group.id,
      label: group.label,
      subtitle: group.subtitle,
      allocations
    };
  }

  return {
    revealedAt: new Date().toISOString(),
    groups: groupsResult
  };
}

/**
 * Gövdeyi 20 KB sınırı ile okur ve JSON olarak ayrıştırır.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        req.resume(); // Kalan veriyi tüket, yanıtı temiz şekilde 413 dön
        reject({
          status: 413,
          message: 'İstek gövdesi çok büyük. En fazla 20 KB veri gönderilebilir.'
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) return;
      if (totalBytes === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject({ status: 400, message: 'Geçersiz JSON nesnesi.' });
          return;
        }
        resolve(parsed);
      } catch (_err) {
        reject({ status: 400, message: 'Geçersiz JSON veri formatı.' });
      }
    });

    req.on('error', () => {
      if (!tooLarge) {
        reject({ status: 400, message: 'İstek okunurken bir hata oluştu.' });
      }
    });
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/**
 * Havuz listesini doğrular.
 */
function validatePoolList(rawPool, minRequired, groupLabel) {
  if (!Array.isArray(rawPool)) {
    return { ok: false, error: `${groupLabel} için takım havuzu listesi geçersiz.` };
  }
  const cleaned = rawPool
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);

  if (cleaned.length < minRequired) {
    return {
      ok: false,
      error: `${groupLabel} havuzunda en az gruptaki kişi sayısı (${minRequired}) kadar takım bulunmalıdır (şu an: ${cleaned.length}).`
    };
  }
  if (cleaned.length > MAX_POOL_SIZE) {
    return {
      ok: false,
      error: `${groupLabel} havuzunda en fazla ${MAX_POOL_SIZE} takım bulunabilir (şu an: ${cleaned.length}).`
    };
  }

  const seen = new Set();
  for (const team of cleaned) {
    if (team.length > MAX_TEAM_NAME_LENGTH) {
      return {
        ok: false,
        error: `Takım ismi en fazla ${MAX_TEAM_NAME_LENGTH} karakter olabilir: "${team.slice(0, 25)}..."`
      };
    }
    const key = team.toLocaleLowerCase('tr-TR');
    if (seen.has(key)) {
      return {
        ok: false,
        error: `${groupLabel} havuzunda tekrar eden takım ismi var: "${team}".`
      };
    }
    seen.add(key);
  }

  return { ok: true, pool: cleaned };
}

/**
 * Oyuncu listesini doğrular.
 */
function validatePlayersList(rawPlayers, groupLabel, globalSeen) {
  if (!Array.isArray(rawPlayers)) {
    return { ok: false, error: `${groupLabel} oyuncu listesi geçersiz.` };
  }
  const cleaned = rawPlayers
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);

  if (cleaned.length < 1) {
    return {
      ok: false,
      error: `${groupLabel} içinde en az 1 oyuncu bulunmalıdır.`
    };
  }
  if (cleaned.length > MAX_PLAYERS_PER_GROUP) {
    return {
      ok: false,
      error: `${groupLabel} içinde en fazla ${MAX_PLAYERS_PER_GROUP} oyuncu bulunabilir.`
    };
  }

  for (const name of cleaned) {
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      return {
        ok: false,
        error: `Oyuncu ismi en fazla ${MAX_PLAYER_NAME_LENGTH} karakter olabilir: "${name.slice(0, 25)}..."`
      };
    }
    const key = name.toLocaleLowerCase('tr-TR');
    if (globalSeen.has(key)) {
      return {
        ok: false,
        error: `Tekrar eden oyuncu ismi kullanılamaz: "${name}".`
      };
    }
    globalSeen.add(key);
  }

  return { ok: true, players: cleaned };
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';

    // Ana sayfa (index.html)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (!fs.existsSync(INDEX_FILE)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html dosyası bulunamadı.');
        return;
      }
      const html = fs.readFileSync(INDEX_FILE, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(html);
      return;
    }

    // Durum sorgulama (4 saniyelik yoklama)
    if (method === 'GET' && pathname === '/api/state') {
      const token =
        extractPlayerToken(req, null) ||
        (parsedUrl.searchParams.get('token') || '').trim() ||
        null;
      const adminKey = extractAdminKey(req, null);
      const clientState = buildClientState(token, adminKey);
      sendJson(res, 200, clientState);
      return;
    }

    // POST uç noktaları
    if (method === 'POST' && pathname.startsWith('/api/')) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (bodyErr) {
        sendJson(res, bodyErr.status || 400, {
          error: bodyErr.message || 'İstek gövdesi okunamadı.'
        });
        return;
      }

      // 1. Oyuncu isim seçimi (Katılım)
      if (pathname === '/api/claim' || pathname === '/api/join') {
        if (state.phase === 'reveal') {
          sendJson(res, 400, {
            error: 'Seçimler açıklandıktan sonra yeni isim alınamaz.'
          });
          return;
        }

        const groupKey = typeof body.group === 'string' ? body.group.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const currentToken = extractPlayerToken(req, body);

        if (!['5star', '4.5star'].includes(groupKey)) {
          sendJson(res, 400, { error: 'Geçersiz grup seçimi. 5★ veya 4.5★ seçmelisin.' });
          return;
        }
        if (!name) {
          sendJson(res, 400, { error: 'Lütfen listeden adını seç.' });
          return;
        }

        const group = state.groups[groupKey];
        const playerIndex = group.players.findIndex((p) => p.name === name);
        if (playerIndex === -1) {
          sendJson(res, 404, { error: 'Seçilen isim bu grupta bulunamadı.' });
          return;
        }

        const targetPlayer = group.players[playerIndex];

        // Zaten alınmış mı kontrol et
        if (targetPlayer.token) {
          if (currentToken && targetPlayer.token === currentToken) {
            sendJson(res, 200, {
              ok: true,
              token: targetPlayer.token,
              group: groupKey,
              name: targetPlayer.name,
              order: playerIndex + 1,
              requiredPicks: playerIndex + 1,
              state: buildClientState(targetPlayer.token, null)
            });
            return;
          }
          sendJson(res, 409, { error: 'Bu isim az önce alındı.' });
          return;
        }

        // Eğer bu tarayıcıda başka bir isim tutuluyorsa:
        if (currentToken) {
          const existing = findPlayerByToken(currentToken);
          if (existing) {
            const hasSubmitted =
              Array.isArray(existing.player.picks) &&
              existing.player.picks.length === existing.requiredPicks;
            if (hasSubmitted) {
              sendJson(res, 400, {
                error: 'Tercih gönderdikten sonra adını bırakamaz veya değiştiremezsin.'
              });
              return;
            }
            existing.player.token = null;
            existing.player.claimedAt = null;
            existing.player.picks = [];
            existing.player.pickedAt = null;
          }
        }

        const newToken = crypto.randomBytes(24).toString('hex');
        targetPlayer.token = newToken;
        targetPlayer.claimedAt = new Date().toISOString();
        saveDataAtomic(state);

        sendJson(res, 200, {
          ok: true,
          token: newToken,
          group: groupKey,
          name: targetPlayer.name,
          order: playerIndex + 1,
          requiredPicks: playerIndex + 1,
          state: buildClientState(newToken, null)
        });
        return;
      }

      // 2. Oyuncunun adını bırakması ("Ben değilim")
      if (pathname === '/api/leave') {
        const token = extractPlayerToken(req, body);
        const found = findPlayerByToken(token);
        if (!found) {
          sendJson(res, 401, { error: 'Aktif bir oyuncu seçimi bulunamadı.' });
          return;
        }
        if (state.phase === 'reveal') {
          sendJson(res, 400, { error: 'Sonuçlar açıklandıktan sonra adını bırakamazsın.' });
          return;
        }
        if (
          Array.isArray(found.player.picks) &&
          found.player.picks.length > 0
        ) {
          sendJson(res, 400, {
            error: 'Tercih gönderdikten sonra adını bırakamazsın.'
          });
          return;
        }

        found.player.token = null;
        found.player.claimedAt = null;
        found.player.picks = [];
        found.player.pickedAt = null;
        saveDataAtomic(state);

        sendJson(res, 200, {
          ok: true,
          state: buildClientState(null, null)
        });
        return;
      }

      // 3. Oyuncunun tercihlerini göndermesi ("Tercihlerimi gönder")
      if (pathname === '/api/pick' || pathname === '/api/picks') {
        if (state.phase !== 'pick') {
          sendJson(res, 400, {
            error: 'Şu anda tercih aşamasında değiliz. Organizatör seçimi başlattığında tercih gönderebilirsin.'
          });
          return;
        }

        const token = extractPlayerToken(req, body);
        const found = findPlayerByToken(token);
        if (!found) {
          sendJson(res, 401, {
            error: 'Geçersiz oyuncu oturumu. Lütfen önce adını seç.'
          });
          return;
        }

        const k = found.requiredPicks;
        const rawPicks = body.picks;

        if (!Array.isArray(rawPicks) || rawPicks.length !== k) {
          sendJson(res, 400, {
            error: `Tam olarak ${k} takım seçmelisin.`
          });
          return;
        }

        const cleanedPicks = [];
        const seen = new Set();
        const poolSet = new Set(found.group.pool);

        for (const item of rawPicks) {
          if (typeof item !== 'string') {
            sendJson(res, 400, { error: 'Geçersiz takım formatı.' });
            return;
          }
          const team = item.trim();
          if (!team || team.length > MAX_TEAM_NAME_LENGTH) {
            sendJson(res, 400, {
              error: `Takım ismi boş olamaz ve ${MAX_TEAM_NAME_LENGTH} karakteri geçemez.`
            });
            return;
          }
          if (seen.has(team)) {
            sendJson(res, 400, {
              error: 'Tercih listende aynı takımı birden fazla kez seçemezsin.'
            });
            return;
          }
          if (!poolSet.has(team)) {
            sendJson(res, 400, {
              error: `"${team}" senin grubunun (${found.group.label}) takım havuzunda bulunmuyor.`
            });
            return;
          }
          seen.add(team);
          cleanedPicks.push(team);
        }

        found.player.picks = cleanedPicks;
        found.player.pickedAt = new Date().toISOString();
        saveDataAtomic(state);

        sendJson(res, 200, {
          ok: true,
          picks: cleanedPicks,
          state: buildClientState(token, null)
        });
        return;
      }

      // 4. Yönetici işlemleri (Sabit zamanlı anahtar doğrulaması zorunlu)
      if (pathname.startsWith('/api/admin/')) {
        const adminKey = extractAdminKey(req, body);
        if (!verifyAdminKey(adminKey)) {
          sendJson(res, 403, {
            error: 'Yetkisiz işlem: Yönetici anahtarı geçersiz.'
          });
          return;
        }

        const playerToken = extractPlayerToken(req, body);

        // 4a. Anahtar doğrulama
        if (pathname === '/api/admin/verify') {
          sendJson(res, 200, {
            ok: true,
            state: buildClientState(playerToken, adminKey)
          });
          return;
        }

        // 4b. Havuzları ve (opsiyonel) oyuncu listesini güncelleme (Sadece hazırlık fazında)
        if (pathname === '/api/admin/pools' || pathname === '/api/admin/settings') {
          if (state.phase !== 'prep') {
            sendJson(res, 400, {
              error: 'Takım havuzları ve oyuncu listeleri sadece hazırlık aşamasında düzenlenebilir.'
            });
            return;
          }

          const nextPlayersMap = {};
          const globalPlayerNames = new Set();

          for (const gKey of ['5star', '4.5star']) {
            const gObj = state.groups[gKey];
            const incomingPlayers =
              body.players && body.players[gKey] !== undefined
                ? body.players[gKey]
                : gObj.players.map((p) => p.name);

            const pVal = validatePlayersList(incomingPlayers, gObj.label, globalPlayerNames);
            if (!pVal.ok) {
              sendJson(res, 400, { error: pVal.error });
              return;
            }
            nextPlayersMap[gKey] = pVal.players;
          }

          const nextPoolsMap = {};
          for (const gKey of ['5star', '4.5star']) {
            const gObj = state.groups[gKey];
            const incomingPool =
              body.pools && body.pools[gKey] !== undefined
                ? body.pools[gKey]
                : body[gKey] !== undefined
                ? body[gKey]
                : gObj.pool;

            const minReq = nextPlayersMap[gKey].length;
            const poolVal = validatePoolList(incomingPool, minReq, gObj.label);
            if (!poolVal.ok) {
              sendJson(res, 400, { error: poolVal.error });
              return;
            }
            nextPoolsMap[gKey] = poolVal.pool;
          }

          // Mevcut katılan oyuncuların tokenlarını koruyarak oyuncu listesini ve havuzları kaydet
          for (const gKey of ['5star', '4.5star']) {
            const gObj = state.groups[gKey];
            const existingByName = new Map(gObj.players.map((p) => [p.name, p]));
            gObj.players = nextPlayersMap[gKey].map((name) => {
              const prev = existingByName.get(name);
              return {
                name,
                token: prev ? prev.token : null,
                claimedAt: prev ? prev.claimedAt : null,
                picks: [],
                pickedAt: null
              };
            });
            gObj.pool = nextPoolsMap[gKey];
          }

          saveDataAtomic(state);
          sendJson(res, 200, {
            ok: true,
            state: buildClientState(playerToken, adminKey)
          });
          return;
        }

        // 4c. Yanlış alınan bir oyuncu ismini serbest bırakma ("Serbest bırak")
        if (pathname === '/api/admin/release') {
          if (state.phase === 'reveal') {
            sendJson(res, 400, {
              error: 'Sonuçlar açıklandıktan sonra isim serbest bırakılamaz. Önce baştan başlayın.'
            });
            return;
          }

          const groupKey = typeof body.group === 'string' ? body.group.trim() : '';
          const name = typeof body.name === 'string' ? body.name.trim() : '';

          if (!['5star', '4.5star'].includes(groupKey) || !name) {
            sendJson(res, 400, { error: 'Geçersiz grup veya oyuncu adı.' });
            return;
          }

          const gObj = state.groups[groupKey];
          const target = gObj.players.find((p) => p.name === name);
          if (!target) {
            sendJson(res, 404, { error: 'Oyuncu bulunamadı.' });
            return;
          }

          target.token = null;
          target.claimedAt = null;
          target.picks = [];
          target.pickedAt = null;
          saveDataAtomic(state);

          sendJson(res, 200, {
            ok: true,
            state: buildClientState(playerToken, adminKey)
          });
          return;
        }

        // 4d. Seçimi başlat ("Seçimi başlat")
        if (pathname === '/api/admin/start') {
          if (state.phase !== 'prep') {
            sendJson(res, 400, {
              error: 'Seçim yalnızca hazırlık aşamasındayken başlatılabilir.'
            });
            return;
          }

          for (const gKey of ['5star', '4.5star']) {
            const gObj = state.groups[gKey];
            if (gObj.players.length < 1) {
              sendJson(res, 400, {
                error: `${gObj.label} içinde en az 1 oyuncu bulunmalıdır.`
              });
              return;
            }
            const poolCheck = validatePoolList(gObj.pool, gObj.players.length, gObj.label);
            if (!poolCheck.ok) {
              sendJson(res, 400, { error: poolCheck.error });
              return;
            }
          }

          state.phase = 'pick';
          state.results = null;
          saveDataAtomic(state);

          sendJson(res, 200, {
            ok: true,
            state: buildClientState(playerToken, adminKey)
          });
          return;
        }

        // 4e. Seçimleri açıkla ("Seçimleri açıkla")
        if (pathname === '/api/admin/reveal') {
          if (state.phase !== 'pick') {
            sendJson(res, 400, {
              error: 'Seçimler yalnızca tercih aşamasındayken açıklanabilir.'
            });
            return;
          }

          const missingPlayers = [];
          for (const gKey of ['5star', '4.5star']) {
            const gObj = state.groups[gKey];
            gObj.players.forEach((p, idx) => {
              const reqCount = idx + 1;
              if (!Array.isArray(p.picks) || p.picks.length !== reqCount) {
                missingPlayers.push({ group: gObj.label, name: p.name });
              }
            });
          }

          if (missingPlayers.length > 0 && body.requireAllPicked === true) {
            sendJson(res, 409, {
              error: `${missingPlayers.length} oyuncu henüz tercihini göndermedi.`,
              needsConfirmation: true,
              missingPlayers
            });
            return;
          }

          state.results = computeRevealResults();
          state.phase = 'reveal';
          saveDataAtomic(state);

          sendJson(res, 200, {
            ok: true,
            state: buildClientState(playerToken, adminKey)
          });
          return;
        }

        // 4f. Baştan başla ("Baştan başla" - katılan isimler korunur, tercihler ve sonuçlar silinir)
        if (pathname === '/api/admin/reset') {
          for (const gKey of ['5star', '4.5star']) {
            const gObj = state.groups[gKey];
            for (const p of gObj.players) {
              p.picks = [];
              p.pickedAt = null;
            }
          }
          state.phase = 'prep';
          state.results = null;
          saveDataAtomic(state);

          sendJson(res, 200, {
            ok: true,
            state: buildClientState(playerToken, adminKey)
          });
          return;
        }

        sendJson(res, 404, { error: 'Bilinmeyen yönetici işlemi.' });
        return;
      }

      sendJson(res, 404, { error: 'API uç noktası bulunamadı.' });
      return;
    }

    sendJson(res, 404, { error: 'Sayfa bulunamadı.' });
  } catch (err) {
    console.error('[SUNUCU HATASI]', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Sunucu tarafında beklenmeyen bir hata oluştu.' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log(`EA Sports FC 27 Turnuva Sunucusu çalışıyor: http://localhost:${PORT}`);
  if (!ENV_ADMIN_KEY) {
    console.log(`Rastgele üretilen ADMIN_KEY: ${ADMIN_KEY}`);
  } else {
    console.log('ADMIN_KEY ortam değişkeninden yüklendi.');
  }
  console.log(`Organizatör Giriş Adresi: http://localhost:${PORT}/?admin=${ADMIN_KEY}`);
  console.log('============================================================');
});