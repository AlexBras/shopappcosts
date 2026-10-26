#!/usr/bin/env node
/* Static site build. No dependencies: `node build.js` writes everything to dist/.
   Edit data/*.json, then rebuild. SITE_URL (env) overrides baseUrl in data/site.json. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { costs, cheapest, usd2 } = require("./src/costs.js");

const ROOT = __dirname;
const OUT = path.join(ROOT, "dist");
const load = f => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
const site = load("site.json");
const CATS = load("categories.json");
const APPS = load("apps.json");
const LOG = load("changelog.json").sort((a, b) => b.date.localeCompare(a.date));

/* Dates from the daily price check (scripts/check-prices.js), when it has run.
   An app's date moves forward only on days its listing matched the stored snapshot;
   the site-wide date is the oldest of those, so it never claims more than was checked. */
{
  let status = null;
  try { status = load("check-status.json"); } catch { /* not run yet */ }
  if (status && status.apps) {
    for (const a of APPS) {
      const c = status.apps[a.id] && status.apps[a.id].confirmed;
      if (c && c > a.checked) a.checked = c;
    }
    const oldest = APPS.map(a => a.checked).sort()[0];
    if (oldest > site.lastChecked) site.lastChecked = oldest;
  }
}
const BASE = (process.env.SITE_URL || site.baseUrl).replace(/\/$/, "");

const byId = Object.fromEntries(APPS.map(a => [a.id, a]));
const catById = Object.fromEntries(CATS.map(c => [c.id, c]));

/* ---------- helpers ---------- */
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDate = iso => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const monthYear = iso => { const [y, m] = iso.split("-").map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; };
const monShort = iso => { const [y, m] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const clip = (t, n = 158) => t.length <= n ? t : t.slice(0, t.lastIndexOf(" ", n - 1)).replace(/[,.;:]$/, "") + "…";
const usd = v => v === 0 ? "$0" : "$" + v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
const planPrice = p => p.priceLabel || (p.from ? "from " : "") + usd(p.price);
const costCell = r => !r ? "n/a" : r.cost === null ? "not published" : (r.from ? "from " : "") + usd2(r.cost);

const appUrl = a => `/apps/${a.slug}/`;
const catUrl = c => `/${c.slug}/`;
const goUrl = a => `/go/${a.slug}/`;
const pairSlug = (a, b) => `${a.slug}-vs-${b.slug}`;
const cmpUrl = (a, b) => `/compare/${pairSlug(a, b)}/`;
const outLink = (a, label, cls = "cta") =>
  `<a class="${cls}" href="${goUrl(a)}" rel="${a.affiliate.url ? "sponsored " : ""}nofollow noopener" target="_blank">${esc(label)}</a>`;

/* All pairs within a category, in data order. */
const PAIRS = [];
for (const c of CATS) {
  const list = APPS.filter(a => a.cat === c.id);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) PAIRS.push([list[i], list[j], c]);
}

/* Cost of one app in one scenario (scenario values on top of the default store). */
const costFor = (app, v) => costs(Object.assign({}, site.defaultScenario, v))[app.cat].find(r => r.id === app.id) || null;

/* ---------- assets (content-hashed) ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
const ASSET = {};
for (const f of ["style.css", "costs.js", "calc.js"]) {
  const src = fs.readFileSync(path.join(ROOT, "src", f));
  const h = crypto.createHash("sha256").update(src).digest("hex").slice(0, 10);
  const name = f.replace(/\.(\w+)$/, `.${h}.$1`);
  fs.writeFileSync(path.join(OUT, "assets", name), src);
  ASSET[f] = `/assets/${name}`;
}

/* ---------- layout ---------- */
const NAV = [
  ["/calculator/", "Cost calculator"],
  ...CATS.map(c => [catUrl(c), c.title]),
  ["/compare/", "Comparisons"],
  ["/price-changes/", "Price changes"]
];
const pages = []; /* [{path, lastmod}] for the sitemap */

