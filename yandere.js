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

const SCRIPT_VER = 'v8.2';

// konachan 有两个域名：.net 是纯净镜像（只有 s），.com 才含 q/e。
// 勾了擦边/工口就自动换 .com，只勾全年龄就用 .net。
const HOSTS = {
  yande: 'https://yande.re/post.json',
  konachan: 'https://konachan.net/post.json',
  konachanR18: 'https://konachan.com/post.json'
};

const SITE_DOMAIN = {
  yande: 'yande.re',
  konachan: 'konachan.net',
  konachanR18: 'konachan.com'
};

const K = {
  cache: 'yd_cache_',        // + family
  pool: 'yd_pool_',          // + ratioKey
  history: 'yd_history',
  lastShow: 'yd_lastshow_',  // + family
  debug: 'yd_debug',
  bad: 'yd_bad',             // 下不下来的图（id → 时间戳），7 天内不再试
  bag: 'yd_bag',             // 洗牌袋：一页清单洗好后逐张发
  shown: 'yd_shown'          // 最近展示过的图的元数据（回放用）
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

// 画幅判定
//   默认（粗分档）：≥1.35 横、0.75~1.35 方、<0.75 竖
//   打开「自定义容忍」后：按理想比例 ±N%（横 1.78 / 方 1.00 / 竖 0.71），N 默认 15
const BAND_LOOSE = { '横图': [1.35, 99], '方图': [0.75, 1.35], '竖图': [0, 0.75] };
const IDEAL_AR = { '横图': 1.78, '方图': 1.33, '竖图': 0.71 };   // 方图按 booru 实际比例 4:3 算，不再是 1.00
// 时段兜底用的阶梯（天）：评分实在降不下来时，先小幅放宽时段，而不是直接跳到「不限」
const PERIOD_LADDER = [1, 3, 7, 14, 30, 90, 180, 365, 730, 1095, 2190];

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
  { key: 'EX_NIPPLE', tags: ['nipple', 'nipples'] },          // 露点（单复数都排）
  { key: 'EX_PANEL', tags: ['4koma'], on: true },             // 多格漫画（仅 yande.re 有效），默认开
  // 「白色」只按整词匹配：konachan 上 white_hair 有上万条，按段匹配会把白毛角色全灭
  { key: 'EX_WHITE', tags: ['white', 'transparent_background', 'transparent'], exact: true, on: true }   // 白底/透明底在桌面组件上都很难看，默认开
  // 其余排除项（胖次/内衣/透视/裸体/骆驼趾/萝莉/捆绑）已删除：
  // 两站标签命中率低、又容易把 q 级素材筛空；需要时用「过滤 · 自定义标签」临时补
];

