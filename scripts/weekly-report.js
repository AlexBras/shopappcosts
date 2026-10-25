#!/usr/bin/env node
/* Weekly report, run by .github/workflows/weekly-report.yml.
   Writes weekly-report.md: price changes of the last 7 days, listings that could not be read,
   pull requests waiting for review (open-prs.json from the gh CLI), and a live-site health check.
   Env: SITE_URL (the live site), OWNER (GitHub username to mention so the issue is emailed). */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return d; } };

(async () => {
  const apps = readJson("data/apps.json", []);
  const log = readJson("data/changelog.json", []);
  const status = readJson("data/check-status.json", { apps: {} });
  const prs = readJson("open-prs.json", []);
  const now = new Date();
  const since = new Date(now - 7 * 864e5).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const recent = log.filter(e => e.date >= since);
  const failing = apps.filter(a => status.apps[a.id] && status.apps[a.id].ok === false);
  const stale = apps.filter(a => { const c = status.apps[a.id] && status.apps[a.id].confirmed; return !c || c < since; });

  /* Live site check */
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const checks = [];
  if (site) {
    for (const p of ["/", "/calculator/", "/sitemap.xml", `/apps/${apps[0] ? apps[0].slug : ""}/`]) {
      try {
        const r = await fetch(site + p, { redirect: "follow", signal: AbortSignal.timeout(20000) });
        checks.push({ p, ok: r.ok, code: r.status });
      } catch (e) { checks.push({ p, ok: false, code: String(e.message || e) }); }
    }
  }

  let md = `${process.env.OWNER ? "@" + process.env.OWNER + " " : ""}Weekly report for ${since} → ${today}.\n\n`;
  md += `## Summary\n- Price changes logged this week: **${recent.length}**\n- Pull requests waiting for review: **${prs.length}**\n- Listings that failed at the last check: **${failing.length}**\n- Listings not confirmed in 7 days: **${stale.length}**\n`;
  if (site) md += `- Live site: **${checks.every(c => c.ok) ? "OK" : "PROBLEM"}**\n`;
  md += "\n";

  if (prs.length) md += `## Waiting for your review\n${prs.map(p => `- [${p.title}](${p.url}) (opened ${p.createdAt.slice(0, 10)})`).join("\n")}\n\n`;
  if (recent.length) md += `## Changes this week\n${recent.map(e => `- **${e.date}** · ${e.title}${e.body ? ` — ${e.body}` : ""}`).join("\n")}\n\n`;
  if (failing.length) md += `## Listings that could not be read\n${failing.map(a => `- ${a.name}: ${status.apps[a.id].error} (${a.listing})`).join("\n")}\n\n`;
  if (stale.length) md += `## Not confirmed for 7 days or more\n${stale.map(a => `- ${a.name} (last confirmed ${(status.apps[a.id] || {}).confirmed || "never"})`).join("\n")}\n\n`;
  if (site) md += `## Live site\n${checks.map(c => `- ${c.ok ? "✅" : "❌"} \`${c.p}\` → ${c.code}`).join("\n")}\n\n`;
  else md += "## Live site\nSet the repository variable `SITE_URL` to include a health check of the live site.\n\n";
  md += `Last price check run: ${status.lastRun || "never"}.\n`;

  fs.writeFileSync(path.join(ROOT, "weekly-report.md"), md);
  console.log(md);
})().catch(e => { console.error(e); process.exit(1); });
