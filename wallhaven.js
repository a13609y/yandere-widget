// ==UserScript==
// @Name         Wallhaven 动漫壁纸小组件
// @Platform     Egern
// @Type         generic
// @Author       Cuttlefish
// @WebURL       https://wallhaven.cc/
// @Version      1.0.0
// ==/UserScript==

/* ================================================================
 * Wallhaven.cc 动漫壁纸小组件（免登录可用，R18 需要 API Key）
 *
 * 数据源：https://wallhaven.cc/api/v1/search
 *   q=关键词       留空则不传，配合 sorting=random 出随机图
 *   categories     010 = 动漫 / 111 = 全部
 *   ratios         landscape / portrait / 1x1 / 5x4 / 4x5（可逗号组合）
 *   purity         100 = 仅 SFW / 110 = SFW+Sketchy / 111 = 含 NSFW（需 apikey）
 *   sorting        relevance（default）/ date_added / toplist / random
 *   atleast        最低分辨率，如 1920x1080
 *
 * ── 环境变量（全部可选）────────────────────────────────────────
 * KEYWORD     关键词，留空 = 随机（服务端 random 排序）
 * SORT        有关键词时的排序：相关度 / 最新 / 热度 / 随机      默认 相关度
 * RATIO_SMALL / MEDIUM / LARGE / XLARGE
 *             每个尺寸单独的画幅：方图 / 横图 / 竖图 / 不限
 *             默认：小号方图、中号横图、大号方图、超大号横图
 * PURITY      仅 SFW / SFW+Sketchy / 全部（含 R18，需 API Key）
 * APIKEY      Wallhaven API Key（账号设置里生成，用于 R18）
 * CATEGORY    动漫 / 全部                                       默认 动漫
 * MIN_RES     不限 / 1280x720 / 1920x1080 / 2560x1440            默认 1920x1080
 * MAX_MB      单张图片大小上限（MB），超了换一张                 默认 2
 * QUALITY     省流(≤MAX_MB) / 高清(不限制大小)                  默认 省流
 * COOLDOWN    换图间隔（分钟），0 = 每次刷新都换                 默认 30
 * NO_REPEAT   防重复窗口（作品数）                               默认 100
 * SHOW_INFO   图上显示分辨率/热度                               默认 true
 * DEBUG       左下角状态角标                                    默认 false
 * ================================================================ */

const SCRIPT_VER = 'v1.1';

const API = 'https://wallhaven.cc/api/v1/search';

const K = {
  cache: 'wh_cache_',        // + family
  pool: 'wh_pool_',          // + ratioKey
  history: 'wh_history',
  lastShow: 'wh_lastshow_',  // + family
  debug: 'wh_debug'
};

