(function () {
  var toggle = document.querySelector('.menu-toggle');
  var drawer = document.getElementById('mobile-drawer');
  if (!toggle || !drawer) return;
  toggle.addEventListener('click', function () {
    var isOpen = drawer.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  drawer.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      drawer.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
})();
