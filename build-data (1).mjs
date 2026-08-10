#!/usr/bin/env node
/*
 * Pulls the day's prices from three Malaysian grocers and boils them down to
 * the slim catalog the phone actually loads.
 *
 * Unlike the Danish version this replaced, none of these three sources hand
 * over a price-history feed — each row is just "what it costs right now"
 * plus, where the source has one, a "regular"/"was" price for the same SKU.
 * So there is no replay-the-change-points step here; every source's own
 * fetch function does its own field mapping straight to the row shape below.
 *
 * Row shape (unchanged from before, the app doesn't know these are new
 * sources): [store, name, price, quantity, unit, regular, since, high]
 *   store     "jaya" | "aeon" | "mydin" -- storeLabel() in the app expands it
 *   name      product title as sold
 *   price     current price, number
 *   quantity  pack size in the row's `unit`, or null if unknown -- most rows
 *             leave this null and let the app's own parsePack() read the
 *             size out of the name instead, same as it always has
 *   unit      "kg" | "L" | "pc" | "" -- "" means "read the name"
 *   regular   the "was"/normal price if the source publishes one, else = price
 *   since     when the current price took effect -- none of these sources
 *             expose this, so it's always null
 *   high      highest price known for this row -- with no history to replay
 *             this is just max(price, regular), kept for shape compatibility
 *
 * Output, same two files as before:
 *   meta.json     tiny, fetched on every app open to check freshness
 *   catalog.json  the slim rows, cached on device until meta.built changes
 *
 * Each source is fetched inside its own try/catch. One source failing (AEON
 * blocking a datacenter IP is the expected failure, see below) should not
 * take down the other two -- a partial catalog beats no catalog.
 */

import { writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = process.env.OUT_DIR || "dist/data";
const UA = "kurv-price-tracker (personal, github actions)";

function round2(n) {
  return typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function num(v) {
  var n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

/* ============================================================ Jaya Grocer
 * Shopify storefront on a per-branch subdomain -- the host IS the location,
 * so JAYA_HOSTS picks which branch(es) to price. Full catalog via
 * /products.json pagination, 250 per page, no auth needed.
 */

const JAYA_HOSTS = (process.env.JAYA_HOSTS || "jgsj")
  .split(",").map((s) => s.trim()).filter(Boolean);
const JAYA_PAGE_DELAY_MS = 300; // "be polite" per their own rate guidance

async function fetchJayaHost(host) {
  const rows = [];
  for (let page = 1; ; page++) {
    const url = `https://${host}.jayagrocer.com/products.json?limit=250&page=${page}`;
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`Jaya ${host} page ${page}: HTTP ${res.status}`);
    const data = await res.json();
    const products = data.products || [];
    if (!products.length) break;

    for (const p of products) {
      const variants = p.variants || [];
      for (const v of variants) {
        const price = num(v.price);
        if (price === null) continue;
        const compareAt = num(v.compare_at_price);
        const regular = compareAt && compareAt > price ? compareAt : price;
        const name = v.title && v.title !== "Default Title"
          ? `${p.title} ${v.title}` : p.title;
        // Weight is shipping weight in Shopify, not reliably the sale unit,
        // so quantity/unit are left blank -- the app reads the real pack
        // size out of the name text instead (it already does this well).
        rows.push(["jaya", name, round2(price), null, "", round2(regular), null, round2(Math.max(price, regular))]);
      }
    }

    if (products.length < 250) break;
    await sleep(JAYA_PAGE_DELAY_MS);
    if (page > 80) break; // sanity cap, a single branch shouldn't run this deep
  }
  return rows;
}

async function fetchJaya() {
  let rows = [];
  for (const host of JAYA_HOSTS) {
    const r = await fetchJayaHost(host);
    rows = rows.concat(r);
    console.log(`  jaya/${host}: ${r.length.toLocaleString()} rows`);
  }
  return rows;
}

/* ============================================================ myAEON2go
 * No full-catalog dump exists here -- only a search endpoint. So the catalog
 * is a harvest: run a broad list of search terms, merge, and dedupe by SKU.
 * Cloud/datacenter IPs (including GitHub Actions runners) are commonly met
 * with a 403 from their bot protection; that is a known, expected failure
 * mode here and the build carries on with the other two sources rather than
 * pretending this one succeeded.
 */

const AEON_TERMS = (process.env.AEON_TERMS || [
  // English
  "milk", "egg", "bread", "rice", "chicken", "beef", "fish", "prawn",
  "vegetable", "fruit", "apple", "banana", "orange", "potato", "onion",
  "garlic", "tomato", "cooking oil", "sugar", "salt", "flour", "noodle",
  "instant noodle", "biscuit", "chocolate", "cheese", "butter", "yogurt",
  "coffee", "tea", "juice", "water", "soft drink", "detergent", "tissue",
  "diaper", "shampoo", "soap", "toothpaste", "frozen", "ice cream",
  // Bahasa Malaysia
  "susu", "telur", "roti", "beras", "ayam", "daging", "ikan", "udang",
  "sayur", "epal", "pisang", "kentang", "bawang", "minyak masak", "gula",
  "garam", "tepung", "mi", "biskut", "keju", "mentega", "kopi", "teh",
  "air mineral", "sabun", "tisu", "lampin",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const AEON_TERM_DELAY_MS = 250;

async function fetchAeonTerm(term) {
  const url = `https://myaeon2go.com/api/search/${encodeURIComponent(term)}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`AEON "${term}": HTTP ${res.status}`);
  const data = await res.json();
  return (data && data.productListEntities) || [];
}

function aeonUnit(u) {
  // Their unitType strings are inconsistent free text; only pass through the
  // ones the app's own unit table already understands, else leave blank and
  // let the app fall back to reading the size out of the name.
  const known = new Set(["g", "kg", "ml", "l", "pc", "pcs", "unit", "units", "each"]);
  const s = String(u || "").trim().toLowerCase();
  return known.has(s) ? s : "";
}

async function fetchAeon() {
  const seen = new Map(); // sku/gid -> row, first hit wins
  let ok = 0, failed = 0;

  for (const term of AEON_TERMS) {
    try {
      const entities = await fetchAeonTerm(term);
      for (const e of entities) {
        const vo = e.variantObject || {};
        const inv = (vo.inventory && vo.inventory[0]) || {};
        const price = num(vo.price) ?? num(inv.price);
        if (price === null) continue;
        const regularRaw = num(vo.standardPrice) ?? num(inv.standardPrice);
        const regular = regularRaw && regularRaw > price ? regularRaw : price;
        const key = vo.sku || e.gid || (e.extendedName || e.name);
        if (!key || seen.has(key)) continue;

        const name = e.extendedName || e.name || vo.nameText || "Unknown item";
        const qty = num(vo.unitCount);
        const unit = aeonUnit(vo.unitType);

        seen.set(key, ["aeon", name, round2(price), qty, unit, round2(regular), null, round2(Math.max(price, regular))]);
      }
      ok++;
    } catch (e) {
      failed++;
      if (failed <= 3) console.warn(`  aeon term "${term}" failed: ${e.message}`);
    }
    await sleep(AEON_TERM_DELAY_MS);
  }

  console.log(`  aeon: ${ok} terms ok, ${failed} failed, ${seen.size.toLocaleString()} unique products`);
  if (failed === AEON_TERMS.length) {
    console.warn("  aeon: every search term failed -- likely blocked as a datacenter IP; continuing without AEON rows.");
  }
  return [...seen.values()];
}

/* ================================================================= mydin
 * One national online catalog (store code S1116) via Magento GraphQL. Walk
 * the category tree, then page products per leaf category. No location
 * split to worry about -- mydin publishes a single public price list.
 */

const MYDIN_ENDPOINT = "https://mymgtbe.mydin.my/graphql";
const MYDIN_STORE = process.env.MYDIN_STORE || "default"; // header value, store code S1116
const MYDIN_PAGE_SIZE = 50;
const MYDIN_REQUEST_DELAY_MS = 250;

async function mydinGraphql(query, variables) {
  const res = await fetch(MYDIN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      Store: MYDIN_STORE,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`mydin GraphQL: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(`mydin GraphQL: ${json.errors[0].message}`);
  return json.data;
}

async function mydinCategoryIds() {
  const data = await mydinGraphql(
    `query($id: String!) {
      categoryList(filters: { parent_id: { eq: $id } }) {
        id name product_count
        children { id name product_count
          children { id name product_count }
        }
      }
    }`,
    { id: "2" }
  );
  const ids = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if ((n.product_count || 0) > 0) ids.push(n.id);
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk((data && data.categoryList) || []);
  return [...new Set(ids)];
}

async function mydinProductsForCategory(categoryId) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await mydinGraphql(
      `query($cat: String!, $page: Int!, $size: Int!) {
        products(filter: { category_id: { eq: $cat } }, pageSize: $size, currentPage: $page) {
          total_count
          page_info { current_page total_pages }
          items {
            name sku
            price_range {
              minimum_price {
                regular_price { value }
                final_price { value }
              }
            }
          }
        }
      }`,
      { cat: categoryId, page, size: MYDIN_PAGE_SIZE }
    );
    const block = data && data.products;
    if (!block) break;

    for (const it of block.items || []) {
      const mp = it.price_range && it.price_range.minimum_price;
      const price = mp && num(mp.final_price && mp.final_price.value);
      if (price === null || price === undefined) continue;
      const regularRaw = mp && num(mp.regular_price && mp.regular_price.value);
      const regular = regularRaw && regularRaw > price ? regularRaw : price;
      rows.push(["mydin", it.name, round2(price), null, "", round2(regular), null, round2(Math.max(price, regular))]);
    }

    const info = block.page_info || {};
    if (!info.total_pages || info.current_page >= info.total_pages) break;
    await sleep(MYDIN_REQUEST_DELAY_MS);
  }
  return rows;
}

async function fetchMydin() {
  const catIds = await mydinCategoryIds();
  console.log(`  mydin: ${catIds.length} leaf categories with stock`);
  let rows = [];
  let failed = 0;
  for (const id of catIds) {
    try {
      const r = await mydinProductsForCategory(id);
      rows = rows.concat(r);
    } catch (e) {
      failed++;
      if (failed <= 3) console.warn(`  mydin category ${id} failed: ${e.message}`);
    }
    await sleep(MYDIN_REQUEST_DELAY_MS);
  }
  console.log(`  mydin: ${rows.length.toLocaleString()} rows, ${failed} categories failed`);
  return rows;
}

/* -------------------------------------------------------------------- go */

async function fromSource(label, fn) {
  console.log(`Fetching ${label} ...`);
  const t0 = Date.now();
  try {
    const rows = await fn();
    console.log(`${label}: ${rows.length.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { rows, ok: true, error: null };
  } catch (e) {
    console.error(`${label} failed entirely: ${e.message}`);
    return { rows: [], ok: false, error: e.message };
  }
}

async function main() {
  const jaya = await fromSource("Jaya Grocer", fetchJaya);
  const aeon = await fromSource("myAEON2go", fetchAeon);
  const mydin = await fromSource("mydin", fetchMydin);

  const rows = [...jaya.rows, ...aeon.rows, ...mydin.rows]
    // A row with no name or a non-finite price is worse than useless -- it
    // would sit in search results and silently fail every downstream sum.
    .filter((r) => r[1] && typeof r[2] === "number" && isFinite(r[2]) && r[2] > 0);

  // Sort by store then name, same reasoning as before: keeps gzip small and
  // costs nothing at runtime since search is a linear scan either way.
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));

  const built = new Date().toISOString();
  const stores = [...new Set(rows.map((r) => r[0]))].sort();
  const meta = {
    built,
    count: rows.length,
    stores,
    fields: ["store", "name", "price", "quantity", "unit", "regular", "since", "high"],
    sources: {
      jaya: { ok: jaya.ok, count: jaya.rows.length, error: jaya.error },
      aeon: { ok: aeon.ok, count: aeon.rows.length, error: aeon.error },
      mydin: { ok: mydin.ok, count: mydin.rows.length, error: mydin.error },
    },
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "meta.json"), JSON.stringify(meta));
  await writeFile(join(OUT_DIR, "catalog.json"), JSON.stringify({ built, rows }));

  const size = (await stat(join(OUT_DIR, "catalog.json"))).size;
  console.log(`\nWrote ${rows.length.toLocaleString()} rows, ${(size / 1048576).toFixed(2)} MB raw`);
  console.log(`  jaya: ${jaya.rows.length.toLocaleString()}  aeon: ${aeon.rows.length.toLocaleString()}  mydin: ${mydin.rows.length.toLocaleString()}`);

  // Fail the Action only if every single source came back empty -- a
  // partial catalog from two-of-three sources is still worth shipping.
  if (!rows.length) {
    throw new Error("All three sources failed or returned nothing -- refusing to publish an empty catalog.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
