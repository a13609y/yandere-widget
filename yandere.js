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

const SCRIPT_VER = 'v2.3';

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

// yande.re / Konachan 的标签全是英文（罗马字），中文直接查是 0 条。
// 这里放一张常用中文→标签的别名表，命中的会自动替换；没命中的原样发出去（然后再回退随机）
const TAG_ALIAS = {
  '初音': 'hatsune_miku', '初音未来': 'hatsune_miku', 'miku': 'hatsune_miku',
  '天空': 'sky', '蓝天': 'sky', '云': 'clouds', '白云': 'clouds',
  '风景': 'scenery', '景色': 'scenery', '山': 'mountain', '瀑布': 'waterfall',
  '少女': 'girl', '女孩': 'girl', '妹子': 'girl',
  '猫耳': 'cat_ears', '猫娘': 'catgirl', '兽耳': 'animal_ears', '尾巴': 'tail',
  '泳装': 'swimsuit', '泳衣': 'swimsuit', '比基尼': 'bikini', '泳池': 'swimming_pool',
  '女仆': 'maid', '和服': 'kimono', '浴衣': 'yukata', '制服': 'uniform', '水手服': 'serafuku', '校服': 'school_uniform',
  '樱花': 'cherry_blossoms', '花': 'flower', '花朵': 'flower',
  '黑丝': 'black_pantyhose', '白丝': 'white_pantyhose', '丝袜': 'pantyhose',
  '长发': 'long_hair', '短发': 'short_hair', '双马尾': 'twintails', '马尾': 'ponytail',
  '眼镜': 'glasses', '帽子': 'hat', '翅膀': 'wings', '尾巴尖': 'tail',
  '剑': 'sword', '刀': 'katana', '枪': 'gun', '机甲': 'mecha',
  '魔法': 'magic', '魔法少女': 'mahou_shoujo', '天使': 'angel', '恶魔': 'demon', '精灵': 'elf',
  '海': 'ocean', '海边': 'beach', '水': 'water', '湖': 'lake',
  '夜晚': 'night', '夜景': 'night', '星空': 'starry_sky', '月亮': 'moon',
  '雨': 'rain', '雪': 'snow', '秋天': 'autumn', '夏天': 'summer', '冬天': 'winter', '春天': 'spring',
  '烟花': 'fireworks', '花火': 'fireworks', '灯笼': 'lantern',
  '睡衣': 'pajamas', '内衣': 'underwear', '袜': 'socks', '过膝袜': 'thighhighs',
  '萝莉': 'loli', '御姐': 'mature_female', '正太': 'shota'
};

function normalizeTag(tag) {
  const key = String(tag || '').trim();
  if (!key) return '';
  const lower = key.toLowerCase();
  if (TAG_ALIAS[key]) return TAG_ALIAS[key];
  if (TAG_ALIAS[lower]) return TAG_ALIAS[lower];
  // 中文但没收录 → 没法查，直接丢掉（免得整串变 0 条），后面会回退随机
  if (/[\u4e00-\u9fa5]/.test(key)) return '';
  return key.replace(/\s+/g, '_');
}

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
  '仅工口': 'rating:e',                      // 只要 e
  '全年龄 + 擦边': '-rating:e',               // s + q（默认）
  '全部（含工口）': '',                        // 不筛，s + q + e
  // 兼容旧值
  '全年龄 + 擦边 + 工口': '',
  '含擦边': '-rating:e',
  '全部（含 R18）': '',
  '全部': ''                    // 旧值「全部」= 以前的不筛，保守起见改成 s+q？这里保持不筛
};

const RATING_ALLOWED = {
  '仅全年龄': ['s'],
  '仅擦边': ['q'],
  '仅工口': ['e'],
  '全年龄 + 擦边': ['s', 'q'],
  '全部（含工口）': ['s', 'q', 'e']
};

