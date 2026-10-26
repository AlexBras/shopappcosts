#!/usr/bin/env node
/* Tells Bing (and the other IndexNow engines: Yandex, Seznam, Naver) that the site changed.
   Waits until the live site serves the key file, then submits every URL in the live sitemap.
   Env: SITE_URL. Key: indexNowKey in data/site.json (the build publishes /<key>.txt). */
"use strict";
const site = require("../data/site.json");
const BASE = (process.env.SITE_URL || site.baseUrl).replace(/\/$/, "");
const KEY = site.indexNowKey;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!KEY) { console.log("No indexNowKey in data/site.json: nothing to do."); return; }
  /* The deploy runs in parallel: wait up to 10 minutes for the key file to be live. */
  let live = false;
  for (let i = 0; i < 40 && !live; i++) {
    try {
      const r = await fetch(`${BASE}/${KEY}.txt`, { cache: "no-store" });
      live = r.ok && (await r.text()).trim() === KEY;
    } catch { /* not yet */ }
    if (!live) await sleep(15000);
  }
  if (!live) { console.log("Key file not live after 10 minutes: skipping this time."); return; }
  await sleep(30000); /* let the rest of the deploy settle */
  const xml = await (await fetch(`${BASE}/sitemap.xml`, { cache: "no-store" })).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const body = { host: new URL(BASE).host, key: KEY, keyLocation: `${BASE}/${KEY}.txt`, urlList: urls };
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body)
  });
  console.log(`IndexNow: submitted ${urls.length} URLs → HTTP ${res.status}`);
  if (res.status >= 400) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
