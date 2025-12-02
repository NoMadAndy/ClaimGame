// Minimal map frontend for ClaimGame: shows spots, heatmap (per-player), live players, and simple register

const baseUrl = window.location.origin;
// ensure our developer helper object exists early so initSocket can set socket
window.CG = window.CG || {};
let currentPlayer = JSON.parse(localStorage.getItem('cg_player') || 'null');
let map, spotsLayer, livePlayersLayer, heatLayer;
let heatEnabled = true; // Heatmap default an
let pollInterval = 5000; // ms
let playerMarker = null;
let compassEnabled = false;
let currentHeading = 0;

function init() {
  // --- base layers for selection ---
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap' });
  const stamenToner = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© Stamen' });
  const stamenWater = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/watercolor/{z}/{x}/{y}.jpg', { maxZoom: 16, attribution: '© Stamen' });
  const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' });
  const cartoPositron = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© Carto' });
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© Carto' });
  const cartoVoyager = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© Carto' });
  // initialize map with osm
  map = L.map('map', { layers: [osm] }).setView([52.52, 13.405], 14);
  spotsLayer = L.layerGroup().addTo(map);
  livePlayersLayer = L.layerGroup().addTo(map);
  heatLayer = L.heatLayer([], { radius: 25, blur: 15, maxZoom: 17 });

  document.getElementById('btnRegister').addEventListener('click', onRegister);
  document.getElementById('btnLogin').addEventListener('click', onLogin);
  document.getElementById('btnLogout').addEventListener('click', onLogout);
  document.getElementById('btnCenter').addEventListener('click', centerToMe);
  document.getElementById('btnCompass').addEventListener('click', async (ev)=>{ compassEnabled = !compassEnabled; if (compassEnabled) enableCompass(); else disableCompass(); updateCompassButton(); });
  document.getElementById('wakelockBtn').addEventListener('click', async ()=>{ await toggleWakeLock(); });
  // layers button toggles the builtin control open/close if possible
  // The layer control is shown in the top-right by default; no bottom toggle needed.

  // user menu: toggle dropdown
  const userMenuBtn = document.getElementById('userMenuBtn');
  const userMenu = document.getElementById('userMenu');
  if (userMenuBtn && userMenu) {
    // init menu label
    if (userMenuBtn) {
      userMenuBtn.setAttribute('title', currentPlayer ? `${currentPlayer.displayName || 'User'}` : 'Guest');
      userMenuBtn.setAttribute('aria-label', currentPlayer ? `${currentPlayer.displayName || 'User'}` : 'Guest');
    }
    userMenuBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const show = userMenu.classList.contains('show');
      if (show) {
        userMenu.classList.remove('show');
        userMenu.setAttribute('aria-hidden','true');
        userMenu.style.display = 'none';
      } else {
        userMenu.classList.add('show');
        userMenu.setAttribute('aria-hidden','false');
        userMenu.style.display = 'block';
      }
    });
    // hide menu on outside click
    document.addEventListener('click', ()=>{ if (userMenu) { userMenu.classList.remove('show'); userMenu.setAttribute('aria-hidden','true'); userMenu.style.display='none'; } });
  }
  // no custom layers toggle button anymore; use Leaflet's native control

  // --- Wake Lock API: Display an/aus Button ---
  let wakeLock = null;
  let wakeLockActive = false;
  let wakeLockSupported = 'wakeLock' in navigator;
  function setWakeLockStatus(msg) {
    const el = document.getElementById('msgWake');
    if (el) el.textContent = msg;
  }
  async function requestWakeLock() {
    if (!wakeLockSupported) {
      setWakeLockStatus('Wake Lock API nicht unterstützt.');
      wakeLockActive = false;
      updateWakeLockButton();
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLockActive = true;
      setWakeLockStatus('Display bleibt an (WakeLock aktiv).');
      updateWakeLockButton();
      wakeLock.addEventListener('release', () => {
        wakeLockActive = false;
        setWakeLockStatus('WakeLock freigegeben. Display kann ausgehen.');
        updateWakeLockButton();
      });
    } catch (err) {
      setWakeLockStatus('Wake Lock Fehler: ' + err.message);
      wakeLockActive = false;
      updateWakeLockButton();
    }
  }
  async function releaseWakeLock() {
    if (wakeLock && wakeLockActive) {
      try {
        await wakeLock.release();
        wakeLockActive = false;
        setWakeLockStatus('WakeLock freigegeben. Display kann ausgehen.');
        updateWakeLockButton();
      } catch (e) {
        setWakeLockStatus('Fehler beim Freigeben des WakeLock.');
      }
    }
  }
  // Sichtbarkeitswechsel: WakeLock ggf. neu anfordern
  document.addEventListener('visibilitychange', () => {
    if (wakeLockSupported && wakeLockActive && document.visibilityState === 'visible') {
      requestWakeLock();
    }
  });
  // Button-Handler
  window.toggleWakeLock = async function() {
    if (wakeLockActive) {
      await releaseWakeLock();
    } else {
      await requestWakeLock();
    }
    updateWakeLockButton();
  };
  function updateWakeLockButton() {
    const btn = document.getElementById('wakelockBtn');
    if (!btn) return;
    // Keep the icon intact, set aria-pressed and title instead
    const isActive = !!window.CG?.wakeLockActive;
    btn.setAttribute('aria-pressed', String(isActive));
    btn.setAttribute('title', isActive ? 'Display bleibt an' : 'Display kann ausgehen');
    btn.classList.toggle('active', isActive);
  }
  // Button initial setzen
  setTimeout(()=>{ updateWakeLockButton(); }, 200);
  // Adjust compass button initial look
  updateCompassButton();

  if (currentPlayer) updateStatus();
  updateUserMenuUI();
  // Create player marker initially at map center (so it is always visible)
  const c = map.getCenter();
  setPlayerPosition({ latitude: c.lat, longitude: c.lng });
  // If we have a stored player position, update marker to that
  if (currentPlayer && currentPlayer.lastSeenPosition) setPlayerPosition(currentPlayer.lastSeenPosition);
  // if token exists, try auto-login
  const token = localStorage.getItem('cg_token');
  if (token) {
    tryAutoLogin(token);
  }

  // map click: open popup to create spot if admin
  map.on('click', async (ev)=>{
    if (!currentPlayer) return alert('Register first');
    if (currentPlayer.role !== 'ADMIN' && currentPlayer.role !== 'CREATOR') return alert('Spot creation is admin-only in dev server.');
    const name = prompt('Spot name', 'New Spot');
    if (!name) return;
    const description = prompt('Description') || '';
    const req = { creatorId: currentPlayer.id, position: { latitude: ev.latlng.lat, longitude: ev.latlng.lng }, name, description, baseXP: 20 };
    const res = await fetch(`${baseUrl}/spots`, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(req)}).then(r=>r.json());
    alert('Spot created: ' + JSON.stringify(res.spot));
    loadSpots();
  });

  // initial actions
  loadSpots(); // Spots direkt beim Start laden
  getPositionAndLoad();
  initSocket();
  setInterval(pollAll, pollInterval);

  // add baseLayers + overlays to control
  const baseLayers = { 'OpenStreetMap': osm, 'Topo': topo, 'Stamen Toner': stamenToner, 'Stamen Watercolor': stamenWater, 'Esri Satellite': esriSat, 'Carto Positron': cartoPositron, 'Carto Dark': cartoDark, 'Carto Voyager': cartoVoyager };
  const overlays = { 'Spots': spotsLayer, 'Live Players': livePlayersLayer, 'Heatmap': heatLayer };
  const layerControl = L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: true }).addTo(map);
  // Style the control container and add a small label for clarity
  try {
    const ctrl = document.querySelector('.leaflet-control-layers');
    if (ctrl) {
      ctrl.classList.add('modern-layer-control');
      // add label (only once) to visually label the control
      if (!ctrl.querySelector('.layers-label')) {
        const lbl = document.createElement('div');
        lbl.className = 'layers-label';
        lbl.innerText = 'Karten';
        ctrl.insertBefore(lbl, ctrl.firstChild);
      }
      // ensure control is visible (don't hide). For mobile collapsed default is used.
      ctrl.classList.remove('hidden');
      ctrl.classList.remove('open');
    }
  } catch (e) { /* ignore */ }
  window.CG.layerControl = layerControl;
  // if heatEnabled initially, add heatlayer
  if (heatEnabled) { map.addLayer(heatLayer); loadHeatmap(); }
  // expose layer control
  window.CG.layerControl = layerControl;
}

