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

// Bu sunucu sürecinin kimliği. İstemci, sunucunun yeniden başladığını bununla anlar.
const BOOT_ID = crypto.randomBytes(6).toString('hex');

// Kalıcı kayıt (isteğe bağlı): GIST_TOKEN ortam değişkeni verilirse tüm durum şifreli olarak
// gizli bir GitHub Gist'ine de yazılır. Böylece sunucu uyuyup yeniden başlasa bile (Render'ın
// ücretsiz planında yerel dosyalar her yeniden başlatmada silinir) kayıtlar geri yüklenir.
const GIST_TOKEN = typeof process.env.GIST_TOKEN === 'string' ? process.env.GIST_TOKEN.trim() : '';
const GIST_ID_ENV = typeof process.env.GIST_ID === 'string' ? process.env.GIST_ID.trim() : '';
const GIST_DESCRIPTION = (process.env.GIST_NAME || 'fc27-turnuva-data').trim();
const GIST_FILE = 'fc27-data.txt';
const GIST_API = (process.env.GIST_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const GIST_TIMEOUT_MS = 10000;

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

function makeDefaultGroup(key) {
  const def = DEFAULT_GROUPS[key];
  return {
    id: def.id,
    label: def.label,
    subtitle: def.subtitle,
    pool: [...def.pool],
    players: def.players.map((name) => ({
      name,
      token: null,
      clientId: null,
      claimedAt: null,
      picks: [],
      pickedAt: null
    }))
  };
}

/**
 * Varsayılan başlangıç verisini oluşturur.
 */
function createInitialData() {
  const groups = {};
  for (const key of Object.keys(DEFAULT_GROUPS)) {
    groups[key] = makeDefaultGroup(key);
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
  try {
    fs.writeFileSync(tmpFile, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch (_e) {
      // geçici dosya zaten yok
    }
    throw err;
  }
}

/**
 * Yerel dosyaya yazar; yazamazsa sunucuyu düşürmez, yalnızca uyarı basar.
 */
function trySaveLocal(data) {
  try {
    saveDataAtomic(data);
    return true;
  } catch (err) {
    console.error('[UYARI] data.json yazılamadı:', err.message);
    return false;
  }
}

/**
 * Dosyadan veya buluttan okunan veriyi doğrular, eksikleri tamamlar.
 * Yapı geçersizse hata fırlatır.
 */
function normalizeData(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.groups || typeof parsed.groups !== 'object') {
    throw new Error('Geçersiz veri yapısı');
  }
  if (!['prep', 'pick', 'reveal'].includes(parsed.phase)) {
    parsed.phase = 'prep';
  }
  for (const key of ['5star', '4.5star']) {
    const def = DEFAULT_GROUPS[key];
    const g = parsed.groups[key];
    if (!g || typeof g !== 'object') {
      parsed.groups[key] = makeDefaultGroup(key);
      continue;
    }
    g.id = def.id;
    g.label = typeof g.label === 'string' && g.label ? g.label : def.label;
    g.subtitle = typeof g.subtitle === 'string' ? g.subtitle : def.subtitle;
    g.pool = Array.isArray(g.pool)
      ? g.pool.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      : [...def.pool];
    g.players = Array.isArray(g.players)
      ? g.players
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            name: String(p.name || '').trim(),
            token: typeof p.token === 'string' && p.token ? p.token : null,
            clientId: typeof p.clientId === 'string' && p.clientId ? p.clientId : null,
            claimedAt: p.claimedAt || null,
            picks: Array.isArray(p.picks) ? p.picks.filter((t) => typeof t === 'string') : [],
            pickedAt: p.pickedAt || null
          }))
      : [];
  }
  const hasResults =
    parsed.results && typeof parsed.results === 'object' && parsed.results.groups;
  if (parsed.phase === 'reveal' && !hasResults) {
    // Sonuçlar kayıpsa açıklama yeniden yapılabilsin.
    parsed.phase = 'pick';
  }
  if (parsed.phase !== 'reveal') {
    parsed.results = null;
  }
  if (typeof parsed.updatedAt !== 'string') {
    parsed.updatedAt = new Date().toISOString();
  }
  return parsed;
}

