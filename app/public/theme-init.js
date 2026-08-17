// Applies the saved theme before first paint, so a dark-mode user does not get
// a white flash. A separate file rather than an inline <script>: the packaged
// app is served by the API under a `script-src 'self'` CSP, which refuses
// inline scripts — this ran in browser dev and silently did nothing packaged.
(function () {
    try {
        var k = 'luminary-theme';
        var p = localStorage.getItem(k);
        var dark = false;
        if (p === 'dark') dark = true;
        else if (p === 'light') dark = false;
        else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.classList.toggle('dark', dark);
    } catch (e) {}
})();
