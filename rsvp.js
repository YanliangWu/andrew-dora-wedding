/* 主页内嵌的「回复出席」面板 —— 名字 + 3 题（来不来 / 几位 / 过敏忌口），不跳转。
 *
 * 数据流：本页 fetch → 同域 <data-api> → Cloudflare Pages Function
 *         (functions/api/rsvp.js) → **本项目自带的 Cloudflare D1**（表 rsvp）。
 *         2026-09-24 之前写的是飞书多维表格，那条路需要「企业自建应用」凭据
 *         （而绕开它的 webhook 自动化要付费套餐），已换掉。见函数里的长注释。
 *
 * 为什么不直接跳飞书表单了：主人要的是"主页上点一下就能回"，跳转那一步会流失人。
 *
 * ⚠️ 端点用相对路径，写在 HTML 的 data-api 上（zh 是 api/rsvp，en 是 ../api/rsvp）。
 *    也可以在 JS 里按 location.pathname 判断，但那样一旦 URL 形态变化（哈希跳页 #p=4
 *    之类）就更容易算错，写死在各自页面里最稳。
 *
 * ⚠️ 后端不在的两种情形都由**预检**兜住（打开面板时先 GET 一下）：
 *    ① GitHub Pages 那份镜像站没有 Functions；② 线上真出故障。
 *    预检不通就整块换成飞书表单入口，并把姓名/编号 prefill 过去 ——
 *    **不让宾客填完三题才发现发不出去**（2026-09-24 有宾客就是这么被坑的）。
 *
 * ⚠️ 文案不写在这里，全部从 #rsvp-sheet 的 data-* 读（{name} / {party} 是占位符），
 *    这样中英共用一个脚本，改文案只改 HTML。
 *
 * ⚠️ 2026-09-24：面板上**不再有「邀请编号」输入框**。那道题只在链接没带 ?c= 时才会
 *    露出来（转发给别人 / 从裸域名进），而那种情况下宾客根本不知道自己的编号 ——
 *    问了也白问，还把他挡在提交之外。编号改成**只从专属链接静默读**：有 ?c= 就随
 *    请求带上（主人侧照样精确对账），没有就不带，服务端按姓名兜底认领。
 */
