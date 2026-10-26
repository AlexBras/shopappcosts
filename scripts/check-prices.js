#!/usr/bin/env node
/* Daily price check, run by .github/workflows/price-check.yml.
   For each app in data/apps.json: download the listing, extract the plan block as text,
   compare it with the last snapshot in data/snapshots/<id>.json.
   - First run (no snapshot): stores a baseline.
   - Same text: marks the app as confirmed today in data/check-status.json.
   - Only prices moved (same plans, limits and fees; new price within 0.25x–4x): updates
     data/apps.json, rewords texts quoting the old price, adds a changelog entry. The workflow
     publishes it directly.
   - Anything else: updates the snapshot, adds a draft changelog entry, and the workflow opens
     a pull request (price-report.md) for a human to review.
   Writes GITHUB_OUTPUT changed=true|false. Needs Node 18+ (global fetch). */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const SNAP = path.join(DATA, "snapshots");
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); /* YYYY-MM-DD, US Eastern */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

/* ---------- HTML to lines of text ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", middot: "·", times: "×" };
function toLines(html) {
  let t = html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article|header|footer|dt|dd|button|span)>/gi, "\n")
    /* A tag can contain ">" inside a quoted attribute (data-action="click->x#y"): skip quoted values. */
    .replace(/<[a-zA-Z\/!](?:"[^"]*"|'[^']*'|[^'">])*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
  return t.split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/* Shopify App Store listings put every plan between "Choose the plan that best fits your business."
   and "All charges are billed in USD..." (then "See all pricing options"). We keep that block.
   Pages without it (an app with no paid plan) fall back to price-like lines only.
   Rating numbers and review counts are dropped so they never trigger a false alert. */
const VOLATILE = /^\d(\.\d)?$|\(\d{1,3}(,\d{3})*\)|\b\d[\d,]* reviews?\b|\bout of 5\b|^try shopify free\b/i;
const START = /^choose the plan that best fits your business\.?$/i;
const END = /^(see all pricing options|all charges are billed\b.*)$/i;
function pricingSection(lines) {
  let out;
  const s = lines.findIndex(l => START.test(l));
  if (s >= 0) {
    let e = -1;
    for (let i = s + 1; i < Math.min(lines.length, s + 400); i++) {
      if (/^see all pricing options$/i.test(lines[i])) { e = i; break; }
      if (/^all charges are billed\b/i.test(lines[i])) e = i + 1; /* keep going: "See all pricing options" may follow */
      else if (e >= 0) break;
    }
    if (e < 0) e = Math.min(lines.length, s + 250);
    out = lines.slice(s, e);
  } else {
    const price = l => /\$\s?\d|^free$|\bfree (plan|for|forever)\b|\/\s?(month|mo|year)\b|\bper (month|order|email|1,?000)\b|\bup to \d[\d,]* (languages?|orders|contacts|subscriptions|words|emails)\b/i.test(l);
    out = lines.filter(price);
  }
  out = out.filter(l => !VOLATILE.test(l) && l.length <= 300);
  return [...new Set(out)].slice(0, 150);
}

/* ---------- plans and prices ---------- */
/* In a listing's plan block, a plan is a name line followed by its price line ("Free", "$49.99"),
   then optional "/ month" and "or $X/year and save N%" lines. Everything else (limits, fees,
   features, plan names) is "structure". A change that leaves the structure identical and only
   moves prices is applied automatically; any other change goes to a pull request for review. */
const PRICE_LINE = /^(free|\$\s?\d[\d,]*(\.\d+)?)$/i;
const PRICE_EXTRA = /^(\/\s?(month|mo|year)|or \$[\d,.]+\s?\/\s?year\b.*)$/i;
const NOT_A_NAME = /^(learn more|features|free to install|choose the plan that best fits your business\.?)$/i;
const amount = l => (/^free$/i.test(l) ? 0 : parseFloat(l.replace(/[$,\s]/g, "")));
const norm = s => String(s).toLowerCase().replace(/\bplan\b/g, "").replace(/[^a-z0-9]+/g, "");
function parsePlans(lines) {
  const plans = [];
  lines.forEach((l, i) => {
    if (!PRICE_LINE.test(l) || i === 0) return;
    const name = lines[i - 1];
    if (PRICE_LINE.test(name) || PRICE_EXTRA.test(name) || NOT_A_NAME.test(name)) return;
    plans.push({ name, price: amount(l) });
  });
  return plans;
}
const structure = lines => lines.filter(l => !PRICE_LINE.test(l) && !PRICE_EXTRA.test(l));
const fmt = v => (v % 1 ? "$" + v.toFixed(2) : "$" + v);

