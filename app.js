(() => {
'use strict';
const CATS = window.CATEGORIES, SPOTS = window.SPOTS, STATIONS = window.STATIONS, ROUTES = window.ROUTES;

// ---------- 設定 ----------
const CFG = {
  walkRadius: 300,          // 徒歩：半径(m)
  stationRadius: 600,       // 電車：次の駅からの半径(m)
  carAheadMin: [10, 15],    // 車：何分先を見るか
  carLateral: 1500,         // 車：ルートからの距離(m)
  railNear: 120,            // 線路に近いとみなす距離(m)
  threshold: 0.45,          // AIスコアの基準
  cooldownMin: { 徒歩: 6, 電車: 3, 車: 6 }, // 通知の間隔（シミュレーション内の分）
  walkMaxKmh: 7,
};

// ---------- 状態（localStorage） ----------
const LS = 'yorimichi-demo-v1';
const today = () => new Date().toISOString().slice(0,10);
const defaultState = () => ({
  interests: ['cafe','history','gourmet','view'],
  weights: Object.fromEntries(Object.keys(CATS).map(k => [k, 1])),
  day: today(), count: 0, cap: 5, history: [],
});
let S;
try { S = Object.assign(defaultState(), JSON.parse(localStorage.getItem(LS) || '{}')); } catch { S = defaultState(); }
if (S.day !== today()) { S.day = today(); S.count = 0; }
const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} };

// ---------- 地理ユーティリティ ----------
const R = 6371000, rad = d => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b[0]-a[0]), dLng = rad(b[1]-a[1]);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function makeLine(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i-1] + dist(points[i-1], points[i]));
  return { points, cum, length: cum[cum.length-1] };
}
function pointAt(line, d) {
  d = Math.max(0, Math.min(line.length, d));
  let i = 1; while (i < line.cum.length - 1 && line.cum[i] < d) i++;
  const seg = line.cum[i] - line.cum[i-1] || 1, t = (d - line.cum[i-1]) / seg;
  const a = line.points[i-1], b = line.points[i];
  return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t];
}
// 点を折れ線に射影 → {along, off}
function project(line, p) {
  const lat0 = rad(p[0]), kx = 111320*Math.cos(lat0), ky = 110540;
  let best = { along: 0, off: Infinity };
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i-1], b = line.points[i];
    const ax=(a[1]-p[1])*kx, ay=(a[0]-p[0])*ky, bx=(b[1]-p[1])*kx, by=(b[0]-p[0])*ky;
    const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy || 1;
    let t = -(ax*dx+ay*dy)/L2; t = Math.max(0, Math.min(1, t));
    const off = Math.hypot(ax+dx*t, ay+dy*t);
    if (off < best.off) best = { along: line.cum[i-1] + t*(line.cum[i]-line.cum[i-1]), off };
  }
  return best;
}
const RAIL = makeLine(STATIONS.map(s => [s.lat, s.lng]));
const STATION_ALONG = STATIONS.map(s => project(RAIL, [s.lat, s.lng]).along);
const fmtMin = s => s < 60 ? `${Math.round(s)}秒` : `${Math.round(s/60)}分`;

// ---------- 地図 ----------
const map = L.map('map', { zoomControl: false }).setView([35.712, 139.785], 14);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
L.polyline(RAIL.points, { color: '#2563eb', weight: 4, opacity: .35, dashArray: '8 6' }).addTo(map);
STATIONS.forEach(s => {
  L.circleMarker([s.lat, s.lng], { radius: 5, color: '#1e3a8a', fillColor: '#fff', fillOpacity: 1, weight: 2 })
    .bindTooltip(s.name, { permanent: true, direction: 'right', className: 'station-lbl', offset: [6,0] }).addTo(map);
});
const spotMarkers = new Map();
SPOTS.forEach((sp, i) => {
  sp.id = i;
  const c = CATS[sp.cat];
  const m = L.marker([sp.lat, sp.lng], { icon: L.divIcon({ className: '', html: `<div class="spot-ico" id="spot-${i}">${c.icon}</div>`, iconSize: [28,28], iconAnchor: [14,14] }) })
    .bindPopup(`<b>${sp.name}</b><br><small>${c.label}・サンプルデータ</small><br>${sp.desc}`).addTo(map);
  spotMarkers.set(i, m);
});
const me = L.marker([35.7111, 139.7964], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [20,20], iconAnchor: [10,10] }), zIndexOffset: 1000 });
const trail = L.polyline([], { color: '#2563eb', weight: 4, opacity: .8 }).addTo(map);
let routeLayer = null, radiusLayer = null, aheadLayer = null;

