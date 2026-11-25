// The account menu at the top right of every page: the Discord avatar, and a dropdown with who is signed in
// and what they can do. Signed out, the same spot holds "Log in with Discord".
//
//   AccountMenu.mount(root, me, { items: [{ label, href } | { label, onClick }], onLogout })
//     me = the /api/me answer, or null when signed out. Items whose `show` is false are left out; `show` can
//     also be a function, checked each time the menu opens (for entries that depend on the page's state).
(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = name => (String(name || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2) || "?").toUpperCase();
  const face = (me, size) => me.avatarUrl
    ? '<img class="avatar" src="' + esc(me.avatarUrl) + '" alt="" width="' + size + '" height="' + size + '">'
    : '<span class="avatar initials" style="width:' + size + 'px;height:' + size + 'px" aria-hidden="true">' + esc(initials(me.displayName)) + "</span>";

  function mount(root, me, opts = {}) {
    root.hidden = false;
    if (!me) {
      root.innerHTML = '<a class="btn discord" href="/auth/discord/login">Log in with Discord</a>';
      return;
    }
    const items = (opts.items || []).filter(i => i.show !== false);
    const visible = it => (typeof it.show === "function" ? !!it.show() : true);
    root.innerHTML =
      '<button type="button" class="avatar-btn" aria-haspopup="menu" aria-expanded="false" title="Account: ' + esc(me.displayName) + '">' +
        face(me, 32) + '<span class="caret" aria-hidden="true">▾</span></button>' +
      '<div class="menu" role="menu" hidden>' +
        '<div class="menu-head">' + face(me, 40) + '<div class="who"><b>' + esc(me.displayName) + '</b>' +
          '<span>@' + esc(me.username) + (me.role === "admin" ? ' <span class="badge running">Admin</span>' : "") + '</span></div></div>' +
        items.map((it, i) => it.href
          ? '<a role="menuitem" data-i="' + i + '" href="' + esc(it.href) + '">' + esc(it.label) + '</a>'
          : '<button type="button" role="menuitem" data-i="' + i + '">' + esc(it.label) + '</button>').join("") +
        '<div class="menu-sep" role="separator"></div>' +
        '<button type="button" role="menuitem" data-logout="1">Log out</button>' +
      '</div>';

    const btn = root.querySelector(".avatar-btn"), menu = root.querySelector(".menu");
    const entries = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(e => !e.hidden);
    const open = focusFirst => {
      for (const el of menu.querySelectorAll("[data-i]")) el.hidden = !visible(items[+el.dataset.i]);
      menu.hidden = false; btn.setAttribute("aria-expanded", "true");
      if (focusFirst) entries()[0]?.focus();
    };
    const close = refocus => {
      if (menu.hidden) return;
      menu.hidden = true; btn.setAttribute("aria-expanded", "false");
      if (refocus) btn.focus();
    };
    btn.onclick = () => (menu.hidden ? open(false) : close(false));
    btn.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); open(true); } };
    root.addEventListener("keydown", e => {
      if (e.key === "Escape" && !menu.hidden) { e.preventDefault(); e.stopPropagation(); close(true); }
    });
    menu.onkeydown = e => {
      const list = entries(), at = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); list[(at + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
      else if (e.key === "Tab") close(false);
    };
    menu.onclick = async e => {
      const b = e.target.closest("button[role=menuitem]");
      if (!b) return;
      close(false);
      if (b.dataset.logout) {
        if (opts.onLogout) await opts.onLogout();
        await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
        location.href = "/";
      } else items[+b.dataset.i].onClick();
    };
    document.addEventListener("click", e => { if (!root.contains(e.target)) close(false); });
  }

  window.AccountMenu = { mount };
})();
