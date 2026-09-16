/* 电子请柬卡 —— 解析专属链接参数，渲染卡面、签到二维码与钱包入口。
 *
 * 链接形态有两种（生成器输出第一种）：
 *   card.html?d=<base64url("姓名|称谓|桌号|席位数|pass序列号")>&l=zh
 *   card.html?n=陈大文&t=8&s=2&k=<serial>&l=zh      ← 手动调试用
 *
 * 二维码里放的是**本页完整链接**，所以签到时扫这个码 = 打开这位宾客的专属卡，
 * 工作人员一眼能看到姓名和席位，不需要任何后端。
 */
(function () {
  'use strict';

  var WALLET_API = 'https://api.walletwallet.dev';
  var AMAP = 'https://uri.amap.com/search?keyword=%E7%8F%A0%E6%B5%B7%E9%95%BF%E9%9A%86%E6%A8%AA%E7%90%B4%E6%B9%BE%E9%85%92%E5%BA%97&src=andrew-dora-wedding';
  var APPLE_MAPS = 'https://maps.apple.com/?q=Chimelong+Hengqin+Bay+Hotel';

  var I18N = {
    zh: {
      h1: '电子请柬卡', sub: '请出示此卡签到 · 可加入手机钱包',
      f_date: '日期', f_datev: '2026.11.14 周六',
      f_time: '时间', f_timev: '16:00 签到 · 16:30 户外仪式',
      f_venue: '地点', f_venuev: '珠海长隆横琴湾酒店 · 婚礼亭',
      f_guest: '宾客', f_table: '席位',
      qrcap: '签到时向工作人员出示此码', qrlink: '查看链接',
      nowhere1: '这张卡需要<b>专属链接</b>才能显示你的名字与席位。',
      nowhere2: '请从我们发给你的链接打开，或在 RSVP 后查收。',
      w_h: '加入手机钱包', w_apple: ' 添加到 Apple 钱包', w_google: '🤖 添加到 Google 钱包',
      w_lede: '加进钱包后，婚礼当天<b>快到婚礼亭时会自动在锁屏上弹出</b>，不用翻聊天记录找链接。',
      w_note: '<b>iPhone</b>：点「Apple 钱包」→ 打开文件即出现「添加」。<b>Android</b>：点「Google 钱包」。也可以直接<b>把本页添加到主屏幕</b>（浏览器分享菜单 → 添加到主屏幕），效果一样。',
      a_h: '当天要做的事', a_nav: '🧭 一键导航', a_map: '🍎 苹果地图',
      a_notice: '🧳 宾客须知', a_cal: '📅 加入日历',
      a_note: '还没定怎么来？「宾客须知」里有<b>坐船（中港城 / 港澳码头 → 九洲港）</b>和<b>开车走港珠澳大桥</b>两种推荐走法的完整攻略。',
      a_invite: '💌 打开请柬正页',
      foot: '♡  好久不见，婚礼见  ♡', back: '← 返回请柬',
      privacy: '此卡为你专属链接，请勿转发他人',
      tablefmt: function (t, s) {
        var out = t.indexOf('桌') >= 0 || /[A-Za-z]/.test(t) ? t : t + ' 号桌';
        if (s) out += ' · ' + s + ' 位';
        return out;
      }
    },
    en: {
      h1: 'Wedding Pass', sub: 'Show this card at check-in · Add it to your wallet',
      f_date: 'DATE', f_datev: 'Sat, 14 Nov 2026',
      f_time: 'TIME', f_timev: '16:00 arrival · 16:30 ceremony',
      f_venue: 'VENUE', f_venuev: 'Chimelong Hengqin Bay Hotel · Pavilion',
      f_guest: 'GUEST', f_table: 'SEAT',
      qrcap: 'Show this code at check-in', qrlink: 'Show link',
      nowhere1: 'This card needs your <b>personal link</b> to show your name and seat.',
      nowhere2: 'Please open it from the link we sent you, or after you RSVP.',
      w_h: 'Add to Wallet', w_apple: 'Add to Apple Wallet', w_google: '🤖 Add to Google Wallet',
      w_lede: 'Once it is in your wallet, the pass <b>pops up on your lock screen when you get near the venue</b> — no more digging through chat history.',
      w_note: '<b>iPhone</b>: tap “Apple Wallet”, then open the downloaded file and tap Add. <b>Android</b>: tap “Google Wallet”. You can also simply <b>add this page to your home screen</b> — it works the same way.',
      a_h: 'Quick actions', a_nav: '🧭 Navigate', a_map: '🍎 Apple Maps',
      a_notice: '🧳 Guest info', a_cal: '📅 Add to calendar',
      a_note: 'Not sure how to get here? The Guest Info page covers both recommended routes: <b>the ferry</b> (China Ferry Terminal / HK–Macau Ferry Terminal → Jiuzhou Port) and <b>driving across the HZMB bridge</b>.',
      a_invite: '💌 Open the invitation',
      foot: '♡  See you at the wedding  ♡', back: '← Back to invitation',
      privacy: 'This link is personal to you — please do not forward it',
      tablefmt: function (t, s) {
        var out = /^[0-9]+$/.test(t) ? 'Table ' + t : t;
        if (s) out += ' · ' + s + (String(s) === '1' ? ' seat' : ' seats');
        return out;
      }
    }
  };

  /* ---------------- 链接参数 ---------------- */
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parse() {
    var q = new URLSearchParams(location.search);
    var g = { lang: q.get('l') === 'en' ? 'en' : 'zh', name: '', salutation: '', table: '', seats: '', serial: '' };
    var d = q.get('d');
    if (d) {
      var p = b64urlDecode(d).split('|');
      g.name = p[0] || ''; g.salutation = p[1] || ''; g.table = p[2] || '';
      g.seats = p[3] || ''; g.serial = p[4] || '';
    } else {
      g.name = q.get('n') || ''; g.salutation = q.get('h') || ''; g.table = q.get('t') || '';
      g.seats = q.get('s') || ''; g.serial = q.get('k') || '';
    }
    return g;
  }

  /* ---------------- 渲染 ---------------- */
  function applyI18n(lang) {
    var dict = I18N[lang] || I18N.zh;
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      var v = dict[el.getAttribute('data-i18n')];
      if (typeof v === 'string') el.innerHTML = v;
    });
    Array.prototype.forEach.call(document.querySelectorAll('#lang-switch a'), function (a) {
      a.classList.toggle('on', a.getAttribute('data-lang') === lang);
    });
    // 顶部标题用页面语言重写
    document.title = (lang === 'en' ? 'My Wedding Pass' : '我的电子请柬卡') + ' · Andrew & Dora';
  }

  function drawQr(text) {
    var box = document.getElementById('qr');
    var urlBox = document.getElementById('qr-url');
    urlBox.textContent = text;
    try {
      if (typeof qrcode !== 'function') throw new Error('qrcode lib missing');
      var qr = qrcode(0, 'M');
      qr.addData(text, 'Byte');
      qr.make();
      // 用 GIF data URL 而不是 SVG：同样内容 SVG 约 32KB，data URL 仅约 12KB。
      // cellSize 调大后由 CSS 缩到 132px 显示，高像素密度屏上边缘更干净。
      var img = new Image();
      img.alt = '签到二维码';
      img.src = qr.createDataURL(8, 2);
      box.innerHTML = '';
      box.appendChild(img);
    } catch (e) {
      // 二维码库不可用时降级为纯文本链接
      box.innerHTML = '';
      urlBox.hidden = false;
      document.getElementById('qr-toggle').hidden = true;
    }
  }

  function reorderWalletButtons() {
    var row = document.querySelector('#wallet-card .btn-row');
    var apple = document.getElementById('btn-apple');
    var google = document.getElementById('btn-google');
    if (!row || !apple || !google) return;
    if (/Android/i.test(navigator.userAgent)) row.insertBefore(google, apple);
  }

  function wireLinks(g) {
    var dict = I18N[g.lang];
    var noticeFile = g.lang === 'en' ? 'notice-en.html' : 'notice.html';

    document.getElementById('btn-notice').href = noticeFile;
    document.getElementById('btn-nav').href = AMAP;
    document.getElementById('btn-map').href = APPLE_MAPS;

    // 带参数的专属链接（切换语言时保留数据）
    var params = new URLSearchParams(location.search);
    Array.prototype.forEach.call(document.querySelectorAll('#lang-switch a'), function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        params.set('l', a.getAttribute('data-lang'));
        location.search = params.toString();
      });
    });

    // 宾客姓名 / 席位
    if (g.name) {
      document.getElementById('guest-name').textContent = g.name + (g.salutation ? ' ' + g.salutation : '');
      document.getElementById('row-guest').hidden = false;
    }
    if (g.table || g.seats) {
      document.getElementById('guest-table').textContent = dict.tablefmt(g.table || '—', g.seats);
      document.getElementById('row-table').hidden = false;
    }

    // 钱包按钮
    var wc = document.getElementById('wallet-card');
    if (g.serial) {
      document.getElementById('btn-apple').href = WALLET_API + '/p/' + g.serial + '/apple.pkpass';
      document.getElementById('btn-google').href = WALLET_API + '/api/passes/' + g.serial + '/google';
      var share = document.getElementById('btn-share');
      share.href = WALLET_API + '/p/' + g.serial;
      share.textContent = g.lang === 'en'
        ? 'Other device? Open the universal install page'
        : '换了设备？打开通用安装页';
      share.hidden = false;
      wc.hidden = false;
      reorderWalletButtons();
    } else {
      document.getElementById('pass-qr').hidden = true;
      document.getElementById('nowhere').hidden = false;
    }
  }

  /* ---------------- 启动 ---------------- */
  var guest = parse();
  applyI18n(guest.lang);
  wireLinks(guest);

  // 二维码内容 = 本页规范化链接（去掉调试用的散参数，保留 d / l）
  var q = new URLSearchParams(location.search);
  var canonical = location.origin + location.pathname;
  if (q.get('d')) { canonical += '?d=' + q.get('d') + (guest.lang === 'en' ? '&l=en' : ''); }
  else { canonical = location.href; }
  drawQr(canonical);

  document.getElementById('qr-toggle').addEventListener('click', function () {
    var u = document.getElementById('qr-url');
    u.hidden = !u.hidden;
    this.textContent = u.hidden ? I18N[guest.lang].qrlink : '×';
  });

  document.getElementById('btn-cal').href = 'assets/wedding.ics';
})();
