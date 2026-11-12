/* Daily price robot. Reads every shop in ./stores, then writes for the app:
     data/prices/latest.json   today's prices of every shop
     data/hist/YYYY-MM.json    every change this month (first sighting in a month = that day's state)
     data/hist/index.json      which months exist, first day of the history
     data/status.json          what happened on the last run
   A shop that fails, or returns far fewer items than last time, keeps yesterday's list and records
   no changes, so a broken page never looks like every product went off sale.
   Usage: node robot.mjs [--only araz,bazar] [--data path/to/data] [--day YYYY-MM-DD] [--dry] */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const DATA = opt('data') || join(HERE, 'data');
const ONLY = opt('only') ? new Set(opt('only').split(',')) : null;
const DRY = args.includes('--dry');
const TIME_LIMIT = 25 * 60e3;   // per shop

const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { return fallback; } };
const writeJson = async (p, v) => { if (DRY) return; await mkdir(dirname(p), {recursive: true}); await writeFile(p, JSON.stringify(v)); };
/* the shops' calendar day, in Baku */
const bakuDay = opt('day') || new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Baku', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const [Y, M, D] = bakuDay.split('-').map(Number);
const monthKey = bakuDay.slice(0, 7);

async function loadStores(){
  const {STORES} = await import(process.env.STORES_FILE || join(HERE, 'robot-shops.mjs'));
  return STORES.filter(s => !s.disabled && (!ONLY || ONLY.has(s.id))).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ': vaxt bitdi')), ms); })]).finally(() => clearTimeout(t)); };

async function main(){
  const prev = await readJson(join(DATA, 'prices', 'latest.json'), {v: 1, stores: {}, items: {}});
  const latest = {v: 1, at: new Date().toISOString(), stores: {...(prev.stores || {})}, items: {...(prev.items || {})}};
  const stores = await loadStores();
  const report = [];
  for (const st of stores) {
    const t0 = Date.now();
    const before = Object.keys((prev.items || {})[st.id] || {}).length;
    try {
      const list = await withTimeout(st.collect({log: (...a) => console.log(`[${st.id}]`, ...a)}), TIME_LIMIT, st.id);
      const items = {};
      for (const it of list) if (it && it.id && it.r != null) items[it.id] = [it.name, it.r, it.s ?? null, it.unit || '', it.img || '', it.code || ''];
      const n = Object.keys(items).length;
      if (!n || (before > 40 && n < before * 0.6)) throw new Error(`az məhsul: ${n} (əvvəl ${before})`);
      latest.items[st.id] = items;
      latest.stores[st.id] = {name: st.name, via: st.via || null, ok: true, n, at: new Date().toISOString(), err: null, secs: Math.round((Date.now() - t0) / 1000)};
      report.push(`${st.id}: ${n} məhsul, ${Math.round((Date.now() - t0) / 1000)} san`);
    } catch (e) {
      latest.stores[st.id] = {...(prev.stores || {})[st.id], name: st.name, via: st.via || null, ok: false, err: String(e && e.message || e).slice(0, 300), tried: new Date().toISOString()};
      report.push(`${st.id}: XƏTA ${e && e.message}`);
      console.error(st.id, e);
    }
  }

  /* this month's history: today's state of every item whose price differs from its last entry */
  const histPath = join(DATA, 'hist', monthKey + '.json');
  const H = await readJson(histPath, {v: 1, month: monthKey, last: 0, names: {}, ev: []});
  const lastOf = new Map();   // 'store:id' -> index of its latest event
  H.ev.forEach((e, i) => lastOf.set(e[1] + ':' + e[2], i));
  let added = 0;
  for (const [sid, meta] of Object.entries(latest.stores)) {
    if (!meta.ok || (ONLY && !ONLY.has(sid))) continue;
    if (stores.length && !stores.some(s => s.id === sid)) continue;
    const now = latest.items[sid] || {};
    const keys = new Set([...Object.keys(now), ...Object.keys((prev.items || {})[sid] || {})]);
    for (const id of keys) {
      const key = sid + ':' + id, it = now[id];
      const r = it ? it[1] : null, s = it ? it[2] : null;
      const li = lastOf.get(key), le = li != null ? H.ev[li] : null;
      if (!it && (!le || le[3] == null)) continue;               // gone, and already marked gone (or never seen this month)
      if (le && le[3] === r && le[4] === s) continue;            // unchanged
      if (it) H.names[key] = it[0];
      if (le && le[0] === D) { le[3] = r; le[4] = s; continue; }  // a second run on the same day corrects that day
      lastOf.set(key, H.ev.length); H.ev.push([D, sid, id, r, s]); added++;
    }
  }
  H.last = D;
  await writeJson(histPath, H);
  const idx = await readJson(join(DATA, 'hist', 'index.json'), {v: 1, first: bakuDay, months: []});
  if (!idx.months.includes(monthKey)) idx.months.push(monthKey);
  idx.months.sort(); idx.last = bakuDay;
  await writeJson(join(DATA, 'hist', 'index.json'), idx);
  await writeJson(join(DATA, 'prices', 'latest.json'), latest);
  await writeJson(join(DATA, 'status.json'), {at: latest.at, day: bakuDay, changes: added, report});
  console.log(report.join('\n'));
  console.log(`tarixçəyə ${added} dəyişiklik yazıldı (${monthKey})`);
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
