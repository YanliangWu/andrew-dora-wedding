/**
 * /api/rsvp —— 主页「回复出席」面板的提交端点（存储 = 本项目自带的 Cloudflare D1）。
 *
 * ── 为什么不是飞书 ────────────────────────────────────────────────
 * 写飞书多维表格需要一个「企业自建应用」的身份（App ID / Secret）：要去开放平台
 * 建应用、开权限、**发布版本**、再把应用加成表格协作者，四步里漏一步就写不进去。
 * 绕开它的另一条路（表里的「接收到 webhook 时」自动化）**要付费套餐**。
 * 而 D1 是本项目自带的 SQLite（binding `DB`），免费额度 5GB / 每天 500 万行读、
 * 10 万行写 —— 48 位宾客的回复量在它面前等于零。没有第三方、没有凭据、没有套餐。
 *
 * ── 数据流 ──────────────────────────────────────────────────────
 *   主页面板 --POST--> 本函数 --D1--> 表 rsvp
 *   主人查看：rsvp-admin.html?key=<RSVP_ADMIN_KEY>   （列表 / 筛选 / 导 CSV）
 *   想回到飞书看：`python3 rsvp_pull.py`（仓库外）把新行推进「RSVP 管理」表，
 *                用的是你**已登录的飞书身份**，不需要建应用、不需要套餐。
 *
 * ── upsert 顺序（「邀请编号」不是宾客要填的题）─────────────────────
 *   1) 带了编号（专属链接的 ?c=）→ 按编号找，容忍前导零（01 = 1）
 *   2) 编号没命中、或压根没带 → 按姓名找（大小写 / 空格不敏感）
 *   3) 都没命中才新建
 *   这样宾客改主意（来→不来、人数变了）是**改行**不是**加行**；链接被转发、
 *   从裸域名进来（没有 ?c=）也认得到人，不至于每收一次回复就多一行。
 *
 *   ⚠️ 编号命中的那行**姓名对不上**时（= 专属链接被转给了别人），故意不覆盖原行：
 *      本次改写成"不带编号"另建一行。宁可多一行，也不能把 A 的回复改成 B 的。
 *      这是唯一会看起来"重复"的情况，靠编号列留空一眼可辨。
 *   ⚠️ 姓名匹配只是兜底，故意不做拼音 / 近似匹配 —— 错并到别人身上的代价，
 *      比多留一行大得多。
 *
 * ── 需要配的东西 ────────────────────────────────────────────────
 *   Deployment binding : D1 database, 变量名 `DB`   （./deploy-cf.sh --setup-d1 自动建）
 *   Environment var    : RSVP_ADMIN_KEY（查看/导出用的口令，只影响 GET/DELETE）
 *   POST 不需要任何配置就能用 —— 这是这次换存储的主要目的。
 */

const MAX_PARTY = 8;
const MAX_NAME = 60;
const MAX_ALLERGY = 200;

/* 表结构。放在代码里而不是只放在部署脚本里：本地 `wrangler pages dev` 和线上
   首次提交都能自愈建表，省掉"忘了跑 migrate"这一类问题。DDL 是幂等的。

   ⚠️ 必须**一条一条**执行，不能用 `env.DB.exec(多语句字符串)`：exec 的语句切分
   在 workerd 里是按换行切的（不是只按分号），多行的 CREATE TABLE 会被腰斩成
   `CREATE TABLE IF NOT EXISTS rsvp (` 然后报 "incomplete input: SQLITE_ERROR"。 */
const SCHEMA = [`
CREATE TABLE IF NOT EXISTS rsvp (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT,              -- 邀请编号原文（专属链接的 ?c=），转发进来为 NULL
  code_key   TEXT,              -- 归一化编号（去前导零），只用于匹配
  name       TEXT NOT NULL,     -- 宾客在面板里写的名字
  name_key   TEXT NOT NULL,     -- 归一化姓名（小写、去空白），只用于匹配
  attend     TEXT NOT NULL,     -- 'yes' | 'no'
  party      INTEGER NOT NULL,  -- 总人数（含本人）；不来记 0
  plus       INTEGER NOT NULL,  -- 陪同人数 = party - 1
  allergy    TEXT,              -- 过敏 / 忌口；宾客留空则保留上次的值
  at         INTEGER NOT NULL,  -- 宾客提交时间（毫秒）
  updated_at INTEGER NOT NULL,  -- 最近一次写入（改主意会变新）
  source     TEXT,              -- 'zh' | 'en'（从 Referer 推断）
  ua         TEXT               -- UA 前 120 字，排障用
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_rsvp_code_key
     ON rsvp(code_key) WHERE code_key IS NOT NULL AND code_key <> '';`,
  `CREATE INDEX IF NOT EXISTS ix_rsvp_name_key ON rsvp(name_key);`,
  `CREATE INDEX IF NOT EXISTS ix_rsvp_updated ON rsvp(updated_at);`
];

