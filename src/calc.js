/* Calculator UI. Needs costs.js and a <script id="calc-meta" type="application/json"> block. */
(function () {
  "use strict";
  const form = document.getElementById("calc");
  const out = document.getElementById("results");
  if (!form || !out) return;
  const meta = JSON.parse(document.getElementById("calc-meta").textContent);
  const { costs, cheapest, usd2, setPrices } = window.AppCosts;
  setPrices(meta.prices);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fields = ["orders", "contacts", "emails", "subs", "aov", "words", "langs"];

  /* Prefill from the URL, so a result can be shared. */
  const qs = new URLSearchParams(location.search);
  fields.forEach(f => { const el = form.elements[f]; if (el && qs.has(f)) el.value = qs.get(f); });

  const read = () => {
    const v = {};
    fields.forEach(f => { v[f] = Math.max(0, +form.elements[f].value || 0); });
    v.langs = Math.min(20, Math.round(v.langs));
    return v;
  };

  function render() {
    const v = read();
    const c = costs(v);
    let total = 0, anyFrom = false;
    out.innerHTML = meta.cats.map(cat => {
      const rows = c[cat.id];
      const best = cheapest(rows);
      if (best) { total += best.cost; if (best.from) anyFrom = true; }
      return `<div class="rgroup"><h3><a href="${cat.url}">${esc(cat.title)}</a></h3>${rows.map(r => {
        const app = meta.apps[r.id];
        return `<div class="rrow ${r === best ? "best" : ""}"><a class="name" href="${app.url}">${esc(app.short)}</a><span class="cost ${r.cost === null ? "unk" : ""}">${r.cost === null ? "not published" : (r.from ? "from " : "") + usd2(r.cost)}</span><span class="why">${esc(r.why)}</span></div>`;
      }).join("")}</div>`;
    }).join("") + `<div class="total"><span>Cheapest stack per month</span><b>${anyFrom ? "from " : ""}${usd2(total)}</b></div>`;
    const p = new URLSearchParams();
    fields.forEach(f => p.set(f, v[f]));
    history.replaceState(null, "", "?" + p.toString());
  }

  form.addEventListener("input", render);
  form.addEventListener("submit", e => e.preventDefault());
  render();
})();