function crumbsHtml(crumbs) {
  if (!crumbs || !crumbs.length) return "";
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>${crumbs.map((c, i) =>
    i === crumbs.length - 1 ? `<li aria-current="page">${esc(c[1])}</li>` : `<li><a href="${c[0]}">${esc(c[1])}</a></li>`).join("")}</ol></nav>`;
}
function crumbsLd(crumbs) {
  const all = [["/", "Home"], ...crumbs];
  return { "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: all.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c[1], item: BASE + c[0] })) };
}

function page({ path: p, title, description, body, crumbs = [], jsonld = [], calc = false, lastmod = site.lastChecked, noindex = false }) {
  const ld = [...jsonld];
  if (crumbs.length) ld.push(crumbsLd(crumbs));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(clip(description))}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${BASE}${p}">`}
${(site.verificationMeta || []).map(m => `<meta name="${esc(m.name)}" content="${esc(m.content)}">`).join("\n")}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(clip(description, 200))}">
<meta property="og:url" content="${BASE}${p}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0b7a5a">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=JetBrains+Mono:wght@400;500;700&display=swap">
<link rel="stylesheet" href="${ASSET["style.css"]}">
${ld.map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("\n")}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar"><div class="in">
  <a class="logo" href="/">${esc(site.nameParts[0])}<span>${esc(site.nameParts[1])}</span></a>
  <nav aria-label="Main">${NAV.map(([u, t]) => `<a href="${u}"${u === p ? ' aria-current="page"' : ""}>${esc(t)}</a>`).join("")}</nav>
</div></header>
<div class="wrap">
${crumbsHtml(crumbs)}
<main id="main" class="stack">
${body}
</main>
<footer class="site">
  <nav aria-label="Footer"><a href="/methodology/">Methodology</a><a href="/disclosure/">Affiliate disclosure</a><a href="/price-changes/">Price changes</a><a href="/compare/">All comparisons</a><a href="mailto:${esc(site.contactEmail)}">Contact</a></nav>
  <p>${esc(site.name)} is an independent guide. It is not affiliated with Shopify or with the app developers listed. Some outbound links are affiliate links: we may earn a commission at no extra cost to you. That never changes the order or the numbers. <a href="/disclosure/">Details</a>.</p>
  <p class="mono">Prices in USD as shown on listings, excluding taxes. Last checked ${fmtDate(site.lastChecked)}.</p>
</footer>
</div>
${calc ? `<script src="${ASSET["costs.js"]}" defer></script><script src="${ASSET["calc.js"]}" defer></script>` : ""}
</body>
</html>
`;
  const file = p.endsWith("/") ? path.join(OUT, p, "index.html") : path.join(OUT, p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  if (!noindex) pages.push({ path: p, lastmod });
}

/* ---------- shared blocks ---------- */
function appCard(a, { link = true } = {}) {
  return `<article class="card">
  <div class="top"><h3>${link ? `<a href="${appUrl(a)}">${esc(a.name)}</a>` : esc(a.name)}</h3>${a.rating ? `<span class="rating">★ ${esc(a.rating)}</span>` : ""}</div>
  <div class="plans">${a.plans.map(p => `<div class="plan"><span>${esc(p.name)}<span class="lim">${esc(p.limits)}</span></span><span class="p">${esc(planPrice(p))}</span></div>`).join("")}</div>
  <p class="verdict">${esc(a.verdict)}</p>${a.watch ? `<p class="watch">${esc(a.watch)}</p>` : ""}
  <span class="src">Read ${fmtDate(a.checked)} · ${esc(a.source)}</span>
  <div class="actions">${link ? `<a class="cta ghost" href="${appUrl(a)}">Full pricing</a>` : ""}${outLink(a, `Visit ${a.short}`)}</div>