function updateUserMenuUI() {
  const regBtn = document.getElementById('btnRegister');
  const loginBtn = document.getElementById('btnLogin');
  const logoutBtn = document.getElementById('btnLogout');
  const userStats = document.getElementById('userStats');
  if (currentPlayer) {
    if (regBtn) regBtn.style.display = 'none';
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'block';
    if (userStats) {
      userStats.style.display = 'block';
      const n = userStats.querySelector('.us-name');
      const r = userStats.querySelector('.us-role');
      const x = userStats.querySelector('.us-xp');
      if (n) n.innerText = currentPlayer.displayName || 'User';
      if (r) r.innerText = `Role: ${currentPlayer.role || 'PLAYER'}`;
      if (x) x.innerText = `XP: ${currentPlayer.stats ? currentPlayer.stats.totalXP : 0}  • Level: ${currentPlayer.stats ? currentPlayer.stats.level : 1}`;
    }
  } else {
    if (regBtn) regBtn.style.display = 'block';
    if (loginBtn) loginBtn.style.display = 'block';
    // If not logged in, keep logout visible for manual logout if localStorage was set
    if (logoutBtn) logoutBtn.style.display = 'block';
    if (userStats) userStats.style.display = 'none';
  }
  const btn = document.getElementById('userMenuBtn');
  if (btn) {
    const name = currentPlayer ? currentPlayer.displayName || 'User' : 'Guest';
    btn.textContent = `${name} ▾`;
    btn.setAttribute('title', `User: ${name}`);
    btn.setAttribute('aria-label', `User Menu for ${name}`);
  }
}

