'use strict';

// ===== Einstellungen =====
// Datenquelle: Transitous (MOTIS). v6.db.transport.rest ist seit 2026 abgeschaltet.
// Bei Bedarf hier austauschen (jede MOTIS-2-Instanz mit gleicher API funktioniert).
const API_BASE = 'https://api.transitous.org/api';
const TZ = 'Europe/Berlin';
const REFRESH_MS = 60_000;
// Nur Nahverkehr: kein ICE/IC/EC, keine Nachtzüge, keine Fernbusse
const TRANSIT_MODES = 'REGIONAL_RAIL,REGIONAL_FAST_RAIL,SUBURBAN,TRAM,SUBWAY,METRO,BUS,FERRY';
const REQUEST_TIMEOUT_MS = 20_000;
const RESULTS_PER_PAGE = 5;
const STORAGE_KEY = 'pendel.routes.v1';
const DETAIL_KEY = 'pendel.detail.v1';
const OFFSETS = [0, 15, 30, 60];
// Farbverläufe der Kacheln auf der Startseite (der Reihe nach)
const TILE_COLORS = [['#4f5bff', '#8a4dff'], ['#00a6c8', '#2f7bff'], ['#ff6a3d', '#ff3d7f'], ['#12a150', '#00a6a6'], ['#c04dff', '#ff4da6']];

// Haltestellen-IDs ermittelt über /v1/geocode am 23.10.2026.
// dbName/eva = Name und Haltestellennummer bei bahn.de (für den Link „In DB Navigator öffnen“).
const STOPS = {
  frankenthal: { id: 'de-DELFI_de:07311:771_G', name: 'Frankenthal (Pfalz) Hbf', dbName: 'Frankenthal Hbf', eva: '8000332', lat: 49.53557, lon: 8.349702 },
  karlsruheHbf: { id: 'de-DELFI_de:08212:90_G', name: 'Karlsruhe Hbf', dbName: 'Karlsruhe Hbf', eva: '8000191', lat: 48.993515, lon: 8.402181 },
  kronenplatz: { id: 'de-KVV_Pde:08212:80', name: 'Karlsruhe Kronenplatz', dbName: 'Kronenplatz (U), Karlsruhe', eva: '501002', lat: 49.008854, lon: 8.410072 },
  woerth: { id: 'de-DELFI_de:07334:1731', name: 'Wörth (Rhein)', dbName: 'Wörth(Rhein)', eva: '8000254', lat: 49.045746, lon: 8.273062 },
};

const DEFAULT_ROUTES = [
  { id: 'r1', name: 'Frankenthal – Karlsruhe Hbf', from: STOPS.frankenthal, to: STOPS.karlsruheHbf },
  { id: 'r2', name: 'Frankenthal – Kronenplatz', from: STOPS.frankenthal, to: STOPS.kronenplatz },
  { id: 'r3', name: 'Kronenplatz – Wörth', from: STOPS.kronenplatz, to: STOPS.woerth },
];

// ===== Hilfsfunktionen =====
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });
const fmtTimeSec = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: TZ });
const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ });
const hhmm = (d) => (d ? fmtTime.format(new Date(d)) : '–');

function berlinLocalISO(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: TZ,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function sameBerlinDay(a, b) { return fmtDay.format(a) === fmtDay.format(b); }

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} Min`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
}

function delayMin(sched, rt) {
  if (!sched || !rt) return 0;
  return Math.round((new Date(rt) - new Date(sched)) / 60000);
}

const isTransit = (leg) => !!leg.tripId;

function lineLabel(leg) {
  let name = (leg.displayName || leg.routeShortName || '').replace(/\s*\(\d+\)\s*$/, '').trim();
  if (!name) name = leg.tripShortName || leg.mode;
  if (/^\d/.test(name)) {
    if (leg.mode === 'TRAM') name = `Tram ${name}`;
    else if (leg.mode === 'BUS') name = `Bus ${name}`;
    else if (leg.mode === 'SUBWAY') name = `U ${name}`;
  }
  return name;
}

function lineChip(leg) {
  const style = leg.routeColor
    ? ` style="background:#${esc(leg.routeColor)};color:#${esc(leg.routeTextColor || 'ffffff')}"`
    : '';
  return `<span class="line${leg.cancelled ? ' cancelled' : ''}"${style}>${esc(lineLabel(leg))}</span>`;
}

// KVV liefert dasselbe Gleis mal als „1(U)“, mal als „1U.“ oder „1“
const normTrack = (t) => String(t).replace(/[\s.()]/g, '').replace(/U$/i, '').toUpperCase();

function trackHtml(place, prefix = 'Gl. ') {
  const changed = place.track && place.scheduledTrack && normTrack(place.track) !== normTrack(place.scheduledTrack);
  const t = changed ? place.track : (place.scheduledTrack || place.track);
  if (!t) return '';
  return changed
    ? `<span class="track-changed" title="Gleisänderung, geplant ${esc(place.scheduledTrack)}">${prefix}${esc(t)} (statt ${esc(place.scheduledTrack)})</span>`
    : `<span>${prefix}<b>${esc(t)}</b></span>`;
}

// Zeit mit Verspätungsfarbe; Planzeit durchgestrichen bei Abweichung
function timeHtml(sched, rt, realTime, cls = 't') {
  if (!realTime || !rt) {
    return `<span class="${cls} plan">${hhmm(sched || rt)}</span>`;
  }
  const d = delayMin(sched, rt);
  if (d === 0) return `<span class="${cls} ok">${hhmm(rt)}</span>`;
  return `<span class="${cls} ${d > 0 ? 'late' : 'ok'}">${hhmm(rt)}</span> <span class="t-sched struck">${hhmm(sched)}</span>`;
}

// Großer Zeitblock: Echtzeit groß, darunter Planzeit und Verspätung als Pille
function timeBlock(sched, rt, realTime, align = '') {
  if (!realTime || !rt) {
    return `<div class="tb ${align}"><span class="t plan">${hhmm(sched || rt)}</span><span class="tb-sub">Fahrplan</span></div>`;
  }
  const d = delayMin(sched, rt);
  if (d === 0) return `<div class="tb ${align}"><span class="t ok">${hhmm(rt)}</span><span class="tb-sub ok">pünktlich</span></div>`;
  const cls = d > 0 ? 'late' : 'ok';
  return `<div class="tb ${align}"><span class="t ${cls}">${hhmm(rt)}</span>`
    + `<span class="tb-sub"><s>${hhmm(sched)}</s> <span class="pill ${cls}">${d > 0 ? '+' : ''}${d}</span></span></div>`;
}

// Balken über die ganze Reise: farbige Fahrten, gepunktete Fußwege, Lücken = Wartezeit
function journeyBar(it) {
  const start = new Date(it.startTime);
  const total = Math.max(new Date(it.endTime) - start, 1);
  let cursor = start;
  const parts = [];
  for (const leg of it.legs) {
    const s = new Date(leg.startTime);
    const e = new Date(leg.endTime);
    if (s - cursor > 60000) parts.push(`<span class="seg wait" style="flex-grow:${(s - cursor) / total}"></span>`);
    const grow = Math.max(e - s, 0) / total;
    if (isTransit(leg)) {
      const bg = leg.routeColor ? `#${esc(leg.routeColor)}` : 'var(--accent)';
      parts.push(`<span class="seg${leg.cancelled ? ' cancelled' : ''}" style="flex-grow:${grow};background:${bg}" title="${esc(lineLabel(leg))}"></span>`);
    } else if (e - s >= 60000) {
      parts.push(`<span class="seg walk" style="flex-grow:${grow}"></span>`);
    }
    if (e > cursor) cursor = e;
  }
  return `<div class="jbar" aria-hidden="true">${parts.join('')}</div>`;
}

