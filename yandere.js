// ==UserScript==
// @Name         yande.re 动漫图小组件
// @Platform     Egern
// @Type         generic
// @Author       Cuttlefish
// @WebURL       https://yande.re/
// @Version      1.0.0
// ==/UserScript==

/* ================================================================
 * yande.re / Konachan 小组件（Moebooru 接口，免登录）
 *
 * 接口：https://yande.re/post.json?tags=order:random+landscape+rating:s&limit=20
 *   order:random   必须放在标签串最前面，否则不生效
 *   rating:s       全年龄 / rating:q 擦边 / rating:e 工口；用 -rating:e 表示「不含工口」
 *   标签用 + 连接表示 AND，yande.re 没有全文搜索，只能按标签
 *
 * 为什么用这个源：sample 图长边 1500px、通常 200~500KB，
 * 不压缩也够清晰、体积也压得住（Wallhaven 只有 432×243 的固定裁切缩略图）
 *
 * ── 环境变量（全部可选）────────────────────────────────────────
 * TAGS        标签，多个用空格/逗号分隔（AND 关系）；留空 = 随机
 * SITE        自动 / yande.re / Konachan；自动 = 先 yande.re，空了再试 Konachan
 * RATIO_SMALL / MEDIUM / LARGE / XLARGE
 *             每个尺寸单独的画幅：方图 / 横图 / 竖图 / 不限
 * RATING      仅全年龄 / 含擦边 / 全部                                默认 仅全年龄
 * MIN_W       sample 最短边下限（像素），太低会糊                     默认 1024
 * COOLDOWN    换图间隔（分钟），0 = 每次刷新都换                      默认 30
 * NO_REPEAT   防重复窗口（按作品 id，全尺寸共用）                     默认 100
 * SHOW_INFO   显示分辨率/评分                                        默认 true
 * DEBUG       调试角标                                               默认 false
 * ================================================================ */

const SCRIPT_VER = 'v1.4';

const HOSTS = {
  yande: 'https://yande.re/post.json',
  konachan: 'https://konachan.net/post.json'
};

const K = {
  cache: 'yd_cache_',        // + family
  pool: 'yd_pool_',          // + ratioKey
  history: 'yd_history',
  lastShow: 'yd_lastshow_',  // + family
  debug: 'yd_debug'
};

const RATIO_BY_FAMILY = {
  systemSmall: 'RATIO_SMALL',
  systemMedium: 'RATIO_MEDIUM',
  systemLarge: 'RATIO_LARGE',
  systemExtraLarge: 'RATIO_XLARGE'
};

const DEFAULT_RATIO = {
  systemSmall: '方图',
  systemMedium: '横图',
  systemLarge: '方图',
  systemExtraLarge: '横图'
};

// yande.re / Konachan 的 rating 只有三个值：
//   s = safe（全年龄）、q = questionable（擦边）、e = explicit（工口）
// 选项按「要哪几种」来给，不是递进关系：
const RATING_TAG = {
  '仅全年龄': 'rating:s',                    // 只要 s
  '仅擦边': 'rating:q',                      // 只要 q
  '全年龄 + 擦边': '-rating:e',               // s + q（默认，不含工口）
  '全年龄 + 擦边 + 工口': '',                  // 不筛，s + q + e
  // 兼容旧值
  '含擦边': '-rating:e',
  '全部（含 R18）': '',
  '全部': '-rating:e'
};

const MAX_POOL = 80;
const HARD_LIMIT_KB = 1200;   // 单张超过这个体积就跳过（iOS 桌面画不出来）

