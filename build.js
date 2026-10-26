#!/usr/bin/env node
/* Static site build. No dependencies: `node build.js` writes everything to dist/.
   Edit data/*.json, then rebuild. SITE_URL (env) overrides baseUrl in data/site.json. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { costs, cheapest, usd2, setApps } = require("./src/costs.js");

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
setApps(APPS); /* plan prices, limits and fees come from data/apps.json */

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
const costFor = (app, v) => (costs(Object.assign({}, site.defaultScenario, v))[app.cat] || []).find(r => r.id === app.id) || null;

/* Categories the calculator covers: those whose scenarios only use calculator inputs. */
const CALC_INPUTS = ["orders", "contacts", "emails", "subs", "aov", "words", "langs", "products"];
const hasCost = c => c.scenarios && c.scenarios.length > 0;
const CALC_CATS = CATS.filter(c => hasCost(c) && c.scenarios.every(s => Object.keys(s.v).every(k => CALC_INPUTS.includes(k))));

/* Plan helpers for FAQs and price-only categories. */
const realFree = a => a.plans.find(p => p.price === 0 && !p.testOnly);
const paidPlans = a => a.plans.filter(p => p.price > 0);
const planWord = name => /plan$/i.test(name) ? name : `${name} plan`;
const midScenario = c => c.scenarios[Math.floor((c.scenarios.length - 1) / 2)];
const lcfirst = t => t.charAt(0).toLowerCase() + t.slice(1);
const ucfirst = t => t.charAt(0).toUpperCase() + t.slice(1);
const andList = arr => arr.length < 2 ? arr.join("") : `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`;
const sizeText = s => s.label.toLowerCase().replace(/ · /g, " and ");
const faqCost = r => r.cost === 0 ? "nothing ($0)" : costCell(r);

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
  ["/apps/", "All apps"],
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