function stopsTimeline(fromName, toName) {
  return `<div class="tile-stops">
    <div class="ts"><span class="ts-dot"></span><span>${esc(fromName)}</span></div>
    <div class="ts"><span class="ts-dot end"></span><span>${esc(toName)}</span></div>
  </div>`;
}

function collectAlerts(legs) {
  const seen = new Map();
  const add = (a) => {
    if (!a || !a.headerText) return;
    const key = a.headerText + '|' + (a.descriptionText || '');
    if (!seen.has(key)) seen.set(key, a);
  };
  for (const leg of legs) {
    (leg.alerts || []).forEach(add);
    (leg.from?.alerts || []).forEach(add);
    (leg.to?.alerts || []).forEach(add);
    (leg.intermediateStops || []).forEach((s) => (s.alerts || []).forEach(add));
  }
  return [...seen.values()];
}

function alertsHtml(alerts, full = false) {
  if (!alerts.length) return '';
  if (!full) {
    const more = alerts.length > 1 ? ` (+${alerts.length - 1} weitere)` : '';
    return `<div class="alert-box">⚠️ ${esc(alerts[0].headerText)}${more}</div>`;
  }
  return alerts.map((a) => `<div class="alert-box"><b>⚠️ ${esc(a.headerText)}</b>${
    a.descriptionText && a.descriptionText !== a.headerText ? `<p>${esc(a.descriptionText)}</p>` : ''}${
    a.url ? `<p><a href="${esc(a.url)}" target="_blank" rel="noopener">Mehr Infos</a></p>` : ''}</div>`).join('');
}

function summarize(it) {
  const transit = it.legs.filter(isTransit);
  if (!transit.length) return null;
  const first = transit[0];
  const last = transit[transit.length - 1];
  const cancelled = transit.some((l) => l.cancelled || l.from.cancelled || l.to.cancelled);
  return {
    it, transit, first, last, cancelled,
    depSched: first.from.scheduledDeparture, depRt: first.from.departure, depReal: first.realTime,
    arrSched: last.to.scheduledArrival, arrRt: last.to.arrival, arrReal: last.realTime,
    key: transit.map((l) => `${l.tripId}@${l.from.scheduledDeparture}`).join('|'),
    alerts: collectAlerts(it.legs),
  };
}

function stopsOf(leg) {
  return [leg.from, ...(leg.intermediateStops || []), leg.to];
}

// ===== Speicher =====
function loadRoutes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const r = JSON.parse(raw);
      if (Array.isArray(r)) return r;
    }
  } catch { /* fällt auf Standard zurück */ }
  return structuredClone(DEFAULT_ROUTES);
}
function saveRoutes(routes) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(routes)); } catch { alert('Speichern nicht möglich (Speicher voll oder privat?).'); }
}
let routes = loadRoutes();

// ===== API =====
class ApiError extends Error {
  constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
}

