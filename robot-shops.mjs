/* Every shop the robot reads. A shop is {id, name, order, via?, collect()} -> [{id, name, r, s, unit, img, code}]. */
import {page, get, item, decode, norm, slug, sleep, woltStore} from './robot-lib.mjs';

/* ===== Araz ===== */
/* Araz (arazmarket.az): the Şirniyyat category page carries its own products as data inside the
   page (id, title, barcode, sales_price, discount_price, is_discount, category). The same data block
   also lists the shop's discounts from every department, so only "products" is read.
   /api/ and /_next/ are closed to robots, so only the public category pages are read, sorted by
   name (?sort_field=title&sort_dir=asc) so the pages do not shift while they are read. */
const BASE_araz = 'https://arazmarket.az';
const CAT_araz = '/az/categories/sirniyyat-605?sort_field=title&sort_dir=asc';

/* the page's data row: a JS string holding a React row holding JSON */
function pageData(h){
  const a = h.indexOf('\\"page_type\\":\\"categories\\"'); if (a < 0) return null;
  const s0 = h.lastIndexOf('self.__next_f.push([1,"', a), s1 = h.indexOf('"])</script>', a);
  if (s0 < 0 || s1 < 0) return null;
  const str = JSON.parse(h.slice(s0 + 'self.__next_f.push([1,'.length, s1 + 1));
  const row = JSON.parse(str.slice(str.indexOf(':') + 1));
  const find = x => { if (!x || typeof x !== 'object') return null; if (x.page_type === 'categories' && x.data) return x.data; for (const v of Object.values(x)) { const r = find(v); if (r) return r; } return null; };
  return find(row);
}
export function parseArazPage(h){
  let d = null; try { d = pageData(h); } catch (e) {}
  if (!d || !Array.isArray(d.products)) return {items: [], last: 0, total: 0};
  const items = d.products.map(p => item(p.id, p.title, p.sales_price, p.is_discount ? p.discount_price : null,
    {code: p.barcode || '', img: (p.images && p.images[0]) || ''}));
  return {items, last: (d.pagination && d.pagination.last_page) || 0, total: (d.pagination && d.pagination.total) || 0};
}
async function collect_araz({log}){
  const all = new Map();
  let last = 1, total = 0;
  const url = p => BASE_araz + CAT_araz + (p > 1 ? '&page=' + p : '');
  for (let p = 1; p <= last && p <= 80; p++) {
    const r = parseArazPage(await page(url(p), {pause: 900}) || '');
    if (!r.items.length) break;
    last = r.last || last; total = r.total || total;
    for (const it of r.items) all.set(it.id, it);
  }
  /* if the list still moved while it was read, one more pass fills the gaps */
  if (total && all.size < total) {
    log('ikinci keçid:', all.size, '/', total);
    for (let p = 1; p <= last && all.size < total; p++) {
      await sleep(500);
      for (const it of parseArazPage(await page(url(p)) || '').items) all.set(it.id, it);
    }
  }
  log('cəmi', all.size, 'sayt deyir', total);
  return [...all.values()];
}

/* ===== Bazarstore ===== */
/* Bazarstore (bazarstore.az, a nopCommerce shop): every sweets category from the site menu,
   page by page. A discounted product shows an old price beside the actual one. */
const BASE_bazar = 'https://bazarstore.az';
const SWEET_CAT_BZ = /sirniyyat|sokolad|konfet|karamel|seker|pecen|vafli|vafel|rulet|marmalad|marmelad|draje|jelibon|saqqiz|tort|keks|biskvit|kreker|zefir|lokum|halva|pastila|bar[ -]|baton/;
const NOT_BZ = /dondurma|icki|su\b|meyve|terevez|et\b|toyuq|qelyanalti|cips|^seker$|seker tozu|kesme seker|seker ve|cay|qehve|kofe|pudra|azer.seker|bisirme|hamisina bax/;
/* known sweets categories, plus whatever the menu adds later */
const KNOWN_BZ = ['cekili-sirniyyat', 'cekili-sokolad', 'cekili-karamel', 'cekili-pecenye', 'cekili-vafli', 'cekili-marmalad', 'cekili-draje', 'cekili-jelibon', 'sokoladlar', 'sekerleme', 'vafli-rulet'];