</article>`;
}

function calculatorBlock() {
  const d = site.defaultScenario;
  const meta = {
    cats: CATS.map(c => ({ id: c.id, title: c.title, url: catUrl(c) })),
    apps: Object.fromEntries(APPS.map(a => [a.id, { short: a.short, url: appUrl(a) }]))
  };
  const f = (id, label, val, small, extra = "") =>
    `<div class="field"><label for="c-${id}">${label}</label><input id="c-${id}" name="${id}" type="number" min="0" value="${val}" inputmode="numeric"${extra}>${small ? `<small>${small}</small>` : ""}</div>`;
  return `<div class="bench">
  <form class="inputs" id="calc" novalidate>
    ${f("orders", "Orders per month", d.orders, "Drives review-app pricing.")}
    ${f("contacts", "Email contacts", d.contacts)}
    ${f("emails", "Emails sent per month", d.emails)}
    ${f("subs", "Active subscribers", d.subs)}
    ${f("aov", "Average subscription order (USD)", d.aov, "Used for Recharge's percentage fee. One renewal per subscriber per month assumed.", ' step="any"')}
    ${f("words", "Words on your store", d.words, "Product pages, collections, theme text.")}
    ${f("langs", "Extra languages", d.langs, "", ' max="20"')}
  </form>
  <div class="results" id="results" aria-live="polite"><noscript>The calculator needs JavaScript. The plan tables on each app page show every price.</noscript></div>