export default async function (ctx) {
  const family = ctx.widgetFamily || 'systemSmall';
  const cfg = readConfig(ctx.env, family);
  const now = Date.now();

  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: 'yande.re', maxLines: 1 }] };
  }
  if (family === 'accessoryCircular' || family === 'accessoryRectangular') {
    return buildAccessory(ctx, family, cfg);
  }

  const cooldownMs = cfg.cooldownMin > 0 ? cfg.cooldownMin * 60000 : 0;
  const cached = readJSON(ctx, K.cache + family);
  const lastShow = Number(ctx.storage.get(K.lastShow + family) || 0) || 0;
  const remaining = cooldownMs - (now - lastShow);
  const sig = signature(cfg);
  const stale = !cached || cached.sig !== sig;

  if (cached && cached.dataUri && remaining > 0 && !stale) {
    const uiSig = uiSignature(cfg);
    if (cached.uiSig !== uiSig) {
      cached.uiSig = uiSig;
      writeJSON(ctx, K.cache + family, cached);
      return buildWidget(cached, family, cfg, new Date(now + 60 * 1000).toISOString());
    }
    return buildWidget(cached, family, cfg, new Date(now + remaining).toISOString());
  }

  // ── 候选池：按画幅分槽 ────────────────────────────────────────
  const poolKey = K.pool + cfg.ratioLabel;
  let pool = readJSON(ctx, poolKey) || {};
  if (!Array.isArray(pool.items)) pool.items = [];
  if (pool.sig !== sig) pool = { items: [], sig };

  let history = readJSON(ctx, K.history);
  if (!Array.isArray(history)) history = [];
  const historySet = new Set(history.map(String));

  let candidate = pickFromPool(pool, historySet, cfg);
  let searches = 0;
  let lastError = '';
  let errorStatus = null;
  let tagFallback = false;

  while (!candidate && searches < 3) {
    try {
      const res = await search(ctx, cfg);
      searches++;
      const have = new Set(pool.items.map(it => String(it.id)));
      const added = res.items.filter(it => !have.has(String(it.id)));
      pool.items = pool.items.concat(added).slice(-MAX_POOL);
      pool.sig = sig;
      writeJSON(ctx, poolKey, pool);
      candidate = pickFromPool(pool, historySet, cfg);
      if (candidate) { tagFallback = res.tagFallback; break; }
      if (res.empty || added.length === 0) break;
    } catch (e) {
      lastError = (e && e.message) || '搜索失败';
      errorStatus = e && e.status ? e.status : null;
      break;
    }
  }

  if (!candidate) {
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, new Date(now + 10 * 60000).toISOString());
    return buildError(lastError || emptyHint(cfg), cfg, new Date(now + 15 * 60000).toISOString());
  }

  // ── 下载（sample 图：1500px 长边、200~500KB）─────────────────
  let img = null;
  try {
    img = await download(ctx, candidate.sample || candidate.file, cfg);
  } catch (e) {
    lastError = (e && e.message) || '图片下载失败';
    if (e && (e.status === 429 || e.status === 403)) errorStatus = e.status;
  }

  if (!img) {
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, new Date(now + 10 * 60000).toISOString());
    return buildError(lastError || '图片下载失败', cfg, new Date(now + 5 * 60000).toISOString());
  }

  const entry = {
    id: candidate.id,
    ar: candidate.sampleW && candidate.sampleH ? +(candidate.sampleW / candidate.sampleH).toFixed(2) : null,
    dim: candidate.sampleW && candidate.sampleH ? `${candidate.sampleW}×${candidate.sampleH}` : '',
    rating: candidate.rating,
    score: candidate.score,
    site: candidate.site,
    page: candidate.page,
    dataUri: img.dataUri,
    sizeKb: Math.round(img.bytes / 1024),
    tags: (candidate.tags || '').split(' ').slice(0, 6).join(' '),
    queryTags: cfg.tagsJoined,
    tagFallback,
    searches,
    uiSig: uiSignature(cfg),
    sig,
    at: now
  };

  writeJSON(ctx, K.cache + family, entry);
  const hi = history.findIndex(x => String(x) === String(candidate.id));
  if (hi >= 0) history.splice(hi, 1);
  history.push(candidate.id);
  while (history.length > cfg.maxHistory) history.shift();
  writeJSON(ctx, K.history, history);
  ctx.storage.set(K.lastShow + family, String(now));
  writeJSON(ctx, K.debug, {
    at: now, id: candidate.id, site: candidate.site, ar: entry.ar, dim: entry.dim,
    sizeKb: entry.sizeKb, rating: candidate.rating, tags: cfg.tagsJoined, tagFallback, searches
  });

  return buildWidget(entry, family, cfg, nextIso(cfg.cooldownMin > 0 ? cfg.cooldownMin : 15));
}

/* ============================ 配置 ============================ */

