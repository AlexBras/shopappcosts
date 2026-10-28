/* Calculator UI. Needs costs.js and a <script id="calc-meta" type="application/json"> block.
   Step 1: pick a category. Step 2: only the numbers that category prices on. Results: every app ranked by monthly cost. */
(function () {
  "use strict";
  const form = document.getElementById("calc");
  const out = document.getElementById("results");
  if (!form || !out) return;
  const meta = JSON.parse(document.getElementById("calc-meta").textContent);
  const { costs, usd, setApps } = window.AppCosts;
  setApps(meta.appsData);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n = v => v.toLocaleString("en-US");
  const money = v => usd(Math.round(v * 100) / 100);
  const catBox = document.getElementById("catpick");
  const fieldBox = document.getElementById("fields");

  /* State: the chosen category and every value typed so far (kept when switching categories). */
  const qs = new URLSearchParams(location.search);
  const allKeys = Object.keys(meta.fields);
  let cat = meta.cats.find(c => c.id === qs.get("cat")) || meta.cats[0];
  const vals = Object.assign({}, meta.defaults);
  allKeys.forEach(k => { if (qs.has(k) && !isNaN(+qs.get(k))) vals[k] = Math.max(0, +qs.get(k)); });
  /* A link without a category but with a volume (old links) opens the category that volume belongs to. */
  if (!qs.has("cat")) { const hit = meta.cats.find(c => c.keys.some(k => qs.has(k))); if (hit) cat = hit; }
  const touched = new Set(allKeys.filter(k => qs.has(k)));

  catBox.innerHTML = meta.cats.map(c => `<button type="button" class="chip" data-cat="${c.id}">${esc(c.short)}</button>`).join("");
  catBox.addEventListener("click", e => {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    cat = meta.cats.find(c => c.id === b.dataset.cat);
    /* Fields the visitor has not typed in take this category's typical values. */
    cat.keys.forEach(k => { if (!touched.has(k)) vals[k] = cat.preset[k]; });
    drawFields(); render();
  });

  function drawFields() {
    catBox.querySelectorAll("[data-cat]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.cat === cat.id)));
    const [main, ...rest] = cat.keys;
    const f = meta.fields[main];
    const box = (k, big) => { const d = meta.fields[k];
      return big
        ? `<div class="bigin">${d.pre ? `<span>${d.pre}</span>` : ""}<input id="c-${k}" name="${k}" type="number" min="0" step="${d.step || 1}" value="${vals[k]}" inputmode="${d.step ? "decimal" : "numeric"}" autocomplete="off"><span>${esc(d.unit)}</span></div>`
        : `<div class="field"><label for="c-${k}">${esc(d.label)}</label><div class="box">${d.pre ? `<span>${d.pre}</span>` : ""}<input id="c-${k}" name="${k}" type="number" min="0" step="${d.step || 1}" value="${vals[k]}" inputmode="${d.step ? "decimal" : "numeric"}"><span>${esc(d.unit)}</span></div>${d.hint ? `<small class="fine">${esc(d.hint)}</small>` : ""}</div>`; };
    fieldBox.innerHTML = `<label class="q" for="c-${main}" style="margin-top:8px"><span class="k">2</span>${esc(f.question)}</label>
${box(main, true)}
<div class="chips" role="group" aria-label="Typical store sizes">${cat.scenarios.map((s, i) => `<button type="button" class="chip" data-s="${i}">${esc(s.chip)}</button>`).join("")}</div>
${rest.length ? `<div class="more">${rest.map(k => box(k, false)).join("")}</div>` : ""}`;
  }

  fieldBox.addEventListener("click", e => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    Object.assign(vals, cat.scenarios[+b.dataset.s].v);
    Object.keys(cat.scenarios[+b.dataset.s].v).forEach(k => { const el = form.elements[k]; if (el) el.value = vals[k]; touched.add(k); });
    render();
  });
  form.addEventListener("input", e => {
    const k = e.target.name; if (!k || !(k in vals)) return;
    vals[k] = Math.max(0, +e.target.value || 0); touched.add(k); render();
  });
  form.addEventListener("submit", e => e.preventDefault());

  function card(r, best) {
    const a = meta.apps[r.id];
    const av = `<span class="av" style="background:${a.color}" aria-hidden="true">${esc(a.short.charAt(0).toUpperCase())}</span>`;
    const visit = `<a class="btn sm${r.cost === null ? " ghost" : ""}" href="${a.go}" rel="${a.sponsored ? "sponsored " : ""}nofollow noopener" target="_blank">Visit ${esc(a.short)}</a>`;
    if (r.cost === null) return `<div class="opt na"><div class="row">${av}<div class="nm"><a href="${a.url}">${esc(a.short)}</a><small>${esc(r.why)}</small></div><div class="cost"><span class="na">Not published</span></div>${visit}</div></div>`;
    const isBest = best !== null && r.cost === best;
    return `<div class="opt${isBest ? " top" : ""}"><div class="row">${av}<div class="nm"><a href="${a.url}">${esc(a.short)}${isBest ? `<span class="badge best">Cheapest</span>` : ""}${r.from ? `<span class="badge from">Starting price</span>` : ""}</a><small title="${esc(r.why)}">${esc(r.why)}</small></div>
<div class="cost">${r.from ? "<span>from </span>" : ""}<b>${money(r.cost)}</b><span>/mo</span></div>${visit}</div></div>`;
  }

  function render() {
    const v = Object.assign({}, vals);
    v.langs = Math.min(20, Math.round(v.langs || 0));
    const rows = (costs(v)[cat.id] || []).slice();
    const known = rows.filter(r => r.cost !== null).sort((x, y) => x.cost - y.cost);
    const unknown = rows.filter(r => r.cost === null);
    const best = known.length ? known[0].cost : null;
    const who = cat.keys.map(k => `${meta.fields[k].pre || ""}${n(Math.round(v[k] * 100) / 100)} ${meta.fields[k].unit}`).slice(0, 2).join(", ");
    out.innerHTML = `<div class="rhead"><h2>${esc(cat.title)} for ${esc(who)}</h2><span>Per month · cheapest plan that fits</span></div>
${[...known, ...unknown].map(r => card(r, best)).join("")}
<p class="fine">Prices in USD from each official Shopify App Store listing, excluding taxes. “Starting price” means the vendor publishes only a minimum at your size. <a href="${cat.url}">All ${esc(cat.title.toLowerCase())}</a> · <a href="${meta.method}">how we calculate</a></p>`;
    const p = new URLSearchParams({ cat: cat.id });
    cat.keys.forEach(k => p.set(k, v[k]));
    history.replaceState(null, "", "?" + p.toString() + location.hash);
  }

  drawFields();
  render();
})();
