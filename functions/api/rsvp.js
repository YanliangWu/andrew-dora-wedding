/**
 * POST /api/rsvp —— 主页「回复出席」面板的提交端点。
 *
 * 写进主人那张飞书多维表格「RSVP 管理」：
 *   base  KQgabWJAIaV7xKsf6wAcz0frnnc
 *   table tblZNTDaA9g2xpHV
 * 和飞书表单收到的是**同一张表**，所以站内回复与表单回复并排出现，统计不用两处合并。
 *
 * 按「邀请编号」做 upsert：先列出表里记录找同编号的，有就改、没有就建。
 * 这样宾客改主意（来→不来、人数变了）不会在表里留两行。
 * 表只有几十行，一次 GET（page_size 500）足够，也就不必去猜筛选操作符的方言。
 *
 * ── 需要配的东西 ────────────────────────────────────────────────
 * 1) Cloudflare Pages → Settings → Environment variables（Production，加密）：
 *      FEISHU_APP_ID / FEISHU_APP_SECRET
 * 2) 飞书开放平台建一个「企业自建应用」，权限至少开通：
 *      bitable:app   （多维表格的查看与编辑；想更细可以拆成
 *                      bitable:app:read + bitable:app:write）
 *    然后**必须发布一个版本**，不发布权限不生效（这一步最容易漏）。
 * 3) 打开那张多维表格 → 右上角「分享」→ 把应用加为协作者（可编辑）。
 *    只给权限不加协作者，飞书会回 permission denied。
 *
 * GET /api/rsvp —— 自检：凭据能不能换到 token、表能不能读、有多少行。
 * 配好之后先浏览器打开这个地址看一眼，比盲试快。
 */

const BASE = 'KQgabWJAIaV7xKsf6wAcz0frnnc';
const TABLE = 'tblZNTDaA9g2xpHV';

/* 字段名直接用中文名（飞书 API 两者都收），字段 ID 列在注释里备查。
   改名时这里要跟着改 —— 用 ID 更抗改名，但可读性差，
   这张表结构稳定，选可读性。 */
const F = {
  invite: '邀请编号',        // fldfhuLFfK  text
  guest: '宾客姓名',         // flddkaEBNH  text
  attend: '是否出席',        // fldaHsE5PS  select
  total: '总人数（含本人）',  // fldDru0q9V  number
  plus: '陪同人数',          // fldBJqRJUQ  number
  allergy: '过敏 / 忌口',     // fld9wBbudo  text
  repliedAt: '回复时间',      // fldmry0o3o  datetime
  result: 'RSVP 结果'        // fldykau0Rw  select
};

/* select 的选项名必须与表里一字不差，否则飞书会新建一个选项：
   ✅ 出席 Attending / ❌ 不出席 Unable to attend
   已确认出席 / 已确认不出席 */
const YES = '✅ 出席 Attending';
const NO = '❌ 不出席 Unable to attend';
const RESULT_YES = '已确认出席';
const RESULT_NO = '已确认不出席';

const FEISHU = 'https://open.feishu.cn/open-apis';
const MAX_PARTY = 8;

/* ---------------------------------------------------------------- 小工具 */

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function str(v) { return v == null ? '' : String(v); }

/* 邀请编号比较：容忍前导零差异（宾客手输时容易把 01 打成 1） */
function sameCode(a, b) {
  const x = str(a).trim(), y = str(b).trim();
  if (!x || !y) return false;
  return x === y || x.replace(/^0+/, '') === y.replace(/^0+/, '');
}

/* 模块级缓存：同一个 isolate 内复用 token。飞书 token 有效期 2 小时，
   提前 60 秒过期，避免边界上刚好用到失效的。 */
let cached = { token: '', until: 0 };

async function tenantToken(env) {
  const now = Date.now();
  if (cached.token && cached.until > now) return cached.token;

  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }

  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await res.json().catch(function () { return {}; });
  if (data.code !== 0) throw new Error(`取 token 失败：${data.code} ${data.msg || ''}`);
  cached = { token: data.tenant_access_token, until: now + (data.expire || 7200) * 1000 - 60000 };
  return cached.token;
}

