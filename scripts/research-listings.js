#!/usr/bin/env node
/* One-off helper, run by .github/workflows/research.yml.
   Reads candidate Shopify App Store listings (handles passed as arguments) with the same
   extractor as the daily check and writes research/listings.json: title, rating line,
   the plan block and the plans parsed from it. Used to add new apps with real data. */
"use strict";
const fs = require("fs");
const path = require("path");
const { toLines, pricingSection, parsePlans } = require("./check-prices.js");

async function main() {
  const handles = process.argv.slice(2).flatMap(a => a.split(/[\s,]+/)).filter(Boolean);
  const out = [];
  for (const h of handles) {
    const url = `https://apps.shopify.com/${h}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; price-check)", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
      const html = await res.text();
      const lines = toLines(html);
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
      const ratingIdx = lines.findIndex(l => /^\d\.\d$/.test(l));
      const block = pricingSection(lines);
      out.push({
        handle: h, url, finalUrl: res.url, status: res.status, title: title.trim(),
        rating: ratingIdx >= 0 ? lines.slice(ratingIdx, ratingIdx + 3) : null,
        lines: block, plans: parsePlans(block)
      });
      console.log(`${res.status} ${h}: ${parsePlans(block).map(p => `${p.name} ${p.price}`).join(" | ")}`);
    } catch (e) {
      out.push({ handle: h, url, error: String(e.message || e) });
      console.log(`ERR ${h}: ${e.message || e}`);
    }
  }
  fs.mkdirSync(path.join(__dirname, "..", "research"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "research", "listings.json"), JSON.stringify(out, null, 2) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