(function () {
  'use strict';

  var sheet = document.getElementById('rsvp-sheet');
  var trigger = document.getElementById('rsvp-btn');
  if (!sheet || !trigger) return;          // 只有主页有这块，别的页静默退出

  var form = document.getElementById('rsvp-form');
  var doneBox = document.getElementById('rsvp-done');
  var doneTitle = document.getElementById('rsvp-done-title');
  var doneSub = document.getElementById('rsvp-done-sub');
  var hi = document.getElementById('rsvp-hi');
  var note = document.getElementById('rsvp-note');
  var sendBtn = document.getElementById('rsvp-send');
  var partyWrap = document.getElementById('rsvp-party-wrap');
  var partyOut = document.getElementById('rsvp-party');
  var allergy = document.getElementById('rsvp-allergy');
  var nameInput = document.getElementById('rsvp-name');
  var offBox = document.getElementById('rsvp-off');
  var offT = document.getElementById('rsvp-off-t');
  var offS = document.getElementById('rsvp-off-s');
  var offA = document.getElementById('rsvp-off-a');
  if (!form || !sendBtn) return;

  var D = sheet.dataset;
  var SEND_LABEL = sendBtn.textContent;
  var MAX_PARTY = 8;
  var KEY = 'andrew-dora-rsvp';

  /* ---------------------------------------------------------- 身份
     专属链接形如 /?c=01&n=张三：c 是邀请编号，**不再问宾客**，只从链接静默读 ——
     有就随请求带上（主人侧按编号精确对账），没有就不带（服务端按姓名兜底认领）。
     n 预填进「你的名字」输入框，但只是**预填**，宾客可以改（改名、写英文名、
     替家人报名都会发生），提交时以输入框里的值为准。两者都不做校验 ——
     这是婚礼请柬，不是登录系统。 */
  var qs = new URLSearchParams(location.search);
  var code = (qs.get('c') || '').trim();
  var guest = (qs.get('n') || '').trim();

  if (guest) nameInput.value = guest;       // 预填，不是只读

  /* 问候语跟着名字框走，而不是钉死在链接参数上：宾客把名字改掉以后（或者裸链接
     自己打字），顶上那行也要跟着变 —— 否则会出现"欢迎张伟 / 记录成李娜"的错位。
     没有名字时退回匿名版文案。 */
  function syncHi() {
    var who = nameInput.value.trim();
    hi.textContent = who ? (D.hi || '').replace('{name}', who) : (D.hiAnon || '');
  }
  nameInput.addEventListener('input', syncHi);
  syncHi();                                 // 首次渲染：预填的名字 / 匿名版

  /* ---------------------------------------------------------- 人数步进 */
  function party() { return parseInt(partyOut.textContent, 10) || 1; }

  function setParty(n) {
    n = Math.max(1, Math.min(MAX_PARTY, n));
    partyOut.textContent = String(n);
    var btns = form.querySelectorAll('.step');
    if (btns[0]) btns[0].disabled = n <= 1;
    if (btns[1]) btns[1].disabled = n >= MAX_PARTY;
  }

  Array.prototype.forEach.call(form.querySelectorAll('.step'), function (b) {
    b.addEventListener('click', function () {
      setParty(party() + parseInt(b.dataset.step, 10));
    });
  });

  function picked() {
    var r = form.querySelector('input[name="attend"]:checked');
    return r ? r.value : '';
  }

  Array.prototype.forEach.call(
    form.querySelectorAll('input[name="attend"]'),
    function (r) {
      r.addEventListener('change', function () {
        // 「来不了」时人数没有意义，直接收起这一题
        partyWrap.hidden = picked() !== 'yes';
      });
    });

  /* ---------------------------------------------------------- 兜底 / 预检
     后端不在的时候（GitHub Pages 那份镜像站没有 Functions；或者线上出故障），
     **不能等宾客填完三题才告诉他发不出去** —— 2026-09-24 就是这么坑到人的。
     所以打开面板时先探一下 GET /api/rsvp：不通就整块换成飞书表单入口。

     顺带把姓名/编号用 prefill_ 带过去：飞书表单的预填参数认的是**题目名**
     （中英两版题目名不同），所以题目名写在各自页面的 data-fallback-name /
     data-fallback-code 上。这样兜底进来的回复也认得是谁。 */
  var backendOk = null;                     // null 未知 / true 通 / false 不通

  function fallbackUrl() {
    var url = D.fallback || '';
    if (!url) return '#';
    var pairs = [];
    var who = nameInput.value.trim() || guest;
    if (D.fallbackName && who) pairs.push(['prefill_' + D.fallbackName, who]);
    if (D.fallbackCode && code) pairs.push(['prefill_' + D.fallbackCode, code]);
    if (!pairs.length) return url;
    return url + (url.indexOf('?') < 0 ? '?' : '&') +
      pairs.map(function (p) {
        return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
      }).join('&');
  }

  function showOffline(msg) {
    offT.textContent = D.offTitle || '';
    offS.textContent = msg || D.offSub || '';
    offA.textContent = D.offCta || '';
    offA.href = fallbackUrl();
    form.hidden = true;
    doneBox.hidden = true;
    offBox.hidden = false;
  }

  function preflight() {
    if (backendOk !== null) return;
    fetch(D.api, { method: 'GET', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      /* 判据是"这个后端在不在"，不是"它现在好不好"：
         表还没建（还没人提交过）也算在 —— 第一次提交会自愈建表。 */
      .then(function (d) {
        backendOk = Boolean(d && d.store === 'd1' && d.bound !== false);
        if (!backendOk && !sheet.hidden) showOffline();
      })
      .catch(function () {
        backendOk = false;
        if (!sheet.hidden) showOffline();
      });
  }

  /* ---------------------------------------------------------- 开关 */
  var sending = false;

  function open() {
    // 每次都回到"可填"状态：上一轮可能停成功态，或者卡在"发送中"
    form.hidden = false;
    doneBox.hidden = true;
    offBox.hidden = true;
    sending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = SEND_LABEL;
    note.textContent = '';

    restore();
    sheet.hidden = false;
    requestAnimationFrame(function () { sheet.classList.add('on'); });
    document.documentElement.classList.add('rsvp-open');

    if (backendOk === false) showOffline();     // 已知不通，直接给表单入口
    else preflight();
  }

  function close() {
    sheet.classList.remove('on');
    document.documentElement.classList.remove('rsvp-open');
    // 等淡出动画走完再真正隐藏，否则会闪一下
    setTimeout(function () { sheet.hidden = true; }, 240);
  }

  trigger.addEventListener('click', open);
  Array.prototype.forEach.call(sheet.querySelectorAll('[data-rsvp-close]'),
    function (el) { el.addEventListener('click', close); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) close();
  });

  /* ---------------------------------------------------------- 回填上次的答案
     localStorage 只是体验优化（改主意时不用从头点）。真正的"改回复"靠服务端
     按「邀请编号优先、姓名兜底」upsert，所以清掉本地记录也不会产生重复行。 */
  function restore() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (err) {}
    if (!saved || typeof saved !== 'object') { setParty(1); return; }

    if (saved.attend === 'yes' || saved.attend === 'no') {
      var r = form.querySelector('input[name="attend"][value="' + saved.attend + '"]');
      if (r) r.checked = true;
    }
    partyWrap.hidden = saved.attend !== 'yes';
    setParty(saved.party || 1);
    if (saved.allergy) allergy.value = saved.allergy;
    /* 名字回填的优先级：
       1) 上次就是从**同一条邀请链接**提交的 → 用他上次写的名字，盖掉链接里的 ?n=。
          否则会出这种事：宾客第一次把名字写成"张伟 & 李娜"提交，第二次点开自己的
          链接（?n= 还是"张伟"）再提交 → 服务端按编号找到的是"张伟 & 李娜"那行、
          姓名对不上，只能当成"别人用转发链接进来"，凭空多出一行没编号的记录。
       2) 不是同一条链接（或本机没记录）→ 只在框空着时回填 ?n=。 */
    var sameInvite = saved.code === (code || '');
    if (sameInvite && saved.name) nameInput.value = saved.name;
    else if (!nameInput.value.trim() && saved.name) nameInput.value = saved.name;
    syncHi();
  }

  /* ---------------------------------------------------------- 提交 */
  function showDone(p) {
    var yes = p.attend === 'yes';
    doneTitle.textContent = (yes ? D.okYes : D.okNo) || '';
    doneSub.textContent = yes
      ? (D.okYesSub || '').replace('{party}', p.party)
      : (D.okNoSub || '');
    doneSub.hidden = !doneSub.textContent;
    form.hidden = true;
    doneBox.hidden = false;
  }

  function showError() {
    note.textContent = '';
    note.appendChild(document.createTextNode((D.err || '') + ' '));
    var a = document.createElement('a');
    a.href = fallbackUrl();       // 带上 prefill_，兜底进来的回复也认得是谁
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = D.errAlt || '';
    note.appendChild(a);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;

    // 按题目在屏幕上的顺序校验：名字 → 来不来（编号已不是题目，只从链接静默读）
    var finalName = nameInput.value.trim();
    if (!finalName) {
      note.textContent = D.needName || '';
      nameInput.focus();
      return;
    }

    var attend = picked();
    if (!attend) { note.textContent = D.needAttend || ''; return; }

    var payload = {
      code: code,               // 专属链接带来的编号；转发/裸域名进来时是空串
      name: finalName,
      attend: attend,
      party: attend === 'yes' ? party() : 0,
      allergy: allergy.value.trim()
    };

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = D.sending || SEND_LABEL;
    note.textContent = '';

    fetch(D.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'rejected');
        try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch (err) {}
        showDone(payload);            // 成功后表单整块换成答谢，sending 保持 true 无妨
      })
      .catch(function () {
        sending = false;
        sendBtn.disabled = false;
        sendBtn.textContent = SEND_LABEL;
        showError();
      });
  });

  setParty(1);   // 初始态：就算没开过面板，DOM 里也是合法值
})();
