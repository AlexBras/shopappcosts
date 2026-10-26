/* Calculator UI. Needs costs.js and a <script id="calc-meta" type="application/json"> block. */
(function () {
  "use strict";
  const form = document.getElementById("calc");
  const out = document.getElementById("results");
  if (!form || !out) return;
  const meta = JSON.parse(document.getElementById("calc-meta").textContent);
  const { costs, cheapest, usd2, setApps } = window.AppCosts;
  setApps(meta.appsData);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fields = ["orders", "contacts", "emails", "subs", "aov", "words", "langs", "products"];

  /* Prefill from the URL, so a result can be shared. */
  const qs = new URLSearchParams(location.search);
  fields.forEach(f => { const el = form.elements[f]; if (el && qs.has(f)) el.value = qs.get(f); });

  const read = () => {
    const v = {};
    fields.forEach(f => { v[f] = Math.max(0, +form.elements[f].value || 0); });
    v.langs = Math.min(20, Math.round(v.langs));
    return v;
  };

  /* Categories counted in the total. Optional ones (e.g. loyalty) start unticked; "skip" and "add" keep the choice in the URL. */
  const skip = new Set((qs.get("skip") || "").split(",").filter(Boolean));
  const add = new Set((qs.get("add") || "").split(",").filter(Boolean));
  const included = cat => (cat.core ? !skip.has(cat.id) : add.has(cat.id));
  out.addEventListener("change", e => {
    const id = e.target && e.target.dataset && e.target.dataset.cat;
    if (!id) return;
    const cat = meta.cats.find(x => x.id === id);
    if (cat.core) { e.target.checked ? skip.delete(id) : skip.add(id); } else { e.target.checked ? add.add(id) : add.delete(id); }
    render();
  });

  function render() {
    const v = read();
    const c = costs(v);
    let total = 0, anyFrom = false;
    out.innerHTML = meta.cats.map(cat => {
      const rows = c[cat.id] || [];
      const best = cheapest(rows);
      const on = included(cat);
      if (best && on) { total += best.cost; if (best.from) anyFrom = true; }
      return `<div class="rgroup${on ? "" : " off"}"><h3><a href="${cat.url}">${esc(cat.title)}</a><label class="inc"><input type="checkbox" data-cat="${cat.id}" id="inc-${cat.id}"${on ? " checked" : ""}> In total</label></h3>${rows.map(r => {
        const app = meta.apps[r.id];
        return `<div class="rrow ${r === best ? "best" : ""}"><a class="name" href="${app.url}">${esc(app.short)}</a><span class="cost ${r.cost === null ? "unk" : ""}">${r.cost === null ? "not published" : (r.from ? "from " : "") + usd2(r.cost)}</span><span class="why">${esc(r.why)}</span></div>`;
      }).join("")}</div>`;
    }).join("") + `<div class="total"><span>Cheapest stack per month (ticked categories)</span><b>${anyFrom ? "from " : ""}${usd2(total)}</b></div>`;
    const p = new URLSearchParams();
    fields.forEach(f => p.set(f, v[f]));
    if (skip.size) p.set("skip", [...skip].join(","));
    if (add.size) p.set("add", [...add].join(","));
    history.replaceState(null, "", "?" + p.toString());
  }

  form.addEventListener("input", render);
  form.addEventListener("submit", e => e.preventDefault());
  render();
})();