// ---------- AIスコア（モック） ----------
function aiScore(sp) {
  const interest = S.interests.includes(sp.cat) ? 1 : 0.45;
  const w = S.weights[sp.cat] ?? 1;
  return Math.min(1, sp.score * interest * w);
}

// ---------- トラッカー（移動手段の推定） ----------
const T = { cand: null, candSince: 0, hist: [], mode: 'none', speed: 0, lastMoveMode: null, lastMoveAt: 0, nextStation: null, railDir: 0 };
function track(p, t) {
  T.hist.push({ p, t });
  while (T.hist.length > 2 && t - T.hist[0].t > 20000) T.hist.shift();
  const a = T.hist[0], dt = (t - a.t) / 1000;
  let moved = 0; for (let i = 1; i < T.hist.length; i++) moved += dist(T.hist[i-1].p, T.hist[i].p);
  T.speed = dt > 1 ? moved / dt * 3.6 : T.speed;
  const rail = project(RAIL, p);
  const nearRail = rail.off < CFG.railNear;
  const nearStation = STATIONS.some(s => dist(p, [s.lat, s.lng]) < 250);
  let mode;
  if (T.speed < 1.5 && T.lastMoveMode && T.lastMoveMode !== 'walk' && t - T.lastMoveAt < 180000) mode = T.lastMoveMode; // 停車中
  else if (T.speed < CFG.walkMaxKmh) mode = T.speed < 0.5 ? 'stay' : 'walk';
  else if (nearRail || (T.lastMoveMode === 'train' && nearStation)) mode = 'train';
  else mode = 'car';
  if (T.speed >= 1.5) { T.lastMoveMode = mode; T.lastMoveAt = t; }
  T.stopped = T.speed < 1.5;
  // ちらつき防止：同じ判定が一定時間（シミュレーション内20秒）続いたら確定
  if (mode !== T.cand) { T.cand = mode; T.candSince = t; }
  if (mode !== T.mode && t - T.candSince >= 20000) T.mode = mode;
  mode = T.mode;
  // 電車：進行方向と次の駅
  if (mode === 'train') {
    if (T.hist.length > 1) {
      const d = rail.along - project(RAIL, T.hist[0].p).along;
      if (Math.abs(d) > 30) T.railDir = Math.sign(d);
    }
    const dir = T.railDir || 1;
    let next = null;
    if (dir > 0) { for (let i = 0; i < STATIONS.length; i++) if (STATION_ALONG[i] > rail.along + 150) { next = i; break; } }
    else { for (let i = STATIONS.length - 1; i >= 0; i--) if (STATION_ALONG[i] < rail.along - 150) { next = i; break; } }
    T.nextStation = next;
  } else T.nextStation = null;
  renderBadge();
}
function renderBadge() {
  const el = document.getElementById('modeBadge');
  const lab = { none: T.hist.length ? '⏳ 判定中' : '⏸ 停止中', stay: '🧍 滞在中', walk: '🚶 徒歩', train: '🚃 電車', car: '🚗 車' }[T.mode];
  let extra = '（推定）';
  if ((T.mode === 'train' || T.mode === 'car') && T.stopped) extra = '・停車中（推定）';
  el.className = 'badge mode-' + (T.mode === 'stay' ? 'walk' : T.mode);
  el.innerHTML = lab + (T.mode === 'none' || T.mode === 'stay' ? '' : `<small>${extra}</small>`);
  document.getElementById('speedLbl').textContent = `${Math.round(T.speed)} km/h` + (T.nextStation != null ? `・次は${STATIONS[T.nextStation].name}` : '');
}

// ---------- 通知判定 ----------
const notified = new Set(), skipped = new Set();
let lastNotifyAt = -Infinity, lastStationChecked = null, lastCarCheck = -Infinity;
let clockNow = () => Date.now();

