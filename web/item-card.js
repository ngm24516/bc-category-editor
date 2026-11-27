// The item hover card (editor and Stockroom page): what an item is worth where. Each page gives a function that
// returns the card's facts for an item; this draws it and shows it next to the item while the pointer rests on it.
//
//   ItemCard.attach(root, selector, el => facts | null)
//   facts: { name, ft, weight?, qty?,
//            atm?: { each, pct, condition?, total? },          ATM payout (whole numbers, like the ATM)
//            store?: { price, fluct? },                         server store price, ± fluct% with its stock
//            blackMarket?: { each, dmz, dmzPct },               Black Market trader estimate (Narcotics & Crime)
//            market?: { name, avg, low, high, n, now?, qty?, owner?, shop?, avgLow?, days?, mine?: { price, qty, undercut } },
//            settings?: "where the server settings come from" }
(function () {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = v => v == null ? "–" : (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const row = (label, value, note) => `<div class="ic-row"><span>${label}</span><b>${value}</b></div>${note ? `<div class="ic-note">${note}</div>` : ""}`;

  function html(f) {
    let h = `<div class="ic-head"><b>${esc(f.name)}</b><span class="mono">${esc(f.ft)}</span></div>`;
    const facts = [];
    if (f.weight != null) facts.push(row("Weight", esc(f.weight)));
    if (f.qty != null) facts.push(row("You have", esc(f.qty.toLocaleString())));
    if (facts.length) h += `<div class="ic-sec">${facts.join("")}</div>`;

    const econ = [];
    if (f.atm) {
      econ.push(row("ATM pays", "$" + money(f.atm.each),
        (f.atm.total != null ? `$${money(f.atm.total)} for all. ` : "") + (f.atm.condition ? "At full condition; a worn one pays less (down to 25%)." : "")));
    }
    if (f.store) {
      econ.push(row("Server store sells for", "$" + money(f.store.price),
        f.store.fluct ? `Moves up to ${esc(f.store.fluct)}% either way with the store's stock.` : ""));
    }
    if (f.blackMarket) {
      econ.push(row("Black Market buys for", "about $" + money(f.blackMarket.each),
        `About $${money(f.blackMarket.dmz)} at DMZ trader sites (${esc(f.blackMarket.dmzPct)}%). Quotes vary with the trader's cash and demand.`));
    }
    if (econ.length) h += `<div class="ic-sec"><div class="ic-title">Server Economy</div>${econ.join("")}${f.settings ? `<div class="ic-note">${esc(f.settings)}</div>` : ""}</div>`;

    if (f.market) {
      const m = f.market;
      h += `<div class="ic-sec"><div class="ic-title">${esc(m.name || "Marketplace")}</div>` +
        (m.now != null ? row("Cheapest now", "$" + money(m.now) + (m.qty != null ? ` <small>(${esc(m.qty.toLocaleString())} listed)</small>` : ""),
          m.owner || m.shop ? `From ${esc(m.owner || "")}${m.shop ? (m.owner ? " at " : "") + esc(m.shop) : ""}.` : "") : row("Cheapest now", "not listed")) +
        (m.mine ? row(m.mine.undercut ? "⚠ Your listing" : "Your listing", "$" + money(m.mine.price) + (m.mine.qty != null ? ` <small>(${esc(m.mine.qty.toLocaleString())})</small>` : ""),
          m.mine.undercut ? `Someone else now lists it $${money(m.mine.price - m.now)} cheaper.` : "You have the cheapest listing.") : "") +
        (m.avgLow != null ? row("Average daily low", "$" + money(m.avgLow), `The cheapest listing on each of ${esc(m.days)} day${m.days === 1 ? "" : "s"} it was listed, averaged.`) : "") +
        row("Average", "$" + money(m.avg)) + row("Low · High", "$" + money(m.low) + " · $" + money(m.high)) +
        `<div class="ic-note">Over ${esc(m.n.toLocaleString())} listing${m.n === 1 ? "" : "s"} seen.</div></div>`;
    }
    return h;
  }

  function attach(root, selector, facts) {
    const card = document.createElement("div");
    card.className = "itemcard"; card.hidden = true; card.setAttribute("role", "tooltip");
    document.body.appendChild(card);
    let timer = null, over = null;
    const hide = () => { clearTimeout(timer); timer = null; over = null; card.hidden = true; };
    function place(x, y) {
      const r = card.getBoundingClientRect(), pad = 14;
      let left = x + pad, top = y + pad;
      if (left + r.width > innerWidth - 8) left = Math.max(8, x - r.width - pad);
      if (top + r.height > innerHeight - 8) top = Math.max(8, innerHeight - r.height - 8);
      card.style.left = left + "px"; card.style.top = top + "px";
    }
    root.addEventListener("mouseover", ev => {
      const el = ev.target.closest(selector);
      if (!el || !root.contains(el)) return;
      if (el === over) return;
      hide(); over = el;
      const { clientX: x, clientY: y } = ev;
      timer = setTimeout(() => {
        const f = facts(el);
        if (!f || over !== el) return;
        card.innerHTML = html(f); card.hidden = false; place(x, y);
      }, 250);
    });
    root.addEventListener("mouseout", ev => {
      if (over && !(ev.relatedTarget && over.contains(ev.relatedTarget))) hide();
    });
    root.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") hide(); });
    return { hide };
  }

  window.ItemCard = { attach, html };
})();
