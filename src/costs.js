/* Monthly cost rules, shared by the browser calculator and the build script.
   Each rule follows the plan limits in data/apps.json. When you change a price
   there, update the matching rule here and rebuild. */
(function (root) {
  "use strict";
  const usd2 = v => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n = v => v.toLocaleString("en-US");

  function costs(input) {
    const v = Object.assign({ orders: 0, contacts: 0, emails: 0, subs: 0, aov: 0, words: 0, langs: 0 }, input);
    const out = { reviews: [], email: [], subscriptions: [], translation: [] };

    /* Reviews */
    out.reviews.push({ id: "judgeme", cost: 0, why: "Free plan: unlimited review requests. Awesome is a flat $15 if you need integrations." });
    if (v.orders <= 500) out.reviews.push({ id: "loox", cost: 0, why: `Free plan covers up to 500 orders (you have ${n(v.orders)}).` });
    else {
      const blocks = Math.ceil((v.orders - 300) / 300);
      const conv = 49.99 + 50 * blocks;
      const best = Math.min(conv, 299.99);
      out.reviews.push({ id: "loox", cost: best, why: best === 299.99
        ? `Unlimited ($299.99) beats Convert at ${usd2(conv)}.`
        : `Convert: $49.99 + $50 × ${blocks} blocks of 300 orders above 300.` });
    }
    out.reviews.push(v.orders <= 50
      ? { id: "yotpo", cost: 0, why: "Free plan up to 50 orders per month." }
      : { id: "yotpo", cost: 15, from: true, why: "Starter from $15; Yotpo does not publish the rate at your volume." });

    /* Email */
    if (v.contacts <= 250 && v.emails <= 500) out.email.push({ id: "klaviyo", cost: 0, why: "Free: up to 250 profiles and 500 emails." });
    else if (v.contacts <= 500) out.email.push({ id: "klaviyo", cost: 20, why: "Email plan, 251 to 500 contacts." });
    else out.email.push({ id: "klaviyo", cost: 20, from: true, why: `Price for ${n(v.contacts)} contacts is not published on the listing (it starts at $20 for 500).` });

    if (v.contacts <= 250 && v.emails <= 500) out.email.push({ id: "omnisend", cost: 0, why: "Free: 250 contacts, 500 emails." });
    else if (v.emails <= v.contacts * 12) out.email.push({ id: "omnisend", cost: 16, from: true, why: `Standard from $16; it allows ${n(v.contacts * 12)} emails at your list size. Exact price depends on contacts.` });
    else out.email.push({ id: "omnisend", cost: 59, from: true, why: "You send more than 12 emails per contact: Pro from $59 (unlimited emails)." });

    const extra = Math.max(0, v.emails - 10000);
    out.email.push({ id: "shopifyemail", cost: Math.ceil(extra / 1000), from: extra > 0,
      why: extra ? `10,000 free, then about $1 per 1,000: ${Math.ceil(extra / 1000)} × $1 (rate “starts at”).` : "Under 10,000 emails: free." });

    /* Subscriptions */
    if (v.subs === 0) {
      out.subscriptions.push({ id: "seal", cost: 0, why: "No subscribers yet." }, { id: "recharge", cost: 25, why: "Entry plan." });
    } else {
      const s = v.subs <= 50 ? [0, "Free plan"] : v.subs <= 100 ? [5.95, "Supersale"] : v.subs <= 250 ? [9.95, "Rising Star"] : v.subs <= 500 ? [24.95, "Legend"] : null;
      out.subscriptions.push(s
        ? { id: "seal", cost: s[0], why: `${s[1]}, ${n(v.subs)} subscribers, no transaction fee.` }
        : { id: "seal", cost: null, why: "Above 500 subscribers: larger plans exist, prices not published." });
      if (v.subs <= 50) out.subscriptions.push({ id: "recharge", cost: 25, why: "Entry plan: no transaction fee for the first 50 subscribers." });
      else {
        const fee = (r, f) => v.subs * (v.aov * r + f);
        const st = 99 + fee(0.0149, 0.19), pl = 499 + fee(0.0134, 0.19);
        const starter = st <= pl;
        out.subscriptions.push({ id: "recharge", cost: Math.min(st, pl),
          why: `${starter ? "Starter: $99" : "Plus: $499"} + ${n(v.subs)} renewals × (${starter ? "1.49" : "1.34"}% of ${usd2(v.aov)} + $0.19) = ${usd2(starter ? fee(0.0149, 0.19) : fee(0.0134, 0.19))} in fees.` });
      }
    }

    /* Translation */
    const tw = v.words * v.langs;
    if (v.langs === 0) {
      for (const id of ["weglot", "langify", "translate"]) out.translation.push({ id, cost: 0, why: "No extra language." });
    } else {
      const W = [[0, 1, 2000, "Free"], [17, 1, 10000, "Starter"], [32, 3, 50000, "Business"], [87, 5, 200000, "Pro"]].find(p => v.langs <= p[1] && tw <= p[2]);
      out.translation.push(W
        ? { id: "weglot", cost: W[0], why: `${W[3]}: ${n(tw)} translated words (${n(v.words)} × ${v.langs}) in ${v.langs} language(s).` }
        : { id: "weglot", cost: null, why: "Beyond the Pro plan (5 languages, 200,000 words): higher plans are not on the listing." });
      const L = [[17.5, 10000, "Basic"], [29.95, 50000, "Growth"], [59.95, 200000, "Premium"]].find(p => tw <= p[1]);
      out.translation.push(v.langs > 20
        ? { id: "langify", cost: null, why: "More than 20 languages." }
        : L ? { id: "langify", cost: L[0], why: `${L[2]} for ${n(tw)} automatic-translation words. Free plan if you translate by hand (up to 5 languages).` }
            : { id: "langify", cost: null, why: "Over 200,000 words: not covered by listed plans." });
      out.translation.push({ id: "translate", cost: 0, why: v.langs <= 2
        ? "Free automatic translation for up to 2 languages."
        : "Free, but automatic translation covers only 2 languages: the rest must be translated by hand." });
    }
    return out;
  }

  /* Cheapest known row in each category. */
  function cheapest(rows) {
    const known = rows.filter(r => r.cost !== null);
    return known.length ? known.reduce((a, b) => (b.cost < a.cost ? b : a)) : null;
  }

  const api = { costs, cheapest, usd2 };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AppCosts = api;
})(typeof window !== "undefined" ? window : globalThis);