async function api(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new ApiError('http', res.status);
    return await res.json();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError('timeout');
    throw new ApiError(navigator.onLine === false ? 'offline' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

function errorText(e) {
  if (!(e instanceof ApiError)) return 'Unerwarteter Fehler beim Verarbeiten der Daten.';
  switch (e.kind) {
    case 'offline': return 'Keine Internetverbindung.';
    case 'timeout': return 'Der Fahrplan-Server antwortet nicht (Zeitüberschreitung).';
    case 'network': return 'Der Fahrplan-Server ist nicht erreichbar.';
    default:
      if (e.status === 429) return 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.';
      if (e.status >= 500) return `Der Fahrplan-Server ist gerade gestört (Fehler ${e.status}).`;
      return `Die Anfrage wurde abgelehnt (Fehler ${e.status}).`;
  }
}

function dbLink(from, to, date = new Date()) {
  const enc = encodeURIComponent;
  const name = (s) => s.dbName || s.name;
  const lid = (s) => (s.eva ? `A=1@O=${name(s)}@L=${s.eva}@` : '');
  return `https://www.bahn.de/buchung/fahrplan/suche#sts=true&so=${enc(name(from))}&zo=${enc(name(to))}`
    + `&soid=${enc(lid(from))}&zoid=${enc(lid(to))}`
    + `&kl=2&r=13:16:KLASSENLOS:1&hd=${enc(berlinLocalISO(date))}&hza=D&ar=false&s=true&d=false&hz=%5B%5D&fm=false&bp=false`;
}

function errorBox(e, from, to, date, retryId) {
  return `<div class="error-box" role="alert">
    <h2>Keine Daten abrufbar</h2>
    <p>${esc(errorText(e))}</p>
    <button class="btn primary" id="${retryId}">Erneut versuchen</button>
    <a class="btn" href="${esc(dbLink(from, to, date))}" target="_blank" rel="noopener">In DB Navigator öffnen</a>
  </div>`;
}

// ===== Router / Rahmen =====
let cleanup = null;
let currentRefresh = null;

function setHeader({ title, back, refresh, manage }) {
  $('#title').textContent = title;
  $('#btn-back').hidden = !back;
  $('#btn-refresh').hidden = !refresh;
  $('#btn-manage').hidden = !manage;
}

function setBusy(busy) { $('#btn-refresh').classList.toggle('spin', busy); }

function startAutoRefresh(fn) {
  const tick = () => { if (document.visibilityState === 'visible') fn(); };
  const id = setInterval(tick, REFRESH_MS);
  const onVis = () => { if (document.visibilityState === 'visible') fn(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
}

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  currentRefresh = null;
  setBusy(false);
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const view = $('#view');
  if (parts[0] === 'r' && parts[1]) return viewConnections(view, parts[1], parts[2] === '1');
  if (parts[0] === 'c') return viewDetail(view);
  if (parts[0] === 'manage') return viewManage(view);
  if (parts[0] === 'edit') return viewEdit(view, parts[1]);
  return viewHome(view);
}

$('#btn-refresh').addEventListener('click', () => currentRefresh && currentRefresh());
$('#btn-manage').addEventListener('click', () => { location.hash = '#/manage'; });
window.addEventListener('hashchange', route);

// Zurück-Knopf: einfache, vorhersehbare Ziele statt Browser-Historie
function backTarget() {
  const h = location.hash;
  if (h.startsWith('#/c')) {
    const d = readDetail();
    return d ? `#/r/${d.routeId}/${d.reverse ? 1 : 0}` : '#/';
  }
  if (h.startsWith('#/edit')) return '#/manage';
  return '#/';
}
$('#btn-back').addEventListener('click', () => { location.hash = backTarget(); });

// ===== Pull-to-Refresh =====
(() => {
  const ptr = $('#ptr');
  let startY = null; let dist = 0;
  const TH = 70;
  window.addEventListener('touchstart', (e) => {
    if (!currentRefresh || window.scrollY > 0 || e.target.closest('#map')) { startY = null; return; }
    startY = e.touches[0].clientY; dist = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dist = Math.max(0, e.touches[0].clientY - startY);
    if (window.scrollY > 0) dist = 0;
    ptr.style.height = `${Math.min(dist * 0.5, 60)}px`;
    ptr.firstElementChild.textContent = dist > TH ? '↻ Loslassen zum Aktualisieren' : '↓ Zum Aktualisieren ziehen';
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (startY !== null && dist > TH && currentRefresh) currentRefresh();
    startY = null; dist = 0; ptr.style.height = '0';
  });
})();

// Transitous-Nutzungsbedingungen: Quellen verlinken und Kontakt (Repo) angeben
function repoUrl() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return null;
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return `https://github.com/${m[1]}${repo ? `/${repo}` : ''}`;
}
function footerHtml() {
  const repo = repoUrl();
  return `<p class="hint">Daten: <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous und Quellen</a>
    · Karte © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>
    ${repo ? `· <a href="${esc(repo)}" target="_blank" rel="noopener">Quellcode und Kontakt</a>` : ''}<br>Private, nicht-kommerzielle App. Angaben ohne Gewähr.</p>`;
}

// ===== Startseite =====
function viewHome(view) {
  setHeader({ title: 'Pendel', manage: true });
  if (!routes.length) {
    view.innerHTML = `<p class="hint">Noch keine Strecken gespeichert.</p>
      <a class="btn primary block" href="#/edit/new">+ Strecke hinzufügen</a>`;
    return;
  }
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('de-DE', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).formatToParts(now).find((p) => p.type === 'hour').value);
  const greet = hour < 5 ? 'Gute Nacht' : hour < 11 ? 'Guten Morgen' : hour < 17 ? 'Guten Tag' : hour < 22 ? 'Guten Abend' : 'Gute Nacht';
  const date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(now);
  view.innerHTML = `
    <section class="hero">
      <div class="hero-greet">${greet}</div>
      <div class="hero-date">${date} · ${hhmm(now)} Uhr</div>
    </section>
    <div class="tiles">${routes.map((r, i) => {
      const [a, b] = TILE_COLORS[i % TILE_COLORS.length];
      return `
      <div class="tile" style="--tile-a:${a};--tile-b:${b}">
        <button class="tile-main" data-go="#/r/${esc(r.id)}/0" aria-label="Hinfahrt ${esc(r.from.name)} nach ${esc(r.to.name)}">
          <div class="tile-name">${esc(r.name)}</div>
          ${stopsTimeline(r.from.name, r.to.name)}
        </button>
        <div class="tile-side">
          <button class="tile-swap" data-go="#/r/${esc(r.id)}/1" aria-label="Rückfahrt ${esc(r.to.name)} nach ${esc(r.from.name)}">⇅</button>
          <small>Rückfahrt</small>
        </div>
      </div>`;
    }).join('')}
      <a class="add-tile" href="#/edit/new">＋ Strecke hinzufügen</a>
    </div>
    ${footerHtml()}`;
  view.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
}

// ===== Verbindungsliste =====
function viewConnections(view, routeId, reverse) {
  const r = routes.find((x) => x.id === routeId);
  if (!r) { location.hash = '#/'; return; }
  const from = reverse ? r.to : r.from;
  const to = reverse ? r.from : r.to;
  setHeader({ title: r.name, back: true, refresh: true });
  const [ca, cb] = TILE_COLORS[routes.indexOf(r) % TILE_COLORS.length];
  const tileStyle = `--tile-a:${ca};--tile-b:${cb}`;

  const st = { offset: 0, items: [], pages: 0, error: null, loading: true, loadingMore: false, updated: null, token: 0 };

  const queryTime = () => new Date(Date.now() + st.offset * 60000);
  const depOf = (s) => new Date(s.depRt || s.depSched);

  // Eine „Seite“ = die nächsten RESULTS_PER_PAGE Verbindungen ab `after` (geplante Abfahrt)
  async function fetchPage(after, list) {
    let added = 0;
    // MOTIS liefert manchmal weniger als gewünscht: bis zu 2× nachladen
    for (let attempt = 0; attempt < 3 && added < RESULTS_PER_PAGE; attempt++) {
      const since = attempt === 0 ? after : nextAfter(list);
      const d = await api('/v6/plan', {
        fromPlace: from.id, toPlace: to.id, time: since.toISOString(), numItineraries: RESULTS_PER_PAGE, language: 'de', transitModes: TRANSIT_MODES,
      });
      const keys = new Set(list.map((x) => x.key));
      const fresh = (d.itineraries || []).map(summarize)
        .filter((s) => s && !keys.has(s.key) && depOf(s) >= since)
        .sort((a, b) => depOf(a) - depOf(b))
        .slice(0, RESULTS_PER_PAGE - added);
      if (!fresh.length) break;
      list.push(...fresh);
      added += fresh.length;
    }
    return added;
  }
  const nextAfter = (list) => new Date(depOf(list[list.length - 1]).getTime() + 60000);

  async function load() {
    const token = ++st.token;
    st.loading = true; st.error = null; setBusy(true); render();
    try {
      const pages = Math.max(1, st.pages);
      const t = queryTime();
      const items = [];
      // Abfahrten der letzten Minute noch zeigen (Planzeit), sonst verschwindet ein verspäteter Zug zu früh
      await fetchPage(new Date(t.getTime() - 60000), items);
      for (let p = 1; p < pages && items.length; p++) await fetchPage(nextAfter(items), items);
      if (token !== st.token) return;
      st.items = items; st.pages = pages; st.updated = new Date();
    } catch (e) {
      if (token !== st.token) return;
      st.error = e;
    } finally {
      if (token === st.token) { st.loading = false; setBusy(false); render(); }
    }
  }

  async function loadMore() {
    if (!st.items.length || st.loadingMore) return;
    st.loadingMore = true; render();
    const token = st.token;
    try {
      const list = [...st.items];
      await fetchPage(nextAfter(list), list);
      if (token !== st.token) return;
      st.items = list; st.pages += 1;
    } catch (e) {
      if (token === st.token) alert(errorText(e));
    } finally {
      st.loadingMore = false; render();
    }
  }

  function connHtml(s, idx) {
    const walkStart = s.it.legs[0].mode === 'WALK' && s.it.legs[0].duration >= 60 ? s.it.legs[0] : null;
    const lastLeg = s.it.legs[s.it.legs.length - 1];
    const walkEnd = lastLeg.mode === 'WALK' && lastLeg.duration >= 60 ? lastLeg : null;
    const showDay = !sameBerlinDay(new Date(s.depSched), new Date());
    const track = trackHtml(s.first.from);
    return `<button class="conn${s.cancelled ? ' cancelled' : ''}" data-idx="${idx}">
      ${s.cancelled ? '<div style="margin-bottom:10px"><span class="badge-cancel">Fällt aus</span></div>' : ''}
      <div class="conn-top">
        ${timeBlock(s.depSched, s.depRt, s.depReal)}
        <div class="conn-mid">
          <span class="dur">${fmtDuration(s.it.duration)}</span>
          <span class="rule"></span>
          <span class="tr">${s.it.transfers === 0 ? 'direkt' : `${s.it.transfers} Umstieg${s.it.transfers > 1 ? 'e' : ''}`}</span>
        </div>
        ${timeBlock(s.arrSched, s.arrRt, s.arrReal, 'right')}
      </div>
      ${journeyBar(s.it)}
      <div class="conn-meta">
        <span class="lines">${s.transit.map(lineChip).join('')}</span>
        ${track ? `<span class="meta-chip">${track}</span>` : ''}
        ${showDay ? `<span class="meta-chip">${fmtDay.format(new Date(s.depSched))}</span>` : ''}
      </div>
      ${walkStart ? `<div class="walk-note">🚶 vorher ${Math.round(walkStart.duration / 60)} Min Fußweg zu ${esc(walkStart.to.name)} (los um ${hhmm(walkStart.startTime)})</div>` : ''}
      ${walkEnd ? `<div class="walk-note">🚶 danach ${Math.round(walkEnd.duration / 60)} Min Fußweg ab ${esc(walkEnd.from.name)}, am Ziel ca. ${hhmm(walkEnd.endTime)}</div>` : ''}
      ${alertsHtml(s.alerts)}
    </button>`;
  }

  function render() {
    const chips = OFFSETS.map((o) => `<button class="chip" data-off="${o}" aria-pressed="${st.offset === o}">${o === 0 ? 'jetzt' : `+${o} Min`}</button>`).join('');
    let body;
    if (st.error) body = errorBox(st.error, from, to, queryTime(), 'retry');
    else if (st.loading && !st.items.length) body = '<div class="skeleton"></div>'.repeat(4);
    else if (!st.items.length) body = `<p class="hint">Keine Verbindungen gefunden.</p><a class="footer-link" href="${esc(dbLink(from, to, queryTime()))}" target="_blank" rel="noopener">In DB Navigator öffnen</a>`;
    else {
      body = st.items.map(connHtml).join('')
        + (`<button class="btn block more" id="more">${st.loadingMore ? 'Lade …' : 'Später ▾'}</button>`)
        + `<a class="footer-link" href="${esc(dbLink(from, to, queryTime()))}" target="_blank" rel="noopener">In DB Navigator öffnen ↗</a>`;
    }
    view.innerHTML = `
      <div class="route-card" style="${tileStyle}">${stopsTimeline(from.name, to.name)}</div>
      <div class="chips">${chips}</div>
      <div class="status-line">
        <span>${st.loading ? 'Aktualisiere …' : st.updated ? `<span class="live-dot"></span>Live · Stand ${fmtTimeSec.format(st.updated)}` : ''}</span>
        <span>ab ${hhmm(queryTime())} · alle 60 s</span>
      </div>
      ${body}`;
    view.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      st.offset = Number(b.dataset.off); st.pages = 0; st.items = []; load();
    }));
    view.querySelectorAll('.conn').forEach((b) => b.addEventListener('click', () => {
      const s = st.items[Number(b.dataset.idx)];
      writeDetail({ it: s.it, routeId: r.id, reverse, from, to });
      location.hash = '#/c';
    }));
    $('#more', view)?.addEventListener('click', loadMore);
    $('#retry', view)?.addEventListener('click', load);
  }

  currentRefresh = load;
  cleanup = startAutoRefresh(load);
  load();
}