async function categories(log){
  const cats = new Map(KNOWN_BZ.map(s => [s, s]));
  try {
    const html = await page(BASE_bazar + '/');
    for (const m of html.matchAll(/<a\b[^>]*href="(?:https:\/\/bazarstore\.az)?\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const slug = m[1], txt = norm(decode(m[2]));
      if (!txt || txt.length > 40) continue;
      if ((SWEET_CAT_BZ.test(txt) || SWEET_CAT_BZ.test(slug)) && !NOT_BZ.test(txt) && !NOT_BZ.test(slug.replace(/-/g, ' '))) cats.set(slug, txt);
    }
  } catch (e) { log('menyu oxunmadı:', e.message); }
  return [...cats.keys()];
}
/* the product boxes of one listing page */
function parseList(html){
  const out = [], heads = [...html.matchAll(/<div\b[^>]*class="[^"]*\bproduct-item\b[^"]*"[^>]*>/gi)];
  heads.forEach((h, i) => {
    const seg = html.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : h.index + 6000);
    const pid = (h[0].match(/data-productid="(\d+)"/) || [])[1];
    const t = seg.match(/class="[^"]*product-title[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!t) return;
    const href = t[1].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    const old = (seg.match(/class="[^"]*\bold-price\b[^"]*"[^>]*>([^<]+)</i) || [])[1];
    const act = (seg.match(/class="[^"]*\bactual-price\b[^"]*"[^>]*>([^<]+)</i) || [])[1];
    const img = (seg.match(/<img\b[^>]*(?:data-lazyloadsrc|data-src|src)="([^"]+)"/i) || [])[1] || '';
    /* the shop's own article number sits in the analytics data of the box */
    const sku = (h[0].match(/&quot;item_id&quot;:&quot;(\d+)|"item_id":"(\d+)"/) || []).slice(1).find(Boolean) || '';
    if (!act && !old) return;
    out.push(item(pid || href, t[2], old || act, old ? act : null, {img: img.startsWith('http') ? img : img ? BASE_bazar + img : '', code: sku}));
  });
  return out;
}
async function collect_bazar({log}){
  const all = new Map();
  for (const cat of await categories(log)) {
    let pages = 1, n0 = all.size;
    for (let p = 1; p <= pages && p <= 200; p++) {
      const html = await page(`${BASE_bazar}/${cat}?pagenumber=${p}&pagesize=20`);
      if (!html) break;
      const list = parseList(html);
      if (!list.length) break;
      let fresh = 0; for (const it of list) { if (!all.has(it.id)) fresh++; all.set(it.id, it); }
      const last = Math.max(1, ...[...html.matchAll(/pagenumber=(\d+)/gi)].map(m => +m[1]));
      pages = Math.max(pages, last);
      if (!fresh && p > 1) break;
    }
    log(cat, '+' + (all.size - n0));
  }
  return [...all.values()];
}

/* ===== OBA ===== */
/* OBA (oba.az): the Şirniyyat list, 30 products a page, the next ones at &start=30, 60, ...
   The site gives no product id, so the id is the name made into a slug (as when first imported).
   The list shows one price; OBA does not show discounts on the site. */
const BASE_oba = 'https://oba.az';
const TYPE_OBA = 'bc8c4845-103e-4462-b10b-dae0612eaf58';   // Şirniyyat

export function parseObaPage(h){
  const out = [];
  for (const raw of h.split('<!-- Product card -->').slice(1)) {
    const c = raw.slice(0, raw.indexOf('</a>') > 0 ? raw.indexOf('</a>') : 4000).replace(/<!--[\s\S]*?-->/g, '');
    const name = decode((c.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '');
    if (!name) continue;
    const prices = [...c.matchAll(/>\s*(\d+(?:[.,]\d{1,2})?)\s*</g)].map(m => m[1]);
    const old = (c.match(/<(?:del|s)\b[^>]*>[\s\S]*?(\d+[.,]\d{2})/i) || [])[1];
    const img = (c.match(/<img\b[^>]*src="([^"]+)"/i) || [])[1] || '';
    const now = prices.filter(p => p !== old).pop();
    if (!now) continue;
    out.push(item(slug(name), name, old || now, old ? now : null, {img}));
  }
  return out;
}
async function collect_oba({log}){
  const all = new Map();
  for (let start = 0; start <= 6000; start += 30) {
    const h = await page(`${BASE_oba}/products/?type=${TYPE_OBA}&sort=a&start=${start}&brand=&filter=`);
    const list = parseObaPage(h || '');
    if (!list.length) break;
    let fresh = 0; for (const it of list) { if (!all.has(it.id)) fresh++; all.set(it.id, it); }
    if (!fresh) break;
  }
  log('cəmi', all.size);
  return [...all.values()];
}

/* ===== Shops whose prices are read from their Wolt branch (no price catalogue of their own) ===== */
export const STORES = [
  {id: 'araz', name: 'Araz', order: 1, collect: collect_araz},
  {id: 'bazar', name: 'Bazarstore', order: 2, collect: collect_bazar},
  {id: 'oba', name: 'OBA', order: 3, collect: collect_oba},
  {id: 'tam', name: 'Tamstore', order: 4, via: 'Wolt', collect: woltStore(['tamstore-20-yanvar', 'tamstore-yeni-yasamal', 'tamstore-tarqovaya', 'tamstore-bayil'])},
  {id: 'bravo', name: 'Bravo', order: 5, via: 'Wolt', collect: woltStore(['bravo-supermarket-genclik', 'bravo-tahir-97', 'bravo-supermarket-samad-vurgun', 'bravo-supermarket-4-mkr'])},
  {id: 'neptun', name: 'Neptun', order: 6, via: 'Wolt', collect: woltStore(['neptun-supermarket-28', 'neptun-supermarket-narimanovv', 'neptun-supermarket-3-mkr', 'neptun-8-mkr'])},
  {id: 'spar', name: 'SPAR', order: 7, via: 'Wolt', collect: woltStore(['spar-axundov'])},
  {id: 'woltm', name: 'Wolt Market', order: 8, via: 'Wolt', collect: woltStore(['wolt-market-yasamal', 'wolt-market-baku', 'wolt-market-nasimi', 'wolt-market-landmark'])},
];