function page({ path: p, title, description, body, crumbs = [], jsonld = [], faq = [], calc = false, lastmod = site.lastChecked, noindex = false }) {
  const ld = [...jsonld];
  if (faq.length) {
    ld.push({ "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
    body += faqHtml(faq);
  }
  if (crumbs.length) ld.push(crumbsLd(crumbs));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(clip(description))}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${BASE}${p}">`}
${(site.verificationMeta || []).map(m => `<meta name="${esc(m.name)}" ${m.value !== undefined ? `value="${esc(m.value)}"` : `content="${esc(m.content)}"`}>`).join("\n")}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(clip(description, 200))}">
<meta property="og:url" content="${BASE}${p}">
<meta property="og:image" content="${BASE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
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
  <nav aria-label="Categories">${CATS.map(c => `<a href="${catUrl(c)}">${esc(c.title)}</a>`).join("")}</nav>
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

function faqHtml(faq) {
  return `<section class="hub" aria-labelledby="h-faq">
  <div class="hubhead"><div><div class="eyebrow">FAQ</div><h2 id="h-faq">Questions merchants ask</h2></div></div>
  <div class="faq">${faq.map(([q, a]) => `<div><h3>${esc(q)}</h3><p>${esc(a)}</p></div>`).join("")}</div>
</section>`;
}

/* For categories priced by features (no volume to compute): entry prices side by side. */
function entryTable(apps) {
  return `<div class="tablewrap"><table><thead><tr><th>App</th><th>Free plan</th><th class="n">Cheapest paid plan</th><th class="n">Top plan</th></tr></thead><tbody>
  ${apps.map(a => { const f = realFree(a), paid = paidPlans(a), lo = paid[0], hi = paid[paid.length - 1];
    return `<tr><th scope="row"><a href="${appUrl(a)}">${esc(a.short)}</a></th><td>${f ? esc(`Yes: ${f.limits}`) : "No"}</td><td class="n price">${lo ? esc(`${planPrice(lo)} (${lo.name})`) : "—"}</td><td class="n price">${hi ? esc(`${planPrice(hi)} (${hi.name})`) : "—"}</td></tr>`; }).join("")}
  </tbody></table></div>`;
}

function calculatorBlock() {
  const d = site.defaultScenario;
  const meta = {
    cats: CALC_CATS.map(c => ({ id: c.id, title: c.title, url: catUrl(c), core: !!c.core })),
    apps: Object.fromEntries(APPS.map(a => [a.id, { short: a.short, url: appUrl(a) }])),
    appsData: APPS.map(a => ({ id: a.id, cat: a.cat, beyond: a.beyond, plans: a.plans.map(p => ({ name: p.name, price: p.price, from: p.from, fits: p.fits, over: p.over, fee: p.fee, limits: p.limits })) }))
  };
  const f = (id, label, val, small, extra = "") =>
    `<div class="field"><label for="c-${id}">${label}</label><input id="c-${id}" name="${id}" type="number" min="0" value="${val}" inputmode="numeric"${extra}>${small ? `<small>${small}</small>` : ""}</div>`;
  return `<div class="bench">
  <form class="inputs" id="calc" novalidate>
    ${f("orders", "Orders per month", d.orders, "Drives review and loyalty app pricing.")}
    ${f("contacts", "Email contacts", d.contacts)}
    ${f("emails", "Emails sent per month", d.emails)}
    ${f("subs", "Active subscribers", d.subs)}
    ${f("aov", "Average subscription order (USD)", d.aov, "Used for per-renewal fees and revenue-based plans. One renewal per subscriber per month assumed.", ' step="any"')}
    ${f("words", "Words on your store", d.words, "Product pages, collections, theme text.")}
    ${f("langs", "Extra languages", d.langs, "", ' max="20"')}
    ${f("products", "Products in your catalog", d.products, "Some translation apps price by products.")}
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
  const lines = CALC_CATS.filter(cat => cat.core).map(cat => { const b = cheapest(c[cat.id]); total += b.cost; if (b.from) anyFrom = true;
    return `<div class="l"><span>${esc(cat.title)} · ${esc(byId[b.id].short)}</span><span>${(b.from ? "from " : "") + usd2(b.cost)}</span></div>`; }).join("");
  const d = site.defaultScenario;
  const planCount = APPS.reduce((n, a) => n + a.plans.length, 0);
  const tracker = APPS.flatMap(a => a.plans.map((p, i) => `<tr>${i === 0
    ? `<td rowspan="${a.plans.length}"><a href="${appUrl(a)}">${esc(a.name)}</a><span class="sub">${esc(a.source)}</span></td><td rowspan="${a.plans.length}"><a href="${catUrl(catById[a.cat])}">${esc(catById[a.cat].title)}</a></td>` : ""}
<td>${esc(p.name)}</td><td class="n price">${esc(planPrice(p))}</td><td>${esc(p.limits)}</td><td class="mono">${fmtDate(a.checked)}</td></tr>`)).join("");
  page({
    path: "/",
    title: `${site.name}: what Shopify apps really cost at your volume`,
    description: `Dated price tracker and cost calculator for ${APPS.length} Shopify apps: ${CATS.map(c => c.title.toLowerCase()).join(", ")}. Every plan read from the official listing.`,
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
    <small>Cheapest plan in each category that fits ${d.orders.toLocaleString("en-US")} orders, ${d.contacts.toLocaleString("en-US")} contacts, ${d.subs} subscribers and ${d.langs} extra language. Change the numbers in the calculator.</small>
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
  <ul class="linklist">${CATS.flatMap(cat => PAIRS.filter(p => p[2].id === cat.id).slice(0, 2)).map(([a, b]) => `<li><a href="${cmpUrl(a, b)}">${esc(a.short)} vs ${esc(b.short)}</a></li>`).join("")}</ul>
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
    faq: catFaq(cat, list),
    jsonld: [{ "@context": "https://schema.org", "@type": "ItemList", name: cat.seoTitle,
      itemListElement: list.map((a, i) => ({ "@type": "ListItem", position: i + 1, url: BASE + appUrl(a), name: a.name })) }],
    body: `<section class="pagehead">
  <div class="eyebrow">Category · checked ${fmtDate(site.lastChecked)}</div>
  <h1>${esc(cat.seoTitle)}</h1>
  <p class="lede">${esc(cat.lede)}</p>
  <p class="watch read">${esc(cat.watch)}</p>
</section>
${hasCost(cat) ? `<section class="hub" aria-labelledby="h-sc">
  <div class="hubhead"><div><div class="eyebrow">Monthly cost</div><h2 id="h-sc">What each app costs at typical volumes</h2></div>${CALC_CATS.includes(cat) ? calcLink({}) : ""}</div>
  ${scenarioTable(cat, list)}
  <p class="read muted">Cheapest plan that fits each volume. “From” means the vendor publishes only a starting price at that size; “not published” means we could not read a price, so we do not show one.</p>
</section>` : `<section class="hub" aria-labelledby="h-sc">
  <div class="hubhead"><div><div class="eyebrow">Entry prices</div><h2 id="h-sc">Free plans and price range</h2></div></div>
  ${entryTable(list)}
</section>`}
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
    description: `${a.name} plans read from the official listing on ${fmtDate(a.checked)}: ${a.plans.map(p => `${p.name} ${planPrice(p)}`).join(", ")}.${hasCost(cat) ? ` See what it costs at your ${cat.driverLabel}.` : ""}`,
    crumbs: [[catUrl(cat), cat.title], [appUrl(a), a.short]],
    lastmod: a.checked,
    faq: appFaq(a, cat),
    jsonld: [{ "@context": "https://schema.org", "@type": "SoftwareApplication", name: a.name,
      applicationCategory: "BusinessApplication", operatingSystem: "Shopify", url: a.listing,
      offers: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: lowest, highPrice: paid.length ? Math.max(...paid) : lowest, offerCount: a.plans.length } }],
    body: `<section class="pagehead">
  <div class="eyebrow">${esc(cat.title)} · read ${fmtDate(a.checked)}</div>
  <h1>${esc(a.short)} pricing: what it really costs per month</h1>
  <p class="lede">${esc(a.verdict)}</p>
  ${a.watch ? `<p class="watch read">${esc(a.watch)}</p>` : ""}
  <div class="actions">${outLink(a, `Visit ${a.short}`)}${CALC_CATS.includes(cat) ? `<a class="cta ghost" href="${calcLinkHref({})}">Price my whole stack</a>` : `<a class="cta ghost" href="${catUrl(cat)}">Compare ${esc(cat.title.toLowerCase())} apps</a>`}</div>
</section>
<section class="hub" aria-labelledby="h-plans">
  <div class="hubhead"><div><div class="eyebrow">Plans</div><h2 id="h-plans">Every ${esc(a.short)} plan</h2></div><span class="mono muted">USD per month</span></div>
  <div class="tablewrap"><table><thead><tr><th>Plan</th><th class="n">Price</th><th>What limits the plan</th></tr></thead><tbody>
  ${a.plans.map(p => `<tr><th scope="row">${esc(p.name)}</th><td class="n price">${esc(planPrice(p))}</td><td>${esc(p.limits)}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="src">Source: ${esc(a.source)}${a.rating ? ` · Rating on the listing: ★ ${esc(a.rating)}` : ""} · <a href="${esc(a.listing)}" rel="nofollow noopener" target="_blank">Official listing</a></p>
</section>
${hasCost(cat) ? `<section class="hub" aria-labelledby="h-vol">
  <div class="hubhead"><div><div class="eyebrow">At your volume</div><h2 id="h-vol">${esc(a.short)} monthly cost by ${esc(cat.driverLabel)}</h2></div>${CALC_CATS.includes(cat) ? calcLink({}) : ""}</div>
  <div class="tablewrap"><table><thead><tr><th>Your store</th><th class="n">Monthly cost</th><th>How we got it</th></tr></thead><tbody>${scenRows}</tbody></table></div>
  ${cat.scenarioNote ? `<p class="mono muted">${esc(cat.scenarioNote)}</p>` : ""}
</section>` : ""}
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
  const summary = !hasCost(cat) ? entrySummary(a, b)
    : winsA === 0 && winsB === 0
    ? `No clear winner from published prices: at most sizes one of the two vendors lists only a starting price. The table shows exactly what each publishes.`
    : winsA === winsB
    ? `Neither app is cheaper at every size: it depends on your ${cat.driverLabel}. The table shows where each one wins.`
    : `${(winsA > winsB ? a : b).short} costs less in ${Math.max(winsA, winsB)} of the ${cat.scenarios.length} store sizes we priced. Where a vendor publishes only a starting price, we do not count it as a win.`;
  const title = `${a.short} vs ${b.short}: which costs less? (${monShort(site.lastChecked)})`;
  page({
    path: cmpUrl(a, b),
    title,
    description: hasCost(cat)
      ? `${a.short} vs ${b.short}: monthly cost at ${cat.scenarios.length} store sizes, every plan side by side, read from the official listings on ${fmtDate(site.lastChecked)}.`
      : `${a.short} vs ${b.short}: free plans, entry prices and every plan side by side, read from the official listings on ${fmtDate(site.lastChecked)}.`,
    crumbs: [["/compare/", "Comparisons"], [cmpUrl(a, b), `${a.short} vs ${b.short}`]],
    faq: cmpFaq(a, b, cat, summary),
    body: `<section class="pagehead">
  <div class="eyebrow">${esc(cat.title)} · compared ${fmtDate(site.lastChecked)}</div>
  <h1>${esc(a.short)} vs ${esc(b.short)}: the real monthly cost</h1>
  <p class="lede">${esc(summary)}</p>
</section>
${hasCost(cat) ? `<section class="hub" aria-labelledby="h-cost">
  <div class="hubhead"><div><div class="eyebrow">Monthly cost</div><h2 id="h-cost">Side by side at ${cat.scenarios.length} store sizes</h2></div>${CALC_CATS.includes(cat) ? calcLink({}) : ""}</div>
  ${scenarioTable(cat, [a, b])}
  <ul class="prose" style="padding-left:20px">${lines.map(l => `<li><b>${esc(l.s.label)}:</b> ${esc(l.txt)}.</li>`).join("")}</ul>
</section>` : `<section class="hub" aria-labelledby="h-cost">
  <div class="hubhead"><div><div class="eyebrow">Entry prices</div><h2 id="h-cost">Free plans and price range</h2></div></div>
  ${entryTable([a, b])}
</section>`}
<section class="hub" aria-labelledby="h-pl">
  <div class="hubhead"><div><div class="eyebrow">Plans</div><h2 id="h-pl">Every plan, as listed</h2></div></div>
  <div class="cards">${appCard(a)}${appCard(b)}</div>
</section>
<section class="hub" aria-labelledby="h-pick">
  <div class="hubhead"><div><div class="eyebrow">Verdict</div><h2 id="h-pick">Which one to pick</h2></div></div>
  <div class="prose">
    <p><b>Pick ${esc(a.short)}</b> if this matters most: ${esc(a.verdict)}</p>
    <p><b>Pick ${esc(b.short)}</b> if this matters most: ${esc(b.verdict)}</p>
    ${CALC_CATS.includes(cat) ? `<p class="muted">Not sure about your volume? Enter it in the <a href="${calcLinkHref({})}">cost calculator</a>, which also prices the rest of your app stack.</p>` : `<p class="muted">See every ${esc(cat.title.toLowerCase())} app we track on the <a href="${catUrl(cat)}">category page</a>.</p>`}
  </div>
  <div class="actions">${outLink(a, `Visit ${a.short}`)}${outLink(b, `Visit ${b.short}`, "cta ghost")}</div>
</section>`
  });
}