function initSocket() {
  const token = localStorage.getItem('cg_token');
  const socket = io({ auth: { token } });
  socket.on('connect', () => { console.log('socket connected', socket.id); });
  socket.on('playerMoved', (p) => {
    // update or add marker for p
    // reuse loadLivePlayers for simplicity by add/update layer
    // create marker keyed by playerId
    if (!window.CG._liveMarkers) window.CG._liveMarkers = {};
    const m = window.CG._liveMarkers[p.playerId];
    if (m) {
      m.setLatLng([p.position.latitude, p.position.longitude]);
    } else {
      const marker = L.circleMarker([p.position.latitude, p.position.longitude], { radius: 8, color: p.color || '#00AAFF' });
      marker.bindPopup(`<b>${p.displayName}</b>`);
      marker.addTo(livePlayersLayer);
      window.CG._liveMarkers[p.playerId] = marker;
    }
  });
  if (window.CG) window.CG.socket = socket;
  // refresh token before it expires to keep socket auth valid
  setInterval(async () => {
    const token = localStorage.getItem('cg_token');
    if (!token) return;
    try {
      await ensureAuth();
      // if token rotated, reconnect socket with new auth
      const newToken = localStorage.getItem('cg_token');
      if (newToken && newToken !== token) {
        socket.auth.token = newToken;
        socket.disconnect();
        socket.connect();
      }
    } catch (e) { /* ignore */ }
  }, 10000);
}