function readConfig(env, family) {
  const s = (k, d) => {
    const v = env && env[k];
    return v === undefined || v === null || String(v).trim() === '' ? d : String(v).trim();
  };
  const bool = (k, d) => {
    const v = s(k, '');
    if (!v) return d;
    return /^(1|true|yes|on|开)$/i.test(v);
  };
  const int = (k, d, min, max) => {
    const n = parseInt(s(k, ''), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };

  const ownKey = RATIO_BY_FAMILY[family];
  const ratioLabel = s(ownKey, '') || DEFAULT_RATIO[family] || '横图';

  const siteLabel = s('SITE', '自动');
  const site = /konachan/i.test(siteLabel) ? 'konachan' : (/yande/i.test(siteLabel) ? 'yande' : 'auto');

  const rawTags = s('TAGS', '')
    .split(/[\s,，、|]+/)
    .map(x => x.trim())
    .filter(Boolean);

  return {
    tags: rawTags,
    tagsJoined: rawTags.join(' '),
    site,
    ratioLabel,
    ratingLabel: s('RATING', '全年龄 + 擦边'),
    ratingTag: RATING_TAG[s('RATING', '全年龄 + 擦边')] !== undefined ? RATING_TAG[s('RATING', '全年龄 + 擦边')] : '-rating:e',
    // 服务端标签只是第一道闸；这里再本地校验一次，
    // 防止「标签无结果→退回随机」时把 e 级图漏进来
    ratingAllowed: (() => {
      const label = s('RATING', '全年龄 + 擦边');
      if (label === '仅全年龄') return ['s'];
      if (label === '仅擦边') return ['q'];
      if (label === '全年龄 + 擦边 + 工口' || label === '全部（含 R18）' || label === '全部') return ['s', 'q', 'e'];
      return ['s', 'q'];
    })(),
    minW: int('MIN_W', 1024, 200, 4000),
    cooldownMin: int('COOLDOWN', 30, 0, 24 * 60),
    maxHistory: int('NO_REPEAT', 100, 1, 2000),
    showInfo: bool('SHOW_INFO', true),
    debug: bool('DEBUG', false),
    timeoutMs: 20000
  };
}

function uiSignature(cfg) {
  return [cfg.showInfo, cfg.debug].join('|');
}

function signature(cfg) {
  return [cfg.tagsJoined, cfg.site, cfg.ratioLabel, cfg.ratingTag, cfg.minW].join('|');
}

function nextIso(minutes) {
  return new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
}

function emptyHint(cfg) {
  if (cfg.tags.length) return '「' + cfg.tagsJoined + '」在 yande.re / Konachan 没有结果，试试换成更常见的标签（例如 landscape、hatsune_miku）';
  return '没有取到图片，稍后会自动重试';
}

/* ============================ 搜索 ============================ */

function hostsFor(cfg) {
  if (cfg.site === 'yande') return ['yande'];
  if (cfg.site === 'konachan') return ['konachan'];
  return ['yande', 'konachan'];
}

// 注意：标签之间必须用「空格」分隔再整体 encodeURIComponent。
// 如果先拼 '+' 再编码，'+' 会变成 %2B（字面加号），服务端就不当作分隔符了——
// 整个串被当成一个不存在的标签，返回一堆随机图，分级/标签筛选全部失效。
function buildTagString(cfg, useTags) {
  const parts = ['order:random'];                 // 必须第一个，否则随机失效
  if (useTags && cfg.tags.length) parts.push(...cfg.tags);
  if (cfg.ratingTag) parts.push(cfg.ratingTag);
  return parts.join(' ');
}

async function search(ctx, cfg) {
  const hosts = hostsFor(cfg);
  let triedEmpty = false;

  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    const url = HOSTS[host] + '?tags=' + encodeURIComponent(buildTagString(cfg, true)) + '&limit=30';
    let body;
    try {
      body = await fetchJson(ctx, url, cfg);
    } catch (e) {
      // 第一个源挂了就直接试下一个
      if (i < hosts.length - 1) continue;
      throw e;
    }
    const items = normalize(body, host);
    const passed = items.filter(it => passesFilter(it, cfg));
    if (passed.length) return { items: passed, empty: false, tagFallback: false };
    triedEmpty = true;
  }

  // 标签组合全空：退回「只要分级 + 随机」，避免组件空着
  if (triedEmpty && cfg.tags.length) {
    const url = HOSTS[hosts[0]] + '?tags=' + encodeURIComponent(buildTagString(cfg, false)) + '&limit=30';
    const body = await fetchJson(ctx, url, cfg);
    const passed = normalize(body, hosts[0]).filter(it => passesFilter(it, cfg));
    return { items: passed, empty: passed.length === 0, tagFallback: true };
  }

  return { items: [], empty: true, tagFallback: false };
}