async function feishu(env, method, path, body) {
  const token = await tenantToken(env);
  const res = await fetch(`${FEISHU}${path}`, {
    method: method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(function () { return {}; });
  if (data.code !== 0) {
    const err = new Error(
      `${data.code} ${data.msg || ''} @ ${method} ${path.split('?')[0]}`);
    err.feishuCode = data.code;
    throw err;
  }
  return data;
}

/* 表里 text 字段两种返回形态都见过：纯字符串，或 [{text:"..."}] 的分段数组 */
function cellText(v) {
  if (Array.isArray(v)) return v.map(function (x) { return x && x.text ? x.text : str(x); }).join('');
  return str(v);
}

/* 按邀请编号找已有记录，返回 record_id；没有就返回空串 */
async function findRecordId(env, code) {
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    let qs = `?page_size=500`;
    if (pageToken) qs += `&page_token=${encodeURIComponent(pageToken)}`;

    const data = await feishu(env, 'GET',
      `/bitable/v1/apps/${BASE}/tables/${TABLE}/records${qs}`);
    const items = (data.data && data.data.items) || [];

    for (const it of items) {
      if (sameCode(cellText(it.fields && it.fields[F.invite]), code)) return it.record_id;
    }

    const more = data.data && data.data.has_more;
    pageToken = (data.data && data.data.page_token) || '';
    if (!more || !pageToken) break;
  }
  return '';
}

/* ---------------------------------------------------------------- POST */

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const code = str(body.code).trim();
  const attend = str(body.attend).trim();
  const guest = str(body.name).trim();
  const allergy = str(body.allergy).trim().slice(0, 200);
  let party = parseInt(body.party, 10);
  if (!Number.isFinite(party) || party < 0) party = 0;
  if (party > MAX_PARTY) party = MAX_PARTY;

  if (!code) return json({ ok: false, error: '缺少邀请编号' }, 400);
  if (code.length > 16) return json({ ok: false, error: '邀请编号过长' }, 400);
  if (attend !== 'yes' && attend !== 'no') {
    return json({ ok: false, error: 'attend 只能是 yes 或 no' }, 400);
  }

  const yes = attend === 'yes';
  if (yes && party < 1) party = 1;          // 说来但人数为 0 → 按 1 位算
  if (!yes) party = 0;

  const fields = {};
  fields[F.invite] = code;
  fields[F.attend] = yes ? YES : NO;
  fields[F.result] = yes ? RESULT_YES : RESULT_NO;
  fields[F.total] = yes ? party : 0;
  fields[F.plus] = yes ? Math.max(0, party - 1) : 0;
  fields[F.repliedAt] = Date.now();          // bitable datetime 收毫秒时间戳
  if (guest) fields[F.guest] = guest;
  // 过敏只在有内容时写：宾客二次提交留空不该把已经收到的忌口抹掉
  if (allergy) fields[F.allergy] = allergy;

  try {
    const recordId = await findRecordId(env, code);

    if (recordId) {
      await feishu(env, 'PUT',
        `/bitable/v1/apps/${BASE}/tables/${TABLE}/records/${recordId}`,
        { fields: fields });
      return json({ ok: true, updated: true, party: party, attend: attend });
    }

    await feishu(env, 'POST',
      `/bitable/v1/apps/${BASE}/tables/${TABLE}/records`,
      { fields: fields });
    return json({ ok: true, updated: false, party: party, attend: attend });

  } catch (err) {
    // 不把 err 原文全抛给前端（可能带 path），但保留飞书错误码方便定位
    return json({
      ok: false,
      error: String(err && err.message || err),
      code: err && err.feishuCode
    }, 502);
  }
}

/* ---------------------------------------------------------------- GET 自检
   配好环境变量后直接浏览器打开 /api/rsvp：能换到 token、能读表、有多少行。
   不会回显任何密钥。 */
export async function onRequestGet(context) {
  const { env } = context;
  const out = {
    ok: true,
    hasCredentials: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET),
    token: false,
    readTable: false,
    base: BASE,
    table: TABLE
  };

  try {
    await tenantToken(env);
    out.token = true;
  } catch (err) {
    out.ok = false;
    out.tokenError = String(err && err.message || err);
    return json(out, 502);
  }

  try {
    const data = await feishu(env, 'GET',
      `/bitable/v1/apps/${BASE}/tables/${TABLE}/records?page_size=1`);
    out.readTable = true;
    out.total = data.data && data.data.total;
  } catch (err) {
    out.ok = false;
    out.readError = String(err && err.message || err);
    out.hint = '多半是应用没被加进这张表的协作者，或 bitable 权限没发布';
    return json(out, 502);
  }

  return json(out);
}