// PLAYER MARKER: create or update our own player marker that shows heading
function createPlayerMarker(position) {
  const html = `
    <div class="player-marker" style="transform: rotate(0deg);"> 
      <svg width="56" height="56" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 1 L16 12 L12 9 L8 12 Z" fill="#007bff" stroke="#004080" stroke-width="0.5"/>
        <circle cx="12" cy="12" r="7" fill="#fff" opacity="0.95" stroke="#004080" stroke-width="0.6" />
      </svg>
    </div>`;
  const icon = L.divIcon({ className: 'cg-player-icon', html, iconSize: [56,56], iconAnchor: [28,28] });
  if (!playerMarker) {
    playerMarker = L.marker([position.latitude, position.longitude], { icon }).addTo(map);
  } else {
    playerMarker.setLatLng([position.latitude, position.longitude]);
  }
}

function updatePlayerHeading(deg) {
  currentHeading = deg || 0;
  if (!playerMarker) return;
  const el = playerMarker.getElement();
  if (!el) return;
  const markerDiv = el.querySelector('.player-marker');
  if (markerDiv) markerDiv.style.transform = `rotate(${deg}deg)`;
}

function setPlayerPosition(position) {
  if (!position) return;
  createPlayerMarker(position);
  // also ensure marker is visible (bring to front)
  if (playerMarker && playerMarker._icon) playerMarker._icon.style.zIndex = 1000;
  if (window.CG && window.CG.socket && currentPlayer) {
    // emit position update to server
    window.CG.socket.emit('positionUpdate', { playerId: currentPlayer.id, position });
  }
}

async function enableCompass() {
  // For iOS 13+ we need DeviceOrientationEvent.requestPermission
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') { alert('Compass permission denied'); return; }
    } catch (e) { console.warn('compass permission error', e); return; }
  }
  window.addEventListener('deviceorientation', onDeviceOrientation);
  if (playerMarker) updatePlayerHeading(currentHeading);
}

function disableCompass() {
  window.removeEventListener('deviceorientation', onDeviceOrientation);
}

function updateCompassButton() {
  const btn = document.getElementById('btnCompass');
  if (!btn) return;
  // Keep icon intact and update aria-pressed / title only
  const isActive = !!window.CG?.compassActive || !!compassEnabled;
  btn.setAttribute('aria-pressed', String(isActive));
  btn.setAttribute('title', isActive ? 'Kompass aktiv' : 'Kompass inaktiv');
  btn.classList.toggle('active', isActive);
}

function onDeviceOrientation(e) {
  // use webkitCompassHeading for iOS if available
  let heading = null;
  if (typeof e.webkitCompassHeading !== 'undefined' && e.webkitCompassHeading !== null) {
    heading = e.webkitCompassHeading; // 0..360, 0=north
  } else if (typeof e.alpha !== 'undefined' && e.alpha !== null) {
    // alpha gives device rotation around z axis (0..360)
    heading = 360 - e.alpha; // convert to compass heading
  }
  if (heading !== null) {
    // normalize
    if (heading < 0) heading += 360;
    heading = Math.round(heading);
    updatePlayerHeading(heading);
  }
}

async function onRegister() {
  const name = prompt('Display name?') || 'DevUser';
  const password = prompt('Password (for login)? (leave blank for simple dev account)');
  const body = { displayName: name, role: 'PLAYER' };
  if (password) body.password = password;
  let res;
  if (password) {
    res = await fetch(`${baseUrl}/auth/register`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r=>r.json());
    if (res.token) localStorage.setItem('cg_token', res.token);
  } else {
    res = await fetch(`${baseUrl}/players/register`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r=>r.json());
  }
  currentPlayer = res.player;
  localStorage.setItem('cg_player', JSON.stringify(currentPlayer));
  updateStatus();
  loadSpots();
  pollAll();
  updateUserMenuUI();
}