const HARD_LIMIT_KB = 1200;   // 单张超过这个体积就跳过（iOS 桌面画不出来）
// 图床（files.yande.re 等）偶尔会返回风控网页而不是图片，用浏览器 UA 过掉大部分
const IMG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

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
    // 这次渲染本来只返回缓存（5ms），顺手把袋子补好，让真正换图那次快一点
    if (cfg.cooldownMin > 0) await prefetchBag(ctx, cfg, sig);
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
  if (pool.sig !== sig) pool = { page: 1, sig, plan: null };
  if (!pool.page) pool.page = 1;

  let history = readJSON(ctx, K.history);
  if (!Array.isArray(history)) history = [];
  const historySet = new Set(history.map(String));   // 存的是 uid（md5）

  const badSet = new Set(Object.keys(readBad(ctx)));

  // ── 洗牌袋 ──────────────────────────────────────────────
  // 一次只向源站要「一页清单」（100 条元数据，不下载图片），本地洗牌后逐张发；
  // 一袋之内绝不重复，袋与袋之间用「允许回放比例」控制重叠。
  let bag = readJSON(ctx, K.bag) || {};
  if (bag.sig !== sig || !Array.isArray(bag.items)) bag = { sig, items: [], srcTurn: bag.srcTurn || 0 };
  const shown = readJSON(ctx, K.shown) || {};

  let candidate = null;
  let recycled = false;
  let searches = 0;
  let lastError = '';
  let errorStatus = null;

  // ① 按比例「回放」最久没出现的一张（默认 20%，均匀撒开，不会连着撞同一张）
  if (cfg.repeatPct > 0 && history.length && Math.random() * 100 < cfg.repeatPct) {
    const holdId = cached && (cached.uid || cached.id) ? String(cached.uid || cached.id) : '';
    for (let i = 0; i < history.length; i++) {
      if (history.length - i <= 8) break;          // 最近 8 次出现过的就别回放了，免得“刚看完又看到”
      const id = String(history[i]);
      const it = shown[id];
      if (it && it.sample && id !== holdId && !badSet.has(id)) { candidate = it; recycled = true; break; }
    }
  }

  // ② 否则从袋里拿一张；袋空就补一袋
  while (!candidate && searches < 4) {
    if (!bag.items.length) {
      // 一页里常有“批量上传大户”占掉大半（实测某画师一个月内几十张），
      // 所以按画师去重后往往不够装一袋 → 再取一页合并，最多 3 页
      let acc = [];
      let pages = 0;
      // yande 单源 + 随机/权重：一次就拿了整个月（300 条），再翻是同一页，白花 4 秒
      const maxPages = (cfg.site === 'yande' && isRandomLike(cfg)) ? 1 : 3;
      while (pages < maxPages && acc.length < cfg.bagSize && searches < 6) {
        try {
          const yandeRandomWithDate = cfg.site === 'yande' && isRandomLike(cfg);

          // 时段切块：从「月份袋」里抽一个自然月，只在这个月里取图
          let c = cfg;
          if (cfg.monthSlice && cfg.periodDays > 0 && !bag.noMonth) {
            if (!Array.isArray(bag.months) || !bag.months.length) bag.months = shuffleArr(monthKeys(cfg.periodDays));
            let mk = null, rg = null;
            while (bag.months.length && !rg) {        // 「权重」档：被成熟期吃掉的月份直接跳过
              mk = bag.months.shift();
              rg = clipMonthRange(cfg, monthRange(mk));
            }
            if (rg) {
              c = Object.assign({}, cfg, { dateFilter: 'date:' + rg.from + '..' + rg.to, monthLock: true, monthLabel: mk });
              bag.lastMonth = mk;
            }
          }
          // 取页要在月切块之后算：月份区间只有 5~6 页，翻到第 20 页必然空响应
          const page = isRandomLike(cfg)
            ? (yandeRandomWithDate ? 1 + Math.floor(Math.random() * pageCapFor(c)) : 1 + Math.floor(Math.random() * 3))
            : Math.max(1, pool.page || 1);

          // 回到「Konachan 优先，空了才用 yande」；不再两源轮换（两站图基本重合，轮换没好处）
          const res = await search(ctx, c, page, pool.plan, badSet, historySet);
          pages++;
          searches++;
          if (!isRandomLike(cfg)) pool.page = page >= pageCapFor(c) ? 1 : page + 1;
          if (res.ok) pool.plan = res.plan || null;
          pool.sig = sig;
          writeJSON(ctx, poolKey, pool);

          const got = (res.fresh && res.fresh.length) ? res.fresh : (res.items || []);
          const unseen = got.filter(it => !historySet.has(String(it.uid)) && !badSet.has(String(it.uid)));
          const add = unseen.length ? unseen : got.filter(it => !badSet.has(String(it.uid))).slice(0, 3);
          if (!add.length) continue;      // 这页/这个月没货 → 换下一页（最多 3 页），别直接放弃
          // 跨页也去重（同一张图两页都可能出现）
          const have = new Set(acc.map(it => String(it.uid)));
          add.forEach(it => { if (!have.has(String(it.uid))) { have.add(String(it.uid)); acc.push(it); } });
          // yande 走的是「大页模式」（limit=300 且固定 page=1，整月一次拿完），
          // 再翻一次只会拿到一模一样的一页 → 直接结束（自动模式下 Konachan 挂了回退到 yande 时尤其浪费）
          if (res.host === 'yande' && isRandomLike(cfg)) break;
        } catch (e) {
          lastError = (e && e.message) || '搜索失败';
          errorStatus = e && e.status ? e.status : null;
          break;
        }
      }
      // 这个月没货（比如这一月的图全看过了）→ 先换一个月试试，别马上关掉切月
      // （以前直接置 noMonth=true，会永久放弃按月切块，时间分布就散了）
      if (!acc.length && cfg.monthSlice && cfg.periodDays > 0 && !bag.noMonth) {
        bag.emptyMonths = (bag.emptyMonths || 0) + 1;
        if (bag.emptyMonths >= 3) {
          bag.noMonth = true;            // 连换三个月全空 → 改用整个时段兜底
          bag.emptyMonths = 0;
        }
        bag.items = [];
        writeJSON(ctx, K.bag, bag);
        continue;
      }
      bag.emptyMonths = 0;
      const uniq = dedupeVariants(acc, cfg.variantDedupe, cfg.artistDedupe);
      bag.items = (cfg.weighted ? weightedShuffle(uniq, cfg.weightK) : shuffleArr(uniq)).slice(0, cfg.bagSize);
      // 一袋装不满（素材太薄，比如只勾工口）→ 下次别切月了，用整个时段兜，池子大得多
      bag.noMonth = bag.items.length < Math.min(12, cfg.bagSize);
      writeJSON(ctx, K.bag, bag);
      if (!bag.items.length) break;
    }
    if (bag.items.length) {
      candidate = bag.items.shift();
      writeJSON(ctx, K.bag, bag);
    }
  }

  if (!candidate) {
    if (cached && cached.dataUri) {
      return buildWidget(Object.assign({}, cached, { searches }), family, cfg, new Date(now + 10 * 60000).toISOString());
    }
    return buildError(lastError || emptyHint(cfg), cfg, new Date(now + 15 * 60000).toISOString());
  }

  // ── 下载（sample 图：1500px 长边、200~500KB）─────────────────
  let img = null;
  let tries = 0;
  let transientHits = 0;
  let retriedSame = false;                          // 同一张图是否已经重试过一次
  // candidate.site 是内部 key（yande / konachan / konachanR18），必须换成真实域名：
  // 拼错成 https://yande/ 时 yande 的图床会 307 回图片页（表现为“加载不出图”）
  const referer = 'https://' + (SITE_DOMAIN[candidate.site] || candidate.site || 'yande.re') + '/';
  while (!img && candidate && tries < 4) {
    tries++;
    try {
      img = await download(ctx, candidate.sample || candidate.file, cfg, referer);
    } catch (e) {
      lastError = (e && e.message) || '图片下载失败';
      if (e && (e.status === 429 || e.status === 403)) { errorStatus = e.status; break; }
      if (e && e.transient) {
        // 图床的 307/HTML 多数是暂时的（yande 会间歇性把 sample 跳回图片页）
        // 先原样重试一次，还不行再换一张；都不算坏图
        if (!retriedSame) { retriedSame = true; continue; }
        badSet.add(String(candidate.uid));
        retriedSame = false;
        if (++transientHits >= 3) break;
      } else {
        badSet.add(String(candidate.uid));
        markBad(ctx, candidate.uid);               // 这张真下不来，7 天内不再试
      }
      // 换袋子里下一张（不会再去试这张坏图）
      candidate = null;
      while (bag.items.length && !candidate) {
        const next = bag.items.shift();
        if (next && !badSet.has(String(next.uid)) && !historySet.has(String(next.uid))) candidate = next;
      }
      writeJSON(ctx, K.bag, bag);
      writeJSON(ctx, poolKey, pool);
    }
  }

  if (!img) {
    const wait = errorStatus === 429 ? 45 : (errorStatus === 403 ? 20 : 10);
    if (cached && cached.dataUri) return buildWidget(Object.assign({}, cached, { searches }), family, cfg, new Date(now + wait * 60000).toISOString());
    return buildError(lastError || '图片下载失败', cfg, new Date(now + Math.min(wait, 15) * 60000).toISOString());
  }

  const meta = candidate.meta || { sc: 0, pd: 0, rl: 0, tf: 0 };
  const entry = {
    id: candidate.id,
    uid: candidate.uid,
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
    // 角标按「这张图实际是按什么档位抓来的」算，存进池子也带着，换刷新不会丢
    tagFallback: !!meta.tf,
    periodRelaxed: (meta.pd || 0) !== strictMeta(cfg).pd,
    scoreRelaxed: cfg.minScore > 0 && (candidate.score || 0) < cfg.minScore,
    scoreCfg: cfg.minScore,
    ratioRelaxed: !!meta.rl,
    recycled,                     // true = 库尽，这张是看过的图轮换出来的
    searches,
    uiSig: uiSignature(cfg),
    sig,
    at: now
  };

  const cacheOk = writeJSON(ctx, K.cache + family, entry);
  if (!cacheOk) entry.cacheFailed = true;
  const hi = history.findIndex(x => String(x) === String(candidate.uid));
  if (hi >= 0) history.splice(hi, 1);
  history.push(candidate.uid);
  while (history.length > cfg.maxHistory) history.shift();
  writeJSON(ctx, K.history, history);
  // 记住最近展示过的图（只留元数据，不含 base64），供「回放」用
  shown[String(candidate.uid)] = {
    id: candidate.id, uid: candidate.uid, site: candidate.site, page: candidate.page, sample: candidate.sample,
    sampleW: candidate.sampleW, sampleH: candidate.sampleH, sampleSize: candidate.sampleSize,
    rating: candidate.rating, score: candidate.score, tags: candidate.tags, meta: candidate.meta
  };
  const keepShown = {};
  history.slice(-300).forEach(id => { const k = String(id); if (shown[k]) keepShown[k] = shown[k]; });
  writeJSON(ctx, K.shown, keepShown);
  ctx.storage.set(K.lastShow + family, String(now));
  writeJSON(ctx, K.debug, {
    at: now, id: candidate.id, site: candidate.site, ar: entry.ar, dim: entry.dim,
    sizeKb: entry.sizeKb, rating: candidate.rating, tags: cfg.tagsJoined,
    meta, searches, cacheOk
  });

  return buildWidget(entry, family, cfg, nextIso(cfg.cooldownMin > 0 ? cfg.cooldownMin : 15));
}