/* ---------- FAQ text, built only from the data ---------- */
function freeAnswer(a) {
  const f = realFree(a), paid = paidPlans(a);
  if (f) return `Yes. The ${planWord(f.name)} costs $0: ${lcfirst(f.limits.replace(/\.$/, ""))}.`;
  return paid.length ? `No. The cheapest plan is ${paid[0].name} at ${planPrice(paid[0])} a month (${paid[0].limits.replace(/\.$/, "")}).` : "No.";
}
function rangeAnswer(a) {
  const paid = paidPlans(a);
  if (!paid.length) return `${a.short} is free.`;
  const lo = paid.reduce((x, y) => (y.price < x.price ? y : x)), hi = paid.reduce((x, y) => (y.price > x.price ? y : x));
  let t = lo === hi ? `${a.short} has one paid plan, ${lo.name}, at ${planPrice(lo)} a month.`
    : `Paid plans run from ${usd(lo.price)} (${lo.name}) to ${usd(hi.price)}${hi.from ? " or more" : ""} (${hi.name}) a month, read on the Shopify App Store listing on ${fmtDate(a.checked)}.`;
  if (paid.some(p => p.from)) t += " Some plans show only a starting price that rises with your volume.";
  const fees = paid.filter(p => p.fee);
  if (fees.length) t += ` Plans also charge a fee on every transaction (${fees.map(p => `${p.name} ${p.fee.pct}%`).join(", ")}).`;
  return t;
}
function appFaq(a, cat) {
  const q = [[`Does ${a.short} have a free plan?`, freeAnswer(a)], [`How much does ${a.short} cost per month?`, rangeAnswer(a)]];
  if (hasCost(cat)) {
    const s = midScenario(cat), r = costFor(a, s.v);
    if (r) q.push([`How much does ${a.short} cost for ${sizeText(s)}?`,
      r.cost === null ? `The listing does not publish a price at that size. ${r.why}` : `${ucfirst(faqCost(r))} a month. ${r.why}`]);
    const peers = APPS.filter(x => x.cat === a.cat).map(x => ({ x, r: costFor(x, s.v) })).filter(o => o.r && o.r.cost !== null && !o.r.from);
    const others = peers.filter(o => o.x.id !== a.id).sort((u, v) => u.r.cost - v.r.cost);
    if (others.length) {
      const best = others[0];
      q.push([`What is the cheapest alternative to ${a.short}?`,
        `At ${sizeText(s)}, ${best.x.short} costs ${faqCost(best.r)} a month, the lowest published price among the other ${cat.noun}s we track. See the ${a.short} vs ${best.x.short} comparison for the plans side by side.`]);
    }
  }
  return q;
}
function entrySummary(a, b) {
  const fa = realFree(a), fb = realFree(b), pa = paidPlans(a)[0], pb = paidPlans(b)[0];
  const free = fa && fb ? "Both have a free plan." : fa ? `Only ${a.short} has a free plan.` : fb ? `Only ${b.short} has a free plan.` : "Neither has a free plan.";
  if (!pa || !pb) return free;
  const lo = pa.price <= pb.price ? [a, pa] : [b, pb], hi = lo[0] === a ? [b, pb] : [a, pa];
  return `${free} ${lo[0].short}'s cheapest paid plan is ${planPrice(lo[1])}, against ${planPrice(hi[1])} for ${hi[0].short}. These apps price by features, so compare what each plan includes.`;
}
function cmpFaq(a, b, cat, summary) {
  return [[`Which is cheaper, ${a.short} or ${b.short}?`, summary],
    [`Does ${a.short} have a free plan?`, freeAnswer(a)],
    [`Does ${b.short} have a free plan?`, freeAnswer(b)]];
}
function catFaq(cat, list) {
  const free = list.filter(realFree).map(a => a.short);
  const q = [];
  if (hasCost(cat)) {
    const s = midScenario(cat);
    const rows = list.map(a => ({ a, r: costFor(a, s.v) })).filter(o => o.r && o.r.cost !== null && !o.r.from).sort((u, v) => u.r.cost - v.r.cost);
    if (rows.length) q.push([`What is the cheapest Shopify ${cat.noun}?`,
      `At ${sizeText(s)}, ${rows[0].a.short} costs ${faqCost(rows[0].r)} a month${rows[1] ? `, then ${rows[1].a.short} at ${faqCost(rows[1].r)}` : ""}. The answer changes with your volume: the table above shows each size.`]);
  }
  q.push([`Which Shopify ${cat.noun}s have a free plan?`,
    free.length ? `${andList(free)} ${free.length > 1 ? "have free plans. Their" : "has a free plan. Its"} limits are in the plan tables above.` : `None of the ${list.length} ${cat.noun}s we track has a free plan.`]);
  return q;
}