// 排除用的敏感标签。yande.re 的 -tag 反选实测无效（只对 rating: 这类元标签生效），
// 所以只能抓回来后在本地按标签精确匹配剔除
const EXCLUDE_PRESETS = [
  { key: 'EX_NIPPLE', tags: ['nipple', 'nipples'] },   // 单复数都排
  { key: 'EX_PANTY', tags: ['panties'] },
  { key: 'EX_UNDERWEAR', tags: ['underwear', 'bra'] },
  { key: 'EX_SEETHROUGH', tags: ['see_through'] },
  { key: 'EX_NUDE', tags: ['nude', 'topless', 'completely_nude'] },
  { key: 'EX_LOLI', tags: ['loli', 'shota'] },
  { key: 'EX_CAMEL', tags: ['cameltoe', 'spread_legs'] },
  { key: 'EX_BONDAGE', tags: ['bondage'] }
];

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
  if (pool.sig !== sig) pool = { items: [], page: 1, sig };
  if (!pool.page) pool.page = 1;

  let history = readJSON(ctx, K.history);
  if (!Array.isArray(history)) history = [];
  const historySet = new Set(history.map(String));

  let candidate = pickFromPool(pool, historySet, cfg);
  let searches = 0;
  let lastError = '';
  let errorStatus = null;
  let tagFallback = false;
  let periodRelaxed = false;
  let scoreRelaxed = false;

  // 素材不够时继续翻页，最多 4 次：
  //   随机 → 每次换一个随机页（每页都是新的一批）
  //   热度/最新 → 按 1..10 页顺序往后翻（排序稳定，翻页才有意义）
  while (!candidate && searches < 4) {
    try {
      const page = cfg.sort === 'random'
        ? 1 + Math.floor(Math.random() * 3)
        : Math.max(1, pool.page || 1);
      const res = await search(ctx, cfg, page);
      if (cfg.sort !== 'random') pool.page = page >= 10 ? 1 : page + 1;
      searches++;
      const have = new Set(pool.items.map(it => String(it.id)));
      const added = res.items.filter(it => !have.has(String(it.id)));
      pool.items = pool.items.concat(added).slice(-MAX_POOL);
      pool.sig = sig;
      writeJSON(ctx, poolKey, pool);
      candidate = pickFromPool(pool, historySet, cfg);
      if (candidate) { tagFallback = res.tagFallback; periodRelaxed = res.periodRelaxed; scoreRelaxed = res.scoreRelaxed; break; }
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
  let tries = 0;
  while (!img && candidate && tries < 3) {
    tries++;
    try {
      img = await download(ctx, candidate.sample || candidate.file, cfg);
    } catch (e) {
      lastError = (e && e.message) || '图片下载失败';
      if (e && (e.status === 429 || e.status === 403)) { errorStatus = e.status; break; }
      historySet.add(String(candidate.id));       // 这张下不下来，跳过换下一张
      candidate = pickFromPool(pool, historySet, cfg);
      if (candidate) writeJSON(ctx, poolKey, pool);
    }
  }

  if (!img) {
    const wait = errorStatus === 429 ? 45 : (errorStatus === 403 ? 20 : 10);
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, new Date(now + wait * 60000).toISOString());
    return buildError(lastError || '图片下载失败', cfg, new Date(now + Math.min(wait, 15) * 60000).toISOString());
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
    periodRelaxed,
    scoreRelaxed,
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

  // 分级：三个独立开关，自由组合（至少留一个）
  const rawAllowed = (() => {
    const hasToggle = ['SHOW_S', 'SHOW_Q', 'SHOW_E'].some(k => s(k, '') !== '');
    if (hasToggle) {
      const out = [];
      if (bool('SHOW_S', true)) out.push('s');
      if (bool('SHOW_Q', true)) out.push('q');
      if (bool('SHOW_E', false)) out.push('e');
      return out;
    }
    // 兼容旧的单选 RATING
    const legacy = s('RATING', '全年龄 + 擦边');
    if (legacy === '仅全年龄') return ['s'];
    if (legacy === '仅擦边') return ['q'];
    if (legacy === '仅工口') return ['e'];
    if (legacy === '全部（含工口）' || legacy === '全部（含 R18）' || legacy === '全部') return ['s', 'q', 'e'];
    return ['s', 'q'];
  })();
  const allowed = rawAllowed.length ? rawAllowed : ['s'];   // 全关掉就按全年龄，别把自己筛空

  const ownKey = RATIO_BY_FAMILY[family];
  const ratioLabel = s(ownKey, '') || DEFAULT_RATIO[family] || '横图';

  const sortLabel = s('SORT', '随机');
  const sort = /热度|score/i.test(sortLabel) ? 'score' : (/最新|date/i.test(sortLabel) ? 'date' : 'random');

  // 时段：yande.re 支持 date:>YYYY-MM-DD（也支持 date:A..B），不支持 age:
  // 「最新」本身就是时间倒序，时段没意义 → 忽略
  const periodLabel = s('PERIOD', '不限');
  const periodDays = {
    '一天内': 1, '一周内': 7, '一个月内': 30, '三个月内': 90,
    '半年内': 180, '一年内': 365, '两年内': 730, '三年内': 1095
  }[periodLabel] || 0;
  const dateFilter = (periodDays > 0 && sort !== 'date') ? 'date:>' + ymdDaysAgo(periodDays) : '';

  // 排除标签：开关命中的 + 手填的
  const excludeTags = (() => {
    const out = [];
    EXCLUDE_PRESETS.forEach(p => { if (bool(p.key, false)) out.push(...p.tags); });
    s('EXCLUDE_EXTRA', '')
      .split(/[,，、|]/)                              // 只用逗号分组：空格是标签内部的（erect nipples → erect_nipples）
      .map(x => x.trim().toLowerCase().replace(/\s+/g, '_'))
      .filter(Boolean)
      .forEach(t => out.push(t));
    return Array.from(new Set(out));
  })();

  const siteLabel = s('SITE', '自动');
  const site = /konachan/i.test(siteLabel) ? 'konachan' : (/yande/i.test(siteLabel) ? 'yande' : 'auto');

  const rawTags = s('TAGS', '')
    .split(/[\s,，、|]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(normalizeTag)
    .filter(Boolean);

  return {
    tags: rawTags,
    tagsJoined: rawTags.join(' '),
    sort,
    sortLabel: sort === 'score' ? '热度' : (sort === 'date' ? '最新' : '随机'),
    site,
    periodLabel,
    dateFilter,
    excludeTags,
    ratioLabel,
    ratingLabel: allowed.map(x => x === 's' ? '全年龄' : x === 'q' ? '擦边' : '工口').join('+'),
    ratingTag: ratingTagFor(allowed),
    // 服务端标签只是第一道闸；本地再校验一次，
    // 防止「标签无结果→退回随机」时把没勾的等级漏进来
    ratingAllowed: allowed,
    minW: int('MIN_W', 1024, 200, 4000),
    minScore: int('MIN_SCORE', 0, 0, 100000),
    cooldownMin: int('COOLDOWN', 30, 0, 24 * 60),
    maxHistory: int('NO_REPEAT', 100, 1, 2000),
    showInfo: bool('SHOW_INFO', true),
    debug: bool('DEBUG', false),
    timeoutMs: 20000
  };
}

// 由选中的等级集合反推服务端标签：全选=不传；选一个=rating:x；选两个=排除第三个
function ymdDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function ratingTagFor(allowed) {
  if (allowed.length >= 3) return '';
  if (allowed.length === 1) return 'rating:' + allowed[0];
  const missing = ['s', 'q', 'e'].filter(k => allowed.indexOf(k) < 0)[0];
  return missing ? '-rating:' + missing : '';
}

function uiSignature(cfg) {
  return [cfg.showInfo, cfg.debug].join('|');
}

function signature(cfg) {
  return [cfg.tagsJoined, cfg.sort, cfg.dateFilter, cfg.site, cfg.ratioLabel, cfg.ratingAllowed.join(''), cfg.minW, cfg.minScore, cfg.excludeTags.join(',')].join('|');
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
  const parts = ['order:' + (cfg.sort || 'random')];   // 必须第一个，否则排序失效
  if (useTags && cfg.tags.length) parts.push(...cfg.tags);
  if (cfg.ratingTag) parts.push(cfg.ratingTag);
  if (cfg.dateFilter) parts.push(cfg.dateFilter);
  return parts.join(' ');
}

async function search(ctx, cfg, page) {
  const hosts = hostsFor(cfg);
  const pg = Math.max(1, page | 0);
  let triedEmpty = false;

  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    const url = HOSTS[host] + '?tags=' + encodeURIComponent(buildTagString(cfg, true)) + '&limit=100&page=' + pg;
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

  // 回退①：标签组合全空 → 去掉用户标签，只留排序 + 分级 + 时段
  if (triedEmpty && cfg.tags.length) {
    const url = HOSTS[hosts[0]] + '?tags=' + encodeURIComponent(buildTagString(cfg, false)) + '&limit=100&page=' + pg;
    const body = await fetchJson(ctx, url, cfg);
    const passed = normalize(body, hosts[0]).filter(it => passesFilter(it, cfg));
    if (passed.length) return { items: passed, empty: false, tagFallback: true, periodRelaxed: false };

    // 回退②：连时段也无图（比如「热度 + 一天内」）→ 再去掉时段，只留排序 + 分级
    if (cfg.dateFilter) {
      const cfg2 = Object.assign({}, cfg, { dateFilter: '' });
      const url2 = HOSTS[hosts[0]] + '?tags=' + encodeURIComponent(buildTagString(cfg2, false)) + '&limit=100&page=' + pg;
      const body2 = await fetchJson(ctx, url2, cfg);
      const passed2 = normalize(body2, hosts[0]).filter(it => passesFilter(it, cfg));
      return { items: passed2, empty: passed2.length === 0, tagFallback: true, periodRelaxed: true };
    }
    return { items: [], empty: true, tagFallback: true, periodRelaxed: false };
  }

  // 最低评分卡太死 → 去掉它再试一次
  if (triedEmpty && cfg.minScore > 0) {
    const cfg3 = Object.assign({}, cfg, { minScore: 0 });
    const url3 = HOSTS[hosts[0]] + '?tags=' + encodeURIComponent(buildTagString(cfg3, cfg.tags.length > 0)) + '&limit=100&page=' + pg;
    const body3 = await fetchJson(ctx, url3, cfg);
    const passed3 = normalize(body3, hosts[0]).filter(it => passesFilter(it, cfg3));
    if (passed3.length) return { items: passed3, empty: false, tagFallback: false, periodRelaxed: false, scoreRelaxed: true };
  }

  // 没有标签但有时段且空 → 去掉时段再试一次
  if (triedEmpty && cfg.dateFilter) {
    const cfg2 = Object.assign({}, cfg, { dateFilter: '' });
    const url2 = HOSTS[hosts[0]] + '?tags=' + encodeURIComponent(buildTagString(cfg2, false)) + '&limit=100&page=' + pg;
    const body2 = await fetchJson(ctx, url2, cfg);
    const passed2 = normalize(body2, hosts[0]).filter(it => passesFilter(it, cfg));
    return { items: passed2, empty: passed2.length === 0, tagFallback: false, periodRelaxed: true };
  }

  return { items: [], empty: true, tagFallback: false, periodRelaxed: false };
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

// 画幅按 sample 的实际宽高判断。
// 方图放宽到 0.75~1.35：小组件是 cover 填充，轻微裁切看不出来，
// 但可选素材能多一大截（4:3、5:4、4:5 这些都算方）
const BAND = { landscape: 1.35, squareLow: 0.75 };

function bandOf(it) {
  const ar = it.sampleW && it.sampleH ? it.sampleW / it.sampleH : 0;
  if (!ar) return '';
  if (ar >= BAND.landscape) return '横图';
  if (ar >= BAND.squareLow) return '方图';
  return '竖图';
}

// 按 `_` 分段匹配：排除词作为「完整的一段」出现才算命中
//   nipples        → nipples / erect_nipples / puffy_nipples  ✅
//   bra            → braid 不会命中（braid 是整段）           ✅
//   erect_nipples  → erect_nipples 命中（多段也能匹配）        ✅
function hitsExclude(tags, excludes) {
  const tokens = String(tags || '').toLowerCase().split(' ').filter(Boolean);
  if (!tokens.length) return false;
  for (let i = 0; i < excludes.length; i++) {
    const kw = excludes[i];
    if (!kw) continue;
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j];
      if (t === kw
        || t.indexOf(kw + '_') === 0
        || t.length > kw.length && t.lastIndexOf('_' + kw) === t.length - kw.length - 1
        || t.indexOf('_' + kw + '_') >= 0) return true;
    }
  }
  return false;
}

function passesFilter(it, cfg) {
  if (it.rating && cfg.ratingAllowed.indexOf(it.rating) < 0) return false;   // 分级兜底
  if (cfg.excludeTags.length && hitsExclude(it.tags, cfg.excludeTags)) return false;
  const band = bandOf(it);
  if (cfg.ratioLabel !== '不限' && band && band !== cfg.ratioLabel) return false;
  const shortSide = Math.min(it.sampleW || 0, it.sampleH || 0);
  if (shortSide && shortSide < cfg.minW * 0.6) return false;   // 太小的直接跳过
  if (it.sampleSize && it.sampleSize / 1024 > HARD_LIMIT_KB) return false;
  if (cfg.minScore > 0 && (it.score || 0) < cfg.minScore) return false;   // 最低评分

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
      shadowColor: 'rgba(0,0,0,0.55)',
      shadowRadius: 3,
      shadowOffset: { x: 0, y: 1 },
      maxLines: 1,
      minScale: 0.7
    });
  }

  if (cfg.debug) {
    lines.push({
      type: 'text',
      text: `${SCRIPT_VER} ${entry.site} ${entry.ar || '-'} ${cfg.ratioLabel} ${entry.rating || '-'}`
        + `${entry.sizeKb ? ' ' + entry.sizeKb + 'KB' : ''}`
        + ` ${cfg.sortLabel}${cfg.dateFilter ? '/' + cfg.periodLabel : ''}`
        + `${entry.tagFallback ? ' ⚠标签' : ''}${entry.periodRelaxed ? ' ⚠时段' : ''}${entry.scoreRelaxed ? ' ⚠评分' : ''}`
        + `${entry.queryTags ? ' 「' + entry.queryTags + '」' : ''} ${entry.searches}搜`,
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
