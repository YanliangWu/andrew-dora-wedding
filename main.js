(function () {
  var app = document.getElementById('app');
  var cover = document.getElementById('cover');
  var openBtn = document.getElementById('open-btn');
  var pager = document.getElementById('pager');
  var video = pager ? pager.querySelector('.hero-video') : null;
  var hint = pager ? pager.querySelector('.scroll-hint') : null;
  var petals = document.getElementById('petals');
  var pages = pager ? Array.prototype.slice.call(pager.querySelectorAll('.page')) : [];
  var dotBtns = Array.prototype.slice.call(document.querySelectorAll('#dots button'));

  /* ==========================================================================
     1) 翻页 —— 放在最前面，并且不依赖下面任何装饰性代码。
        圆点是 HTML 里静态写好的（不是 JS 生成），所以即使脚本出错，
        导航本身依然存在；这里只负责"哪个点是当前页"和点击跳转。
     ========================================================================== */
  var current = -1;

  function go(i) {
    i = Math.max(0, Math.min(pages.length - 1, i));
    var top = pages[i].offsetTop; // 每页正好一屏高，offsetTop 即目标位置
    if (pager.scrollTo) pager.scrollTo({ top: top, behavior: 'smooth' });
    else pager.scrollTop = top;
  }

  function setActive(i) {
    if (i < 0 || i >= pages.length || i === current) return;
    current = i;
    pages.forEach(function (pg, j) {
      pg.classList.toggle('in', j === i);
    });
    dotBtns.forEach(function (b, j) {
      if (j === i) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    if (hint) hint.style.opacity = (i === 0 ? '' : '0');
    // 视频只在首屏播放，翻走就暂停（省电，也避免后台解码）
    if (video) {
      if (i === 0) playHero();
      else video.pause();
    }
  }

  dotBtns.forEach(function (b, i) {
    b.addEventListener('click', function () { go(i); });
  });

  if (pages.length) {
    setActive(0); // 先落一个初始状态，观察器不可用也正确

    var io = null;
    try {
      // 每页正好一屏高 → 任一时刻最多只有一页的可见比例 > 0.55
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && e.intersectionRatio > 0.55) {
            setActive(pages.indexOf(e.target));
          }
        });
      }, { root: pager, threshold: [0.56, 1] });
      pages.forEach(function (pg) { io.observe(pg); });
    } catch (err) {
      io = null;
    }

    if (!io) {
      // 兜底（老浏览器没有 IntersectionObserver）：按滚动位置算当前页
      var onScroll = function () {
        setActive(Math.round(pager.scrollTop / pager.clientHeight));
      };
      pager.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    // 键盘翻页（桌面端）
    document.addEventListener('keydown', function (e) {
      if (!app.classList.contains('started')) return;
      var k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Spacebar') {
        e.preventDefault(); go(current + 1);
      } else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') {
        e.preventDefault(); go(current - 1);
      } else if (k === 'Home') {
        e.preventDefault(); go(0);
      } else if (k === 'End') {
        e.preventDefault(); go(pages.length - 1);
      }
    });

    // 视口变化（横竖屏切换、地址栏收放）后重新对齐当前页，避免停在两页之间
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (current >= 0) pager.scrollTop = pages[current].offsetTop;
      }, 160);
    });

    pager.scrollTop = 0;
  }

  /* ==========================================================================
     2) 开启请柬 / 首屏视频
     ========================================================================== */
  var started = false;

  function playHero() {
    if (!video) return;
    try {
      var pr = video.play();
      if (pr && pr.catch) pr.catch(function () {}); // 静音自动播放被拦时静默忽略
    } catch (err) { /* 忽略 */ }
  }

  function open() {
    if (started) return;
    started = true;
    cover.classList.add('opened');
    app.classList.add('started');
    playHero();
  }

  if (openBtn) openBtn.addEventListener('click', open);

  // #skip 开启后停在第一页；#p=3 开启并直接翻到第 3 页（调试 / 分享指定页用）
  var jump = /^#p=(\d+)$/.exec(location.hash);
  if (location.hash === '#skip' || jump) open();
  if (jump && pages.length) {
    var idx = Math.max(0, Math.min(pages.length - 1, parseInt(jump[1], 10) - 1));
    var land = function () {
      pager.scrollTop = pages[idx].offsetTop;
      setActive(idx);
    };
    requestAnimationFrame(land);
    setTimeout(land, 150);
  }

  /* ==========================================================================
     3) 装饰：花瓣（放在最后，出问题也不影响上面的功能）
     ========================================================================== */
  if (petals) {
    for (var i = 0; i < 10; i++) {
      var p = document.createElement('i');
      p.style.left = Math.random() * 100 + 'vw';
      p.style.animationDuration = (9 + Math.random() * 8) + 's';
      p.style.animationDelay = (Math.random() * 10) + 's';
      p.style.transform = 'scale(' + (0.6 + Math.random() * 0.8) + ')';
      petals.appendChild(p);
    }
  }
})();