const RATIO_PARAM = {
  '方图': '1x1,5x4,4x5',
  '横图': 'landscape',
  '竖图': 'portrait',
  '不限': ''
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

const SORT_MAP = {
  '相关度': 'relevance', 'relevance': 'relevance',
  '最新': 'date_added', 'date_added': 'date_added',
  '热度': 'toplist', 'toplist': 'toplist',
  '随机': 'random', 'random': 'random'
};

const PURITY_MAP = {
  '仅 SFW': 100, '仅SFW': 100, '100': 100,
  'SFW + Sketchy': 110, 'SFW+Sketchy': 110, '110': 110,
  '全部（含 R18，需 API Key）': 111, '全部': 111, '111': 111
};

const MAX_POOL = 120;

export default async function (ctx) {
  const family = ctx.widgetFamily || 'systemSmall';
  const cfg = readConfig(ctx.env, family);
  const now = Date.now();

  // 没有 API Key 却选了「全部」→ 自动降级成 SFW+Sketchy，不报错
  let purity = cfg.purity;
  let purityDowngraded = false;
  if (purity === 111 && !cfg.apiKey) {
    purity = 110;
    purityDowngraded = true;
  }
  cfg.purityUsed = purity;

  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: 'Wallhaven', maxLines: 1 }] };
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

  // ── 候选池：按画幅分槽，随机排序时不需要游标 ──────────────────
  const poolKey = K.pool + (cfg.ratioKey || 'any');
  let pool = readJSON(ctx, poolKey) || {};
  if (!Array.isArray(pool.items)) pool.items = [];
  if (pool.sig !== sig) pool = { items: [], page: 1, sig };

  let history = readJSON(ctx, K.history);
  if (!Array.isArray(history)) history = [];
  history = history.filter(x => x !== null && x !== undefined);
  const historySet = new Set(history.map(String));

  let candidate = pickFromPool(pool, historySet, cfg);
  let searches = 0;
  let lastError = '';
  let errorStatus = null;

  while (!candidate && searches < 3) {
    try {
      const res = await search(ctx, cfg, pool);
      searches++;
      const have = new Set(pool.items.map(it => String(it.id)));
      const added = res.items.filter(it => !have.has(String(it.id)));
      pool.items = pool.items.concat(added).slice(-MAX_POOL);
      pool.page = res.page;
      pool.sig = sig;
      writeJSON(ctx, poolKey, pool);
      candidate = pickFromPool(pool, historySet, cfg);
      if (res.empty) {
        lastError = emptyHint(cfg);
        break;
      }
      if (added.length === 0) break;
    } catch (e) {
      lastError = (e && e.message) || '搜索失败';
      errorStatus = e && e.status ? e.status : null;
      break;
    }
  }

  if (!candidate) {
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, new Date(now + 10 * 60000).toISOString());
    return buildError(lastError || '暂无可用图片', cfg, new Date(now + 15 * 60000).toISOString());
  }

  // ── 下载图片（Wallhaven 图床直连，不需要 referer 也能拿）─────
  // iOS 桌面小组件对整包大小很敏感：太大就干脆用 432px 缩略图（约 25KB），
  // 模糊但一定能画出来，比白板强
  const HARD_KB = Math.max(1200, cfg.capKb * 2);
  const src = (cfg.quality === 'thumb' || (candidate.size && candidate.size / 1024 > HARD_KB && candidate.thumb))
    ? { url: candidate.thumb || candidate.path, small: true }
    : { url: candidate.path, small: false };

  let img = null;
  try {
    img = await download(ctx, src.url, cfg);
    if (img.bytes / 1024 > HARD_KB && candidate.thumb && !src.small) {
      img = await download(ctx, candidate.thumb, cfg);   // 原图太大 → 换缩略图重试
      src.small = true;
    }
  } catch (e) {
    lastError = (e && e.message) || '图片下载失败';
    if (e && (e.status === 429 || e.status === 403)) errorStatus = e.status;
    if (candidate.thumb) {
      try { img = await download(ctx, candidate.thumb, cfg); src.small = true; } catch (e2) {}
    }
  }

  if (!img) {
    writeJSON(ctx, K.debug, { at: now, stage: 'image', error: lastError, id: candidate.id });
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, new Date(now + 10 * 60000).toISOString());
    return buildError(lastError || '图片下载失败', cfg, new Date(now + 5 * 60000).toISOString());
  }

  const entry = {
    id: candidate.id,
    ar: candidate.w && candidate.h ? +(candidate.w / candidate.h).toFixed(2) : null,
    dim: candidate.w && candidate.h ? `${candidate.w}×${candidate.h}` : '',
    category: candidate.category,
    purity: candidate.purity,
    views: candidate.views,
    page: candidate.page,
    url: img.url,
    dataUri: img.dataUri,
    sizeKb: Math.round(img.bytes / 1024),
    thumbUsed: !!src.small,
    searches,
    keyword: cfg.keyword,
    sorting: cfg.sortingUsed,
    purityDowngraded,
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
    at: now, id: candidate.id, ar: entry.ar, dim: entry.dim, sizeKb: entry.sizeKb,
    searches, keyword: cfg.keyword, sorting: cfg.sortingUsed, pool: pool.items.length, error: lastError || null
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

  const categoryLabel = s('CATEGORY', '动漫');
  const category = /全部|all/i.test(categoryLabel) ? '111' : '010';

  const minRes = s('MIN_RES', '1920x1080');
  const atleast = /^\d+x\d+$/i.test(minRes) ? minRes.toLowerCase() : '';

  const keyword = s('KEYWORD', '');
  const sortLabel = s('SORT', '相关度');
  const sort = keyword ? (SORT_MAP[sortLabel] || 'relevance') : 'random';

  const qualityLabel = s('QUALITY', '省流');
  // 每个档位对应「原图」的大小上限（KB）；超了就先换一张，实在没有才用缩略图
  // thumb = 直接只要 432px 缩略图（约 25KB），用来排查「桌面上不显示」
  const quality = /缩略|thumb/i.test(qualityLabel) ? 'thumb'
    : /省流|小/i.test(qualityLabel) ? 'slim'
    : /高清|大/i.test(qualityLabel) ? 'full' : 'std';
  const capKb = quality === 'thumb' ? 60 : quality === 'slim' ? 450 : quality === 'full' ? 2500 : 900;

  return {
    keyword,
    sortingUsed: sort,
    category,
    atleast,
    apiKey: s('APIKEY', ''),
    purity: PURITY_MAP[s('PURITY', '仅 SFW')] || 100,
    ratioKey: RATIO_PARAM[ratioLabel] === undefined ? 'any' : (RATIO_PARAM[ratioLabel] || 'any'),
    ratioParam: RATIO_PARAM[ratioLabel] === undefined ? '' : RATIO_PARAM[ratioLabel],
    ratioLabel,
    capKb,
    quality,
    cooldownMin: int('COOLDOWN', 30, 0, 24 * 60),
    maxHistory: int('NO_REPEAT', 100, 1, 2000),
    showInfo: bool('SHOW_INFO', true),
    debug: bool('DEBUG', false),
    timeoutMs: 20000
  };
}