function updateStatus() {
  const el = document.getElementById('msgStatus');
  if (!currentPlayer) {
    if (el) el.innerText = 'Not registered';
  } else {
    if (el) el.innerText = `Player: ${currentPlayer.displayName} (${currentPlayer.id}) role:${currentPlayer.role}`;
  }
  const ubtn = document.getElementById('userMenuBtn');
    if (ubtn) { 
      ubtn.setAttribute('title', currentPlayer ? `${currentPlayer.displayName || 'User'}` : 'Guest'); 
      ubtn.setAttribute('aria-label', currentPlayer ? `${currentPlayer.displayName || 'User'}` : 'Guest'); 
    }
}

function getAuthHeaders() {
  const headers = {'Content-Type': 'application/json'};
  const token = localStorage.getItem('cg_token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

async function ensureAuth() {
  // make sure token is valid; if expired, try to refresh using refreshToken
  const token = localStorage.getItem('cg_token');
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const payload = JSON.parse(atob(parts[1]));
    const exp = payload.exp * 1000;
    const nowMs = Date.now();
    // if token expires in less than 20 seconds, refresh
    if (exp - nowMs < 20000) {
      const refreshToken = localStorage.getItem('cg_refresh');
      if (!refreshToken) { onLogout(); return false; }
      const r = await fetch(`${baseUrl}/auth/refresh`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ refreshToken }) });
      if (!r.ok) { onLogout(); return false; }
      const body = await r.json();
      localStorage.setItem('cg_token', body.token);
      localStorage.setItem('cg_refresh', body.refreshToken);
      // update current player info
      if (body.player) { currentPlayer = body.player; localStorage.setItem('cg_player', JSON.stringify(currentPlayer)); updateStatus(); }
      const tEl = document.getElementById('msgToken'); if (tEl) tEl.innerText = `Token: valid (expires: ${getTokenExpiry(body.token)})`;
      return true;
    }
    return true;
  } catch (e) { onLogout(); return false; }
}

async function onLogin() {
  const id = prompt('Player ID (register first or use admin)');
  const password = prompt('Password');
  const res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, password }) }).then(r=>r.json());
  if (res.error) return alert(JSON.stringify(res));
  currentPlayer = res.player;
  localStorage.setItem('cg_player', JSON.stringify(currentPlayer));
  if (res.token) localStorage.setItem('cg_token', res.token);
  updateStatus();
  loadSpots();
  // close user menu if open
  const um = document.getElementById('userMenu'); if (um) { um.classList.remove('show'); um.setAttribute('aria-hidden','true'); um.style.display='none'; }
  // update menu label
  const ubtn = document.getElementById('userMenuBtn'); if (ubtn) { ubtn.setAttribute('title', currentPlayer.displayName || 'User'); ubtn.setAttribute('aria-label', currentPlayer.displayName || 'User'); }
  updateUserMenuUI();
}

function onLogout() {
  localStorage.removeItem('cg_player');
  localStorage.removeItem('cg_token');
  currentPlayer = null;
  const el = document.getElementById('msgStatus'); if (el) el.innerText = 'Not registered';
  const tEl2 = document.getElementById('msgToken'); if (tEl2) tEl2.innerText = '';
  const wEl2 = document.getElementById('msgWake'); if (wEl2) wEl2.innerText = '';
  const ubtn = document.getElementById('userMenuBtn'); if (ubtn) { ubtn.setAttribute('title', 'Guest'); ubtn.setAttribute('aria-label', 'Guest'); }
  const um2 = document.getElementById('userMenu'); if (um2) { um2.classList.remove('show'); um2.setAttribute('aria-hidden','true'); um2.style.display='none'; }
  updateUserMenuUI();
}

