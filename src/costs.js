/* Monthly cost rules, shared by the browser calculator and the build script.
   Plan prices are NOT written here: they come from data/apps.json through setPrices(),
   so a price updated by the daily check flows into the calculator and every page.
   What stays here are the rules a price alone cannot express: thresholds (orders,
   contacts, subscribers, words), per-unit add-ons and transaction fees. A change to one
   of those is a structure change, which the daily check sends for review. */
(function (root) {
  "use strict";
  const usd2 = v => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n = v => v.toLocaleString("en-US");

  /* App data from data/apps.json: { id, cat, plans:[{name, price, from?, fits?, over?, fee?}] }.
     Apps with a hand-written rule below (the first 11) only take their prices from it.
     Every other app is priced by generic() from its plans' "fits", "over" and "fee" fields. */
  let APPS = [];
  let BY_ID = {};
  function setApps(apps) {
    APPS = (apps || []).map(a => ({ id: a.id, cat: a.cat, beyond: a.beyond,
      plans: a.plans.map(p => ({ name: p.name, price: p.price, from: p.from, fits: p.fits, over: p.over, fee: p.fee, limits: p.limits })) }));
    BY_ID = Object.fromEntries(APPS.map(a => [a.id, a]));
  }
  /* Kept for older callers: a { id: { plan: price } } map is turned into app records. */
  function setPrices(map) {
    setApps(Object.entries(map || {}).map(([id, plans]) => ({ id, plans: Object.entries(plans).map(([name, price]) => ({ name, price })) })));
  }
  function pricesFromApps(apps) {
    const m = {};
    for (const a of apps) { m[a.id] = {}; for (const p of a.plans) m[a.id][p.name] = p.price; }
    return m;
  }
  function P(id, plan) {
    const a = BY_ID[id], p = a && a.plans.find(x => x.name === plan);
    if (!p || typeof p.price !== "number") throw new Error(`No price for ${id} / ${plan} in data/apps.json`);
    return p.price;
  }

  /* Values a plan limit can refer to. */
  function measure(v, key) {
    switch (key) {
      case "tw": return v.words * v.langs;                 /* translated words */
      case "subRevenue": return v.subs * v.aov;           /* monthly subscription revenue */
      default: return v[key] || 0;
    }
  }
  const UNIT = { orders: "orders", contacts: "contacts", emails: "emails", subs: "subscribers", langs: "languages", tw: "translated words",
    subRevenue: "in subscription revenue", products: "products", pages: "published pages", upsellRev: "in upsell revenue" };
  const money = k => k === "subRevenue" || k === "upsellRev";
  const amt = (k, x) => (money(k) ? "$" + n(x) : n(x));

  /* Cheapest plan whose limits fit the store. A plan without "fits" is never picked
     (its limits are not volume-based, or not published). fits:{} means no limit. */
  function generic(app, v) {
    let best = null;
    for (const p of app.plans) {
      if (!p.fits) continue;
      let ok = true, extra = 0, detail = [];
      for (const [k, max] of Object.entries(p.fits)) {
        const x = measure(v, k);
        if (x <= max) continue;
        if (p.over && p.over.key === k) {
          const blocks = Math.ceil((x - max) / p.over.per);
          extra += blocks * p.over.price;
          detail.push(`${usd(p.over.price)} × ${blocks} blocks of ${n(p.over.per)} ${UNIT[k] || k} above ${amt(k, max)}`);
          continue;
        }
        ok = false; break;
      }
      if (!ok) continue;
      let fee = 0;
      if (p.fee && v.subs > 0) {
        fee = v.subs * (v.aov * p.fee.pct / 100 + (p.fee.fixed || 0));
        detail.push(`${n(v.subs)} renewals × ${p.fee.pct}% of ${usd2(v.aov)}${p.fee.fixed ? ` + ${usd2(p.fee.fixed)}` : ""} = ${usd2(fee)} in fees`);
      }
      const cost = p.price + extra + fee;
      if (!best || cost < best.cost) best = { cost, p, detail };
    }
    if (!best) return { id: app.id, cost: null, why: app.beyond || "Beyond the plans published on the listing." };
    const head = best.p.price === 0 && !best.detail.length ? `${best.p.name} plan` : `${best.p.name}: ${best.p.from ? "from " : ""}${usd(best.p.price)}`;
    const lim = best.p.limits ? ` (${best.p.limits.replace(/\.$/, "")})` : "";
    return { id: app.id, cost: best.cost, from: !!best.p.from,
      why: best.detail.length ? `${head} + ${best.detail.join(" + ")}.` : `${head}${lim}.` };
  }

  function costs(input) {
    const v = Object.assign({ orders: 0, contacts: 0, emails: 0, subs: 0, aov: 0, words: 0, langs: 0, products: 0, pages: 0, upsellRev: 0 }, input);
    const out = { reviews: [], email: [], subscriptions: [], translation: [] };

    /* Reviews */
    out.reviews.push({ id: "judgeme", cost: 0, why: `Free plan: unlimited review requests. Awesome is a flat ${usd(P("judgeme", "Awesome"))} if you need integrations.` });
    if (v.orders <= 500) out.reviews.push({ id: "loox", cost: 0, why: `Free plan covers up to 500 orders (you have ${n(v.orders)}).` });
    else {
      const convert = P("loox", "Convert"), unlimited = P("loox", "Unlimited");
      const blocks = Math.ceil((v.orders - 300) / 300);
      const conv = convert + 50 * blocks;
      const best = Math.min(conv, unlimited);
      out.reviews.push({ id: "loox", cost: best, why: best === unlimited
        ? `Unlimited (${usd2(unlimited)}) beats Convert at ${usd2(conv)}.`
        : `Convert: ${usd2(convert)} + $50 × ${blocks} blocks of 300 orders above 300.` });
    }
    const yStarter = P("yotpo", "Starter");
    out.reviews.push(v.orders <= 50
      ? { id: "yotpo", cost: 0, why: "Free plan up to 50 orders per month." }
      : { id: "yotpo", cost: yStarter, from: true, why: `Starter from ${usd(yStarter)}; Yotpo does not publish the rate at your volume.` });

    /* Email */
    const kEmail = P("klaviyo", "Email");
    if (v.contacts <= 250 && v.emails <= 500) out.email.push({ id: "klaviyo", cost: 0, why: "Free: up to 250 profiles and 500 emails." });
    else if (v.contacts <= 500) out.email.push({ id: "klaviyo", cost: kEmail, why: "Email plan, 251 to 500 contacts." });
    else out.email.push({ id: "klaviyo", cost: kEmail, from: true, why: `Price for ${n(v.contacts)} contacts is not published on the listing (it starts at ${usd(kEmail)} for 500).` });

    const oStd = P("omnisend", "Standard"), oPro = P("omnisend", "Pro");
    if (v.contacts <= 250 && v.emails <= 500) out.email.push({ id: "omnisend", cost: 0, why: "Free: 250 contacts, 500 emails." });
    else if (v.emails <= v.contacts * 12) out.email.push({ id: "omnisend", cost: oStd, from: true, why: `Standard from ${usd(oStd)}; it allows ${n(v.contacts * 12)} emails at your list size. Exact price depends on contacts.` });
    else out.email.push({ id: "omnisend", cost: oPro, from: true, why: `You send more than 12 emails per contact: Pro from ${usd(oPro)} (unlimited emails).` });

    const extra = Math.max(0, v.emails - 10000);
    out.email.push({ id: "shopifyemail", cost: Math.ceil(extra / 1000), from: extra > 0,
      why: extra ? `10,000 free, then about $1 per 1,000: ${Math.ceil(extra / 1000)} × $1 (rate “starts at”).` : "Under 10,000 emails: free." });

    /* Subscriptions */
    const rEntry = P("recharge", "Entry plan");
    if (v.subs === 0) {
      out.subscriptions.push({ id: "seal", cost: 0, why: "No subscribers yet." }, { id: "recharge", cost: rEntry, why: "Entry plan." });
    } else {
      const s = v.subs <= 50 ? [0, "Free plan"] : v.subs <= 100 ? [P("seal", "Supersale"), "Supersale"] : v.subs <= 250 ? [P("seal", "Rising Star"), "Rising Star"] : v.subs <= 500 ? [P("seal", "Legend"), "Legend"] : null;
      out.subscriptions.push(s
        ? { id: "seal", cost: s[0], why: `${s[1]}, ${n(v.subs)} subscribers, no transaction fee.` }
        : { id: "seal", cost: null, why: "Above 500 subscribers: larger plans exist, prices not published." });
      if (v.subs <= 50) out.subscriptions.push({ id: "recharge", cost: rEntry, why: "Entry plan: no transaction fee for the first 50 subscribers." });
      else {
        const rStarter = P("recharge", "Starter"), rPlus = P("recharge", "Plus");
        const fee = (r, f) => v.subs * (v.aov * r + f);
        const st = rStarter + fee(0.0149, 0.19), pl = rPlus + fee(0.0134, 0.19);
        const starter = st <= pl;
        out.subscriptions.push({ id: "recharge", cost: Math.min(st, pl),
          why: `${starter ? `Starter: ${usd(rStarter)}` : `Plus: ${usd(rPlus)}`} + ${n(v.subs)} renewals × (${starter ? "1.49" : "1.34"}% of ${usd2(v.aov)} + $0.19) = ${usd2(starter ? fee(0.0149, 0.19) : fee(0.0134, 0.19))} in fees.` });
      }
    }

    /* Translation */
    const tw = v.words * v.langs;
    if (v.langs === 0) {
      for (const id of ["weglot", "langify", "translate"]) out.translation.push({ id, cost: 0, why: "No extra language." });
    } else {
      const W = [[0, 1, 2000, "Free"], [P("weglot", "Starter"), 1, 10000, "Starter"], [P("weglot", "Business"), 3, 50000, "Business"], [P("weglot", "Pro"), 5, 200000, "Pro"]].find(p => v.langs <= p[1] && tw <= p[2]);
      out.translation.push(W
        ? { id: "weglot", cost: W[0], why: `${W[3]}: ${n(tw)} translated words (${n(v.words)} × ${v.langs}) in ${v.langs} language(s).` }
        : { id: "weglot", cost: null, why: "Beyond the Pro plan (5 languages, 200,000 words): higher plans are not on the listing." });
      const L = [[P("langify", "Basic"), 10000, "Basic"], [P("langify", "Growth"), 50000, "Growth"], [P("langify", "Premium"), 200000, "Premium"]].find(p => tw <= p[1]);
      out.translation.push(v.langs > 20
        ? { id: "langify", cost: null, why: "More than 20 languages." }
        : L ? { id: "langify", cost: L[0], why: `${L[2]} for ${n(tw)} automatic-translation words. Free plan if you translate by hand (up to 5 languages).` }
            : { id: "langify", cost: null, why: "Over 200,000 words: not covered by listed plans." });
      out.translation.push({ id: "translate", cost: 0, why: v.langs <= 2
        ? "Free automatic translation for up to 2 languages."
        : "Free, but automatic translation covers only 2 languages: the rest must be translated by hand." });
    }

    /* Every other app: generic pricing from its plan data, in data order. */
    const custom = new Set(Object.values(out).flat().map(r => r.id));
    for (const a of APPS) {
      if (custom.has(a.id) || !a.cat) continue;
      (out[a.cat] || (out[a.cat] = [])).push(generic(a, v));
    }
    /* Rows follow the order of data/apps.json within each category. */
    const order = Object.fromEntries(APPS.map((a, i) => [a.id, i]));
    for (const k of Object.keys(out)) out[k].sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0));
    return out;
  }

  /* $15 for whole amounts, $17.50 otherwise (matches the plan tables). */
  function usd(v) { return v % 1 ? usd2(v) : "$" + v.toLocaleString("en-US"); }

  /* Cheapest known row in each category. */
  function cheapest(rows) {
    const known = rows.filter(r => r.cost !== null);
    return known.length ? known.reduce((a, b) => (b.cost < a.cost ? b : a)) : null;
  }

  const api = { costs, cheapest, usd2, usd, setApps, setPrices, pricesFromApps, generic };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AppCosts = api;
})(typeof window !== "undefined" ? window : globalThis);