/* ---------------------------------------------------------------- 小工具 */

function json(body, status, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}

function str(v) { return v == null ? '' : String(v); }

/* 编号归一化：`01` 与 `1` 视为同一个人（专属链接里是补零的两位）。 */
function normCode(v) {
  const x = str(v).trim();
  if (!x) return '';
  return /^\d+$/.test(x) ? String(Number(x)) : x;
}

/* 姓名归一化：只在"没有编号"时用来认领已有记录，所以容忍大小写与空格差异。 */
function normName(v) {
  return str(v).trim().toLowerCase().replace(/[\s\u3000]+/g, '');
}

/* 口令比较：长度先比、内容逐字符异或，避免按字符提前返回。 */
function sameSecret(a, b) {
  const x = str(a), y = str(b);
  if (!x || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* 极轻量的内存限流：同一个 isolate 内按 IP 计数。对"某个人的浏览器卡住疯狂重试"
   足够，对分布式攻击无效 —— 这是婚礼请柬，够用了，真实防线是字段长度 + 唯一索引。
   默认每分钟 30 次：单个宾客根本用不到 2 次，但移动网络的 CGNAT 后面可能
   同时坐着好几个人，别把正常的第二个人一起挡了。可用 RSVP_RATE_MAX 覆盖
   （本地测试要连打几十个请求，就得把它调大）。 */
const HITS = new Map();
function rateLimited(ip, cap) {
  if (!ip) return false;
  const now = Date.now();
  const rec = HITS.get(ip);
  if (!rec || now - rec.t0 > 60000) { HITS.set(ip, { t0: now, n: 1 }); return false; }
  rec.n += 1;
  if (HITS.size > 500) HITS.clear();          // 别让它长成内存泄漏
  return rec.n > cap;
}

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    /* 逐条 prepare().run()：DDL 是幂等的，重复跑没有副作用。
       失败就重置，下次请求再试（部署顺序错、瞬时故障都能自愈）。 */
    schemaReady = (async function () {
      for (const sql of SCHEMA) await env.DB.prepare(sql).run();
      return true;
    })().catch(function (err) {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/* ---------------------------------------------------------------- POST */

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) {
    /* 没绑 D1 → 说清楚，别让宾客看到"请检查网络"这种假线索。 */
    return json({
      ok: false,
      error: 'store_unavailable',
      hint: 'D1 binding `DB` 未配置，跑一次 ./deploy-cf.sh --setup-d1'
    }, 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const rateCap = parseInt(env.RSVP_RATE_MAX, 10);
  if (rateLimited(ip, Number.isFinite(rateCap) && rateCap > 0 ? rateCap : 30)) {
    return json({ ok: false, error: 'too_many_requests' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const code = str(body.code).trim().slice(0, 16);
  const guest = str(body.name).trim().slice(0, MAX_NAME);
  const allergy = str(body.allergy).trim().slice(0, MAX_ALLERGY);
  const attend = str(body.attend).trim();
  let party = parseInt(body.party, 10);
  if (!Number.isFinite(party) || party < 0) party = 0;
  if (party > MAX_PARTY) party = MAX_PARTY;

  /* 编号不再是宾客填的题（2026-09-24 起），只可能来自专属链接的 ?c=；
     转发链接 / 裸域名进来的就是空 —— 那种情况靠姓名认人，所以两者不能都空。 */
  if (!code && !guest) return json({ ok: false, error: '缺少邀请编号和姓名' }, 400);
  if (attend !== 'yes' && attend !== 'no') {
    return json({ ok: false, error: 'attend 只能是 yes 或 no' }, 400);
  }

  const yes = attend === 'yes';
  if (yes && party < 1) party = 1;            // 说来但人数为 0 → 按 1 位算
  if (!yes) party = 0;

  const now = Date.now();
  const codeKey = normCode(code);
  const nameKey = normName(guest);
  const referer = request.headers.get('Referer') || '';
  const source = /\/en\//.test(referer) ? 'en' : 'zh';
  const ua = str(request.headers.get('User-Agent')).slice(0, 120);

  try {
    await ensureSchema(env);

    /* ---- 找已有记录：编号优先 → 姓名兜底（一次查完，别来回打 D1） ---- */
    let target = null;          // {id, code_key, name_key}
    let codeOwner = null;       // 编号命中的那行（可能姓名对不上）
    let dropCode = false;       // 本次是否"故意不写编号"

    if (codeKey) {
      codeOwner = await env.DB
        .prepare('SELECT id, code_key, name_key FROM rsvp WHERE code_key = ?1 LIMIT 1')
        .bind(codeKey).first();
    }
    if (codeOwner && nameKey && codeOwner.name_key !== nameKey) {
      /* 链接被转发给别人了：编号是原主人的。不覆盖原行，本次当"无编号"处理。
         ⚠️ 这里必须真的把编号丢掉再 INSERT —— 否则会撞 code_key 唯一索引
            （宁可多留一行，也不能把 A 的回复改成 B 的）。 */
      dropCode = true;
    } else {
      target = codeOwner || null;
    }

    if (!target && nameKey) {
      target = await env.DB
        .prepare('SELECT id, code_key, name_key FROM rsvp WHERE name_key = ?1 ORDER BY updated_at DESC LIMIT 1')
        .bind(nameKey).first();
    }

    if (target) {
      /* 改行。过敏留空时保留原值（二次提交空着不该把已收到的忌口抹掉）；
         编号只在"原来没有、这次有"时补上（认领），不覆盖已有的。
         ⚠️ dropCode 时**不许认领** —— 那个编号是原主人的，写上去会撞唯一索引。 */
      const claimCode = (!dropCode && codeKey && !target.code_key) ? codeKey : null;
      const claimCodeRaw = claimCode ? code : null;
      await env.DB.prepare(
        `UPDATE rsvp SET
           code       = COALESCE(?1, code),
           code_key   = COALESCE(?2, code_key),
           name       = ?3,
           name_key   = ?4,
           attend     = ?5,
           party      = ?6,
           plus       = ?7,
           allergy    = COALESCE(NULLIF(?8, ''), allergy),
           updated_at = ?9,
           source     = ?10,
           ua         = ?11
         WHERE id = ?12`
      ).bind(claimCodeRaw, claimCode, guest, nameKey, attend,
        yes ? party : 0, yes ? Math.max(0, party - 1) : 0,
        allergy, now, source, ua, target.id).run();

      return json({
        ok: true, updated: true, party: yes ? party : 0, attend: attend,
        claimedCode: Boolean(claimCode)
      });
    }

    /* ---- 新建 ---- */
    const insertCode = dropCode ? null : (code || null);
    const insertCodeKey = dropCode ? null : (codeKey || null);
    await env.DB.prepare(
      `INSERT INTO rsvp
         (code, code_key, name, name_key, attend, party, plus, allergy, at, updated_at, source, ua)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULLIF(?8, ''), ?9, ?9, ?10, ?11)`
    ).bind(insertCode, insertCodeKey, guest, nameKey, attend,
      yes ? party : 0, yes ? Math.max(0, party - 1) : 0,
      allergy, now, source, ua).run();

    return json({
      ok: true, updated: false, party: yes ? party : 0, attend: attend,
      codeLess: !insertCodeKey,
      forwarded: dropCode || undefined      // 说明"这行的编号被摘掉了，因为链接不是他的"
    });

  } catch (err) {
    /* 打给 Pages 的 Functions 日志（控制台 → 项目 → 函数日志，
       或 `wrangler pages deployment tail`）。宾客那头只看到一句人话 + 兜底链接，
       具体原因得靠这行，否则出问题只能靠猜。 */
    console.error('rsvp 写入失败', {
      code: code, attend: attend, party: party,
      message: String(err && err.message || err)
    });
    return json({
      ok: false,
      error: 'store_failed',
      detail: String(err && err.message || err)
    }, 500);
  }
}

/* ---------------------------------------------------------------- GET
   · 不带 key  → 健康检查（有没有绑 DB、表建好没、收了多少条）
   · 带 key    → 数据。?format=csv 导出，?since=<ms> 只取增量（喂给同步脚本）
   健康检查不泄露任何回复内容；数据接口要口令，口令没配就直接拒绝。 */

function csvCell(v) {
  const s = str(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const head = ['邀请编号', '宾客姓名', '是否出席', '总人数（含本人）', '陪同人数',
    '过敏 / 忌口', '回复时间', '最近更新', '来源'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.code ? String(r.code).padStart(2, '0') : '',
      r.name,
      r.attend === 'yes' ? '出席' : '不出席',
      r.party,
      r.plus,
      r.allergy || '',
      new Date(r.at).toISOString(),
      new Date(r.updated_at).toISOString(),
      r.source || ''
    ].map(csvCell).join(','));
  }
  /* BOM：否则 Excel 打开中文是乱码 */
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!env.DB) {
    return json({
      ok: false, store: 'd1', bound: false,
      hint: 'D1 binding `DB` 未配置，跑一次 ./deploy-cf.sh --setup-d1'
    }, 503);
  }

  const admin = Boolean(env.RSVP_ADMIN_KEY) && sameSecret(key, env.RSVP_ADMIN_KEY);

  if (!admin) {
    /* 健康检查：只回统计，不回内容。
       ⚠️ 「表还不存在」**不是故障** —— 表会在第一次 POST 时自愈建出来。
       早先这里把它当成 ok:false，结果刚配好的站点在第一个宾客提交之前，
       前端预检会误判成"后端坏了"，把人直接推到飞书表单去。
       所以 ok 只表示"后端在"，表有没有单独用 table 字段说。 */
    const out = { ok: true, store: 'd1', bound: true, admin: false, table: true };
    try {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rsvp').first();
      out.total = (row && row.n) || 0;
    } catch (err) {
      out.table = false;
      out.total = 0;
    }
    return json(out);
  }

  try {
    const since = parseInt(url.searchParams.get('since'), 10);
    const sql = Number.isFinite(since) && since > 0
      ? 'SELECT * FROM rsvp WHERE updated_at > ?1 ORDER BY updated_at ASC'
      : 'SELECT * FROM rsvp ORDER BY (code IS NULL), CAST(code AS INTEGER), updated_at DESC';
    const stmt = env.DB.prepare(sql);
    const res = Number.isFinite(since) && since > 0
      ? await stmt.bind(since).all()
      : await stmt.all();
    const rows = (res && res.results) || [];

    if ((url.searchParams.get('format') || '') === 'csv') {
      return new Response(toCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="rsvp.csv"',
          'Cache-Control': 'no-store'
        }
      });
    }

    return json({ ok: true, admin: true, count: rows.length, rows: rows });
  } catch (err) {
    const msg = String(err && err.message || err);
    /* 还没人提交过 → 表还不存在。这不是错误，给空列表就行，
       否则主人第一次打开后台页会先看到一片红。 */
    if (/no such table/i.test(msg)) {
      if ((url.searchParams.get('format') || '') === 'csv') {
        return new Response(toCsv([]), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="rsvp.csv"',
            'Cache-Control': 'no-store'
          }
        });
      }
      return json({ ok: true, admin: true, count: 0, rows: [], note: '还没有人回复' });
    }
    return json({ ok: false, error: msg }, 500);
  }
}

/* ---------------------------------------------------------------- DELETE
   删掉一条（比如自己测试留下的）。需要口令；/api/* 已由 _routes.json 放行。 */
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.DB) return json({ ok: false, error: 'store_unavailable' }, 503);
  if (!env.RSVP_ADMIN_KEY || !sameSecret(url.searchParams.get('key') || '', env.RSVP_ADMIN_KEY)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const id = parseInt(url.searchParams.get('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: '缺少 id' }, 400);

  const res = await env.DB.prepare('DELETE FROM rsvp WHERE id = ?1').bind(id).run();
  return json({ ok: true, deleted: (res.meta && res.meta.changes) || 0 });
}