async function tryAutoLogin(token) {
  // attempt to get profile via /auth/me or decode token client-side
  try {
    const res = await fetch(`${baseUrl}/auth/me`, { headers: { 'Authorization': 'Bearer ' + token } }).then(r=>r.json());
    if (res && res.player) {
      currentPlayer = res.player;
      localStorage.setItem('cg_player', JSON.stringify(currentPlayer));
      localStorage.setItem('cg_token', token);
      updateStatus();
      const tEl3 = document.getElementById('msgToken'); if (tEl3) tEl3.innerText = `Token: valid (expires: ${getTokenExpiry(token)})`;
      loadSpots();
      updateUserMenuUI();
      return;
    }
  } catch (e) {
    console.warn('Auto-login failed', e);
  }
  // fallback: remove token if invalid
  localStorage.removeItem('cg_token');
  const tEl4 = document.getElementById('msgToken'); if (tEl4) tEl4.innerText = 'Token invalid or expired';
}

// try periodic auto-refresh too
setInterval(async ()=>{
  const refresh = localStorage.getItem('cg_refresh');
  const token = localStorage.getItem('cg_token');
  if (!refresh || !token) return;
  try {
    await ensureAuth();
  } catch(e) { /* ignore */ }
}, 15 * 1000);

function getTokenExpiry(token) {
  // decode JWT payload to extract exp claim
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 'unknown';
    const payload = JSON.parse(atob(parts[1]));
    if (!payload.exp) return 'unknown';
    const d = new Date(payload.exp * 1000);
    return d.toISOString();
  } catch (e) { return 'unknown'; }
}

async function getPositionAndLoad() {
  if (!navigator.geolocation) {
    alert('Geolocation not available');
    loadSpots();
    return;
  }
  navigator.geolocation.getCurrentPosition((pos)=>{
    map.setView([pos.coords.latitude, pos.coords.longitude], 16);
    loadSpots(pos.coords.latitude, pos.coords.longitude);
    // update player marker to current GPS position immediately
    setPlayerPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
  }, (err)=>{ console.warn('geo err', err); loadSpots(); });
}

async function loadSpots(lat = 52.52, lon = 13.405) {
  const rad = 2000; // 2km radius
  const res = await fetch(`${baseUrl}/spots?lat=${lat}&lon=${lon}&radius=${rad}`, { headers: getAuthHeaders() }).then(r=>r.json());
  spotsLayer.clearLayers();
  for (const s of res) {
    const m = L.marker([s.position.latitude, s.position.longitude]);
    m.bindPopup(`<b>${s.name}</b><br/>${s.description || ''}<br/>baseXP: ${s.baseXP} autoXP: ${s.autoXP}<br/>
      <button class='btnManual app-btn app-btn-ghost' data-id='${s.id}' title='Manual Log' aria-label='Manual Log'>
        <svg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'><path d='M12 12v8M6 16h12M8 7h8' stroke='#111' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/></svg>
      </button>
      <button class='btnAuto app-btn app-btn-ghost' data-id='${s.id}' title='Auto Log' aria-label='Auto Log'>
        <svg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'><path d='M12 2v7l4-4M6 9a6 6 0 1 0 12 0' stroke='#111' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>
      </button>`);
    m.on('popupopen', (ev)=>{ setTimeout(()=>attachPopupButtons(ev.popup), 50); });
    spotsLayer.addLayer(m);
  }
  if (heatEnabled) loadHeatmap();
}

