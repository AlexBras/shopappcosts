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
const costCell = r => !r ? "n/a" : r.cost === null ? "not published" : (r.from ? "from " : "") + usd(Math.round(r.cost * 100) / 100);

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
const CALC_INPUTS = ["orders", "contacts", "emails", "subs", "aov", "words", "langs", "products", "pages", "upsellRev"];
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
  ["/apps/", "Apps", ""],
  ["/compare/", "Compare", "hide-sm"],
  ["/price-changes/", "Price changes", "hide-md"]
];
const pages = []; /* [{path, lastmod}] for the sitemap */
const n = v => v.toLocaleString("en-US");
const money = v => usd(Math.round(v * 100) / 100);
const AV_COLORS = ["#0c7a57", "#e0484d", "#3550f0", "#ef6c1a", "#8b4fd1", "#0f9d8a", "#c2410c", "#0369a1"];
APPS.forEach((a, i) => { a.color = AV_COLORS[i % AV_COLORS.length]; });
const avatar = a => `<span class="av" style="background:${a.color}" aria-hidden="true">${esc(a.short.charAt(0).toUpperCase())}</span>`;
const catShort = c => c.title.replace(/ & .*$/, "");

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

function page({ path: p, title, description, body, crumbs = [], jsonld = [], faq = [], faqTitle = "Questions merchants ask", calc = false, lastmod = site.lastChecked, noindex = false }) {
  const ld = [...jsonld];
  if (faq.length) {
    ld.push({ "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
    body += faqHtml(faq, faqTitle);
  }
  if (crumbs.length) ld.push(crumbsLd(crumbs));
  const logo = `<a class="logo" href="/"><i></i><span>${esc(site.nameParts[0])}<b>${esc(site.nameParts[1])}</b></span></a>`;
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
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${ASSET["style.css"]}">
${ld.map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("\n")}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar"><div class="wrap">
  ${logo}
  <nav aria-label="Main">${NAV.map(([u, t, c]) => `<a href="${u}"${c ? ` class="${c}"` : ""}${u === p ? ' aria-current="page"' : ""}>${esc(t)}</a>`).join("")}<a class="btn" href="/calculator/">Calculator</a></nav>
</div></header>
<div class="wrap">
${crumbsHtml(crumbs)}
<main id="main">
${body}
</main>
</div>
<footer class="site"><div class="wrap">
  ${logo}
  <nav aria-label="Categories">${CATS.map(c => `<a href="${catUrl(c)}">${esc(c.title)}</a>`).join("")}</nav>
  <nav aria-label="Footer"><a href="/calculator/">Calculator</a><a href="/apps/">All apps</a><a href="/compare/">Comparisons</a><a href="/price-changes/">Price changes</a><a href="/methodology/">How we calculate</a><a href="/disclosure/">Affiliate disclosure</a><a href="mailto:${esc(site.contactEmail)}">Contact</a></nav>
  <p>${esc(site.name)} is an independent guide, not affiliated with Shopify or with the app developers listed. Some “Visit” links are affiliate links: we may earn a commission at no extra cost to you. It never changes the order or the numbers.</p>
  <p>Prices in USD as shown on the Shopify App Store listings, excluding taxes. Last checked ${fmtDate(site.lastChecked)}.</p>
</div></footer>
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
function faqHtml(faq, title) {
  return `<section class="section narrow" aria-labelledby="h-faq" style="width:100%">
  <div class="shead"><h2 id="h-faq">${esc(title)}</h2></div>
  <div class="faq">${faq.map(([q, a], i) => `<details${i === 0 ? " open" : ""}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
</section>`;
}
function section(id, title, inner, { sub = "", aside = "" } = {}) {
  return `<section class="section" aria-labelledby="h-${id}">
  <div class="shead${aside ? " row" : ""}"><div class="shead"><h2 id="h-${id}">${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div>${aside}</div>
  ${inner}
</section>`;
}
const costShort = r => !r ? "n/a" : r.cost === null ? "Not published" : (r.from ? "from " : "") + money(r.cost) + "/mo";
const fromText = a => { const paid = paidPlans(a); return paid.length ? `${usd(Math.min(...paid.map(p => p.price)))}/mo` : "Free"; };
const calcHref = cat => CALC_CATS.includes(cat) ? `/calculator/?cat=${cat.id}` : catUrl(cat);
const pairLinks = list => `<ul class="links">${list.map(([a, b]) => `<li><a href="${cmpUrl(a, b)}">${esc(a.short)} <span class="muted">vs</span> ${esc(b.short)}</a></li>`).join("")}</ul>`;

function appCard(a) {
  const cat = catById[a.cat];
  const s = hasCost(cat) ? midScenario(cat) : null, r = s ? costFor(a, s.v) : null;
  return `<article class="card">
  <div class="head">${avatar(a)}<div><h3><a href="${appUrl(a)}">${esc(a.short)}</a></h3><small>${esc(cat.title)} · ${a.plans.length} plan${a.plans.length > 1 ? "s" : ""}</small></div></div>
  <p>${esc(a.verdict)}</p>
  <div class="kv"><div><span>Free plan</span><span>${realFree(a) ? "Yes" : "No"}</span></div><div><span>Paid plans from</span><span>${esc(fromText(a))}</span></div>${s ? `<div><span>${esc(s.label.split(" · ")[0])}</span><span>${esc(costShort(r))}</span></div>` : ""}${a.rating ? `<div><span>Rating on the listing</span><span>★ ${esc(a.rating)}</span></div>` : ""}</div>
  <div class="actions"><a class="btn ghost sm" href="${appUrl(a)}">Full pricing</a>${outLink(a, `Visit ${a.short}`, "btn sm")}</div>
</article>`;
}

/* For categories priced by features (no volume to compute): entry prices side by side. */
function entryTable(apps) {
  return `<div class="tablewrap"><table><thead><tr><th>App</th><th>Free plan</th><th class="n">Cheapest paid plan</th><th class="n">Top plan</th></tr></thead><tbody>
  ${apps.map(a => { const f = realFree(a), paid = paidPlans(a), lo = paid[0], hi = paid[paid.length - 1];
    return `<tr><th scope="row"><a href="${appUrl(a)}">${esc(a.short)}</a></th><td>${f ? esc(`Yes: ${f.limits}`) : "No"}</td><td class="n">${lo ? esc(`${planPrice(lo)} (${lo.name})`) : "—"}</td><td class="n">${hi ? esc(`${planPrice(hi)} (${hi.name})`) : "—"}</td></tr>`; }).join("")}
  </tbody></table></div>`;
}

const FIELDS = {
  orders: { label: "Orders per month", unit: "orders", question: "How many orders do you get per month?" },
  contacts: { label: "Email contacts", unit: "contacts", question: "How many email contacts do you have?" },
  emails: { label: "Emails sent per month", unit: "emails", hint: "All campaigns and automations together." },
  subs: { label: "Active subscribers", unit: "subscribers", question: "How many active subscribers do you have?" },
  aov: { label: "Average subscription order", unit: "per order", pre: "$", step: "any", hint: "One renewal per subscriber per month assumed." },
  words: { label: "Words on your store", unit: "words", question: "How many words are on your store?" },
  langs: { label: "Extra languages", unit: "languages" },
  products: { label: "Products in your catalog", unit: "products", hint: "Some apps price by products." },
  pages: { label: "Published pages", unit: "pages", question: "How many pages do you want to publish?" },
  upsellRev: { label: "Upsell revenue per month", unit: "upsell revenue", pre: "$", step: "any", hint: "Extra revenue the app's offers bring in." }
};
function calculatorBlock() {
  const meta = {
    method: "/methodology/",
    fields: FIELDS,
    defaults: Object.assign({ pages: 5, upsellRev: 400 }, site.defaultScenario),
    cats: CALC_CATS.map(c => { const keys = Object.keys(c.scenarios[0].v);
      return { id: c.id, title: c.title, short: catShort(c), url: catUrl(c), keys, preset: midScenario(c).v,
        scenarios: c.scenarios.map(s => ({ chip: s.label.split(" · ")[0], v: s.v })) }; }),
    apps: Object.fromEntries(APPS.map(a => [a.id, { short: a.short, url: appUrl(a), go: goUrl(a), sponsored: !!a.affiliate.url, color: a.color }])),
    appsData: APPS.map(a => ({ id: a.id, cat: a.cat, beyond: a.beyond, plans: a.plans.map(p => ({ name: p.name, price: p.price, from: p.from, fits: p.fits, over: p.over, fee: p.fee, limits: p.limits, testOnly: p.testOnly })) }))
  };
  return `<div class="tool" id="calc-tool">
  <form id="calc" novalidate style="display:flex;flex-direction:column;gap:16px">
    <div class="q"><span class="k">1</span>What kind of app are you looking for?</div>
    <div class="catpick" id="catpick" role="group" aria-label="App category"></div>
    <div id="fields" style="display:flex;flex-direction:column;gap:16px"></div>
  </form>
  <div class="results" id="results" aria-live="polite"><noscript><p>The calculator needs JavaScript. Every price is also listed on the <a href="/apps/">app pages</a>.</p></noscript></div>
</div>
<script id="calc-meta" type="application/json">${JSON.stringify(meta).replace(/</g, "\\u003c")}</script>`;
}

/* Scenario table: one row per store size, one column per app, the cheapest marked. */
function scenarioTable(cat, apps) {
  const rows = cat.scenarios.map(s => {
    const cells = apps.map(a => costFor(a, s.v));
    const known = cells.filter(r => r && r.cost !== null).map(r => r.cost);
    const min = known.length > 1 ? Math.min(...known) : null;
    return `<tr><th scope="row">${esc(s.label)}</th>${cells.map(r =>
      `<td class="n${min !== null && r && r.cost === min && known.filter(x => x === min).length < known.length ? " win" : ""}">${esc(costCell(r))}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="tablewrap"><table><thead><tr><th>Your store</th>${apps.map(a => `<th class="n">${esc(a.short)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
${cat.scenarioNote ? `<p class="fine">${esc(cat.scenarioNote)}</p>` : ""}`;
}

function logHtml(entries) {
  return `<div class="log">${entries.map(e => `<div class="logi"><span class="d">${fmtDate(e.date)}</span><div><h3>${e.app ? `<a href="${appUrl(byId[e.app])}">${esc(e.title)}</a>` : esc(e.title)}</h3><p>${esc(e.body)}</p>${e.source ? `<span class="src">Source: ${esc(e.source)}</span>` : ""}</div></div>`).join("")}</div>`;
}

/* ---------- home ---------- */
{
  const catCards = CATS.map(cat => { const list = APPS.filter(a => a.cat === cat.id);
    let line = "Priced by features";
    if (hasCost(cat)) { const s = midScenario(cat);
      const best = list.map(a => ({ a, r: costFor(a, s.v) })).filter(o => o.r && o.r.cost !== null).sort((x, y) => x.r.cost - y.r.cost)[0];
      if (best) line = `From ${money(best.r.cost)}/mo at ${s.label.split(" · ")[0]} (${best.a.short})`; }
    return `<article class="card"><div class="head"><div><h3><a href="${catUrl(cat)}">${esc(cat.title)}</a></h3><small>${list.length} apps · ${esc(list.map(a => a.short).slice(0, 3).join(", "))}${list.length > 3 ? "…" : ""}</small></div></div><p>${esc(line)}</p><div class="actions"><a class="btn ghost sm" href="${catUrl(cat)}">Compare</a>${CALC_CATS.includes(cat) ? `<a class="btn sm" href="${calcHref(cat)}">Calculate</a>` : ""}</div></article>`; }).join("");
  page({
    path: "/",
    title: `${site.name}: what Shopify apps really cost at your volume`,
    description: `Dated price tracker and cost calculator for ${APPS.length} Shopify apps: ${CATS.map(c => c.title.toLowerCase()).join(", ")}. Every plan read from the official listing.`,
    jsonld: [{ "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: BASE + "/" }],
    calc: true,
    faq: homeFaq(),
    body: `<section class="hero">
  <span class="pill"><span class="dot"></span>${APPS.length} Shopify apps · prices checked ${fmtDate(site.lastChecked)}</span>
  <h1>Find the cheapest Shopify app for your store.</h1>
  <p class="lede">Pick a category, enter your numbers. We show what each app really costs per month, from its official App Store listing.</p>
  ${calculatorBlock()}
</section>
${section("cats", "Browse by category", `<div class="grid">${catCards}</div>`)}
${section("how", "How it works", `<div class="steps">
  <div class="step"><span class="n">Step 1</span><h3>Pick a category</h3><p>Reviews, email, subscriptions, translation and more: each is priced on different numbers.</p></div>
  <div class="step"><span class="n">Step 2</span><h3>Enter your volume</h3><p>Orders, contacts, subscribers or words. We pick the cheapest plan that fits on every app.</p></div>
  <div class="step"><span class="n">Step 3</span><h3>Compare and choose</h3><p>Results are sorted by monthly price, with the formula behind each number. Prices are re-read every day.</p></div>
</div>`)}
${section("cmp", "Popular comparisons", pairLinks(CATS.flatMap(cat => PAIRS.filter(p => p[2].id === cat.id).slice(0, 2))), { aside: `<a href="/compare/">All ${PAIRS.length} comparisons →</a>` })}
${LOG.length ? section("log", "Latest price changes", logHtml(LOG.slice(0, 3)), { aside: `<a href="/price-changes/">Full log →</a>` }) : ""}`
  });
}
function homeFaq() {
  const q = [];
  const rev = catById.reviews;
  if (rev && hasCost(rev)) { const s = midScenario(rev);
    const rows = APPS.filter(a => a.cat === rev.id).map(a => ({ a, r: costFor(a, s.v) })).filter(o => o.r && o.r.cost !== null && !o.r.from).sort((u, v) => u.r.cost - v.r.cost);
    if (rows.length) q.push([`What is the cheapest Shopify review app?`, `At ${sizeText(s)}, ${rows[0].a.short} costs ${faqCost(rows[0].r)} a month. Pick another category or enter your own volume in the calculator above.`]); }
  q.push([`How up to date are these prices?`, `Every plan is read from the app's official Shopify App Store listing and re-read automatically every day. Each app page shows the date it was last confirmed. The last full check was on ${fmtDate(site.lastChecked)}.`]);
  q.push([`Is ${site.name} paid by these apps?`, `Some “Visit” links are affiliate links, so we may earn a commission if you install an app. It never changes the order, the prices or the cheapest pick: results are always sorted by price.`]);
  return q;
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
  <h1>${esc(cat.seoTitle)}</h1>
  <p class="lede">${esc(cat.lede)}</p>
  ${CALC_CATS.includes(cat) ? `<div class="actions"><a class="btn" href="${calcHref(cat)}">Calculate for my store</a></div>` : ""}
  ${cat.watch ? `<p class="note"><b>Good to know:</b> ${esc(cat.watch)}</p>` : ""}
</section>
${hasCost(cat)
  ? section("sc", "Monthly cost at typical store sizes", scenarioTable(cat, list), { sub: "The cheapest plan that fits each size. ✓ marks the lowest price in each row; “from” means the vendor publishes only a starting price." })
  : section("sc", "Free plans and price range", entryTable(list), { sub: "These apps price by features, not volume." })}
${section("apps", "Every app", `<div class="grid">${list.map(appCard).join("")}</div>`)}
${pairs.length ? section("pairs", "Compare two apps", pairLinks(pairs)) : ""}`
  });
}

/* ---------- app pages ---------- */
for (const a of APPS) {
  const cat = catById[a.cat];
  const pairs = PAIRS.filter(p => p[0].id === a.id || p[1].id === a.id);
  const paid = a.plans.filter(p => p.price > 0 && !p.priceLabel).map(p => p.price);
  const lowest = Math.min(...a.plans.map(p => p.price));
  const logs = LOG.filter(e => e.app === a.id);
  const scenRows = hasCost(cat) ? cat.scenarios.map(s => { const r = costFor(a, s.v);
    return `<tr><th scope="row">${esc(s.label)}</th><td class="n">${esc(costCell(r))}</td><td class="why">${esc(r ? r.why : "")}</td></tr>`; }).join("") : "";
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
  <div class="title">${avatar(a)}<h1>${esc(a.short)} pricing</h1></div>
  <p class="lede">${esc(a.verdict)}</p>
  <div class="actions">${outLink(a, `Visit ${a.short}`, "btn")}<a class="btn ghost" href="${calcHref(cat)}">${CALC_CATS.includes(cat) ? "Compare with my numbers" : `Compare ${esc(cat.title.toLowerCase())} apps`}</a></div>
  <div class="facts">
    <div class="fact"><span>Free plan</span><b>${realFree(a) ? "Yes" : "No"}</b></div>
    <div class="fact"><span>Paid plans from</span><b>${esc(fromText(a))}</b></div>
    ${a.rating ? `<div class="fact"><span>Rating on the listing</span><b>★ ${esc(a.rating)}</b></div>` : ""}
    <div class="fact"><span>Prices checked</span><b>${fmtDate(a.checked)}</b></div>
  </div>
  ${a.watch ? `<p class="note"><b>Watch out:</b> ${esc(a.watch)}</p>` : ""}
</section>
${hasCost(cat) ? section("vol", `What ${a.short} costs at your volume`, `<div class="tablewrap"><table><thead><tr><th>Your store</th><th class="n">Per month</th><th>How we got it</th></tr></thead><tbody>${scenRows}</tbody></table></div>${cat.scenarioNote ? `<p class="fine">${esc(cat.scenarioNote)}</p>` : ""}`, CALC_CATS.includes(cat) ? { aside: `<a href="${calcHref(cat)}">Use my own numbers →</a>` } : {}) : ""}
${section("plans", `Every ${a.short} plan`, `<div class="tablewrap"><table><thead><tr><th>Plan</th><th class="n">Price</th><th>What limits the plan</th></tr></thead><tbody>
  ${a.plans.map(p => `<tr><th scope="row">${esc(p.name)}</th><td class="n">${esc(planPrice(p))}</td><td class="why">${esc(p.limits)}</td></tr>`).join("")}
  </tbody></table></div><p class="fine">Source: ${esc(a.source)}, read ${fmtDate(a.checked)} · <a href="${esc(a.listing)}" rel="nofollow noopener" target="_blank">Official listing</a></p>`)}
${pairs.length ? section("alt", `${a.short} vs the alternatives`, pairLinks(pairs), { aside: `<a href="${catUrl(cat)}">All ${esc(cat.title.toLowerCase())} apps →</a>` }) : ""}
${logs.length ? section("chg", `${a.short} price changes`, logHtml(logs)) : ""}`
  });
}

/* ---------- comparisons ---------- */
for (const [a, b, cat] of PAIRS) {
  const lines = hasCost(cat) ? cat.scenarios.map(s => {
    const ra = costFor(a, s.v), rb = costFor(b, s.v);
    if (!ra || !rb || ra.cost === null || rb.cost === null) return { s, txt: "one price is not published", sure: false };
    if (ra.cost === rb.cost) return { s, txt: ra.from || rb.from ? "same starting price" : "same price", sure: !(ra.from || rb.from) };
    const [lo, hi, rlo, rhi] = ra.cost < rb.cost ? [a, b, ra, rb] : [b, a, rb, ra];
    return { s, win: lo, txt: `${lo.short} is cheaper (${costCell(rlo)} vs ${costCell(rhi)})`, sure: !rlo.from };
  }) : [];
  const winsA = lines.filter(l => l.win === a && l.sure).length, winsB = lines.filter(l => l.win === b && l.sure).length;
  const summary = !hasCost(cat) ? entrySummary(a, b)
    : winsA === 0 && winsB === 0
    ? `No clear winner from published prices: at most sizes one of the two vendors lists only a starting price. The table shows exactly what each publishes.`
    : winsA === winsB
    ? `Neither app is cheaper at every size: it depends on your ${cat.driverLabel}. The table shows where each one wins.`
    : `${(winsA > winsB ? a : b).short} costs less in ${Math.max(winsA, winsB)} of the ${cat.scenarios.length} store sizes we priced. Where a vendor publishes only a starting price, we do not count it as a win.`;
  /* Head-to-head cards at a typical store size (or entry prices for feature-priced categories). */
  const s = hasCost(cat) ? midScenario(cat) : null;
  const ra = s ? costFor(a, s.v) : null, rb = s ? costFor(b, s.v) : null;
  const ka = ra && ra.cost !== null && !ra.from, kb = rb && rb.cost !== null && !rb.from;
  const winId = ka && kb && ra.cost !== rb.cost ? (ra.cost < rb.cost ? a.id : b.id) : null;
  const vs = (x, r) => `<div class="vs${winId === x.id ? " win" : ""}">
  <div style="display:flex;align-items:center;gap:12px">${avatar(x)}<h3><a href="${appUrl(x)}" style="color:var(--ink)">${esc(x.short)}</a>${winId === x.id ? `<span class="badge best">Cheaper</span>` : ""}</h3></div>
  <div class="big">${s ? (r && r.cost !== null ? `${r.from ? "<span>from </span>" : ""}${money(r.cost)}<span>/mo</span>` : `<span>Not published</span>`) : `${esc(fromText(x))}`}</div>
  <p class="muted small">${esc(s ? (r ? r.why : "") : "Cheapest paid plan.")}</p>
  <div class="kv"><div><span>Free plan</span><span>${realFree(x) ? "Yes" : "No"}</span></div>${x.rating ? `<div><span>Rating on the listing</span><span>★ ${esc(x.rating)}</span></div>` : ""}</div>
  ${outLink(x, `Visit ${x.short}`, winId === x.id ? "btn" : "btn ghost")}
</div>`;
  page({
    path: cmpUrl(a, b),
    title: `${a.short} vs ${b.short}: which costs less? (${monShort(site.lastChecked)})`,
    description: hasCost(cat)
      ? `${a.short} vs ${b.short}: monthly cost at ${cat.scenarios.length} store sizes, every plan side by side, read from the official listings on ${fmtDate(site.lastChecked)}.`
      : `${a.short} vs ${b.short}: free plans, entry prices and every plan side by side, read from the official listings on ${fmtDate(site.lastChecked)}.`,
    crumbs: [["/compare/", "Comparisons"], [cmpUrl(a, b), `${a.short} vs ${b.short}`]],
    faq: cmpFaq(a, b, cat, summary),
    body: `<section class="pagehead">
  <h1>${esc(a.short)} vs ${esc(b.short)}</h1>
  <p class="lede">${esc(summary)}</p>
</section>
${section("vs", s ? `At ${s.label.replace(/ · /g, ", ")}` : "Entry prices", `<div class="versus">${vs(a, ra)}${vs(b, rb)}</div>`, CALC_CATS.includes(cat) ? { aside: `<a href="${calcHref(cat)}">Try my own numbers →</a>` } : {})}
${hasCost(cat) ? section("cost", "At every store size", scenarioTable(cat, [a, b]), { sub: "✓ marks the lower monthly price." }) : section("cost", "Free plans and price range", entryTable([a, b]))}
${section("pick", "Which one to pick", `<div class="versus">
  <div class="step"><span class="n">Choose ${esc(a.short)} if</span><p>${esc(a.verdict)}</p></div>
  <div class="step"><span class="n">Choose ${esc(b.short)} if</span><p>${esc(b.verdict)}</p></div>
</div>`)}`
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
    free.length ? `${andList(free)} ${free.length > 1 ? "have free plans" : "has a free plan"}. The limits are on each app page.` : `None of the ${list.length} ${cat.noun}s we track has a free plan.`]);
  return q;
}

/* ---------- all apps index ---------- */
page({
  path: "/apps/",
  title: `All ${APPS.length} Shopify apps we track: pricing and plans (${monShort(site.lastChecked)})`,
  description: `Pricing for ${APPS.length} Shopify apps across ${CATS.length} categories, read from the official listings and re-checked daily.`,
  crumbs: [["/apps/", "All apps"]],
  body: `<section class="pagehead"><h1>Every Shopify app we track</h1><p class="lede">${APPS.length} apps in ${CATS.length} categories, every plan read from the official listing. Open one for its full pricing, or use the <a href="/calculator/">calculator</a> to rank them for your store.</p></section>
${CATS.map(cat => section(cat.id, cat.title, `<div class="grid">${APPS.filter(a => a.cat === cat.id).map(appCard).join("")}</div>`, { aside: `<a href="${catUrl(cat)}">Compare ${esc(cat.title.toLowerCase())} →</a>` })).join("")}`
});

/* ---------- compare index ---------- */
page({
  path: "/compare/",
  title: `Shopify app comparisons: real cost head to head (${monthYear(site.lastChecked)})`,
  description: `${PAIRS.length} head-to-head Shopify app price comparisons at several store sizes, from plans read on the official listings.`,
  crumbs: [["/compare/", "Comparisons"]],
  body: `<section class="pagehead"><h1>Compare two Shopify apps</h1><p class="lede">Same store, two apps, the real monthly bill at every size.</p></section>
${CATS.map(cat => { const ps = PAIRS.filter(p => p[2].id === cat.id); return ps.length ? section("c-" + cat.id, cat.title, pairLinks(ps)) : ""; }).join("")}`
});

/* ---------- calculator ---------- */
page({
  path: "/calculator/",
  title: `Shopify app cost calculator: your monthly app bill (${monthYear(site.lastChecked)})`,
  description: "Enter your orders, contacts, subscribers, words and products. See the cheapest plan that fits in each category, with the formula behind every number.",
  crumbs: [["/calculator/", "Calculator"]],
  calc: true,
  body: `<section class="hero" style="padding-top:12px"><h1>Shopify app cost calculator</h1>
<p class="lede">Pick a category, enter your store's numbers, and see every app's monthly bill, cheapest first. The page address updates as you type, so you can bookmark or share the result.</p>
${calculatorBlock()}</section>`
});

/* ---------- change log ---------- */
page({
  path: "/price-changes/",
  title: `Shopify app price changes: dated log (${monthYear(site.lastChecked)})`,
  description: "Every pricing and terms change we spot on the Shopify app listings we track, with the date and the source.",
  crumbs: [["/price-changes/", "Price changes"]],
  lastmod: LOG.length ? LOG[0].date : site.lastChecked,
  body: `<section class="pagehead"><h1>Price changes</h1><p class="lede">When a plan, price or limit changes on a listing we track, it goes here with the date and the source.</p></section>
${logHtml(LOG)}`
});

/* ---------- methodology ---------- */
page({
  path: "/methodology/",
  title: `How ${site.name} checks Shopify app prices`,
  description: "Where every price comes from, how often it is re-read, and how monthly costs are calculated.",
  crumbs: [["/methodology/", "How we calculate"]],
  body: `<section class="pagehead"><h1>How we calculate</h1><p class="lede">Four rules behind every number on this site.</p></section>
<div class="steps">
  <div class="step"><span class="n">1</span><h3>Read at the source</h3><p>Each plan comes from the app's official Shopify App Store listing, or the vendor's own help center when the listing is silent. Every app page links to its source.</p></div>
  <div class="step"><span class="n">2</span><h3>Dated and re-read daily</h3><p>Every price carries the date it was read, and each listing is re-read automatically every day. Changes go into the <a href="/price-changes/">price change log</a>.</p></div>
  <div class="step"><span class="n">3</span><h3>Cost at your volume</h3><p>Plans charge on orders, contacts, subscribers, revenue, words, products or pages. The calculator applies each vendor's published rule and shows the formula.</p></div>
  <div class="step"><span class="n">4</span><h3>No guessing</h3><p>When a vendor publishes only a starting price, we show “from” and flag it. A price we have not read is never shown as a number.</p></div>
</div>
<div class="prose"><h2>Independence</h2><p>Affiliate commissions never change a price, the order or a verdict. Results are always sorted by price. See the <a href="/disclosure/">affiliate disclosure</a>.</p>
<p>Spotted a price that changed? Email <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>.</p></div>`
});

/* ---------- disclosure ---------- */
page({
  path: "/disclosure/",
  title: `Affiliate disclosure · ${site.name}`,
  description: `How ${site.name} earns money and why it does not change the numbers.`,
  crumbs: [["/disclosure/", "Affiliate disclosure"]],
  body: `<section class="pagehead"><h1>Affiliate disclosure</h1></section>
<div class="prose">
<p>${esc(site.name)} is free to use. Some “Visit” buttons are affiliate links: if you install or subscribe through them, the app developer may pay us a commission. You pay the same price.</p>
<p>Affiliate links are marked in the page code with <code>rel="sponsored"</code>. They never change the order of apps, the prices shown, the cheapest pick in the calculator, or our verdicts. Apps without a program are compared the same way.</p>
<p>${esc(site.name)} is not affiliated with, endorsed by or sponsored by Shopify Inc. or any app developer listed. Shopify is a trademark of Shopify Inc.</p>
</div>`
});

/* ---------- 404 ---------- */
page({
  path: "/404.html", noindex: true,
  title: `Page not found · ${site.name}`, description: "This page does not exist.",
  body: `<section class="hero"><h1>This page does not exist.</h1><p class="lede">Start from the calculator instead.</p><div class="actions"><a class="btn" href="/calculator/">Open the calculator</a><a class="btn ghost" href="/apps/">See all apps</a></div></section>`
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
fs.writeFileSync(path.join(OUT, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0c7a57"/><circle cx="32" cy="32" r="11" fill="none" stroke="#fff" stroke-width="6"/></svg>`);

console.log(`Built ${pages.length} indexable pages + 404 into dist/ (base URL ${BASE})`);
console.log(`  ${APPS.length} app pages, ${CATS.length} category pages, ${PAIRS.length} comparisons`);