/* ---------- all apps index ---------- */
page({
  path: "/apps/",
  title: `All ${APPS.length} Shopify apps we track: pricing and plans (${monShort(site.lastChecked)})`,
  description: `Pricing for ${APPS.length} Shopify apps across ${CATS.length} categories, read from the official listings and re-checked daily.`,
  crumbs: [["/apps/", "All apps"]],
  body: `<section class="pagehead"><div class="eyebrow">All apps</div><h1>Every Shopify app we track</h1><p class="lede">${APPS.length} apps in ${CATS.length} categories. Each page lists every plan, dated, with what it costs at your volume.</p></section>
${CATS.map(cat => `<section class="hub"><div class="hubhead"><h2><a href="${catUrl(cat)}" style="color:inherit">${esc(cat.title)}</a></h2></div>
  <div class="tablewrap"><table><thead><tr><th>App</th><th>Free plan</th><th class="n">Paid plans</th><th>Rating</th></tr></thead><tbody>
  ${APPS.filter(a => a.cat === cat.id).map(a => { const paid = paidPlans(a), f = realFree(a);
    return `<tr><th scope="row"><a href="${appUrl(a)}">${esc(a.short)}</a></th><td>${f ? "Yes" : "No"}</td><td class="n price">${paid.length ? esc(paid.length > 1 ? `${planPrice(paid[0])} – ${planPrice(paid[paid.length - 1])}` : planPrice(paid[0])) : "—"}</td><td class="mono">${a.rating ? esc("★ " + a.rating) : ""}</td></tr>`; }).join("")}
  </tbody></table></div></section>`).join("")}`
});

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
  description: "Enter your orders, contacts, subscribers, words and products. See the cheapest plan that fits in each category, with the formula behind every number.",
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
  <div><span class="k">03</span><h3>Cost at your volume</h3><p>Plans charge on orders, contacts, subscribers, revenue, words, products or pages. The calculator applies each vendor's published rule and shows the formula.</p></div>
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
if (fs.existsSync(path.join(ROOT, "src", "og.png"))) fs.copyFileSync(path.join(ROOT, "src", "og.png"), path.join(OUT, "og.png"));
if (site.indexNowKey) fs.writeFileSync(path.join(OUT, `${site.indexNowKey}.txt`), site.indexNowKey);
fs.writeFileSync(path.join(OUT, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b7a5a"/><path d="M18 20v24M28 20v24M38 20v24M48 20v24M14 38l40-12" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`);

console.log(`Built ${pages.length} indexable pages + 404 into dist/ (base URL ${BASE})`);
console.log(`  ${APPS.length} app pages, ${CATS.length} category pages, ${PAIRS.length} comparisons`);