// Açılışta yerel kayıt bulunamadıysa (ör. Render yeniden başlatması) true olur.
let localWasMissing = false;

/**
 * Diskten veriyi okur veya yoksa oluşturur.
 */
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    } catch (err) {
      console.error('[UYARI] data.json okunamadı, varsayılan veriyle başlatılıyor:', err.message);
    }
  }
  localWasMissing = true;
  const initial = createInitialData();
  trySaveLocal(initial);
  return initial;
}

let state = loadData();
let changedSinceBoot = false;

/**
 * Durumu kaydeder: önce yerel dosyaya, ardından (açıksa) buluta.
 * Kayıt hatası isteği başarısız yapmaz; durum bellekte güncel kalır.
 */
function persistState() {
  changedSinceBoot = true;
  if (!trySaveLocal(state)) {
    state.updatedAt = new Date().toISOString();
  }
  scheduleRemoteSave();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Kalıcı kayıt (isteğe bağlı): şifreli durum, gizli bir GitHub Gist'inde tutulur.
// ---------------------------------------------------------------------------
const gist = {
  enabled: Boolean(GIST_TOKEN) && typeof fetch === 'function',
  id: GIST_ID_ENV || null,
  ready: false, // bulut kaydıyla ilk eşitleme tamamlandı mı
  dirty: false, // buluta yazılmayı bekleyen değişiklik var mı
  saving: false,
  timer: null,
  retryTimer: null,
  failCount: 0,
  lastSavedAt: null,
  lastError: null,
  writeTimes: []
};

// false iken API "sunucu açılıyor" yanıtı verir: bulut kaydı yüklenmeden işlem yapılmaz.
let storageReady = !gist.enabled;
let shuttingDown = false;

/**
 * Organizatöre gösterilen kayıt durumu.
 * mode: 'gist' (bulut), 'file' (kalıcı dosya), 'ephemeral' (yeniden başlatmada silinir)
 */
function storageInfo() {
  if (gist.enabled) {
    return {
      mode: 'gist',
      ready: gist.ready,
      pending: gist.dirty || gist.saving,
      lastSavedAt: gist.lastSavedAt,
      error: gist.lastError
    };
  }
  const ephemeral = Boolean(process.env.RENDER) && !process.env.DATA_FILE;
  return {
    mode: ephemeral ? 'ephemeral' : 'file',
    error: GIST_TOKEN ? 'Bu Node sürümü bulut kaydını desteklemiyor (Node 18 veya üstü gerekli).' : null
  };
}

function gistCryptoKey() {
  return crypto.createHash('sha256').update('fc27-data-v1:' + GIST_TOKEN, 'utf8').digest();
}

/** Durumu AES-256-GCM ile şifreler; Gist'i açan biri tercihleri okuyamaz. */
function sealData(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', gistCryptoKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return 'fc27v1:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function openData(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('fc27v1:')) {
    throw new Error('Tanınmayan kayıt biçimi');
  }
  const buf = Buffer.from(raw.slice(7), 'base64');
  if (buf.length < 29) {
    throw new Error('Kayıt eksik');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', gistCryptoKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

async function gistRequest(method, apiPath, body) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + GIST_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fc27-turnuva'
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(GIST_API + apiPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_e) {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && data.message) || text.slice(0, 120) || 'yanıt yok';
    const err = new Error(`GitHub ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Bu uygulamaya ait Gist'i açıklamasından bulur. Yoksa null döner. */
async function gistFindId() {
  if (gist.id) return gist.id;
  for (let page = 1; page <= 10; page++) {
    const list = await gistRequest('GET', `/gists?per_page=100&page=${page}`);
    if (!Array.isArray(list) || list.length === 0) break;
    const hit = list.find(
      (g) => g && g.description === GIST_DESCRIPTION && g.files && g.files[GIST_FILE]
    );
    if (hit && hit.id) {
      gist.id = String(hit.id);
      return gist.id;
    }
    if (list.length < 100) break;
  }
  return null;
}

async function gistFetchRemote() {
  const id = await gistFindId();
  if (!id) return { data: null };
  let doc;
  try {
    doc = await gistRequest('GET', '/gists/' + encodeURIComponent(id));
  } catch (err) {
    if (err.status === 404 && !GIST_ID_ENV) {
      gist.id = null; // Gist silinmiş: yenisi oluşturulacak
      return { data: null };
    }
    throw err;
  }
  const file = doc && doc.files && doc.files[GIST_FILE];
  if (!file || typeof file.content !== 'string') return { data: null };
  try {
    return { data: normalizeData(openData(file.content)) };
  } catch (err) {
    return { data: null, unreadable: err.message };
  }
}

/**
 * Bulut kaydıyla eşitler. Sunucu boş açıldıysa buluttaki kayıt geri yüklenir;
 * yerelde daha yeni veri varsa buluta yazılır. Ulaşılamazsa hata fırlatır.
 */
async function gistSync() {
  const remote = await gistFetchRemote();
  if (remote.data) {
    const remoteTime = Date.parse(remote.data.updatedAt) || 0;
    const localTime = Date.parse(state.updatedAt) || 0;
    const localHasRealData = changedSinceBoot || !localWasMissing;
    if (!localHasRealData || (!changedSinceBoot && remoteTime >= localTime)) {
      state = remote.data;
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      } catch (_e) {
        // yerel kopya yazılamazsa bellekteki durum yeterli
      }
      console.log(`[KAYIT] Buluttaki kayıt geri yüklendi (son değişiklik: ${state.updatedAt}).`);
    } else {
      gist.dirty = true;
      console.log('[KAYIT] Yereldeki kayıt daha yeni; buluta yazılacak.');
    }
  } else {
    gist.dirty = true;
    if (remote.unreadable) {
      console.error(
        '[UYARI] Buluttaki kayıt çözülemedi (GIST_TOKEN değişmiş olabilir); üzerine yazılacak:',
        remote.unreadable
      );
    }
  }
  gist.ready = true;
  gist.lastError = null;
  gist.failCount = 0;
  if (gist.dirty) scheduleRemoteSave(0);
}

function scheduleGistRetry() {
  if (gist.retryTimer || shuttingDown) return;
  const delay = Math.min(300000, 30000 * 2 ** Math.min(gist.failCount, 4));
  gist.retryTimer = setTimeout(async () => {
    gist.retryTimer = null;
    try {
      await gistSync();
    } catch (err) {
      gist.failCount++;
      gist.lastError = err.message;
      console.error('[KAYIT] Bulut kaydına hâlâ ulaşılamıyor:', err.message);
      scheduleGistRetry();
    }
  }, delay);
}

/** Açılışta bulut kaydını yükler; bu bitene kadar API istekleri bekletilir. */
async function initStorage() {
  if (!gist.enabled) return;
  const deadline = Date.now() + 120000;
  for (let attempt = 1; ; attempt++) {
    try {
      await gistSync();
      break;
    } catch (err) {
      gist.lastError = err.message;
      console.error(`[KAYIT] Bulut kaydına ulaşılamadı (deneme ${attempt}):`, err.message);
      // Yalnızca geçici hatalarda (ağ kopması, GitHub 5xx/429) 2 dakikaya kadar yeniden dene.
      // Anahtar hatası gibi kalıcı hatalarda (401/403/404) beklemek çözmez; site kayıtsız açılır.
      const transient = !err.status || err.status >= 500 || err.status === 429;
      if (!transient || Date.now() > deadline) break;
      await sleep(Math.min(3000 * attempt, 10000));
    }
  }
  storageReady = true;
  if (!gist.ready) {
    console.error('[UYARI] Kalıcı kayıt şu an çalışmıyor; kayıtlar yalnızca bu oturumda tutuluyor.');
    scheduleGistRetry();
  }
}

/** Yoğun kullanımda GitHub sınırlarına takılmamak için yazma aralığını ayarlar. */
function nextSaveDelay() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  gist.writeTimes = gist.writeTimes.filter((t) => t > cutoff);
  return gist.writeTimes.length >= 40 ? 30000 : 2000;
}

function scheduleRemoteSave(delayMs) {
  if (!gist.enabled) return;
  gist.dirty = true;
  if (!gist.ready || gist.saving || gist.timer || shuttingDown) return;
  gist.timer = setTimeout(runRemoteSave, typeof delayMs === 'number' ? delayMs : nextSaveDelay());
}

async function runRemoteSave() {
  if (gist.timer) {
    clearTimeout(gist.timer);
    gist.timer = null;
  }
  if (gist.saving || !gist.dirty || !gist.ready) return;
  gist.saving = true;
  gist.dirty = false;
  try {
    const content = sealData(state);
    if (gist.id) {
      await gistRequest('PATCH', '/gists/' + encodeURIComponent(gist.id), {
        files: { [GIST_FILE]: { content } }
      });
    } else {
      const created = await gistRequest('POST', '/gists', {
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILE]: { content } }
      });
      if (!created || !created.id) {
        throw new Error('Gist oluşturuldu ama kimliği alınamadı');
      }
      gist.id = String(created.id);
      console.log(`[KAYIT] Bulut kaydı oluşturuldu (gist ${gist.id}).`);
    }
    gist.writeTimes.push(Date.now());
    gist.lastSavedAt = new Date().toISOString();
    gist.lastError = null;
    gist.failCount = 0;
  } catch (err) {
    gist.dirty = true;
    gist.failCount++;
    gist.lastError = err.message;
    if (err.status === 404 && gist.id && !GIST_ID_ENV) {
      gist.id = null; // Gist silinmiş: sonraki denemede yeniden oluştur
    }
    console.error('[KAYIT] Buluta yazılamadı:', err.message);
  } finally {
    gist.saving = false;
    if (gist.dirty && !shuttingDown) {
      const delay = gist.failCount
        ? Math.min(60000, 3000 * 2 ** Math.min(gist.failCount - 1, 5))
        : nextSaveDelay();
      gist.timer = setTimeout(runRemoteSave, delay);
    }
  }
}

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
 * İstekten tarayıcı kimliğini çıkarır. Tarayıcı bu rastgele kimliği kendisi üretir ve her
 * istekte yollar. Katılım yanıtı yolda kaybolursa (anahtar tarayıcıya ulaşmazsa) sunucu
 * oyuncuyu bu kimlikten tanıyıp anahtarını yeniden verir; isim sahipsiz kilitli kalmaz.
 */
function extractClientId(req, body) {
  const fromHeader = req.headers['x-client-id'];
  const fromBody = body && typeof body.clientId === 'string' ? body.clientId : '';
  const value = (typeof fromHeader === 'string' && fromHeader.trim()) || fromBody.trim();
  return /^[A-Za-z0-9_-]{16,80}$/.test(value) ? value : null;
}

/**
 * İstekten yönetici anahtarını çıkarır.
 */
function extractAdminKey(req, body) {
  // Tarayıcılar başlıkta ş, ğ, ı gibi harfleri gönderemez; istemci anahtarı URL-kodlu yollar.
  const encodedKey = req.headers['x-admin-key-enc'];
  if (typeof encodedKey === 'string' && encodedKey.trim()) {
    try {
      const decoded = decodeURIComponent(encodedKey.trim()).trim();
      if (decoded) return decoded;
    } catch (_e) {
      // bozuk kodlama: diğer kaynaklara bak
    }
  }
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
 * Tarayıcı kimliği ile oyuncuyu bulur (yalnızca isim alınmışsa).
 */
function findPlayerByClientId(clientId) {
  if (!clientId) return null;
  for (const groupKey of ['5star', '4.5star']) {
    const group = state.groups[groupKey];
    for (let i = 0; i < group.players.length; i++) {
      const p = group.players[i];
      if (p.token && p.clientId && p.clientId === clientId) {
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
function buildClientState(playerToken, adminKey, clientId) {
  let meInfo = findPlayerByToken(playerToken);
  // Anahtar tanınmıyor ama tarayıcı kimliği eşleşiyorsa oyuncu tanınır ve anahtarı yeniden verilir.
  let recoveredToken = null;
  if (!meInfo && clientId) {
    meInfo = findPlayerByClientId(clientId);
    if (meInfo) recoveredToken = meInfo.player.token;
  }
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
    bootId: BOOT_ID,
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

  // Kayıtların kalıcı olup olmadığını yalnızca organizatör görür.
  if (isAdmin) {
    response.storage = storageInfo();
  }

  if (recoveredToken) {
    response.recoveredToken = recoveredToken;
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
    'X-Content-Type-Options': 'nosniff',
    'X-FC27-Server': '1'
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
 * İki havuzda da bulunan ilk takımı döndürür (yoksa null).
 * Aynı takım iki havuzda olursa iki farklı oyuncuya düşebilir.
 */
function findSharedTeam(poolA, poolB) {
  const seen = new Set(poolA.map((t) => t.toLocaleLowerCase('tr-TR')));
  return poolB.find((t) => seen.has(t.toLocaleLowerCase('tr-TR'))) || null;
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

const LIVE_MARKER = '<script>window.__FC27_LIVE__=true;</script>';

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    // Sağlık kontrolü (izleme servisleri için; HEAD de kabul edilir)
    if (isRead && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (isRead && pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nDisallow: /\n');
      return;
    }

    if (isRead && pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }

    // Ana sayfa (index.html)
    if (isRead && (pathname === '/' || pathname === '/index.html')) {
      if (!fs.existsSync(INDEX_FILE)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html dosyası bulunamadı.');
        return;
      }
      // İşaret, sayfanın gerçek sunucudan geldiğini bildirir; sayfa bu durumda
      // bağlantı koptuğunda "önizleme simülasyonuna" asla geçmez.
      const html = fs
        .readFileSync(INDEX_FILE, 'utf8')
        .replace(/<head>/i, '<head>\n  ' + LIVE_MARKER);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(html);
      return;
    }

    // Bulut kaydı yüklenene kadar (açılıştan sonraki ilk saniyeler) işlem kabul edilmez.
    if (pathname.startsWith('/api/') && !storageReady) {
      res.setHeader('Retry-After', '3');
      sendJson(res, 503, {
        error: 'Sunucu açılıyor, kayıtlar yükleniyor. Birkaç saniye içinde hazır olacak.',
        starting: true
      });
      return;
    }

    // Durum sorgulama (4 saniyelik yoklama)
    if (method === 'GET' && pathname === '/api/state') {
      const token =
        extractPlayerToken(req, null) ||
        (parsedUrl.searchParams.get('token') || '').trim() ||
        null;
      const adminKey = extractAdminKey(req, null);
      const clientState = buildClientState(token, adminKey, extractClientId(req, null));
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
        const clientId = extractClientId(req, body);

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
          // Aynı tarayıcı isteği yineliyorsa (ör. ilk yanıt yolda kaybolduysa) mevcut anahtarı geri ver.
          const sameToken = currentToken && targetPlayer.token === currentToken;
          const sameClient = clientId && targetPlayer.clientId === clientId;
          if (sameToken || sameClient) {
            sendJson(res, 200, {
              ok: true,
              token: targetPlayer.token,
              group: groupKey,
              name: targetPlayer.name,
              order: playerIndex + 1,
              requiredPicks: playerIndex + 1,
              state: buildClientState(targetPlayer.token, extractAdminKey(req, body))
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
            existing.player.clientId = null;
            existing.player.claimedAt = null;
            existing.player.picks = [];
            existing.player.pickedAt = null;
          }
        }

        const newToken = crypto.randomBytes(24).toString('hex');
        targetPlayer.token = newToken;
        targetPlayer.clientId = clientId;
        targetPlayer.claimedAt = new Date().toISOString();
        persistState();

        sendJson(res, 200, {
          ok: true,
          token: newToken,
          group: groupKey,
          name: targetPlayer.name,
          order: playerIndex + 1,
          requiredPicks: playerIndex + 1,
          state: buildClientState(newToken, extractAdminKey(req, body))
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
        found.player.clientId = null;
        found.player.claimedAt = null;
        found.player.picks = [];
        found.player.pickedAt = null;
        persistState();

        sendJson(res, 200, {
          ok: true,
          state: buildClientState(null, extractAdminKey(req, body))
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
        persistState();

        sendJson(res, 200, {
          ok: true,
          picks: cleanedPicks,
          state: buildClientState(token, extractAdminKey(req, body))
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

          const sharedTeam = findSharedTeam(nextPoolsMap['5star'], nextPoolsMap['4.5star']);
          if (sharedTeam) {
            sendJson(res, 400, {
              error: `"${sharedTeam}" iki havuzda da var. Bir takım yalnızca bir havuzda bulunabilir.`
            });
            return;
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
                clientId: prev ? prev.clientId || null : null,
                claimedAt: prev ? prev.claimedAt : null,
                picks: [],
                pickedAt: null
              };
            });
            gObj.pool = nextPoolsMap[gKey];
          }

          persistState();
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
          target.clientId = null;
          target.claimedAt = null;
          target.picks = [];
          target.pickedAt = null;
          persistState();

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

          const sharedAtStart = findSharedTeam(
            state.groups['5star'].pool,
            state.groups['4.5star'].pool
          );
          if (sharedAtStart) {
            sendJson(res, 400, {
              error: `"${sharedAtStart}" iki havuzda da var. Bir takım yalnızca bir havuzda bulunabilir.`
            });
            return;
          }

          state.phase = 'pick';
          state.results = null;
          persistState();

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
          persistState();

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
          persistState();

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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[KAPANIŞ] ${signal} alındı, bekleyen kayıtlar yazılıyor.`);
  setTimeout(() => process.exit(0), 12000).unref();
  try {
    server.close();
    if (gist.enabled && gist.ready) {
      const waitUntil = Date.now() + 10000;
      while (gist.saving && Date.now() < waitUntil) {
        await sleep(100);
      }
      if (gist.dirty) await runRemoteSave();
    }
  } catch (err) {
    console.error('[KAPANIŞ] Son kayıt yazılamadı:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Beklenmeyen bir hata sunucuyu düşürmesin: düşerse bellekteki kayıtlar kaybolur.
process.on('unhandledRejection', (reason) => {
  console.error('[HATA] Yakalanmamış söz reddi:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[HATA] Yakalanmamış hata:', err);
});

server.on('error', (err) => {
  console.error('[SUNUCU] Başlatılamadı:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log(`EA Sports FC 27 Turnuva Sunucusu çalışıyor: http://localhost:${PORT}`);
  if (!ENV_ADMIN_KEY) {
    console.log(`Rastgele üretilen ADMIN_KEY: ${ADMIN_KEY}`);
    console.log('[UYARI] ADMIN_KEY ortam değişkeni tanımlı değil; anahtar her yeniden başlatmada değişir.');
  } else {
    console.log('ADMIN_KEY ortam değişkeninden yüklendi.');
  }
  console.log(`Organizatör Giriş Adresi: http://localhost:${PORT}/?admin=${encodeURIComponent(ADMIN_KEY)}`);
  const info = storageInfo();
  if (info.mode === 'gist') {
    console.log('[KAYIT] Kalıcı kayıt açık: durum şifreli olarak GitHub Gist\'e yazılıyor.');
  } else if (info.mode === 'ephemeral') {
    console.log('[UYARI] Kalıcı kayıt KAPALI: sunucu yeniden başladığında tüm isimler, tercihler ve sonuçlar silinir.');
    console.log('        Render ücretsiz planında bu, 15 dakika kimse girmediğinde olur. Çözüm: GIST_TOKEN ortam değişkeni.');
  } else {
    console.log(`[KAYIT] Kayıt dosyası: ${DATA_FILE}`);
  }
  if (info.error && info.mode !== 'gist') {
    console.log('[UYARI] ' + info.error);
  }
  console.log('============================================================');
});

initStorage().catch((err) => {
  console.error('[KAYIT] Açılış eşitlemesi başarısız:', err);
  storageReady = true;
});