// ===== Detailansicht =====
function writeDetail(d) { try { sessionStorage.setItem(DETAIL_KEY, JSON.stringify(d)); } catch { /* egal */ } window.__detail = d; }
function readDetail() {
  if (window.__detail) return window.__detail;
  try { return JSON.parse(sessionStorage.getItem(DETAIL_KEY)); } catch { return null; }
}

const tDep = (s) => new Date(s.departure || s.arrival || s.scheduledDeparture || s.scheduledArrival);
const tArr = (s) => new Date(s.arrival || s.departure || s.scheduledArrival || s.scheduledDeparture);

// Wo ist das Fahrzeug laut (Echtzeit-)Fahrplan? Rein rechnerisch, keine GPS-Position.
function legState(leg, now) {
  const stops = stopsOf(leg).map((s, i) => ({ s, i })).filter(({ s }) => !s.cancelled && (s.departure || s.arrival));
  if (stops.length < 2) return { state: 'unknown' };
  if (now < tDep(stops[0].s)) return { state: 'before' };
  if (now >= tArr(stops[stops.length - 1].s)) return { state: 'after' };
  for (let k = 0; k < stops.length; k++) {
    const a = stops[k].s;
    if (k > 0 && now >= tArr(a) && now < tDep(a)) return { state: 'at', i: stops[k].i };
    const b = stops[k + 1]?.s;
    if (b && now >= tDep(a) && now < tArr(b)) {
      const span = tArr(b) - tDep(a);
      return { state: 'between', i: stops[k].i, j: stops[k + 1].i, f: span > 0 ? (now - tDep(a)) / span : 0 };
    }
  }
  return { state: 'unknown' };
}