function emptyHint(cfg) {
  const parts = [];
  if (cfg.keyword) parts.push('关键词「' + cfg.keyword + '」');
  if (cfg.ratioParam) parts.push('画幅「' + cfg.ratioLabel + '」');
  if (cfg.purityUsed === 100) parts.push('分级「仅 SFW」');
  return '没有符合条件的结果' + (parts.length ? '：' + parts.join(' + ') : '') + '，换个词或放宽画幅/分级试试';
}

function uiSignature(cfg) {
  return [cfg.showInfo, cfg.debug].join('|');
}

function signature(cfg) {
  return [cfg.keyword, cfg.sortingUsed, cfg.category, cfg.atleast, cfg.purityUsed,
    cfg.ratioParam, cfg.quality, !!cfg.apiKey].join('|');
}

function nextIso(minutes) {
  return new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
}

/* ============================ 搜索 ============================ */

async function search(ctx, cfg, pool) {
  const page = cfg.sortingUsed === 'random'
    ? 1 + Math.floor(Math.random() * 3)
    : Math.max(1, pool.page || 1);

  const build = (atleast) => {
    const qs = ['page=' + page];
    if (cfg.keyword) qs.push('q=' + encodeURIComponent(cfg.keyword));
    qs.push('categories=' + cfg.category);
    qs.push('purity=' + cfg.purityUsed);
    qs.push('sorting=' + cfg.sortingUsed);
    if (cfg.ratioParam) qs.push('ratios=' + cfg.ratioParam);
    if (atleast) qs.push('atleast=' + atleast);
    if (cfg.apiKey && cfg.purityUsed === 111) qs.push('apikey=' + encodeURIComponent(cfg.apiKey));
    return API + '?' + qs.join('&');
  };

  const url = build(cfg.atleast);
  let resp;
  try {
    resp = await ctx.http.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Egern/WallhavenWidget ' + SCRIPT_VER },
      timeout: cfg.timeoutMs
    });
  } catch (e) {
    const err = new Error('网络不可达 / 超时');
    err.status = 0;
    throw err;
  }

  const st = resp.status || 0;
  if (st === 429) { const e = new Error('请求过于频繁（429）'); e.status = 429; throw e; }
  if (st === 401) { const e = new Error('API Key 无效（401）'); e.status = 401; throw e; }
  if (st >= 400) { const e = new Error('接口返回 HTTP ' + st); e.status = st; throw e; }

  let body = await resp.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) {
    const e = new Error('接口返回异常');
    e.status = 200;
    throw e;
  }

  // 最低分辨率卡太死导致 0 结果时，自动放开一次（换词/换画幅是用户的选择，不擅自改）
  let relaxed = false;
  if (body.data.length === 0 && cfg.atleast) {
    relaxed = true;
    const r2 = await ctx.http.get(build(''), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Egern/WallhavenWidget ' + SCRIPT_VER },
      timeout: cfg.timeoutMs
    }).catch(() => null);
    if (r2 && (r2.status || 0) < 400) {
      const b2 = await r2.json().catch(() => null);
      if (b2 && Array.isArray(b2.data) && b2.data.length) body = b2;
    }
  }

  const items = body.data.map(it => ({
    id: it.id,
    path: it.path,
    thumb: (it.thumbs && (it.thumbs.large || it.thumbs.original || it.thumbs.small)) || '',
    w: Number(it.dimension_x) || 0,
    h: Number(it.dimension_y) || 0,
    size: Number(it.file_size) || 0,
    category: it.category,
    purity: it.purity,
    views: Number(it.views) || 0,
    page: it.url || ''
  })).filter(it => it.id && /^https:\/\//.test(it.path || ''));

  const lastPage = Number(body.meta && body.meta.last_page) || 1;
  return {
    items,
    page: page >= lastPage ? 1 : page + 1,
    empty: items.length === 0,
    relaxed
  };
}