function attachPopupButtons(popup) {
  const el = popup.getElement();
  if (!el) return;
  const btnManual = el.querySelector('.btnManual');
  if (btnManual) btnManual.addEventListener('click', async (ev) => {
    if (!currentPlayer) return alert('Register first');
    const id = ev.currentTarget.getAttribute('data-id');
    const distance = parseFloat(prompt('Approx distance in meters?', '5'));
    const note = prompt('Note?');
    const ok = await ensureAuth();
    if (!ok) return alert('You must be logged in');
    const headers = getAuthHeaders();
    const r = await fetch(`${baseUrl}/spots/${id}/logs`, { method: 'POST', headers, body: JSON.stringify({ playerId: currentPlayer.id, distance, note }) });
    alert('Log result: ' + JSON.stringify(await r.json()));
    loadSpots();
    loadHeatmap();
  });
  const btnAuto = el.querySelector('.btnAuto');
  if (btnAuto) btnAuto.addEventListener('click', async (ev)=>{
    if (!currentPlayer) return alert('Register first');
    const id = ev.currentTarget.getAttribute('data-id');
    const distance = parseFloat(prompt('Approx distance in meters?', '5'));
    const ok2 = await ensureAuth();
    if (!ok2) return alert('You must be logged in');
    const headers = getAuthHeaders();
    const r = await fetch(`${baseUrl}/spots/${id}/auto-log`, { method: 'POST', headers, body: JSON.stringify({ playerId: currentPlayer.id, distance }) });
    alert('Auto-log result: ' + JSON.stringify(await r.json()));
    loadSpots();
    loadHeatmap();
  });
}

async function loadHeatmap() {
  if (!currentPlayer) {
    const infoEl = document.getElementById('msgToken');
    if (infoEl) infoEl.innerText = 'Login to view your personal Heatmap';
    return;
  } else {
    const infoEl = document.getElementById('msgToken');
    if (infoEl) infoEl.innerText = '';
  }
  const res = await fetch(`${baseUrl}/heatmap/${currentPlayer.id}`, { headers: getAuthHeaders() }).then(r=>r.json());
  if (!Array.isArray(res)) return;
  const points = res.map(s => [s.position.latitude, s.position.longitude, Math.max(0.1, Math.min(1, s.playerClaimShare))]);
  heatLayer.setLatLngs(points.map(p=>[p[0], p[1], p[2]*0.8]));
}

function toggleHeatmap() {
  if (heatEnabled) {
    map.addLayer(heatLayer);
    loadHeatmap();
  } else {
    map.removeLayer(heatLayer);
  }
}

async function loadLivePlayers(lat = null, lon = null, radius = 2000) {
  // optionally use map center
  if (!lat || !lon) {
    const c = map.getCenter(); lat = c.lat; lon = c.lng;
  }
  const res = await fetch(`${baseUrl}/livePlayers?lat=${lat}&lon=${lon}&radius=${radius}`, { headers: getAuthHeaders() }).then(r=>r.json());
  livePlayersLayer.clearLayers();
  for (const p of res) {
    if (!p.position) continue;
    const marker = L.circleMarker([p.position.latitude, p.position.longitude], { radius: 8, color: p.color || '#00AAFF' });
    marker.bindPopup(`<b>${p.displayName}</b>`);
    livePlayersLayer.addLayer(marker);
  }
}

async function centerToMe() {
  if (!navigator.geolocation) return alert('Geolocation not available');
  navigator.geolocation.getCurrentPosition((pos)=>{ 
    map.setView([pos.coords.latitude, pos.coords.longitude], 16); 
    loadSpots(pos.coords.latitude, pos.coords.longitude); 
    setPlayerPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
    loadLivePlayers(pos.coords.latitude, pos.coords.longitude);
    if (window.CG && window.CG.socket && currentPlayer) { window.CG.socket.emit('positionUpdate', { playerId: currentPlayer.id, position: { latitude: pos.coords.latitude, longitude: pos.coords.longitude } }); }
  });
}

async function pollAll() {
  try {
    // refresh live players + heatmap
    const c = map.getCenter();
    loadLivePlayers(c.lat, c.lng);
    if (heatEnabled) loadHeatmap();
  } catch (e) { console.error('poll error', e); }
}

init();

// Expose helper for developer console
// Ensure we extend existing window.CG instead of replacing it to keep earlier properties such as socket
window.CG = Object.assign(window.CG || {}, { loadSpots, loadLivePlayers, pollAll });