function gate(cands, ctx, now) {
  // cands: [{sp, reason}]
  const scored = cands.filter(c => !notified.has(c.sp.id)).map(c => ({ ...c, s: aiScore(c.sp) }));
  if (!scored.length) return;
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0];
  const low = scored.filter(c => c.s < CFG.threshold);
  low.forEach(c => skipped.add(c.sp.id));
  if (best.s < CFG.threshold) return renderStats();
  if (S.count >= S.cap) { scored.forEach(c => skipped.add(c.sp.id)); return renderStats(); }
  if (now - lastNotifyAt < CFG.cooldownMin[ctx] * 60000) { scored.forEach(c => skipped.add(c.sp.id)); return renderStats(); }
  scored.slice(1).forEach(c => skipped.add(c.sp.id)); // 1回に1件だけ
  skipped.delete(best.sp.id);
  notified.add(best.sp.id);
  lastNotifyAt = now; S.count++;
  notify(best.sp, best.s, best.reason, ctx);
  renderStats();
}

function evaluate(p, now) {
  if (T.mode === 'stay' || T.mode === 'none') { drawRadius(null); clearAhead(); return; }
  if (T.mode === 'walk') {
    const c = SPOTS.map(sp => ({ sp, d: dist(p, [sp.lat, sp.lng]) })).filter(x => x.d <= CFG.walkRadius)
      .map(x => ({ sp: x.sp, reason: `徒歩${Math.max(1, Math.round(x.d / 75))}分（約${Math.round(x.d / 10) * 10}m）` }));
    drawRadius(p, CFG.walkRadius, '#16a34a');
    gate(c, '徒歩', now);
  } else if (T.mode === 'train') {
    clearAhead();
    if (T.nextStation == null) return drawRadius(null);
    const st = STATIONS[T.nextStation];
    drawRadius([st.lat, st.lng], CFG.stationRadius, '#2563eb');
    if (lastStationChecked === T.nextStation) return;
    lastStationChecked = T.nextStation;
    const c = SPOTS.map(sp => ({ sp, d: dist([st.lat, st.lng], [sp.lat, sp.lng]) })).filter(x => x.d <= CFG.stationRadius)
      .map(x => ({ sp: x.sp, reason: `次の駅「${st.name}」で降りる価値あり・駅から徒歩${Math.max(1, Math.round(x.d / 75))}分` }));
    gate(c, '電車', now);
  } else if (T.mode === 'car') {
    drawRadius(null);
    if (now - lastCarCheck < 30000) return;
    lastCarCheck = now;
    const v = Math.max(T.speed, 30) / 3.6; // m/s
    const [m1, m2] = CFG.carAheadMin;
    let c = [];
    if (sim.line && sim.running) {
      const cur = project(sim.line, p).along;
      const a1 = cur + v * m1 * 60, a2 = cur + v * m2 * 60;
      drawAhead(sim.line, a1, a2);
      c = SPOTS.map(sp => ({ sp, pr: project(sim.line, [sp.lat, sp.lng]) }))
        .filter(x => x.pr.off <= CFG.carLateral && x.pr.along >= a1 && x.pr.along <= a2)
        .map(x => ({ sp: x.sp, reason: `約${Math.round((x.pr.along - cur) / v / 60)}分先・ルートから${(x.pr.off / 1000).toFixed(1)}km` }));
    } else if (T.hist.length > 1) { // 実GPS：進行方向に前方の点を置いて判定
      const a = T.hist[0].p, kx = Math.cos(rad(p[0]));
      const dy = p[0] - a[0], dx = (p[1] - a[1]) * kx, n = Math.hypot(dx, dy) || 1;
      const ahead = v * (m1 + m2) / 2 * 60;
      const q = [p[0] + dy / n * ahead / 110540, p[1] + dx / n * ahead / (111320 * kx)];
      drawRadius(q, 2500, '#ea580c');
      c = SPOTS.map(sp => ({ sp, d: dist(q, [sp.lat, sp.lng]) })).filter(x => x.d <= 2500)
        .map(x => ({ sp: x.sp, reason: `約${m1}〜${m2}分先の進行方向` }));
    }
    gate(c, '車', now);
  }
}

function drawRadius(c, r, color) {
  if (radiusLayer) { map.removeLayer(radiusLayer); radiusLayer = null; }
  if (c) radiusLayer = L.circle(c, { radius: r, color, weight: 1.5, fillOpacity: .07, dashArray: '4 4' }).addTo(map);
}
function clearAhead() { if (aheadLayer) { map.removeLayer(aheadLayer); aheadLayer = null; } }
function drawAhead(line, a1, a2) {
  clearAhead();
  const pts = []; for (let d = a1; d <= Math.min(a2, line.length); d += 200) pts.push(pointAt(line, d));
  if (pts.length > 1) aheadLayer = L.polyline(pts, { color: '#ea580c', weight: 10, opacity: .35 }).addTo(map);
}

