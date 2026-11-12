/* Shared helpers for the shop readers: polite fetching, numbers, names. No dependencies. */
export const UA = 'Mozilla/5.0 (compatible; MehsulBazasiBot/1.0; +https://gundeminfo.github.io/kod-yaddasim/)';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* one request at a time per shop, a short pause between them, three tries on a failure */
export async function get(url, {json = false, headers = {}, pause = 700, tries = 3} = {}){
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      await sleep(i ? 2000 * i : pause);
      const r = await fetch(url, {headers: {'user-agent': UA, 'accept-language': 'az,en;q=0.8', ...headers}, redirect: 'follow'});
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return json ? await r.json() : await r.text();
    } catch (e) { last = e; }
  }
  throw last;
}

/* robots.txt: the paths a shop asks robots to leave alone */
const robotsCache = new Map();
export async function allowed(url){
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const txt = await get(u.origin + '/robots.txt', {pause: 0, tries: 1}) || '';
      let mine = false;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
        const [k, ...rest] = line.split(':'); const v = rest.join(':').trim();
        if (/^user-agent$/i.test(k)) mine = v === '*' || /mehsul/i.test(v);
        else if (mine && /^disallow$/i.test(k) && v) rules.push(v);
        else if (mine && /^allow$/i.test(k) && v) rules.push('!' + v);
      }
    } catch (e) {}
    robotsCache.set(u.origin, rules);
  }
  const path = u.pathname + u.search;
  let verdict = true, len = -1;
  for (const r of robotsCache.get(u.origin)) {
    const allow = r.startsWith('!'), p = allow ? r.slice(1) : r;
    const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && p.length > len) { verdict = allow; len = p.length; }
  }
  return verdict;
}
export async function page(url, opts){
  if (!await allowed(url)) throw new Error('robots.txt disallows ' + url);
  return get(url, opts);
}

/* "2,99 ₼" -> 2.99 */
export const num = s => {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? Math.round(s * 100) / 100 : null;
  const m = String(s).replace(/\s+/g, '').replace(/,(\d{1,2})(?!\d)/, '.$1').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0]) * 100) / 100 : null;
};
export const decode = s => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, ' ').trim();
export const norm = s => String(s ?? '').toLocaleLowerCase('az')
  .replace(/i\u0307/g, 'i').replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c')
  .replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim();
export const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const isKg = s => /\bk[qg]\b|\bkilo|\bceki/.test(norm(s));
/* one item as the app reads it */
export function item(id, name, r, s, extra = {}){
  r = num(r); s = num(s);
  if (r == null && s != null) { r = s; s = null; }
  if (s != null && r != null && s >= r) s = null;
  return {id: String(id), name: decode(name), r, s, unit: extra.unit || (isKg(name) ? 'kq' : 'ed'), img: extra.img || '', code: extra.code ? String(extra.code) : ''};
}
/* sweets words, for shops whose category tree we cannot narrow down */
export const SWEET = /sirniyyat|sokolad|konfet|karamel|karovka|korovka|iris|vafli|vafel|peceny|biskvit|kreker|tort|keks|rulet|zefir|marmelad|lokum|halva|pastila|draje|jele|jelibon|saqqiz|baton|pryanik|kruassan|sufle|chocolate|candy|cookie|wafer|biscuit|gum/;

/* Shops that sell online only through Wolt. Wolt's own web page reads the same public catalogue:
   a venue's category tree, then each category's items, 50 at a time (page_token for the next).
   Prices come in qəpik; an item on sale has original_price above price; weighed items are per kg.
   One Bakı branch stands for the chain; the first branch on the list that answers is used. */
const API = 'https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/';
const SWEET_CAT = /sirniyyat|sokolad|konfet|pecen|vafli|tort|keks|rulet|biskvit|saqqiz|desert|marmelad|zefir|lokum|halva|sweets|chocolate|candy|cookie|confection/;
const NOT_CAT = /^seker$|dondurma|icki|kofe|cay\b|^bal$|murebbe|^cem$|kakao|isti sokolad|donmus|meyve|terevez/;
const HEAD = {accept: 'application/json', origin: 'https://wolt.com', referer: 'https://wolt.com/'};

function sweetCats(cats){
  const out = [];
  const walk = (list, inSweet) => {
    for (const c of list || []) {
      const n = norm(c.name || '');
      if (NOT_CAT.test(n)) continue;          // ice cream, honey, jam, cocoa drinks: not sweets here
      const sweet = inSweet || SWEET_CAT.test(n);
      if (sweet && !(c.subcategories || []).length) out.push(c.slug);
      else if ((c.subcategories || []).length) walk(c.subcategories, sweet);
      else if (sweet) out.push(c.slug);
    }
  };
  walk(cats, false);
  return [...new Set(out)];
}
export function woltItem(i){
  const w = i.sell_by_weight_config || (i.unit_price && i.unit_price.unit === 'kilogram');
  const now = w && i.sell_by_weight_config && i.sell_by_weight_config.price_per_kg ? i.sell_by_weight_config.price_per_kg : i.price;
  const was = w && i.unit_price && i.unit_price.unit === 'kilogram' ? i.unit_price.original_price : i.original_price;
  const r = (was && was > now ? was : now) / 100, s = was && was > now ? now / 100 : null;
  return item(i.id, i.name, r, s, {unit: w ? 'kq' : 'ed', img: (i.images && i.images[0] && i.images[0].url) || '', code: i.barcode_gtin || ''});
}
export function woltStore(venues){
  return async function collect({log}){
    let venue = null, tree = null;
    for (const v of venues) {
      try { tree = await get(API + v + '/assortment?language=az', {json: true, headers: HEAD, tries: 2}); if (tree && tree.categories) { venue = v; break; } } catch (e) { log(v, e.message); }
    }
    if (!venue) throw new Error('heç bir filial cavab vermədi');
    const cats = sweetCats(tree.categories);
    log(venue, 'kateqoriyalar:', cats.join(', '));
    const all = new Map();
    for (const slug of cats) {
      let token = null, guard = 0;
      do {
        const url = API + venue + '/assortment/categories/slug/' + slug + '?language=az' + (token ? '&page_token=' + encodeURIComponent(token) : '');
        const j = await get(url, {json: true, headers: HEAD, pause: 1200});
        if (!j) break;
        for (const i of j.items || []) if (i && i.id && i.price != null) all.set(i.id, woltItem(i));
        token = j.metadata && j.metadata.next_page_token;
      } while (token && ++guard < 60);
      await sleep(400);
    }
    log('cəmi', all.size);
    return [...all.values()];
  };
}