/* Returns { updates:[{plan, from, to}] } when the change is price-only and every moved price maps to a plan
   in data/apps.json with a plausible new value; otherwise { reason } explaining why it needs review. */
function priceOnlyChange(app, prevLines, lines) {
  if (JSON.stringify(structure(prevLines)) !== JSON.stringify(structure(lines))) return { reason: "plan names, limits or fees changed" };
  const before = parsePlans(prevLines), after = parsePlans(lines);
  if (before.length !== after.length || before.some((p, i) => p.name !== after[i].name)) return { reason: "the list of plans changed" };
  const updates = [];
  for (let i = 0; i < after.length; i++) {
    const from = before[i].price, to = after[i].price;
    if (from === to) continue;
    const plan = app.plans.find(p => norm(p.listingName || p.name) === norm(after[i].name));
    if (!plan) return { reason: `plan "${after[i].name}" is not in data/apps.json` };
    if (plan.price !== from) return { reason: `data/apps.json had ${fmt(plan.price)} for ${plan.name}, the listing had ${fmt(from)}` };
    if (from === 0 || to === 0 || isNaN(to) || to / from > 4 || to / from < 0.25) return { reason: `${plan.name}: ${fmt(from)} → ${fmt(to)} is outside the automatic range` };
    updates.push({ plan, from, to });
  }
  return { updates };
}

/* Texts on this app's entry that quote the old price (verdict, warning, the plan's own limits)
   are reworded to the new price. "$15" never matches inside "$150" or "$15.50". */
function rewordTexts(app, plan, from, to) {
  const re = new RegExp(fmt(from).replace(/[$.]/g, "\\$&") + "(?![\\d]|[.,]\\d)", "g");
  const done = [];
  const fix = (obj, key, label) => {
    if (obj[key] && re.test(obj[key])) { re.lastIndex = 0; obj[key] = obj[key].replace(re, fmt(to)); done.push(label); }
    re.lastIndex = 0;
  };
  fix(app, "verdict", "verdict"); fix(app, "watch", "warning"); fix(plan, "limits", `${plan.name} limits`);
  return done;
}

