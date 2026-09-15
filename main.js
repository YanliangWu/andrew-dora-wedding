(function () {
  var cover = document.getElementById('cover');
  var app = document.getElementById('app');
  var openBtn = document.getElementById('open-btn');
  var petals = document.getElementById('petals');

  // ---- 花瓣 ----
  var COUNT = 10;
  for (var i = 0; i < COUNT; i++) {
    var p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.animationDuration = (9 + Math.random() * 8) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    p.style.transform = 'scale(' + (0.6 + Math.random() * 0.8) + ')';
    petals.appendChild(p);
  }

  // ---- 开启请柬 ----
  function open() {
    cover.classList.add('opened');
    app.classList.add('started');
  }
  openBtn.addEventListener('click', open);
  if (location.hash === '#skip') open(); // 调试直达

  // ---- 滚动淡入 ----
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.18 });

  document.querySelectorAll('.sec, .actions').forEach(function (el) {
    el.classList.add('reveal');
    io.observe(el);
  });
})();