// ---------- 通知表示 ----------
function notify(sp, score, reason, ctx) {
  const c = CATS[sp.cat];
  const item = { id: sp.id, name: sp.name, cat: sp.cat, score, reason, ctx, at: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }), state: '未対応' };
  S.history.unshift(item); S.history = S.history.slice(0, 50); save();
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderLeftColor = c.color;
  el.innerHTML = `<div class="t-head"><span>${c.icon} ${c.label}・${ctx}中のおすすめ</span><span class="score">AIマッチ ${Math.round(score * 100)}%</span></div>
    <div class="t-title">${sp.name}</div><div class="t-reason">${reason}</div><div class="t-desc">${sp.desc}</div>
    <div class="t-btns"><button class="btn primary" data-act="go">行ってみる</button><button class="btn ghost" data-act="no">興味なし</button></div>`;
  el.querySelector('[data-act=go]').onclick = () => { feedback(item, true); el.remove(); };
  el.querySelector('[data-act=no]').onclick = () => { feedback(item, false); el.remove(); };
  const box = document.getElementById('toasts');
  box.prepend(el);
  while (box.children.length > 2) box.lastChild.remove();
  setTimeout(() => el.remove(), 15000);
  document.getElementById('spot-' + sp.id)?.classList.add('hit');
  renderHistory();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`${c.icon} ${sp.name}`, { body: `${reason}\n${sp.desc}`, tag: 'spot-' + sp.id }); } catch {}
  }
  if (navigator.vibrate) try { navigator.vibrate(80); } catch {}
}
function feedback(item, positive) {
  const k = item.cat;
  S.weights[k] = +(Math.max(0.2, Math.min(1.5, (S.weights[k] ?? 1) * (positive ? 1.1 : 0.6)))).toFixed(2);
  item.state = positive ? '行ってみる' : '興味なし';
  const h = S.history.find(x => x.id === item.id && x.at === item.at); if (h) h.state = item.state;
  save(); renderWeights(); renderHistory();
  if (positive) { map.setView(spotMarkers.get(item.id).getLatLng(), 16); spotMarkers.get(item.id).openPopup(); }
  smallToast(positive ? `「${CATS[k].label}」の優先度を上げました（学習）` : `「${CATS[k].label}」の優先度を下げました（学習）→ 重み ${S.weights[k]}`);
}
function smallToast(msg) {
  const el = document.createElement('div'); el.className = 'toast small'; el.textContent = '🤖 ' + msg;
  document.getElementById('toasts').prepend(el); setTimeout(() => el.remove(), 3000);
}

// ---------- UI描画 ----------
function renderStats(now = clockNow()) {
  document.getElementById('statCount').textContent = `${S.count} / ${S.cap}`;
  document.getElementById('statSkip').textContent = skipped.size;
  const cd = CFG.cooldownMin[{ walk: '徒歩', train: '電車', car: '車' }[T.mode]] || 6;
  const rest = cd * 60000 - (now - lastNotifyAt);
  document.getElementById('statCool').textContent = S.count >= S.cap ? '上限到達' : rest > 0 ? fmtMin(rest / 1000) : 'いつでも';
}
function renderChips() {
  const box = document.getElementById('chips'); box.innerHTML = '';
  Object.entries(CATS).forEach(([k, c]) => {
    const b = document.createElement('button');
    b.className = 'chip' + (S.interests.includes(k) ? ' on' : ''); b.textContent = `${c.icon} ${c.label}`; b.dataset.cat = k;
    b.onclick = () => { S.interests = S.interests.includes(k) ? S.interests.filter(x => x !== k) : [...S.interests, k]; save(); renderChips(); renderWeights(); };
    box.appendChild(b);
  });
}
function renderWeights() {
  const box = document.getElementById('weights'); box.innerHTML = '';
  Object.entries(CATS).forEach(([k, c]) => {
    const eff = (S.interests.includes(k) ? 1 : 0.45) * (S.weights[k] ?? 1);
    box.insertAdjacentHTML('beforeend', `<div class="w-row"><span>${c.icon} ${c.label}</span><div class="w-bar"><i style="width:${Math.min(100, eff / 1.5 * 100)}%;background:${c.color}"></i></div><span>${eff.toFixed(2)}</span></div>`);
  });
}
function renderHistory() {
  const box = document.getElementById('history');
  document.getElementById('histCount').textContent = S.history.length;
  if (!S.history.length) { box.innerHTML = '<p class="empty">まだ通知はありません。</p>'; return; }
  box.innerHTML = S.history.map((h, i) => `<div class="h-item" data-i="${i}"><div class="h-ico">${CATS[h.cat].icon}</div><div class="h-main"><div class="h-title">${h.name}</div><div class="h-sub">${h.at}・${h.ctx}・${h.reason}</div></div><span class="h-state">${h.state}</span></div>`).join('');
  box.querySelectorAll('.h-item').forEach(el => el.onclick = () => { const h = S.history[+el.dataset.i]; const m = spotMarkers.get(h.id); if (m) { map.setView(m.getLatLng(), 16); m.openPopup(); } });
}

