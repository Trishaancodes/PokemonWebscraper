/**
 * Pokemon Center TCG Monitor (Node.js)
 * - Polls the TCG category page
 * - Detects new product detail URLs (TCG-only heuristics)
 * - Uses ETag / Last-Modified (304 handling) to reduce load
 * - Persists seen URLs to state.json
 * - Notifies via Discord webhook
 *
 * Usage:
 *   WEBHOOK_URL="https://discord.com/api/webhooks/..." \
 *   TARGET_URL="https://www.pokemoncenter.com/category/trading-card-game" \
 *   INTERVAL_MS=20000 \
 *   node index.js
 *
 * Canada example:
 *   TARGET_URL="https://www.pokemoncenter.com/en-ca/category/trading-card-game"
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios").default;
const cheerio = require("cheerio");

const TARGET_URL =
  process.env.TARGET_URL ||
  "https://www.pokemoncenter.com/category/trading-card-game";

const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 20000); // 20s default
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "state.json");
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL env var.");
  process.exit(1);
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      seen: new Set(parsed.seen || []),
      etag: parsed.etag || null,
      lastModified: parsed.lastModified || null,
      lastCheck: parsed.lastCheck || null,
    };
  } catch {
    return { seen: new Set(), etag: null, lastModified: null, lastCheck: null };
  }
}

function saveState(state) {
  const out = {
    seen: Array.from(state.seen),
    etag: state.etag,
    lastModified: state.lastModified,
    lastCheck: state.lastCheck,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), "utf8");
}

function normalizeUrl(raw, baseUrl) {
  try {
    const u = new URL(raw, baseUrl);
    // Remove tracking params to stabilize identity
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Extract likely TCG product detail links from the TCG category HTML.
 * This uses heuristics because the DOM can change and may differ under bot challenges.
 */
function extractTcgProductLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  const bannedPathPrefixes = [
    "/category/",
    "/en-ca/category/",
    "/search",
    "/account",
    "/cart",
    "/wishlist",
    "/help",
    "/customer-service",
    "/orders",
    "/stores",
    "/events",
    "/legal",
    "/policies",
  ];

  // Keywords often present in sealed TCG product slugs.
  // Adjust as needed (e.g., add "blister", "sleeves" if you want accessories too).
  const tcgSlugKeywords = [
    "booster",
    "elite",
    "trainer",
    "etb",
    "bundle",
    "collection",
    "box",
    "tin",
    "deck",
    "pokemon-tcg",
    "tcg",
  ];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const abs = normalizeUrl(href, baseUrl);
    if (!abs) return;

    const u = new URL(abs);

    // Ensure domain is Pokemon Center
    if (!u.hostname.endsWith("pokemoncenter.com")) return;

    const p = u.pathname.toLowerCase();

    // Skip common non-product sections
    if (bannedPathPrefixes.some((bp) => p.startsWith(bp))) return;
    if (p === "/" || p.length < 2) return;

    // Heuristic: keep only likely product pages by slug keyword match
    const isTcgLike = tcgSlugKeywords.some((k) => p.includes(k));
    if (!isTcgLike) return;

    links.add(u.toString());
  });

  return Array.from(links).sort();
}

async function postDiscord(content) {
  await axios.post(
    WEBHOOK_URL,
    { content },
    { timeout: 15000, headers: { "Content-Type": "application/json" } }
  );
}

async function fetchPage(state) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  if (state.etag) headers["If-None-Match"] = state.etag;
  if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;

  const resp = await axios.get(TARGET_URL, {
    headers,
    timeout: 20000,
    validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
  });

  return { status: resp.status, html: resp.status === 304 ? null : resp.data, headers: resp.headers };
}

function looksBlocked(html) {
  if (typeof html !== "string") return false;
  const t = html.toLowerCase();
  // Very rough indicators of challenge/block pages
  return (
    t.includes("captcha") ||
    t.includes("access denied") ||
    t.includes("incapsula") ||
    t.includes("request unsuccessful") ||
    t.includes("please enable cookies") ||
    t.includes("bot detection")
  );
}

async function checkOnce(state, isFirstRun) {
  const now = new Date().toISOString();

  let res;
  try {
    res = await fetchPage(state);
  } catch (err) {
    console.error(`[${now}] Fetch error: ${err.message || err}`);
    state.lastCheck = now;
    saveState(state);
    return;
  }

  if (res.headers?.etag) state.etag = res.headers.etag;
  if (res.headers?.["last-modified"]) state.lastModified = res.headers["last-modified"];

  if (res.status === 304) {
    console.log(`[${now}] No change (304).`);
    state.lastCheck = now;
    saveState(state);
    return;
  }

  const html = res.html;
  if (typeof html !== "string" || html.length < 1000) {
    console.warn(`[${now}] Unexpected response body (short/invalid). Status=${res.status}`);
    state.lastCheck = now;
    saveState(state);
    return;
  }

  if (looksBlocked(html)) {
    console.warn(`[${now}] Page looks like a bot challenge/block. Slow down polling or test in browser.`);
    state.lastCheck = now;
    saveState(state);
    return;
  }

  const links = extractTcgProductLinks(html, TARGET_URL);

  if (isFirstRun && state.seen.size === 0) {
    links.forEach((l) => state.seen.add(l));
    console.log(`[${now}] Initialized with ${links.length} TCG-like product links (no alerts).`);
    state.lastCheck = now;
    saveState(state);
    return;
  }

  const newLinks = links.filter((l) => !state.seen.has(l));

  if (newLinks.length === 0) {
    console.log(`[${now}] No new TCG product links.`);
    state.lastCheck = now;
    saveState(state);
    return;
  }

  // Persist before notifying to avoid duplicate alerts on webhook failure
  newLinks.forEach((l) => state.seen.add(l));
  state.lastCheck = now;
  saveState(state);

  console.log(`[${now}] NEW TCG LINKS: ${newLinks.length}. Sending Discord alert...`);

  const maxList = 10;
  const listed = newLinks.slice(0, maxList).map((l) => `• ${l}`).join("\n");
  const more = newLinks.length > maxList ? `\n…and ${newLinks.length - maxList} more.` : "";

  const msg =
    `🆕 Pokémon Center TCG update detected (${newLinks.length})\n` +
    `Time: ${now}\n` +
    `Page: ${TARGET_URL}\n\n` +
    listed +
    more;

  try {
    await postDiscord(msg);
  } catch (err) {
    console.error(`[${now}] Discord webhook error: ${err.response?.status || ""} ${err.message || err}`);
  }
}

async function main() {
  if (INTERVAL_MS < 5000) {
    console.warn(`INTERVAL_MS=${INTERVAL_MS} is very aggressive. Expect blocks. Prefer 15000–60000ms.`);
  }

  const state = loadState();
  console.log(`Monitoring TCG page: ${TARGET_URL}`);
  console.log(`Interval: ${INTERVAL_MS}ms`);
  console.log(`State file: ${STATE_FILE}`);

  let first = true;
  await checkOnce(state, first);
  first = false;

  setInterval(async () => {
    await checkOnce(state, first);
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