/* ============================ 配置 ============================ */

// 洗牌参数不再暴露成变量：按「排序」自动套用一套预设
//   随机 = 大袋子、按月切块、不回放
//   热度 = 小袋子、按月切块、10% 回放（榜单走完一定会回头）
//   权重 = 大袋子、按月切块、按分数加权洗牌、不回放 + 14 天成熟期
const SORT_PRESETS = {
  random: { bagSize: 50, monthSlice: true,  variantDedupe: true, artistDedupe: false, repeatPct: 0 },
  score:  { bagSize: 30, monthSlice: true,  variantDedupe: true, artistDedupe: false, repeatPct: 10 },
  weight: { bagSize: 40, monthSlice: true,  variantDedupe: true, artistDedupe: false, repeatPct: 0 }
};

// 「权重」档的两个固定值（不暴露成设置项）
const MATURE_DAYS = 14;   // 成熟期：最近 14 天的投稿不参与，等分数涨完了再判
const WEIGHT_K = 0.4;     // 分数权重指数：w = (score+1)^0.4，温和偏向高分，不饿死低分池

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

  // 画幅：一个变量管所有尺寸。「自动」= 小方 / 中横 / 大方 / 超大横
  const ratioSel = s('RATIO_MODE', '自动');
  const ratioLabel = ratioSel === '自动' ? (DEFAULT_RATIO[family] || '横图') : ratioSel;
  const ratioMode = ratioLabel === '不限' ? 'any' : 'band';
  const customOn = bool('RATIO_CUSTOM', true);      // 开箱即用：默认按理想比例 ±10% 收
  const tolPct = Math.min(50, Math.max(5, int('RATIO_TOL', 10, 5, 50)));   // 留空默认 10%，限制 5~50
  const band = (() => {
    if (!BAND_LOOSE[ratioLabel]) return null;                              // 「不限」不筛
    if (!customOn) return BAND_LOOSE[ratioLabel];
    const ideal = IDEAL_AR[ratioLabel];
    return [ideal * (1 - tolPct / 100), ideal * (1 + tolPct / 100)];
  })();

  const sortLabel = s('SORT', '随机');
  // 「最新」已去掉；老用户 env 里存着「最新」的话，落到「权重」（同样是“跳过刚发的、等分数涨完”的思路）
  const sort = /权重|weight|最新|date/i.test(sortLabel) ? 'weight' : (/热度|score/i.test(sortLabel) ? 'score' : 'random');
  const preset = SORT_PRESETS[sort] || SORT_PRESETS.random;

  // 时段：yande.re 支持 date:>YYYY-MM-DD（也支持 date:A..B / date:<YYYY-MM-DD），不支持 age:
  const periodLabel = s('PERIOD', '三年内');
  const periodDays = {
    '一天内': 1, '一周内': 7, '一个月内': 30, '三个月内': 90,
    '半年内': 180, '一年内': 365, '两年内': 730, '三年内': 1095, '六年内': 2190
  }[periodLabel] || 0;
  // 成熟期（只在「权重」档启用）：最近 14 天的投稿分数还没涨完，先不参与评选
  const matureAt = sort === 'weight' ? Date.now() - MATURE_DAYS * 86400000 : 0;
  const dateFilter = dateFilterFor(periodDays, matureAt);

  // 排除标签：开关命中的 + 手填的
  const exclude = (() => {
    const seg = [];   // 按 `_` 分段匹配（nipples 命中 erect_nipples）
    const exact = []; // 整词匹配（white 不误伤 white_hair）
    EXCLUDE_PRESETS.forEach(p => {
      if (!bool(p.key, !!p.on)) return;
      (p.exact ? exact : seg).push(...p.tags);
    });
    s('EXCLUDE_EXTRA', '')
      .split(/[,，、|]/)                              // 只用逗号分组：空格是标签内部的（erect nipples → erect_nipples）
      .map(x => x.trim().toLowerCase().replace(/\s+/g, '_'))
      .filter(Boolean)
      .forEach(t => seg.push(t));
    return { seg: Array.from(new Set(seg)), exact: Array.from(new Set(exact)) };
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
    sortLabel: sort === 'weight' ? '权重' : (sort === 'score' ? '热度' : '随机'),
    site,
    periodLabel,
    periodDays,
    dateFilter,
    excludeSeg: exclude.seg,
    excludeExact: exclude.exact,
    ratioLabel,
    ratioMode,
    bandLo: band ? band[0] : 0,
    bandHi: band ? band[1] : 99,
    customOn,
    tolPct,
    ratingLabel: allowed.map(x => x === 's' ? '全年龄' : x === 'q' ? '擦边' : '工口').join('+'),
    ratingTag: ratingTagFor(allowed),
    // 服务端标签只是第一道闸；本地再校验一次，
    // 防止「标签无结果→退回随机」时把没勾的等级漏进来
    ratingAllowed: allowed,
    minW: int('MIN_W', 1024, 200, 4000),
    minScore: 0,        // v6.0 起不提供最低评分选项：实测高分档候选集太小，只会原地轮换
    cooldownMin: int('COOLDOWN', 30, 0, 24 * 60),
    maxHistory: 200,   // 固定值，不再暴露成变量（洗牌袋模式下 200 足够）
    showInfo: bool('SHOW_INFO', false),   // 默认不显示，想看再手动打开
    // 洗牌参数由「排序」决定（见 SORT_PRESETS），不再单独暴露成变量
    weighted: sort === 'weight',
    matureAt,
    weightK: WEIGHT_K,
    repeatPct: preset.repeatPct,
    bagSize: preset.bagSize,
    monthSlice: preset.monthSlice,
    artistDedupe: preset.artistDedupe,
    variantDedupe: preset.variantDedupe,
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
  return [cfg.tagsJoined, cfg.sort, cfg.dateFilter, cfg.site, cfg.ratioLabel, cfg.customOn ? 'C' + cfg.tolPct : 'L', cfg.ratingAllowed.join(''), cfg.minW, cfg.minScore, cfg.excludeSeg.join(',') + '|' + cfg.excludeExact.join(','), cfg.repeatPct, cfg.bagSize, cfg.monthSlice].join('|');
}

function nextIso(minutes) {
  return new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
}

function emptyHint(cfg) {
  if (cfg.tags.length) return '「' + cfg.tagsJoined + '」在 yande.re / Konachan 没有结果，试试换成更常见的标签（例如 landscape、hatsune_miku）';
  return '没有取到图片，稍后会自动重试';
}

/* ============================ 搜索 ============================ */

function konachanHostFor(cfg) {
  const wantsAdult = cfg.ratingAllowed.some(k => k === 'q' || k === 'e');
  return wantsAdult ? 'konachanR18' : 'konachan';
}

function hostsFor(cfg) {
  const kHost = konachanHostFor(cfg);
  if (cfg.site === 'yande') return ['yande'];
  if (cfg.site === 'konachan') return [kHost];
  return [kHost, 'yande'];          // 自动：Konachan 先（量大、一次给 100 条），空了再 yande.re
}

// 注意：标签之间必须用「空格」分隔再整体 encodeURIComponent。
// 如果先拼 '+' 再编码，'+' 会变成 %2B（字面加号），服务端就不当作分隔符了——
// 整个串被当成一个不存在的标签，返回一堆随机图，分级/标签筛选全部失效。
// 时间过滤统一在这里拼：下限=时段，上限=成熟期（只有「权重」档有上限）
function dateFilterFor(days, matureAt) {
  const hi = matureAt ? ymdDaysAgo(MATURE_DAYS) : '';
  if (!hi) return days ? 'date:>' + ymdDaysAgo(days) : '';
  // 时段比成熟期还短（选了「一天内」「一周内」）→ 那个窗口里全是没涨完分的图，
  // 这时忽略时段下限，只保留 14 天前的上限，否则必然空结果
  if (!days || days <= MATURE_DAYS) return 'date:<' + hi;
  return 'date:' + ymdDaysAgo(days) + '..' + hi;
}

// 「随机」和「权重」都是随机取样，取页/翻页策略一致，只是「权重」多一道加权洗牌
// 单月切块时源站只有 5~6 页（实测 yande 单月 400~600 张、Konachan 700~800 张）；
// 不切月时（整个时段）页数很多，随机翻到 20 页没问题
function pageCapFor(cfg) {
  return cfg.monthLock ? 5 : 20;
}

function isRandomLike(cfg) {
  return cfg.sort === 'random' || cfg.sort === 'weight';
}

// 按月切块时把月份区间上限压到成熟期之前；整月都被吃掉就返回 null（跳过这个月）
function clipMonthRange(cfg, rg) {
  if (!cfg.matureAt) return rg;
  const hi = ymdDaysAgo(MATURE_DAYS);
  const to = rg.to < hi ? rg.to : hi;
  if (rg.from > to) return null;
  return { from: rg.from, to };
}

function buildTagString(cfg, useTags) {
  // yande.re 的 order:random 叠加 date: 只回 0~3 条（服务端毛病），
  // 这时改用 order:date + 随机页：仍然是“随机挑一批”，但落在时段内且数量正常
  const orderName = cfg.sort === 'weight' ? 'random' : (cfg.sort || 'random');
  // yande.re 的 order:random 叠加「区间」或「date:>」会退化（0~3 条），只叠 date:< 上限时正常
  // yande.re 的 order:random 是个半残：无日期只回 ~20 条、带 date:< 回 ~15 条、带区间 0 条，
  // 所以只要是「随机/权重」档走 yande，就一律换成 order:date + 随机页（每页照样 100 条）
  const yandeRandom = (cfg.site === 'yande' || cfg.forceOrderDate) && isRandomLike(cfg);
  const parts = ['order:' + (yandeRandom ? 'date' : orderName)];   // 必须第一个，否则排序失效
  if (useTags && cfg.tags.length) parts.push(...cfg.tags);
  if (cfg.ratingTag) parts.push(cfg.ratingTag);
  // 评分也交给服务端：本地「先随机抽 100 张再筛掉低分」等于白抽一大半，
  // 服务端 score:>N-1 能让随机抽样直接发生在高分池里（yande / Konachan 实测都支持）
  if (cfg.minScore > 0) parts.push('score:>' + (cfg.minScore - 1));
  if (cfg.dateFilter) parts.push(cfg.dateFilter);
  return parts.join(' ');
}

function effPeriod(cfg) {
  return cfg.dateFilter ? (cfg.periodDays || 0) : 0;
}

// 严格档位 = 用户设置的原始条件
function strictMeta(cfg) {
  return { sc: cfg.minScore || 0, pd: effPeriod(cfg), rl: 0, tf: 0 };
}

function sameMeta(a, b) {
  if (!a || !b) return false;
  return (a.sc || 0) === (b.sc || 0) && (a.pd || 0) === (b.pd || 0) && (a.rl ? 1 : 0) === (b.rl ? 1 : 0) && (a.tf ? 1 : 0) === (b.tf ? 1 : 0);
}

// 这批图是否符合「严格档位」。老池子里的项没有 meta，一律按严格处理（sig 变了会清池）
function isStrictMeta(meta, cfg) {
  if (!meta) return true;
  return sameMeta(meta, strictMeta(cfg));
}

// 把档位还原成一次查询配置
function variantCfg(cfg, meta) {
  const c = Object.assign({}, cfg, { minScore: Math.max(0, meta.sc || 0) });
  const pd = meta.pd || 0;
  if (pd !== effPeriod(cfg)) {
    c.periodDays = pd;
    c.dateFilter = dateFilterFor(pd, c.matureAt);
  }
  if (meta.rl) {
    c.customOn = false;
    c.bandLo = BAND_LOOSE[cfg.ratioLabel] ? BAND_LOOSE[cfg.ratioLabel][0] : 0;
    c.bandHi = BAND_LOOSE[cfg.ratioLabel] ? BAND_LOOSE[cfg.ratioLabel][1] : 99;
  }
  return c;
}

// 评分阶梯：卡太死时逐级降（200 → 150 → 100 → 50），而不是一步砍到 0
function scoreLadder(minScore) {
  if (!(minScore > 0)) return [];
  const out = [];
  [minScore, 200, 150, 100, 50].forEach(v => {
    if (v > minScore) return;
    if (!out.length || v < out[out.length - 1]) out.push(v);
  });
  return out;
}

// 依次尝试的档位序列（严格 → 去标签 → 粗分档 → 评分阶梯 → 时段阶梯 → 全放开）
function buildAttempts(cfg, plan) {
  const strict = strictMeta(cfg);
  const withTags = cfg.tags.length > 0;
  const list = [];

  // 上次刷新成功的档位先试一次（避免每次刷新都重走整条链）
  if (plan && !sameMeta(plan, strict)) {
    list.push({ cfg: variantCfg(cfg, plan), useTags: !plan.tf, meta: plan });
  }
  list.push({ cfg, useTags: true, meta: strict });
  if (cfg.tags.length) list.push({ cfg, useTags: false, meta: Object.assign({}, strict, { tf: 1 }) });
  if (cfg.customOn) list.push({ cfg: variantCfg(cfg, Object.assign({}, strict, { rl: 1 })), useTags: withTags, meta: Object.assign({}, strict, { rl: 1 }) });

  // 评分阶梯：保住时段
  scoreLadder(cfg.minScore).slice(1).forEach(sc => {
    list.push({ cfg: Object.assign({}, cfg, { minScore: sc }), useTags: withTags, meta: Object.assign({}, strict, { sc, tf: withTags ? 0 : 0 }) });
  });

  // 时段阶梯：保住评分
  if (cfg.dateFilter && !cfg.monthLock) {
    let days = PERIOD_LADDER.filter(d => d > (cfg.periodDays || 0));
    // yande.re 的 order:random 叠加 date 几乎必空（实测 0~3 条），中间档位纯浪费请求，直接跳到不限
    if (cfg.site === 'yande' && isRandomLike(cfg)) days = [];
    days.slice(0, 3).forEach(d => {
      list.push({
        cfg: Object.assign({}, cfg, { dateFilter: dateFilterFor(d, cfg.matureAt), periodDays: d }),
        useTags: withTags, meta: Object.assign({}, strict, { pd: d })
      });
    });
    list.push({
      cfg: Object.assign({}, cfg, { dateFilter: dateFilterFor(0, cfg.matureAt), periodDays: 0 }),
      useTags: withTags, meta: Object.assign({}, strict, { pd: 0 })
    });
  }

  // 最后兜底：评分不要了、时段不限
  if (cfg.minScore > 0) {
    list.push({
      cfg: Object.assign({}, cfg, { minScore: 0, dateFilter: '' }),
      useTags: withTags, meta: { sc: 0, pd: 0, rl: 0, tf: 0 }
    });
  }
  return list;
}

async function search(ctx, cfg, page, plan, skipSet, historySet, hostOrder) {
  const hosts = hostOrder || hostsFor(cfg);
  const pg = Math.max(1, page | 0);
  let budget = 16;                // 单次搜索请求上限，防止放宽链把小组件拖超时
  let lastErr = null;
  let rateLimited = false;
  const okHosts = [];

  const stalePool = [];        // 这一档有图、但全被防重复窗口挡住了 → 当作「库尽」，往下放宽

  const call = async (c, useTags, hostList) => {
    // tf = 这次查询是否把用户标签丢了（没有标签时不算丢）
    const tfDropped = (cfg.tags.length > 0 && !useTags) ? 1 : 0;
    const sent = { sc: c.minScore || 0, pd: c.dateFilter ? (c.periodDays || 0) : 0, rl: c.customOn ? 0 : (cfg.customOn ? 1 : 0), tf: tfDropped };
    for (let i = 0; i < hostList.length; i++) {
      if (budget <= 0) return { items: [] };
      budget--;
      const host = hostList[i];
      // 轮到 yande 且带时段时，它的 order:random 只回 0~3 条 → 换成 order:date
      const cc = (host === 'yande' && isRandomLike(c) && c.dateFilter) ? Object.assign({}, c, { forceOrderDate: true }) : c;
      // yande 的随机/权重档：一次要 300 条（单月总量 400~600，基本一页拿完），避免翻 3 页白等
      const bigPage = host === 'yande' && isRandomLike(c);
      const limit = bigPage ? 300 : 100;
      const page = bigPage ? 1 : pg;
      const url = HOSTS[host] + '?tags=' + encodeURIComponent(buildTagString(cc, useTags)) + '&limit=' + limit + '&page=' + page;
      try {
        const items = normalize(await fetchJson(ctx, url, cc), host, sent)
          .filter(it => passesFilter(it, c) && !(skipSet && skipSet.has(String(it.uid))));   // 下不来的图当不存在，好让放宽链继续往下走（注意键是 uid/md5，不是 post id）
        okHosts.push(host);
        if (!items.length) continue;
        const fresh = historySet ? items.filter(it => !historySet.has(String(it.uid))) : items;
        if (fresh.length) return { items, fresh, host, meta: sent };
        stalePool.push.apply(stalePool, items);   // 全看过 → 记下来兜底，同时让链继续降档
      } catch (e) {
        lastErr = e;              // 某个源挂了 → 试下一个
        if (e && e.status === 429) { rateLimited = true; return { items: [] }; }   // 限流了就别再连环请求
      }
    }
    return { items: [] };
  };

  const attempts = buildAttempts(cfg, plan);
  const reachable = () => (okHosts.length ? Array.from(new Set(okHosts)) : hosts);

  for (let i = 0; i < attempts.length; i++) {
    if (budget <= 0 || rateLimited) break;
    const a = attempts[i];
    // 前两次（上次档位 / 严格）两个源都试；之后只在连通的那个源上放宽
    const hostList = i <= 1 ? hosts : reachable();
    const r = await call(a.cfg, a.useTags, hostList);
    if (r.items.length) {
      return {
        items: r.items, fresh: r.fresh, host: r.host, ok: true,
        meta: r.meta,
        plan: sameMeta(r.meta, strictMeta(cfg)) ? null : r.meta
      };
    }
  }
  // 只要有源正常回过（哪怕 0 条），就不算失败；偶发超时不该让整个组件显示「加载失败」
  if (lastErr && (okHosts.length === 0 || rateLimited)) throw lastErr;
  return { items: [], fresh: [], stale: stalePool, ok: false, meta: null, plan: null };
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

function normalize(list, host, meta) {
  const m = meta || { sc: 0, pd: 0, rl: 0, tf: 0 };
  return list.map(p => {
    const sample = p.sample_url || '';
    const sampleW = Number(p.sample_width) || Number(p.width) || 0;
    const sampleH = Number(p.sample_height) || Number(p.height) || 0;
    const sampleSize = Number(p.sample_file_size) || 0;
    return {
      id: p.id,
      site: host,
      page: 'https://' + (SITE_DOMAIN[host] || 'yande.re') + '/post/show/' + p.id,
      file: p.file_url || '',
      sample: sample,          // 不用 file_url 兜底：yande 的 /image/ 原图未登录会被 307 回图片页
      sampleW,
      sampleH,
      sampleSize: sampleSize || Number(p.file_size) || 0,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      rating: p.rating || '',
      created: Number(p.created_at) || 0,
      score: Number(p.score) || 0,
      md5: p.md5 || '',
      creator: p.creator_id || p.author || '',
      parent: p.parent_id || 0,
      srcKey: (() => {
        const m = String(p.source || '').match(/pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i);
        return m ? 'p' + m[1] : '';
      })(),
      // 跨站去重键：同一张画在两站 md5 相同，用它当历史/坏图的 key
      uid: (p.md5 ? 'm' + p.md5 : 'i' + host + '_' + p.id),
      tags: p.tags || '',
      meta: m            // 这批图是按哪个档位抓来的（sc=评分下限 / pd=时段天数 / rl=画幅退回粗分档 / tf=丢了标签）
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
function hitsExclude(tags, segExcludes, exactExcludes) {
  const tokens = String(tags || '').toLowerCase().split(' ').filter(Boolean);
  if (!tokens.length) return false;
  for (let i = 0; i < exactExcludes.length; i++) {
    if (tokens.indexOf(exactExcludes[i]) >= 0) return true;
  }
  for (let i = 0; i < segExcludes.length; i++) {
    const kw = segExcludes[i];
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
  if ((cfg.excludeSeg.length || cfg.excludeExact.length) && hitsExclude(it.tags, cfg.excludeSeg, cfg.excludeExact)) return false;
  if (cfg.ratioMode === 'band') {
    const ar2 = it.sampleW && it.sampleH ? it.sampleW / it.sampleH : 0;
    if (ar2 && (ar2 < cfg.bandLo || ar2 >= cfg.bandHi)) return false;
  }
  const shortSide = Math.min(it.sampleW || 0, it.sampleH || 0);
  if (shortSide && shortSide < cfg.minW * 0.6) return false;   // 太小的直接跳过
  if (it.sampleSize && it.sampleSize / 1024 > HARD_LIMIT_KB) return false;
  if (cfg.minScore > 0 && (it.score || 0) < cfg.minScore) return false;   // 最低评分
  if (cfg.matureAt && it.created && it.created * 1000 > cfg.matureAt) return false;   // 成熟期兜底

  return true;
}

/* ============================ 选图 ============================ */

// 把「最近 N 天」展开成自然月列表（倒序），用于时段切块
function monthKeys(days) {
  const out = [];
  const now = new Date();
  const oldest = new Date(Date.now() - Math.max(1, days) * 86400000);
  let y = now.getFullYear(), m = now.getMonth();
  for (let i = 0; i < 400; i++) {
    if (y < oldest.getFullYear() || (y === oldest.getFullYear() && m < oldest.getMonth())) break;
    out.push(y + '-' + String(m + 1).padStart(2, '0'));
    m--; if (m < 0) { m = 11; y--; }
  }
  return out;
}

function monthRange(key) {
  const parts = String(key).split('-');
  const y = Number(parts[0]), m = Number(parts[1]);
  const last = new Date(y, m, 0).getDate();
  return { from: key + '-01', to: key + '-' + String(last).padStart(2, '0') };
}

// 机会式预补货：在「本来命中缓存、秒回」的那次渲染里，顺手把袋子补一点。
// 显示的还是旧图，用户无感；等到真该换图时，袋里已有货，只剩下载这一步。
async function prefetchBag(ctx, cfg, sig) {
  try {
    const bag = readJSON(ctx, K.bag) || {};
    if (bag.sig !== sig) return;
    const size = cfg.bagSize || 50;
    if (Array.isArray(bag.items) && bag.items.length >= Math.max(8, Math.floor(size / 2))) return;

    const badSet = new Set(Object.keys(readBad(ctx)));
    const historySet = new Set((readJSON(ctx, K.history) || []).map(String));
    let c = cfg;
    if (cfg.monthSlice && cfg.periodDays > 0 && !bag.noMonth) {
      const months = (Array.isArray(bag.months) && bag.months.length) ? bag.months : shuffleArr(monthKeys(cfg.periodDays));
      while (months.length && !clipMonthRange(cfg, monthRange(months[0]))) months.shift();   // 跳过被成熟期吃掉的月份
      const mk = months[0];
      const rg = mk ? clipMonthRange(cfg, monthRange(mk)) : null;
      if (rg) {
        c = Object.assign({}, cfg, { dateFilter: 'date:' + rg.from + '..' + rg.to, monthLock: true });
        bag.months = months;
        bag.lastMonth = mk;
      } else {
        bag.months = [];
      }
    }
    const page = isRandomLike(cfg)
      ? (c.dateFilter && cfg.site === 'yande' ? 1 + Math.floor(Math.random() * pageCapFor(c)) : 1 + Math.floor(Math.random() * 3))
      : Math.max(1, pool_page(bag, pageCapFor(c)));

    const res = await search(ctx, c, page, bag.plan, badSet, historySet, null);
    if (!res.ok || !res.items.length) return;
    const add = dedupeVariants(res.items, cfg.variantDedupe, cfg.artistDedupe);
    const have = new Set((bag.items || []).map(it => String(it.uid)));
    const merged = (bag.items || []).concat(add.filter(it => !have.has(String(it.uid))));
    bag.items = (cfg.weighted ? weightedShuffle(merged, cfg.weightK) : shuffleArr(merged)).slice(0, size);
    bag.plan = res.plan || bag.plan || null;
    bag.sig = sig;
    writeJSON(ctx, K.bag, bag);
  } catch (e) { /* 预补货失败不影响本次渲染 */ }
}

function pool_page(bag, cap) {
  const n = Number((bag && bag.page) || 1) || 1;
  const c = cap || 10;
  return n >= c ? 1 : n + 1;
}

// 同一个画师常一次上传一整套（草稿/差分/裁切），md5 不同但看起来一样。
// 这里按「同 pixiv 作品 / 父子变体 / 同画师」三道筛，一袋里每个画师最多留 1 张。
function dedupeVariants(list, doVariant, doArtist) {
  const srcSeen = {};
  const artistSeen = {};
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (doVariant) {
      if (it.parent) continue;                    // 子图（同一张画的变体）直接跳过
      if (it.srcKey) {
        if (srcSeen[it.srcKey]) continue;         // 同一 pixiv 作品只留一张
        srcSeen[it.srcKey] = 1;
      }
    }
    if (doArtist) {
      const who = String(it.creator || '');
      if (who) {
        if (artistSeen[who]) continue;             // 一袋里每个画师最多 1 张
        artistSeen[who] = 1;
      }
    }
    out.push(it);
  }
  return out;
}

// Fisher-Yates 洗牌
// 加权洗牌（Efraimidis–Spirakis）：每张按 w=(score+1)^k 生成 key，取 key 最大的排前面。
// 等效「不放回按权重抽样」：高分更容易靠前，低分不会消失，池子大小不变。
function weightedShuffle(arr, k) {
  const kk = Number.isFinite(k) ? k : 0.4;
  return arr
    .map(it => {
      const w = Math.pow(Math.max(0, Number(it.score) || 0) + 1, kk);
      return { it, key: Math.pow(Math.random(), 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map(x => x.it);
}

function shuffleArr(arr) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ============================ 下载 ============================ */

async function download(ctx, url, cfg, referer) {
  // 只补裸空格/非 ASCII，不做 decodeURI→encodeURI：
  // 那一步会把 %28 %29（括号）、%21（!）解成字面量，yande 的图床就认不出文件、307 跳回图片页
  const safeUrl = String(url || '').trim()
    .replace(/ /g, '%20')
    .replace(/[^\x21-\x7e]+/g, m => encodeURIComponent(m));
  let resp;
  try {
    resp = await ctx.http.get(safeUrl, {
      headers: { 'Referer': referer || 'https://yande.re/', 'User-Agent': IMG_UA },
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
  if (bytes[0] === 0x3c) {          // '<' → 被重定向到图片页/风控页，多半是限流，不是这张图坏了
    const e = new Error('图床限流了，稍后重试');
    e.status = 0;
    e.transient = true;
    throw e;
  }
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
    // 放宽角标只放在调试行（开着 DEBUG 才显示），封面保持干净
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
        + (entry.recycled ? ' 库尽轮换' : '')
        + (entry.cacheFailed ? ' 缓存写入失败' : '')
        + `${entry.tagFallback ? ' ⚠标签' : ''}${entry.periodRelaxed ? ' ⚠时段' : ''}${entry.scoreRelaxed ? ' ⚠评分' + entry.score + '<' + entry.scoreCfg : ''}${entry.ratioRelaxed ? ' ⚠画幅' : ''}`
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
  // 只加了锁屏组件时，小/中号桌面组件可能是空的 → 四个尺寸的缓存挨个找一遍
  const cached = Object.keys(RATIO_BY_FAMILY)
    .map(f => readJSON(ctx, K.cache + f))
    .find(c => c && c.dataUri) || null;
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
    return true;
  } catch (e) {
    return false;      // 比如单张图 base64 太大写不进去，要能看出来
  }
}

// 下不下来的图（重定向到 HTML、404 之类）：记 7 天，别每次刷新都拿它试 3 遍
function readBad(ctx) {
  const o = readJSON(ctx, K.bad) || {};
  const now = Date.now();
  const out = {};
  Object.keys(o).forEach(k => { if (now - (Number(o[k]) || 0) < 7 * 86400000) out[k] = o[k]; });
  return out;
}

function markBad(ctx, id) {
  const o = readBad(ctx);
  o[String(id)] = Date.now();
  writeJSON(ctx, K.bad, o);
}