// ---------- シミュレーション ----------
const sim = { line: null, key: null, d: 0, v: 0, t: 0, running: false, timer: null, mult: 30, dwell: 0, stops: [] };
const VMAX = { walk: 4.5, train: 55, car: 50 }; // km/h
function loadRoute(key) {
  stopSim();
  const r = ROUTES[key];
  sim.key = key; sim.line = makeLine(r.points); sim.d = 0; sim.v = 0; sim.t = Date.now(); sim.dwell = key === 'train' ? 20 : 0;
  sim.stops = key === 'train' ? sim.line.cum.slice(1) : [];
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(r.points, { color: { walk: '#16a34a', train: '#2563eb', car: '#ea580c' }[key], weight: 5, opacity: .5 }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
  trail.setLatLngs([]); me.setLatLng(r.points[0]).addTo(map);
  T.hist = []; T.mode = 'none'; T.cand = null; T.speed = 0; T.lastMoveMode = null; T.nextStation = null; T.railDir = 0;
  notified.clear(); skipped.clear(); lastNotifyAt = -Infinity; lastStationChecked = null; lastCarCheck = -Infinity;
  drawRadius(null); clearAhead(); renderBadge(); renderStats(sim.t);
  document.getElementById('toasts').innerHTML = '';
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('simInfo').textContent = r.label + '（ルートは概略です）';
  document.querySelectorAll('.spot-ico.hit').forEach(e => e.classList.remove('hit'));
}
function stepSim(dt) { // dt: 秒（シミュレーション内）
  const line = sim.line, key = sim.key;
  if (sim.dwell > 0) { sim.dwell -= dt; sim.v = 0; }
  else {
    let vmax = VMAX[key] / 3.6, acc = key === 'walk' ? 5 : key === 'train' ? 0.8 : 1.2;
    if (key === 'car') vmax = (sim.d > 8000 && sim.d < line.length - 3000 ? 70 : 40) / 3.6; // 郊外は速め
    let nextStop = sim.stops.find(s => s > sim.d + 0.5);
    if (key !== 'train') nextStop = line.length;
    const toStop = nextStop - sim.d;
    const vBrake = Math.sqrt(2 * acc * Math.max(0, toStop));
    let target = Math.min(vmax, vBrake);
    if (key === 'walk') target = vmax * (0.85 + 0.3 * Math.random());
    sim.v = sim.v < target ? Math.min(target, sim.v + acc * dt) : target;
    sim.v = Math.max(sim.v, key === 'walk' ? 0.3 : 0.6);
    sim.d += sim.v * dt;
    if (sim.d >= nextStop - 1) { sim.d = nextStop; sim.v = 0; if (key === 'train') sim.dwell = 30; }
  }
  sim.t += dt * 1000;
}
function tickSim() {
  const realDt = 0.1, total = realDt * sim.mult;
  const n = Math.ceil(total);
  for (let i = 0; i < n; i++) {
    stepSim(total / n);
    if (i % 2 === 1 || i === n - 1) { const p = pointAt(sim.line, sim.d); track(p, sim.t); }
  }
  const p = pointAt(sim.line, sim.d);
  me.setLatLng(p); trail.addLatLng(p);
  if (!map.getBounds().pad(-0.15).contains(p)) map.panTo(p, { animate: true });
  evaluate(p, sim.t);
  renderStats(sim.t);
  document.getElementById('progressBar').style.width = (sim.d / sim.line.length * 100).toFixed(1) + '%';
  if (sim.d >= sim.line.length) { stopSim(); T.mode = 'none'; T.hist = []; renderBadge(); document.getElementById('simInfo').textContent = '到着しました。別のルートも試してみてください。'; }
}
function startSim() {
  if (!sim.line) loadRoute(document.getElementById('routeSel').value);
  if (sim.d >= sim.line.length) loadRoute(sim.key);
  clockNow = () => sim.t;
  sim.running = true; sim.timer = setInterval(tickSim, 100);
  document.getElementById('playBtn').textContent = '⏸ 一時停止';
}
function stopSim() {
  sim.running = false; clearInterval(sim.timer); sim.timer = null;
  document.getElementById('playBtn').textContent = '▶ 再生';
}

// ---------- 実GPS ----------
let watchId = null;
function startGps() {
  const info = document.getElementById('gpsInfo');
  if (!('geolocation' in navigator)) { info.textContent = 'このブラウザは位置情報に対応していません。'; return; }
  if (!window.isSecureContext) info.textContent = '⚠ HTTPS か localhost で開かないと位置情報は使えません。';
  stopSim(); if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; } sim.line = null;
  clockNow = () => Date.now();
  T.hist = []; T.mode = 'none'; T.cand = null; trail.setLatLngs([]); me.addTo(map);
  let first = true;
  watchId = navigator.geolocation.watchPosition(pos => {
    const p = [pos.coords.latitude, pos.coords.longitude], now = pos.timestamp || Date.now();
    track(p, now);
    if (pos.coords.speed != null && !isNaN(pos.coords.speed)) { T.speed = pos.coords.speed * 3.6; }
    me.setLatLng(p); trail.addLatLng(p);
    if (first) { map.setView(p, 15); first = false; }
    evaluate(p, now); renderStats(now);
    info.textContent = `取得中：精度 約${Math.round(pos.coords.accuracy)}m。サンプルスポットは東京（浅草・上野・山手線・新宿〜八王子）にしかありません。`;
  }, err => { info.textContent = '位置情報を取得できませんでした：' + err.message; stopGps(); },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  document.getElementById('gpsBtn').textContent = '⏹ 取得を停止';
}
function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; document.getElementById('gpsBtn').textContent = '📡 位置情報の取得を開始';
}