async function fetchJson(ctx, url, cfg) {
  let resp;
  try {
    resp = await ctx.http.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Egern/YandereWidget ' + SCRIPT_VER },
      timeout: cfg.timeoutMs
    });
  } catch (e) {
    const err = new Error('网络不可达 / 超时');
    err.status = 0;
    throw err;
  }
  const st = resp.status || 0;
  if (st === 429) { const e = new Error('请求过于频繁（429）'); e.status = 429; throw e; }
  if (st === 403) { const e = new Error('被拒绝（403），稍后再试'); e.status = 403; throw e; }
  if (st >= 400) { const e = new Error('接口 HTTP ' + st); e.status = st; throw e; }
  const body = await resp.json().catch(() => null);
  if (!Array.isArray(body)) { const e = new Error('接口返回异常'); e.status = 200; throw e; }
  return body;
}

function normalize(list, host) {
  return list.map(p => {
    const sample = p.sample_url || '';
    const sampleW = Number(p.sample_width) || Number(p.width) || 0;
    const sampleH = Number(p.sample_height) || Number(p.height) || 0;
    const sampleSize = Number(p.sample_file_size) || 0;
    return {
      id: p.id,
      site: host,
      page: 'https://' + (host === 'konachan' ? 'konachan.net' : 'yande.re') + '/post/show/' + p.id,
      file: p.file_url || '',
      sample: sample || p.file_url || '',
      sampleW,
      sampleH,
      sampleSize: sampleSize || Number(p.file_size) || 0,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      rating: p.rating || '',
      score: Number(p.score) || 0,
      tags: p.tags || ''
    };
  }).filter(it => it.id && it.sample);
}

// 画幅按 sample 的实际宽高判断
function bandOf(it) {
  const ar = it.sampleW && it.sampleH ? it.sampleW / it.sampleH : 0;
  if (!ar) return '';
  if (ar >= 1.4) return '横图';
  if (ar >= 0.85) return '方图';
  return '竖图';
}

function passesFilter(it, cfg) {
  if (it.rating && cfg.ratingAllowed.indexOf(it.rating) < 0) return false;   // 分级兜底
  const band = bandOf(it);
  if (cfg.ratioLabel !== '不限' && band && band !== cfg.ratioLabel) return false;
  const shortSide = Math.min(it.sampleW || 0, it.sampleH || 0);
  if (shortSide && shortSide < cfg.minW * 0.6) return false;   // 太小的直接跳过
  if (it.sampleSize && it.sampleSize / 1024 > HARD_LIMIT_KB) return false;
  return true;
}

/* ============================ 选图 ============================ */

function pickFromPool(pool, historySet, cfg) {
  if (!pool || !Array.isArray(pool.items) || pool.items.length === 0) return null;
  const fresh = pool.items.filter(it => it && it.sample && !historySet.has(String(it.id)));
  if (fresh.length === 0) return null;
  const picked = fresh[Math.floor(Math.random() * fresh.length)];
  pool.items = pool.items.filter(it => it !== picked);
  return picked;
}

/* ============================ 下载 ============================ */

async function download(ctx, url, cfg) {
  const safeUrl = encodeURI(decodeURI(url));   // sample 地址里常带空格（%20 或裸空格）
  let resp;
  try {
    resp = await ctx.http.get(safeUrl, {
      headers: { 'Referer': 'https://yande.re/', 'User-Agent': 'Egern/YandereWidget ' + SCRIPT_VER },
      timeout: cfg.timeoutMs
    });
  } catch (e) {
    const err = new Error('图片下载超时');
    err.status = 0;
    throw err;
  }
  const st = resp.status || 0;
  if (st === 429) { const e = new Error('图床限流'); e.status = 429; throw e; }
  if (st >= 400) { const e = new Error('图片 HTTP ' + st); e.status = st; throw e; }

  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const looksImage = (bytes[0] === 0xff && bytes[1] === 0xd8)
    || (bytes[0] === 0x89 && bytes[1] === 0x50)
    || (bytes[0] === 0x47 && bytes[1] === 0x49)
    || (bytes[8] === 0x57 && bytes[9] === 0x45);
  if (bytes.byteLength < 1024 || !looksImage) {
    const e = new Error('图片内容异常');
    e.status = 0;
    throw e;
  }
  if (bytes.byteLength / 1024 > HARD_LIMIT_KB) {
    const e = new Error('图片超过 ' + HARD_LIMIT_KB + 'KB');
    e.status = 413;
    throw e;
  }
  return { url: safeUrl, dataUri: `data:${detectMime(bytes)};base64,${toBase64(bytes)}`, bytes: bytes.byteLength };
}

function detectMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}