function isPassed(stop, idx, lastIdx, now) {
  const t = idx === lastIdx ? tArr(stop) : tDep(stop);
  return t <= now;
}

function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const out = [];
  let lat = 0; let lon = 0; let i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let result = 0; let shift = 0; let b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

function dist2(a, b) {
  const dy = a[0] - b[0];
  const dx = (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180);
  return dx * dx + dy * dy;
}

// Geschätzte Position: entlang der Streckengeometrie zwischen zwei Halten interpoliert
function estimatePosition(leg, ls) {
  const pts = leg.legGeometry ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6) : [];
  const stops = stopsOf(leg);
  if (ls.state === 'at') return [stops[ls.i].lat, stops[ls.i].lon];
  if (ls.state !== 'between') return null;
  const a = stops[ls.i]; const b = stops[ls.j];
  if (pts.length < 2) return [a.lat + (b.lat - a.lat) * ls.f, a.lon + (b.lon - a.lon) * ls.f];
  // Halte der Reihe nach auf der Linie verorten (Index steigt monoton)
  let from = 0; let ia = 0; let ib = 0;
  for (let k = 0; k <= ls.j; k++) {
    const p = [stops[k].lat, stops[k].lon];
    let best = from; let bestD = Infinity;
    for (let n = from; n < pts.length; n++) { const d = dist2(p, pts[n]); if (d < bestD) { bestD = d; best = n; } }
    from = best;
    if (k === ls.i) ia = best;
    if (k === ls.j) ib = best;
  }
  if (ib <= ia) return [a.lat + (b.lat - a.lat) * ls.f, a.lon + (b.lon - a.lon) * ls.f];
  const seg = []; let total = 0;
  for (let n = ia; n < ib; n++) { const d = Math.sqrt(dist2(pts[n], pts[n + 1])); seg.push(d); total += d; }
  let target = total * Math.min(Math.max(ls.f, 0), 1);
  for (let n = 0; n < seg.length; n++) {
    if (target <= seg[n] || n === seg.length - 1) {
      const t = seg[n] ? Math.min(target / seg[n], 1) : 0;
      const p = pts[ia + n]; const q = pts[ia + n + 1];
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    target -= seg[n];
  }
  return null;
}

function vehicleWord(leg) {
  if (leg.mode === 'TRAM') return 'Bahn';
  if (leg.mode === 'BUS' || leg.mode === 'COACH') return 'Bus';
  return 'Zug';
}