</div>
<script id="calc-meta" type="application/json">${JSON.stringify(meta).replace(/</g, "\\u003c")}</script>`;
}

function scenarioTable(cat, apps) {
  const rows = cat.scenarios.map(s => {
    const cells = apps.map(a => costFor(a, s.v));
    const known = cells.filter(r => r && r.cost !== null).map(r => r.cost);
    const min = known.length > 1 ? Math.min(...known) : null;
    return `<tr><th scope="row">${esc(s.label)}</th>${cells.map(r =>
      `<td class="n${min !== null && r && r.cost === min && known.filter(x => x === min).length < known.length ? " win" : ""}">${esc(costCell(r))}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="tablewrap"><table><thead><tr><th>Your store</th>${apps.map(a => `<th class="n">${esc(a.short)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
${cat.scenarioNote ? `<p class="mono muted">${esc(cat.scenarioNote)}</p>` : ""}`;
}

function calcLink(v, label = "Price it with your own numbers →") {
  const q = new URLSearchParams(Object.assign({}, site.defaultScenario, v)).toString();
  return `<a class="mono" href="/calculator/?${q}">${esc(label)}</a>`;
}

/* ---------- home ---------- */
{
  const c = costs(site.defaultScenario);
  let total = 0, anyFrom = false;
  const lines = CATS.map(cat => { const b = cheapest(c[cat.id]); total += b.cost; if (b.from) anyFrom = true;
    return `<div class="l"><span>${esc(cat.title)} · ${esc(byId[b.id].short)}</span><span>${(b.from ? "from " : "") + usd2(b.cost)}</span></div>`; }).join("");
  const d = site.defaultScenario;
  const planCount = APPS.reduce((n, a) => n + a.plans.length, 0);
  const tracker = APPS.flatMap(a => a.plans.map((p, i) => `<tr>${i === 0
    ? `<td rowspan="${a.plans.length}"><a href="${appUrl(a)}">${esc(a.name)}</a><span class="sub">${esc(a.source)}</span></td><td rowspan="${a.plans.length}"><a href="${catUrl(catById[a.cat])}">${esc(catById[a.cat].title)}</a></td>` : ""}
<td>${esc(p.name)}</td><td class="n price">${esc(planPrice(p))}</td><td>${esc(p.limits)}</td><td class="mono">${fmtDate(a.checked)}</td></tr>`)).join("");
  page({
    path: "/",
    title: `${site.name}: what Shopify apps really cost at your volume`,
    description: `Dated price tracker and cost calculator for ${APPS.length} Shopify apps: reviews, email, subscriptions and translation. Every plan read from the official listing.`,
    jsonld: [{ "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: BASE + "/" }],
    body: `<section class="hero">
  <div>
    <div class="eyebrow">${esc(site.tagline)}</div>
    <h1 style="margin-top:12px">What your Shopify apps really cost at your order volume.</h1>
    <p class="lede read">App listings show a starting price. Your bill depends on orders, contacts, subscribers and words. We read every plan from the official Shopify App Store listing, date each check, and turn it into a monthly cost you can recalculate for your store.</p>
    <div class="stats"><span><b>${APPS.length}</b> apps tracked</span><span><b>${planCount}</b> plans recorded</span><span><b>${fmtDate(site.lastChecked)}</b> last check</span></div>
    <div class="actions" style="margin-top:22px"><a class="cta" href="/calculator/">Calculate my app bill</a><a class="cta ghost" href="/compare/">Browse comparisons</a></div>
  </div>
  <div class="receipt" aria-label="Example monthly bill">
    <div class="t">EXAMPLE STORE · ${d.orders.toLocaleString("en-US")} ORDERS/MO</div>
    ${lines}<div class="l tot"><span>TOTAL / MONTH</span><span>${anyFrom ? "from " : ""}${usd2(total)}</span></div>
    <small>Cheapest plan in each category that fits ${d.orders.toLocaleString("en-US")} orders, ${d.contacts.toLocaleString("en-US")} contacts, ${d.subs} subscribers and ${d.langs} extra language.</small>
  </div>
</section>

<section class="hub" aria-labelledby="h-cats">
  <div class="hubhead"><div><div class="eyebrow">Categories</div><h2 id="h-cats">Compare by what you need</h2></div></div>
  <div class="cards">${CATS.map(cat => { const list = APPS.filter(a => a.cat === cat.id);
    return `<article class="card"><h3><a href="${catUrl(cat)}">${esc(cat.title)}</a></h3><p class="verdict">${esc(cat.lede)}</p><p class="src">${list.map(a => esc(a.short)).join(" · ")}</p><div class="actions"><a class="cta ghost" href="${catUrl(cat)}">See costs</a></div></article>`; }).join("")}</div>
</section>

<section class="hub" aria-labelledby="h-tr">
  <div class="hubhead"><div><div class="eyebrow">Price tracker</div><h2 id="h-tr">Every plan, with the date we read it</h2></div><span class="mono muted">USD per month · billed through Shopify every 30 days</span></div>
  <div class="tablewrap"><table><thead><tr><th>App</th><th>Category</th><th>Plan</th><th class="n">Price</th><th>What limits the plan</th><th>Checked</th></tr></thead><tbody>${tracker}</tbody></table></div>
</section>

<section class="hub" aria-labelledby="h-cmp">
  <div class="hubhead"><div><div class="eyebrow">Head to head</div><h2 id="h-cmp">Popular comparisons</h2></div><a class="mono" href="/compare/">All comparisons →</a></div>
  <ul class="linklist">${PAIRS.map(([a, b]) => `<li><a href="${cmpUrl(a, b)}">${esc(a.short)} vs ${esc(b.short)}</a></li>`).join("")}</ul>
</section>

<section class="hub" aria-labelledby="h-log">
  <div class="hubhead"><div><div class="eyebrow">Change log</div><h2 id="h-log">Latest pricing changes</h2></div><a class="mono" href="/price-changes/">Full log →</a></div>
  ${logHtml(LOG.slice(0, 3))}
</section>`
  });
}

function logHtml(entries) {
  return `<div class="log">${entries.map(e => `<div class="logi"><span class="d">${fmtDate(e.date)}</span><div><h3>${e.app ? `<a href="${appUrl(byId[e.app])}">${esc(e.title)}</a>` : esc(e.title)}</h3><p class="muted">${esc(e.body)}</p>${e.source ? `<span class="src">Source: ${esc(e.source)}</span>` : ""}</div></div>`).join("")}</div>`;
}

/* ---------- categories ---------- */
for (const cat of CATS) {
  const list = APPS.filter(a => a.cat === cat.id);
  const pairs = PAIRS.filter(p => p[2].id === cat.id);
  page({
    path: catUrl(cat),
    title: `${cat.metaTitle} (${monShort(site.lastChecked)})`,
    description: `${list.map(a => a.short).join(", ")}: every plan, dated, and what each costs at your volume. ${cat.lede}`,
    crumbs: [[catUrl(cat), cat.title]],
    jsonld: [{ "@context": "https://schema.org", "@type": "ItemList", name: cat.seoTitle,
      itemListElement: list.map((a, i) => ({ "@type": "ListItem", position: i + 1, url: BASE + appUrl(a), name: a.name })) }],
    body: `<section class="pagehead">
  <div class="eyebrow">Category · checked ${fmtDate(site.lastChecked)}</div>
  <h1>${esc(cat.seoTitle)}</h1>
  <p class="lede">${esc(cat.lede)}</p>
  <p class="watch read">${esc(cat.watch)}</p>
</section>
<section class="hub" aria-labelledby="h-sc">
  <div class="hubhead"><div><div class="eyebrow">Monthly cost</div><h2 id="h-sc">What each app costs at typical volumes</h2></div>${calcLink({})}</div>
  ${scenarioTable(cat, list)}
  <p class="read muted">Cheapest plan that fits each volume. “From” means the vendor publishes only a starting price at that size; “not published” means we could not read a price, so we do not show one.</p>
</section>
<section class="hub" aria-labelledby="h-apps">
  <div class="hubhead"><div><div class="eyebrow">Plans</div><h2 id="h-apps">Every plan, as listed</h2></div></div>
  <div class="cards">${list.map(a => appCard(a)).join("")}</div>
</section>
${pairs.length ? `<section class="hub" aria-labelledby="h-pairs">
  <div class="hubhead"><div><div class="eyebrow">Head to head</div><h2 id="h-pairs">Compare two apps</h2></div></div>
  <ul class="linklist">${pairs.map(([a, b]) => `<li><a href="${cmpUrl(a, b)}">${esc(a.short)} vs ${esc(b.short)}</a></li>`).join("")}</ul>
</section>` : ""}`
  });
}

/* ---------- app pages ---------- */
for (const a of APPS) {
  const cat = catById[a.cat];
  const peers = APPS.filter(x => x.cat === a.cat && x.id !== a.id);
  const pairs = PAIRS.filter(p => p[0].id === a.id || p[1].id === a.id);
  const paid = a.plans.filter(p => p.price > 0 && !p.priceLabel).map(p => p.price);
  const lowest = Math.min(...a.plans.map(p => p.price));
  const logs = LOG.filter(e => e.app === a.id);
  const scenRows = cat.scenarios.map(s => { const r = costFor(a, s.v);
    return `<tr><th scope="row">${esc(s.label)}</th><td class="n price">${esc(costCell(r))}</td><td>${esc(r ? r.why : "")}</td></tr>`; }).join("");
  page({
    path: appUrl(a),
    title: `${a.short} pricing (${monShort(a.checked)}): real monthly cost`,
    description: `${a.name} plans read from the official listing on ${fmtDate(a.checked)}: ${a.plans.map(p => `${p.name} ${planPrice(p)}`).join(", ")}. See what it costs at your ${cat.driverLabel}.`,
    crumbs: [[catUrl(cat), cat.title], [appUrl(a), a.short]],
    lastmod: a.checked,
    jsonld: [{ "@context": "https://schema.org", "@type": "SoftwareApplication", name: a.name,
      applicationCategory: "BusinessApplication", operatingSystem: "Shopify", url: a.listing,
      offers: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: lowest, highPrice: paid.length ? Math.max(...paid) : lowest, offerCount: a.plans.length } }],
    body: `<section class="pagehead">
  <div class="eyebrow">${esc(cat.title)} · read ${fmtDate(a.checked)}</div>
  <h1>${esc(a.short)} pricing: what it really costs per month</h1>
  <p class="lede">${esc(a.verdict)}</p>
  ${a.watch ? `<p class="watch read">${esc(a.watch)}</p>` : ""}
  <div class="actions">${outLink(a, `Visit ${a.short}`)}<a class="cta ghost" href="${calcLinkHref({})}">Price my whole stack</a></div>
</section>
<section class="hub" aria-labelledby="h-plans">
  <div class="hubhead"><div><div class="eyebrow">Plans</div><h2 id="h-plans">Every ${esc(a.short)} plan</h2></div><span class="mono muted">USD per month</span></div>
  <div class="tablewrap"><table><thead><tr><th>Plan</th><th class="n">Price</th><th>What limits the plan</th></tr></thead><tbody>
  ${a.plans.map(p => `<tr><th scope="row">${esc(p.name)}</th><td class="n price">${esc(planPrice(p))}</td><td>${esc(p.limits)}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="src">Source: ${esc(a.source)}${a.rating ? ` · Rating on the listing: ★ ${esc(a.rating)}` : ""} · <a href="${esc(a.listing)}" rel="nofollow noopener" target="_blank">Official listing</a></p>
</section>
<section class="hub" aria-labelledby="h-vol">
  <div class="hubhead"><div><div class="eyebrow">At your volume</div><h2 id="h-vol">${esc(a.short)} monthly cost by ${esc(cat.driverLabel)}</h2></div>${calcLink({})}</div>
  <div class="tablewrap"><table><thead><tr><th>Your store</th><th class="n">Monthly cost</th><th>How we got it</th></tr></thead><tbody>${scenRows}</tbody></table></div>
  ${cat.scenarioNote ? `<p class="mono muted">${esc(cat.scenarioNote)}</p>` : ""}
</section>
${peers.length ? `<section class="hub" aria-labelledby="h-alt">
  <div class="hubhead"><div><div class="eyebrow">Alternatives</div><h2 id="h-alt">${esc(a.short)} alternatives, compared</h2></div><a class="mono" href="${catUrl(cat)}">All ${esc(cat.title.toLowerCase())} apps →</a></div>
  <ul class="linklist">${pairs.map(([x, y]) => `<li><a href="${cmpUrl(x, y)}">${esc(x.short)} vs ${esc(y.short)}</a></li>`).join("")}</ul>
</section>` : ""}
${logs.length ? `<section class="hub" aria-labelledby="h-chg"><div class="hubhead"><div><div class="eyebrow">History</div><h2 id="h-chg">${esc(a.short)} pricing changes</h2></div></div>${logHtml(logs)}</section>` : ""}`
  });
}
function calcLinkHref(v) { return "/calculator/?" + new URLSearchParams(Object.assign({}, site.defaultScenario, v)).toString(); }

/* ---------- comparisons ---------- */
for (const [a, b, cat] of PAIRS) {
  /* One-line answer per scenario, without overclaiming on "from" prices. */
  const lines = cat.scenarios.map(s => {
    const ra = costFor(a, s.v), rb = costFor(b, s.v);
    if (!ra || !rb || ra.cost === null || rb.cost === null) return { s, txt: "one price is not published", sure: false };
    if (ra.cost === rb.cost) return { s, txt: ra.from || rb.from ? "same starting price" : "same price", sure: !(ra.from || rb.from) };
    const [lo, hi, rlo, rhi] = ra.cost < rb.cost ? [a, b, ra, rb] : [b, a, rb, ra];
    return { s, win: lo, txt: `${lo.short} is cheaper (${costCell(rlo)} vs ${costCell(rhi)})`, sure: !rlo.from };
  });
  const winsA = lines.filter(l => l.win === a && l.sure).length, winsB = lines.filter(l => l.win === b && l.sure).length;
  const summary = winsA === 0 && winsB === 0
    ? `No clear winner from published prices: at most sizes one of the two vendors lists only a starting price. The table shows exactly what each publishes.`
    : winsA === winsB
    ? `Neither app is cheaper at every size: it depends on your ${cat.driverLabel}. The table shows where each one wins.`
    : `${(winsA > winsB ? a : b).short} costs less in ${Math.max(winsA, winsB)} of the ${cat.scenarios.length} store sizes we priced. Where a vendor publishes only a starting price, we do not count it as a win.`;
  const title = `${a.short} vs ${b.short}: which costs less? (${monShort(site.lastChecked)})`;
  page({
    path: cmpUrl(a, b),
    title,
    description: `${a.short} vs ${b.short}: monthly cost at ${cat.scenarios.length} store sizes, every plan side by side, read from the official listings on ${fmtDate(site.lastChecked)}.`,
    crumbs: [["/compare/", "Comparisons"], [cmpUrl(a, b), `${a.short} vs ${b.short}`]],
    body: `<section class="pagehead">
  <div class="eyebrow">${esc(cat.title)} · compared ${fmtDate(site.lastChecked)}</div>
  <h1>${esc(a.short)} vs ${esc(b.short)}: the real monthly cost</h1>
  <p class="lede">${esc(summary)}</p>
</section>
<section class="hub" aria-labelledby="h-cost">
  <div class="hubhead"><div><div class="eyebrow">Monthly cost</div><h2 id="h-cost">Side by side at ${cat.scenarios.length} store sizes</h2></div>${calcLink({})}</div>
  ${scenarioTable(cat, [a, b])}
  <ul class="prose" style="padding-left:20px">${lines.map(l => `<li><b>${esc(l.s.label)}:</b> ${esc(l.txt)}.</li>`).join("")}</ul>
</section>
<section class="hub" aria-labelledby="h-pl">
  <div class="hubhead"><div><div class="eyebrow">Plans</div><h2 id="h-pl">Every plan, as listed</h2></div></div>
  <div class="cards">${appCard(a)}${appCard(b)}</div>
</section>
<section class="hub" aria-labelledby="h-pick">
  <div class="hubhead"><div><div class="eyebrow">Verdict</div><h2 id="h-pick">Which one to pick</h2></div></div>
  <div class="prose">
    <p><b>Pick ${esc(a.short)}</b> if this matters most: ${esc(a.verdict)}</p>
    <p><b>Pick ${esc(b.short)}</b> if this matters most: ${esc(b.verdict)}</p>
    <p class="muted">Not sure about your volume? Enter it in the <a href="${calcLinkHref({})}">cost calculator</a>, which also prices the rest of your app stack.</p>
  </div>
  <div class="actions">${outLink(a, `Visit ${a.short}`)}${outLink(b, `Visit ${b.short}`, "cta ghost")}</div>
</section>`
  });
}

/* ---------- compare index ---------- */
page({
  path: "/compare/",
  title: `Shopify app comparisons: real cost head to head (${monthYear(site.lastChecked)})`,
  description: `${PAIRS.length} head-to-head Shopify app price comparisons at several store sizes, from plans read on the official listings.`,
  crumbs: [["/compare/", "Comparisons"]],
  body: `<section class="pagehead"><div class="eyebrow">Head to head</div><h1>Shopify app comparisons</h1><p class="lede">Two apps, the same store, the real monthly bill. Each comparison prices both apps at several volumes from plans we read and dated.</p></section>
${CATS.map(cat => { const ps = PAIRS.filter(p => p[2].id === cat.id); return ps.length ? `<section class="hub"><div class="hubhead"><h2><a href="${catUrl(cat)}" style="color:inherit">${esc(cat.title)}</a></h2></div><ul class="linklist">${ps.map(([a, b]) => `<li><a href="${cmpUrl(a, b)}">${esc(a.short)} vs ${esc(b.short)}</a></li>`).join("")}</ul></section>` : ""; }).join("")}`
});

/* ---------- calculator ---------- */
page({
  path: "/calculator/",
  title: `Shopify app cost calculator: your monthly app bill (${monthYear(site.lastChecked)})`,
  description: "Enter your orders, contacts, subscribers and words. See the cheapest plan that fits in each category, with the formula behind every number.",
  crumbs: [["/calculator/", "Cost calculator"]],
  calc: true,
  body: `<section class="pagehead"><div class="eyebrow">Cost calculator</div><h1>Your monthly Shopify app bill</h1>
<p class="lede">Enter your store's numbers. For each category we pick the cheapest plan that fits, and show the formula. When a vendor does not publish the price at your volume, we say so instead of guessing.</p>
<p class="mono muted">The page address updates as you type, so you can bookmark or share your result.</p></section>
${calculatorBlock()}`
});

/* ---------- change log ---------- */
page({
  path: "/price-changes/",
  title: `Shopify app price changes: dated log (${monthYear(site.lastChecked)})`,
  description: "Every pricing and terms change we spot on the Shopify app listings we track, with the date and the source.",
  crumbs: [["/price-changes/", "Price changes"]],
  lastmod: LOG.length ? LOG[0].date : site.lastChecked,
  body: `<section class="pagehead"><div class="eyebrow">Change log</div><h1>Pricing and terms changes</h1><p class="lede">When a plan, price or limit changes on a listing we track, it goes here with the date and the source.</p></section>
${logHtml(LOG)}`
});

/* ---------- methodology ---------- */
page({
  path: "/methodology/",
  title: `How ${site.name} checks Shopify app prices`,
  description: "Where every price comes from, how often it is re-read, and how monthly costs are calculated.",
  crumbs: [["/methodology/", "Methodology"]],
  body: `<section class="pagehead"><div class="eyebrow">Methodology</div><h1>How every number is built</h1></section>
<div class="method">
  <div><span class="k">01</span><h3>Read at the source</h3><p>Each plan comes from the app's official Shopify App Store listing, or the vendor's own help center when the listing is silent. Every app page names its source and links to it.</p></div>
  <div><span class="k">02</span><h3>Dated, then re-read</h3><p>Every price carries the date it was read. Each listing is re-read automatically every day. When one changes, the change goes into the <a href="/price-changes/">change log</a> with the date and the source.</p></div>
  <div><span class="k">03</span><h3>Cost at your volume</h3><p>Plans charge on orders, contacts, subscribers or words. The calculator applies each vendor's published rule and shows the formula.</p></div>
  <div><span class="k">04</span><h3>No guessing</h3><p>When a vendor publishes only a starting price, we show “from” and flag it. A price we have not read is never shown as a number.</p></div>
</div>
<div class="prose"><h2>Independence</h2><p>Affiliate commissions never change a price, a ranking or a verdict. Apps without an affiliate program are listed and compared the same way. See the <a href="/disclosure/">affiliate disclosure</a>.</p>
<p>Spotted a price that changed? Email <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>.</p></div>`
});

/* ---------- disclosure ---------- */
page({
  path: "/disclosure/",
  title: `Affiliate disclosure · ${site.name}`,
  description: `How ${site.name} earns money and why it does not change the numbers.`,
  crumbs: [["/disclosure/", "Affiliate disclosure"]],
  body: `<section class="pagehead"><div class="eyebrow">Disclosure</div><h1>Affiliate disclosure</h1></section>
<div class="prose">
<p>${esc(site.name)} is free to use. Some “Visit” buttons are affiliate links: if you install or subscribe through them, the app developer may pay us a commission. You pay the same price.</p>
<p>Affiliate links are marked in the page code with <code>rel="sponsored"</code>. They never change the order of apps, the prices shown, the cheapest-plan pick in the calculator, or our verdicts. Apps without a program are compared the same way.</p>
<p>${esc(site.name)} is not affiliated with, endorsed by or sponsored by Shopify Inc. or any app developer listed. Shopify is a trademark of Shopify Inc.</p>
</div>`
});

/* ---------- 404 ---------- */
page({
  path: "/404.html", noindex: true,
  title: `Page not found · ${site.name}`, description: "This page does not exist.",
  body: `<section class="pagehead"><div class="eyebrow">404</div><h1>This page does not exist.</h1><p class="lede">Try the <a href="/calculator/">cost calculator</a> or the <a href="/compare/">comparisons</a>.</p></section>`
});

/* ---------- redirects, sitemap, robots, headers, favicon ---------- */
/* /go/<app>/ sends visitors to the affiliate URL when set, else the official listing.
   _redirects works on both Netlify and Cloudflare Pages. */
const redirects = APPS.map(a => { const to = a.affiliate.url || a.listing;
  return `/go/${a.slug}/  ${to}  302\n/go/${a.slug}  ${to}  302`; }).join("\n");
fs.writeFileSync(path.join(OUT, "_redirects"), redirects + "\n");

fs.writeFileSync(path.join(OUT, "_headers"), `/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/go/*
  X-Robots-Tag: noindex, nofollow
`);

fs.writeFileSync(path.join(OUT, "robots.txt"), `User-agent: *\nDisallow: /go/\n\nSitemap: ${BASE}/sitemap.xml\n`);
fs.writeFileSync(path.join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url><loc>${BASE}${p.path}</loc><lastmod>${p.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`);
fs.writeFileSync(path.join(OUT, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b7a5a"/><path d="M18 20v24M28 20v24M38 20v24M48 20v24M14 38l40-12" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`);

console.log(`Built ${pages.length} indexable pages + 404 into dist/ (base URL ${BASE})`);
console.log(`  ${APPS.length} app pages, ${CATS.length} category pages, ${PAIRS.length} comparisons`);