function toBase64(bytes) {
  const CHUNK = 0x2000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let part = '';
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    bin += part;
  }
  return btoa(bin);
}

/* ============================ 渲染 ============================ */

function buildWidget(entry, family, cfg, refreshAfter) {
  const children = [];
  const lines = [];

  if (cfg.showInfo && entry.dim) {
    lines.push({
      type: 'text',
      text: entry.dim + (entry.score ? ' · ♥' + entry.score : ''),
      font: { size: 'caption1', weight: 'semibold' },
      textColor: '#FFFFFF',
      maxLines: 1,
      minScale: 0.7
    });
  }

  if (cfg.debug) {
    lines.push({
      type: 'text',
      text: `${SCRIPT_VER} ${entry.site} ${entry.ar || '-'} · ${cfg.ratioLabel} · ${entry.rating || '-'}`
        + `${entry.tagFallback ? ' · ⚠标签无结果已随机' : ''}`
        + `${entry.sizeKb ? ' · ' + entry.sizeKb + 'KB' : ''}`
        + ` · ${entry.queryTags ? '「' + entry.queryTags + '」' : '随机'} · ${entry.searches}搜`,
      font: { size: 'caption2' },
      textColor: 'rgba(255,255,255,0.55)',
      maxLines: 1
    });
  }

  if (lines.length) {
    children.push({ type: 'spacer' });
    children.push({
      type: 'stack',
      direction: 'row',
      alignItems: 'end',
      gap: 0,
      padding: [30, 12, 10, 12],
      backgroundGradient: {
        type: 'linear',
        colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.08)', 'rgba(0,0,0,0.42)', 'rgba(0,0,0,0.86)'],
        stops: [0, 0.3, 0.62, 1],
        startPoint: { x: 0.5, y: 0 },
        endPoint: { x: 0.5, y: 1 }
      },
      children: [
        { type: 'stack', direction: 'column', alignItems: 'start', gap: 2, children: lines },
        { type: 'spacer' }
      ]
    });
  }

  const node = {
    type: 'widget',
    refreshAfter,
    padding: 0,
    backgroundImage: entry.dataUri,
    children
  };
  if (entry.page) node.url = entry.page;
  return node;
}

function buildAccessory(ctx, family, cfg) {
  const cached = readJSON(ctx, K.cache + 'systemSmall') || readJSON(ctx, K.cache + 'systemMedium');
  const has = cached && cached.dataUri;

  if (family === 'accessoryCircular') {
    if (has) {
      return {
        type: 'widget', padding: 0,
        ...(cached.page ? { url: cached.page } : {}),
        children: [{ type: 'image', src: cached.dataUri, resizeMode: 'cover', width: 60, height: 60, borderRadius: 'auto' }]
      };
    }
    return { type: 'widget', children: [{ type: 'image', src: 'sf-symbol:photo.artframe', width: 28, height: 28 }] };
  }

  return {
    type: 'widget', padding: 0,
    ...(cached && cached.page ? { url: cached.page } : {}),
    children: [{
      type: 'stack', direction: 'column', alignItems: 'start', gap: 1,
      children: [
        { type: 'text', text: (cached && cached.dim) || 'yande.re', font: { size: 'caption1', weight: 'semibold' }, maxLines: 1, minScale: 0.7 },
        { type: 'text', text: (cached && cached.site) || '等待刷新', font: { size: 'caption2' }, opacity: 0.7, maxLines: 1 }
      ]
    }]
  };
}

function buildError(message, cfg, refreshAfter) {
  return {
    type: 'widget',
    refreshAfter,
    backgroundColor: '#1C1C1E',
    padding: 16,
    gap: 8,
    url: 'https://yande.re/',
    children: [
      { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', color: '#FF9F0A', width: 24, height: 24 },
      { type: 'text', text: '加载失败', font: { size: 'headline', weight: 'bold' }, textColor: '#FFFFFF' },
      { type: 'text', text: message, font: { size: 'caption1' }, textColor: 'rgba(255,255,255,0.6)', maxLines: 3 },
      { type: 'spacer' },
      { type: 'text', text: '轻点打开 yande.re', font: { size: 'caption2' }, textColor: 'rgba(255,255,255,0.35)', maxLines: 1 }
    ]
  };
}

/* ============================ 工具 ============================ */

function readJSON(ctx, key) {
  try {
    const raw = ctx.storage.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeJSON(ctx, key, value) {
  try {
    ctx.storage.set(key, JSON.stringify(value));
  } catch (e) {}
}