function viewDetail(view) {
  const d = readDetail();
  if (!d || !d.it) { location.hash = '#/'; return; }
  setHeader({ title: 'Verbindung', back: true, refresh: true });
  let map = null; let posMarker = null;
  const st = { it: d.it, updated: new Date(), error: null, loading: false };

  async function refresh() {
    if (!st.it.id) return;
    st.loading = true; setBusy(true);
    try {
      const fresh = await api('/v6/refresh-itinerary', { itineraryId: st.it.id, language: 'de', transitModes: TRANSIT_MODES });
      if (fresh && Array.isArray(fresh.legs) && fresh.legs.length) {
        st.it = fresh; d.it = fresh; writeDetail(d);
      }
      st.error = null; st.updated = new Date();
    } catch (e) {
      st.error = e;
    } finally {
      st.loading = false; setBusy(false); render();
    }
  }

  function stopRow(s, idx, lastIdx, leg, now) {
    const passed = isPassed(s, idx, lastIdx, now);
    const major = idx === 0 || idx === lastIdx;
    const showArr = idx > 0;
    const showDep = idx < lastIdx;
    const rt = leg.realTime;
    const times = [];
    if (showArr && (idx === lastIdx || !s.departure || delayMin(s.scheduledArrival, s.arrival) !== delayMin(s.scheduledDeparture, s.departure) || hhmm(s.arrival) !== hhmm(s.departure))) {
      times.push(['an', s.scheduledArrival, s.arrival]);
    }
    if (showDep) times.push([idx === 0 ? 'ab' : (times.length ? 'ab' : ''), s.scheduledDeparture, s.departure]);
    const tHtml = times.map(([lbl, sch, act]) => {
      const dly = delayMin(sch, act);
      if (!rt || !act) return `<div>${lbl ? `<small>${lbl}</small> ` : ''}${hhmm(sch || act)}</div>`;
      return `<div>${lbl ? `<small>${lbl}</small> ` : ''}<span class="rt ${dly > 0 ? 'late' : 'ok'}">${hhmm(act)}</span>${dly !== 0 ? `<span class="sched struck">${hhmm(sch)}</span>` : ''}</div>`;
    }).join('');
    return `<li class="stop${passed ? ' passed' : ''}${major ? ' major' : ''}${s.cancelled ? ' cancelled' : ''}">
      <span class="dot"></span>
      <div><div class="s-name">${esc(s.name)}${s.cancelled ? ' – Halt entfällt' : ''}</div><div class="s-track">${trackHtml(s)}</div></div>
      <div class="s-times">${tHtml}</div>
    </li>`;
  }

  function legHtml(leg, now) {
    if (!isTransit(leg)) {
      const mins = Math.max(1, Math.round(leg.duration / 60));
      return `<div class="walk-leg"><span>🚶</span><span>${mins} Min Fußweg${leg.distance ? ` (${Math.round(leg.distance)} m)` : ''} → ${esc(leg.to.name)}</span></div>`;
    }
    const stops = stopsOf(leg);
    const lastIdx = stops.length - 1;
    const ls = legState(leg, now);
    const veh = vehicleWord(leg);
    let stateTxt = '';
    if (leg.cancelled) stateTxt = '<span class="badge-cancel">Fahrt fällt aus</span>';
    else if (ls.state === 'before') {
      const m = Math.round((tDep(leg.from) - now) / 60000);
      stateTxt = `Abfahrt in ${m} Min`;
    } else if (ls.state === 'at') stateTxt = `${veh} hält in ${esc(stops[ls.i].name)}`;
    else if (ls.state === 'between') stateTxt = `${veh} ist zwischen ${esc(stops[ls.i].name)} und ${esc(stops[ls.j].name)}`;
    else if (ls.state === 'after') stateTxt = 'Angekommen';

    const rows = stops.map((s, idx) => {
      let row = stopRow(s, idx, lastIdx, leg, now);
      if (ls.state === 'between' && idx === ls.i) {
        row += `<li class="between">➜ ${veh} ist hier unterwegs (geschätzt)</li>`;
      }
      return row;
    }).join('');

    const legAlerts = collectAlerts([leg]);
    return `<div class="leg">
      <div class="leg-head">${lineChip(leg)}<span class="dir">→ ${esc(leg.headsign || leg.tripTo?.name || leg.to.name)}</span></div>
      <div class="leg-sub">${[leg.tripShortName && leg.tripShortName !== lineLabel(leg) ? `Fahrt ${esc(leg.tripShortName)}` : '', esc(leg.agencyName || ''), leg.realTime ? 'Echtzeit' : 'nur Fahrplan, keine Echtzeit'].filter(Boolean).join(' · ')}</div>
      ${stateTxt ? `<div class="leg-state">${stateTxt}</div>` : ''}
      ${alertsHtml(legAlerts, true)}
      <ul class="stops"${leg.routeColor ? ` style="--c:#${esc(leg.routeColor)}"` : ''}>${rows}</ul>
    </div>`;
  }

  function overall(now) {
    const transit = st.it.legs.filter(isTransit);
    if (transit.some((l) => l.cancelled)) return { cls: 'cancel', icon: '⚠️', html: 'Achtung: Diese Verbindung fällt (teilweise) aus.<small>Bitte eine andere Verbindung wählen.</small>' };
    for (const leg of transit) {
      const ls = legState(leg, now);
      const stops = stopsOf(leg);
      const veh = vehicleWord(leg);
      if (ls.state === 'before') {
        const m = Math.round((tDep(leg.from) - now) / 60000);
        return { icon: '🕒', html: `${esc(lineLabel(leg))} fährt in ${m} Min ab ${esc(leg.from.name)}<small>${trackHtml(leg.from)}</small>` };
      }
      if (ls.state === 'at') return { icon: '🚉', html: `${esc(lineLabel(leg))}: ${veh} hält in ${esc(stops[ls.i].name)}<small>Position geschätzt aus Fahrplan und Echtzeit</small>` };
      if (ls.state === 'between') return { icon: '🚆', html: `${esc(lineLabel(leg))}: ${veh} ist zwischen ${esc(stops[ls.i].name)} und ${esc(stops[ls.j].name)}<small>Position geschätzt aus Fahrplan und Echtzeit</small>` };
    }
    return { cls: 'done', icon: '✓', html: 'Reise beendet' };
  }

  function drawMap(now) {
    const el = $('#map', view);
    if (!el || typeof L === 'undefined') { if (el) el.innerHTML = '<p class="hint">Karte konnte nicht geladen werden.</p>'; return; }
    map = L.map(el, { zoomControl: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const bounds = [];
    for (const leg of st.it.legs) {
      const pts = leg.legGeometry ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6) : [];
      const line = pts.length ? pts : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
      bounds.push(...line);
      if (isTransit(leg)) {
        L.polyline(line, { color: leg.routeColor ? `#${leg.routeColor}` : '#0a5fd6', weight: 5, opacity: 0.85 }).addTo(map);
        for (const s of stopsOf(leg)) {
          L.circleMarker([s.lat, s.lon], { radius: 4, color: '#fff', weight: 2, fillColor: '#444', fillOpacity: 1 })
            .bindTooltip(s.name).addTo(map);
        }
      } else {
        L.polyline(line, { color: '#888', weight: 3, dashArray: '4 6' }).addTo(map);
      }
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
    updateMarker(now);
  }

  function updateMarker(now) {
    if (!map) return;
    let pos = null; let label = '';
    for (const leg of st.it.legs.filter(isTransit)) {
      const ls = legState(leg, now);
      if (ls.state === 'at' || ls.state === 'between') { pos = estimatePosition(leg, ls); label = lineLabel(leg); break; }
    }
    if (!pos) { if (posMarker) { posMarker.remove(); posMarker = null; } return; }
    if (!posMarker) {
      posMarker = L.marker(pos, { icon: L.divIcon({ className: '', html: '<div class="pos-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000 })
        .bindTooltip(`${label} · geschätzte Position`).addTo(map);
    } else posMarker.setLatLng(pos);
  }

  function render() {
    const now = new Date();
    const scrollY = window.scrollY;
    const s = summarize(st.it);
    const ov = overall(now);
    const legs = st.it.legs;
    let legsHtml = '';
    let prevTransit = null;
    legs.forEach((leg) => {
      if (isTransit(leg) && prevTransit) {
        const mins = Math.round((tDep(leg.from) - tArr(prevTransit.to)) / 60000);
        legsHtml += `<div class="transfer"><span>↪</span><span>Umstieg in ${esc(leg.from.name)}: ${mins} Min${mins < 4 ? ' – <b style="color:var(--late)">knapp!</b>' : ''}</span></div>`;
      }
      legsHtml += legHtml(leg, now);
      if (isTransit(leg)) prevTransit = leg;
    });

    const hadMap = !!map;
    if (map) { map.remove(); map = null; posMarker = null; }
    view.innerHTML = `
      ${s ? `<div class="hero-card">
        <div class="conn-top">
          ${timeBlock(s.depSched, s.depRt, s.depReal)}
          <div class="conn-mid"><span class="dur">${fmtDuration(st.it.duration)}</span><span class="rule"></span>
            <span class="tr">${st.it.transfers === 0 ? 'direkt' : `${st.it.transfers} Umstieg${st.it.transfers > 1 ? 'e' : ''}`}</span></div>
          ${timeBlock(s.arrSched, s.arrRt, s.arrReal, 'right')}
        </div>
        <div class="hc-names"><span>${esc(s.first.from.name)}</span><span>${esc(s.last.to.name)}</span></div>
        ${journeyBar(st.it)}
      </div>` : ''}
      <div class="banner${ov.cls ? ` ${ov.cls}` : ''}"><span class="b-icon">${ov.icon}</span><div>${ov.html}</div></div>
      <div class="status-line"><span>${st.loading ? 'Aktualisiere …' : `<span class="live-dot"></span>Live · Stand ${fmtTimeSec.format(st.updated)}`}</span><span>alle 60 s</span></div>
      ${st.error ? `<div class="alert-box">Aktualisierung fehlgeschlagen: ${esc(errorText(st.error))} Angezeigt wird der letzte Stand.</div>` : ''}
      <div class="map-wrap"><div id="map"></div><div class="map-note">● Position geschätzt, kein GPS</div></div>
      ${legsHtml}
      <a class="footer-link" href="${esc(dbLink(d.from, d.to, new Date(s ? s.depSched : Date.now())))}" target="_blank" rel="noopener">In DB Navigator öffnen ↗</a>`;
    drawMap(now);
    if (hadMap) window.scrollTo(0, scrollY);
  }

  render();
  currentRefresh = refresh;
  const stopAuto = startAutoRefresh(refresh);
  // Position und „passiert“-Markierung laufen zwischen den Abrufen weiter
  const ticker = setInterval(() => { if (document.visibilityState === 'visible') updateMarker(new Date()); }, 10_000);
  cleanup = () => { stopAuto(); clearInterval(ticker); if (map) { map.remove(); map = null; } };
  refresh();
}

// ===== Strecken verwalten =====
function viewManage(view) {
  setHeader({ title: 'Strecken verwalten', back: true });
  const render = () => {
    view.innerHTML = routes.map((r, i) => `
      <div class="manage-item">
        <div class="mi-text"><div class="mi-name">${esc(r.name)}</div><div class="mi-route">${esc(r.from.name)} ↔ ${esc(r.to.name)}</div></div>
        <button class="icon-btn" data-act="up" data-i="${i}" aria-label="Nach oben" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-act="down" data-i="${i}" aria-label="Nach unten" ${i === routes.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn" data-act="edit" data-i="${i}" aria-label="Bearbeiten">✎</button>
        <button class="icon-btn" data-act="del" data-i="${i}" aria-label="Löschen">🗑</button>
      </div>`).join('') + `
      <a class="btn primary block" href="#/edit/new" style="margin-top:12px">+ Strecke hinzufügen</a>
      <button class="btn block danger" id="reset" style="margin-top:24px">Auf meine 3 Standardstrecken zurücksetzen</button>`;
    view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      if (act === 'up' && i > 0) [routes[i - 1], routes[i]] = [routes[i], routes[i - 1]];
      else if (act === 'down' && i < routes.length - 1) [routes[i + 1], routes[i]] = [routes[i], routes[i + 1]];
      else if (act === 'edit') { location.hash = `#/edit/${encodeURIComponent(routes[i].id)}`; return; }
      else if (act === 'del') { if (!confirm(`„${routes[i].name}“ löschen?`)) return; routes.splice(i, 1); }
      saveRoutes(routes); render();
    }));
    $('#reset', view).addEventListener('click', () => {
      if (!confirm('Alle Strecken durch die drei Standardstrecken ersetzen?')) return;
      routes = structuredClone(DEFAULT_ROUTES); saveRoutes(routes); render();
    });
  };
  render();
}

function viewEdit(view, id) {
  const existing = routes.find((r) => r.id === id);
  setHeader({ title: existing ? 'Strecke bearbeiten' : 'Neue Strecke', back: true });
  const draft = existing ? structuredClone(existing) : { id: `r${Date.now().toString(36)}`, name: '', from: null, to: null };
  const search = { from: { q: '', results: [], loading: false, error: null }, to: { q: '', results: [], loading: false, error: null } };
  let debounce = null; let reqNo = 0;

  function pickerHtml(key, label) {
    const val = draft[key];
    const s = search[key];
    if (val) {
      return `<div class="form-row"><label>${label}</label>
        <div class="picked"><span>${esc(val.name)}</span><button class="icon-btn" data-clear="${key}" aria-label="${label} ändern">✕</button></div></div>`;
    }
    const list = s.loading ? '<li><button disabled>Suche …</button></li>'
      : s.error ? `<li><button disabled>${esc(errorText(s.error))}</button></li>`
      : s.results.map((x, i) => `<li><button data-pick="${key}" data-i="${i}">${esc(x.name)}<small>${esc(x.area)}</small></button></li>`).join('');
    return `<div class="form-row"><label for="q-${key}">${label}</label>
      <input type="search" id="q-${key}" placeholder="Haltestelle suchen …" autocomplete="off" value="${esc(s.q)}">
      ${list ? `<ul class="results">${list}</ul>` : ''}</div>`;
  }

  async function doSearch(key) {
    const s = search[key];
    const my = ++reqNo;
    if (s.q.trim().length < 2) { s.results = []; s.loading = false; render(key); return; }
    s.loading = true; s.error = null; render(key);
    try {
      const res = await api('/v1/geocode', { text: s.q.trim(), type: 'STOP', language: 'de', place: '49.1,8.4' });
      if (my !== reqNo) return;
      // Manche Daten kommen in Großbuchstaben („KARLSRUHE HBF“)
      const tidy = (n) => (n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : n);
      s.results = (res || []).filter((x) => x.type === 'STOP').slice(0, 10).map((x) => ({
        id: x.id, name: tidy(x.name), lat: x.lat, lon: x.lon,
        area: (x.areas || []).filter((a) => a.name && a.name !== x.name).slice(-1).map((a) => a.name).join('') || (x.modes || []).join(', '),
      }));
    } catch (e) {
      if (my !== reqNo) return;
      s.error = e; s.results = [];
    }
    s.loading = false; render(key);
  }

  function render(focusKey) {
    const caret = focusKey ? $(`#q-${focusKey}`, view)?.selectionStart : null;
    view.innerHTML = `
      <div class="form-row"><label for="name">Name</label>
        <input type="text" id="name" value="${esc(draft.name)}" placeholder="z. B. Uni – Zuhause"></div>
      ${pickerHtml('from', 'Von')}
      <button class="btn block" id="swap" style="margin:-4px 0 12px">⇅ Richtung tauschen</button>
      ${pickerHtml('to', 'Nach')}
      <div class="actions">
        <a class="btn" href="#/manage">Abbrechen</a>
        <button class="btn primary" id="save" ${draft.from && draft.to ? '' : 'disabled style="opacity:.5"'}>Speichern</button>
      </div>`;
    $('#name', view).addEventListener('input', (e) => { draft.name = e.target.value; });
    for (const key of ['from', 'to']) {
      const inp = $(`#q-${key}`, view);
      if (inp) {
        inp.addEventListener('input', (e) => {
          search[key].q = e.target.value;
          clearTimeout(debounce);
          debounce = setTimeout(() => doSearch(key), 300);
        });
        if (focusKey === key) { inp.focus(); if (caret != null) inp.setSelectionRange(caret, caret); }
      }
    }
    view.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.pick;
      const x = search[key].results[Number(b.dataset.i)];
      draft[key] = { id: x.id, name: x.name, lat: x.lat, lon: x.lon };
      search[key] = { q: '', results: [], loading: false, error: null };
      render();
    }));
    view.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
      draft[b.dataset.clear] = null; render(b.dataset.clear);
    }));
    $('#swap', view).addEventListener('click', () => {
      [draft.from, draft.to] = [draft.to, draft.from];
      [search.from, search.to] = [search.to, search.from];
      render();
    });
    $('#save', view).addEventListener('click', () => {
      if (!draft.from || !draft.to) return;
      if (draft.from.id === draft.to.id) { alert('Start und Ziel sind gleich.'); return; }
      if (!draft.name.trim()) draft.name = `${draft.from.name} – ${draft.to.name}`;
      const i = routes.findIndex((r) => r.id === draft.id);
      if (i >= 0) routes[i] = draft; else routes.push(draft);
      saveRoutes(routes);
      location.hash = '#/manage';
    });
  }
  render();
}

// ===== Start =====
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