/* ---------- main ---------- */
async function fetchListing(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; price-check; +https://github.com)", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const apps = readJson(path.join(DATA, "apps.json"), []);
  const changelogFile = path.join(DATA, "changelog.json");
  const statusFile = path.join(DATA, "check-status.json");
  const changelog = readJson(changelogFile, []);
  const status = readJson(statusFile, { lastRun: null, apps: {} });
  fs.mkdirSync(SNAP, { recursive: true });

  const changes = [], baselines = [], failures = [], autoApplied = [];
  for (const a of apps) {
    const st = status.apps[a.id] || (status.apps[a.id] = {});
    st.lastAttempt = today;
    let lines;
    try {
      lines = pricingSection(toLines(await fetchListing(a.listing)));
      if (lines.length < 2) throw new Error("pricing section not found on the page");
    } catch (e) {
      st.ok = false; st.error = String(e.message || e);
      failures.push({ a, error: st.error });
      console.log(`✗ ${a.short}: ${st.error}`);
      continue;
    }
    st.ok = true; delete st.error;
    const snapFile = path.join(SNAP, `${a.id}.json`);
    const prev = readJson(snapFile, null);
    if (!prev) {
      writeJson(snapFile, { url: a.listing, since: today, lines });
      st.confirmed = today;
      baselines.push({ a, lines });
      console.log(`• ${a.short}: baseline stored (${lines.length} lines)`);
    } else if (JSON.stringify(prev.lines) === JSON.stringify(lines)) {
      st.confirmed = today;
      console.log(`✓ ${a.short}: unchanged`);
    } else {
      writeJson(snapFile, { url: a.listing, since: today, lines });
      const verdict = priceOnlyChange(a, prev.lines, lines);
      const source = `${/apps\.shopify\.com/.test(a.listing) ? "Shopify App Store listing" : "Vendor pricing page"}, automatic daily check`;
      if (verdict.updates) {
        /* Price-only: apply it. The site, the calculator and the comparisons use the new price on the next build. */
        st.confirmed = today;
        if (verdict.updates.length) {
          for (const u of verdict.updates) u.plan.price = u.to;
          a.checked = today;
          const review = verdict.updates.flatMap(u => rewordTexts(a, u.plan, u.from, u.to));
          const what = verdict.updates.map(u => `${u.plan.name} ${fmt(u.from)} → ${fmt(u.to)}`).join(", ");
          changelog.unshift({
            date: today, app: a.id,
            title: `${a.short}: ${verdict.updates.map(u => `${u.plan.name} plan now ${fmt(u.to)}/month (was ${fmt(u.from)})`).join("; ")}`,
            body: "Read on the listing today. The plan table, the calculator and the comparisons use the new price.",
            source
          });
          autoApplied.push({ a, what, review });
          console.log(`$ ${a.short}: applied ${what}`);
        } else {
          console.log(`~ ${a.short}: annual price wording changed, monthly prices unchanged`);
        }
      } else {
        const removed = prev.lines.filter(l => !lines.includes(l));
        const added = lines.filter(l => !prev.lines.includes(l));
        changes.push({ a, removed, added, reason: verdict.reason });
        const short = arr => arr.slice(0, 6).join(" · ") + (arr.length > 6 ? " …" : "");
        changelog.unshift({
          date: today, app: a.id,
          title: `${a.short}: pricing changed on the listing`,
          body: `${removed.length ? `Before: ${short(removed)}. ` : ""}${added.length ? `Now: ${short(added)}.` : ""}`.trim(),
          source
        });
        console.log(`Δ ${a.short}: needs review (${verdict.reason})`);
      }
    }
  }
  status.lastRun = today;
  writeJson(statusFile, status);
  if (changes.length || autoApplied.length) writeJson(changelogFile, changelog);
  if (autoApplied.length) writeJson(path.join(DATA, "apps.json"), apps);

  /* Report used as the pull request body (changes) or the run summary (no changes). */
  const block = arr => arr.length ? "```\n" + arr.join("\n") + "\n```" : "_(none)_";
  let md = "";
  if (autoApplied.length) {
    md += `## Prices updated automatically on ${today}\n\n${autoApplied.map(x => `- **${x.a.name}**: ${x.what}`).join("\n")}\n\nThe site, the calculator and the changelog were updated and published.\n\n`;
    const rev = autoApplied.filter(x => x.review.length);
    if (rev.length) md += `Texts reworded to the new price: ${rev.map(x => `${x.a.short} (${x.review.join(", ")})`).join("; ")}. Worth a glance to check they still read well.\n\n`;
  }
  if (changes.length) {
    md += `## Pricing changes detected on ${today}\n\n`;
    md += "The listings below changed since the last check. Draft entries were added to `data/changelog.json`.\n\n";
    md += "**Before merging:**\n- [ ] Update the plans in `data/apps.json` (and `checked` dates)\n- [ ] Update the rule in `src/costs.js` if a threshold or fee changed\n- [ ] Rewrite the changelog entries in plain English if needed\n\nMerging publishes the site automatically.\n\n";
    for (const c of changes) md += `### ${c.a.name}\n${c.a.listing}\n\nWhy it needs a human: ${c.reason}.\n\n**Removed**\n${block(c.removed)}\n\n**Added**\n${block(c.added)}\n\n`;
  }
  if (baselines.length) {
    md += `## Baseline stored for ${baselines.length} app(s)\nCheck that each block shows the plans and prices. If one looks wrong, the extraction needs adjusting for that listing.\n\n`;
    for (const b of baselines) md += `<details><summary>${b.a.name}</summary>\n\n${block(b.lines)}\n</details>\n\n`;
  }
  if (failures.length) {
    md += `## Could not read ${failures.length} listing(s)\n\n${failures.map(f => `- ${f.a.name}: ${f.error} (${f.a.listing})`).join("\n")}\n\n`;
  }
  if (!md) md = `All ${apps.length} listings unchanged on ${today}.\n`;
  fs.writeFileSync(path.join(ROOT, "price-report.md"), md);

  const commitMsg = autoApplied.length ? `Price update: ${autoApplied.map(x => `${x.a.short} ${x.what}`).join("; ")}` : "Daily price check: no pricing change";
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length ? "true" : "false"}\ncommit_msg=${commitMsg.replace(/\n/g, " ")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(`\n${autoApplied.length} applied, ${changes.length} need review, ${baselines.length} baselines, ${failures.length} failed`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { toLines, pricingSection, parsePlans, priceOnlyChange };