// ---------- イベント ----------
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
});
document.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
  document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
  const gps = b.dataset.src === 'gps';
  document.getElementById('simCtrls').hidden = gps; document.getElementById('gpsCtrls').hidden = !gps;
  if (!gps) { stopGps(); loadRoute(document.getElementById('routeSel').value); }
  else stopSim();
});
document.getElementById('routeSel').onchange = e => loadRoute(e.target.value);
document.getElementById('playBtn').onclick = () => sim.running ? stopSim() : startSim();
document.getElementById('resetRouteBtn').onclick = () => loadRoute(document.getElementById('routeSel').value);
document.getElementById('speedSel').onchange = e => sim.mult = +e.target.value;
document.getElementById('gpsBtn').onclick = () => watchId != null ? stopGps() : startGps();
document.getElementById('capSel').value = String(S.cap);
document.getElementById('capSel').onchange = e => { S.cap = +e.target.value; save(); renderStats(); };
document.getElementById('resetDayBtn').onclick = () => { S.count = 0; lastNotifyAt = -Infinity; save(); renderStats(); smallToast('今日の通知回数をリセットしました'); };
document.getElementById('resetLearnBtn').onclick = () => { S.weights = defaultState().weights; save(); renderWeights(); smallToast('学習をリセットしました'); };
const permBtn = document.getElementById('notifPermBtn');
if (!('Notification' in window)) permBtn.hidden = true;
else {
  if (Notification.permission === 'granted') permBtn.textContent = '🔔 端末通知：オン';
  permBtn.onclick = async () => { try { const r = await Notification.requestPermission(); permBtn.textContent = r === 'granted' ? '🔔 端末通知：オン' : '🔕 端末通知：オフ'; } catch {} };
}

renderChips(); renderWeights(); renderHistory(); renderStats();
loadRoute('walk');

// テスト用フック
window.__demo = { sim, T, S, notified, skipped, loadRoute, startSim, stopSim, get count() { return S.count; } };
})();