/* ============================ 选图 ============================ */

function sizeOk(it, cfg) {
  if (cfg.quality === 'thumb') return !!(it.thumb || it.path);   // 只看缩略图，原图多大都无所谓
  if (!it.size) return true;
  return it.size <= cfg.capKb * 1024;
}

function pickFromPool(pool, historySet, cfg) {
  if (!pool || !Array.isArray(pool.items) || pool.items.length === 0) return null;
  const fresh = pool.items.filter(it => it && it.path && !historySet.has(String(it.id)));
  if (fresh.length === 0) return null;

  const small = fresh.filter(it => sizeOk(it, cfg));
  const list = small.length ? small : fresh;
  const picked = list[Math.floor(Math.random() * list.length)];
  pool.items = pool.items.filter(it => it !== picked);
  return picked;
}

/* ============================ 下载 ============================ */

async function download(ctx, url, cfg) {
  let resp;
  try {
    resp = await ctx.http.get(url, {
      headers: { 'Referer': 'https://wallhaven.cc/', 'User-Agent': 'Egern/WallhavenWidget ' + SCRIPT_VER },
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
  const mime = detectMime(bytes);
  return { url, dataUri: `data:${mime};base64,${toBase64(bytes)}`, bytes: bytes.byteLength };
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
  const isSmall = family === 'systemSmall';
  const children = [];
  const lines = [];

  if (cfg.showInfo && entry.dim) {
    lines.push({
      type: 'text',
      text: entry.dim + (entry.views ? ` · ${formatViews(entry.views)}` : ''),
      font: { size: 'caption1', weight: 'semibold' },
      textColor: '#FFFFFF',
      maxLines: 1,
      minScale: 0.7
    });
  }

  if (cfg.debug) {
    lines.push({
      type: 'text',
      text: `${SCRIPT_VER} ${entry.ar || '-'} · ${cfg.ratioLabel} · ${cfg.purityUsed === 111 ? 'R18' : (cfg.purityUsed === 110 ? 'Sketchy' : 'SFW')}`
        + `${entry.purityDowngraded ? ' · ⚠无 Key 降级' : ''}`
        + `${entry.sizeKb ? ' · ' + entry.sizeKb + 'KB' + (entry.thumbUsed ? '(缩略)' : '') : ''}`
        + ` · ${entry.keyword ? '「' + entry.keyword + '」' : '随机'}${entry.sorting ? '/' + entry.sorting : ''}`
        + ` · ${entry.searches}搜`,
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

  const title = (cached && cached.dim) || 'Wallhaven';
  const sub = (cached && cached.category) ? String(cached.category) : '等待刷新';
  return {
    type: 'widget', padding: 0,
    ...(cached && cached.page ? { url: cached.page } : {}),
    children: [{
      type: 'stack', direction: 'column', alignItems: 'start', gap: 1,
      children: [
        { type: 'text', text: title, font: { size: 'caption1', weight: 'semibold' }, maxLines: 1, minScale: 0.7 },
        { type: 'text', text: sub, font: { size: 'caption2' }, opacity: 0.7, maxLines: 1 }
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
    url: 'https://wallhaven.cc/',
    children: [
      { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', color: '#FF9F0A', width: 24, height: 24 },
      { type: 'text', text: '加载失败', font: { size: 'headline', weight: 'bold' }, textColor: '#FFFFFF' },
      { type: 'text', text: message, font: { size: 'caption1' }, textColor: 'rgba(255,255,255,0.6)', maxLines: 3 },
      { type: 'spacer' },
      { type: 'text', text: '轻点打开 Wallhaven', font: { size: 'caption2' }, textColor: 'rgba(255,255,255,0.35)', maxLines: 1 }
    ]
  };
}

function formatViews(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
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
