// Minimal map frontend for ClaimGame: shows spots, heatmap (per-player), live players, and simple register

const baseUrl = window.location.origin;
// ensure our developer helper object exists early so initSocket can set socket
window.CG = window.CG || {};
let currentPlayer = JSON.parse(localStorage.getItem('cg_player') || 'null');
let map, spotsLayer, lootSpotsLayer, livePlayersLayer, heatLayer, routeLayer;
let heatEnabled = true; // Heatmap default an
let pollInterval = 5000; // ms
let playerMarker = null;
let compassEnabled = false;
let currentHeading = 0;
let autoFollow = true; // Karte folgt Position bis der Nutzer die Karte bewegt
let localLootSpots = [];
let lootSpotsGenerated = false;
const LOOT_COLLECTION_RADIUS = 25; // meters
const AUTO_LOG_RADIUS = 10; // meters for auto-logs
const AUTO_LOG_COOLDOWN = 5 * 60 * 1000; // 5 minutes
let autoLogCooldowns = {}; // { spotId: timestamp }
// Smooth follow tuning
const FLY_THRESHOLD_METERS = 400; // ab dieser Distanz weicher Flug statt Pan
const FOLLOW_PAN_SHORT = { duration: 0.45, easeLinearity: 0.22 };
const FOLLOW_PAN_LONG = { duration: 0.8, easeLinearity: 0.3 };

// Route tracking
let trackingEnabled = false;
let activeRouteId = null;
let routePoints = [];
let showLiveRoute = true;
let oldRoutesList = [];
let selectedOldRouteId = null;

// --- Helpers ---
function isMobileDevice() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.matchMedia('(max-width: 600px)').matches;
}
function getStandardZoom() {
  return isMobileDevice() ? 19 : 16;
}

// --- Local Loot Spots (Phase 1) - Global functions ---
function generateLocalLootSpotsAround(center) {
  const spots = [];
  const count = 5 + Math.floor(Math.random() * 6); // 5-10 spots
  console.log(`Generating ${count} loot spots around`, center);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const radius = 50 + Math.random() * 100; // 50-150m
    const pos = moveCoordinate(center, angle, radius);
    const xp = 10;
    const itemReward = Math.random() > 0.7 ? { name: ['Kompass', 'Karte', 'Boost'][Math.floor(Math.random()*3)], quantity: 1 } : null;
    spots.push({
      id: 'loot-' + Date.now() + '-' + i,
      position: pos,
      xpReward: xp,
      itemReward: itemReward,
      isCollected: false,
      createdAt: Date.now()
    });
  }
  console.log('Generated loot spots:', spots);
  return spots;
}

function moveCoordinate(center, angleRad, distanceMeters) {
  const R = 6371000; // earth radius in meters
  const lat1 = center.lat * Math.PI / 180;
  const lon1 = center.lng * Math.PI / 180;
  const dR = distanceMeters / R;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dR) + Math.cos(lat1)*Math.sin(dR)*Math.cos(angleRad));
  const lon2 = lon1 + Math.atan2(Math.sin(angleRad)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR)-Math.sin(lat1)*Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lng: lon2 * 180 / Math.PI };
}

function displayLootSpots() {
  console.log('Displaying loot spots:', localLootSpots.length, 'total');
  lootSpotsLayer.clearLayers();
  localLootSpots.forEach(loot => {
    if (loot.isCollected) return;
    console.log('Adding loot marker at', loot.position);
    const marker = L.marker([loot.position.lat, loot.position.lng], {
      icon: L.divIcon({
        className: 'loot-spot-icon',
        html: '<svg viewBox="0 0 24 24" width="32" height="32"><polygon points="12,2 15,9 22,10 17,15 18,22 12,18 6,22 7,15 2,10 9,9" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.5"/></svg>',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      })
    });
    marker.bindPopup(`<b>Loot Spot</b><br>XP: ${loot.xpReward}${loot.itemReward ? '<br>Item: '+loot.itemReward.name : ''}`);
    lootSpotsLayer.addLayer(marker);
  });
  console.log('Loot layer now has', lootSpotsLayer.getLayers().length, 'markers');
}

function tryCollectNearbyLootSpots(currentPos) {
  if (!currentPos) return;
  localLootSpots.forEach(loot => {
    if (loot.isCollected) return;
    const dist = distanceBetween(currentPos, loot.position);
    if (dist <= LOOT_COLLECTION_RADIUS) {
      collectLootSpot(loot, dist);
    }
  });
}

function collectLootSpot(loot, dist) {
  loot.isCollected = true;
  loot.collectedAt = Date.now();
  const gainedXP = loot.xpReward;
  
  if (currentPlayer && currentPlayer.id && currentPlayer.mode === 'LOGGED_IN') {
    // Sync with backend for logged-in players
    const payload = {
      lootSpotId: loot.id,
      xpReward: gainedXP,
      itemReward: loot.itemReward,
      distance: dist
    };
    fetch(`${baseUrl}/players/${currentPlayer.id}/loot`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(r => r.json())
    .then(data => {
      if (data.player) {
        currentPlayer = data.player;
        localStorage.setItem('cg_player', JSON.stringify(currentPlayer));
        updateUserMenuUI();
        updateStatus();
      }
      displayLootSpots();
      showMessage(`🎉 Loot gesammelt! +${gainedXP} XP${loot.itemReward ? ' + '+loot.itemReward.name : ''}`, 3000);
    })
    .catch(e => {
      console.warn('Backend loot sync failed, using local fallback', e);
      // Fallback to local update
      updateLocalLootStats(loot, gainedXP);
    });
  } else {
    // Local-only for guests or offline
    updateLocalLootStats(loot, gainedXP);
  }
}

function updateLocalLootStats(loot, gainedXP) {
  if (currentPlayer) {
    if (!currentPlayer.stats) currentPlayer.stats = { totalXP: 0, collectedLootSpotsCount: 0, level: 1, xpToNextLevel: 100 };
    currentPlayer.stats.totalXP += gainedXP;
    currentPlayer.stats.collectedLootSpotsCount = (currentPlayer.stats.collectedLootSpotsCount || 0) + 1;
    // Recalc level
    const level = 1 + Math.floor(currentPlayer.stats.totalXP / 100);
    const nextThreshold = level * 100;
    currentPlayer.stats.level = level;
    currentPlayer.stats.xpToNextLevel = Math.max(0, nextThreshold - currentPlayer.stats.totalXP);
    
    if (loot.itemReward) {
      if (!currentPlayer.inventory) currentPlayer.inventory = { items: {} };
      const itemId = loot.itemReward.name;
      if (!currentPlayer.inventory.items[itemId]) {
        currentPlayer.inventory.items[itemId] = { name: loot.itemReward.name, quantity: 0 };
      }
      currentPlayer.inventory.items[itemId].quantity += loot.itemReward.quantity;
    }
    
    localStorage.setItem('cg_player', JSON.stringify(currentPlayer));
    updateUserMenuUI();
    updateStatus();
  }
  
  displayLootSpots();
  showMessage(`🎉 Loot gesammelt! +${gainedXP} XP${loot.itemReward ? ' + '+loot.itemReward.name : ''}`, 3000);
}

function distanceBetween(pos1, pos2) {
  const R = 6371000;
  const lat1 = pos1.lat * Math.PI / 180;
  const lat2 = pos2.lat * Math.PI / 180;
  const dLat = (pos2.lat - pos1.lat) * Math.PI / 180;
  const dLon = (pos2.lng - pos1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)*Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showMessage(html, duration = 2000) {
  // Toast als fixes Overlay im Body (nicht mit Karte beweglich)
  const toast = document.createElement('div');
  toast.className = 'toast-message';
  toast.innerHTML = html;
  document.body.appendChild(toast);
  
  // Berechne die Position basierend auf anderen aktiven Toasts
  const activeToasts = document.querySelectorAll('.toast-message');
  const toastIndex = Array.from(activeToasts).indexOf(toast);
  const baseTop = 100; // Pixel von oben
  const toastHeight = 55; // Ungefähre Höhe eines Toasts + Gap
  const offsetTop = baseTop + (toastIndex * toastHeight);
  
  toast.style.top = offsetTop + 'px';
  
  // position relative to map viewport if possible
  if (window.CG && typeof window.CG.positionOverlays === 'function') window.CG.positionOverlays();
  // Fade in
  setTimeout(() => toast.classList.add('show'), 10);
  // Remove after duration
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
      // Re-position remaining toasts
      const remaining = document.querySelectorAll('.toast-message');
      remaining.forEach((t, idx) => {
        t.style.top = (baseTop + (idx * toastHeight)) + 'px';
      });
    }, 300);
  }, duration);
}

function tryAutoLogNearbySpots(currentPos) {
  if (!currentPos || !currentPlayer || currentPlayer.mode !== 'LOGGED_IN') return;
  
  Object.values(window.loadedSpots || {}).forEach(spot => {
    const dist = distanceBetween(currentPos, spot.position);
    if (dist <= AUTO_LOG_RADIUS) {
      const lastLog = autoLogCooldowns[spot.id] || 0;
      const now = Date.now();
      if (now - lastLog >= AUTO_LOG_COOLDOWN) {
        performAutoLog(spot, dist);
      }
    }
  });
}

async function performAutoLog(spot, dist) {
  autoLogCooldowns[spot.id] = Date.now();
  
  const payload = {
    playerId: currentPlayer.id,
    distance: dist
  };
  
  try {
    const res = await fetch(`${baseUrl}/spots/${spot.id}/auto-log`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (res.status === 429) {
      // Cooldown active, ignore silently
      return;
    }
    
    const data = await res.json();
    if (data.updatedPlayer) {
      currentPlayer = data.updatedPlayer;
      localStorage.setItem('cg_player', JSON.stringify(currentPlayer));
      updateUserMenuUI();
    }
    
    showMessage(`🔄 Auto-Log: ${spot.name} (+${data.xpGained} XP)`, 2000);
    
    // Update spot claim info if available
    if (window.loadedSpots && data.updatedSpotClaimInfo) {
      window.loadedSpots[spot.id].claimInfo = data.updatedSpotClaimInfo;
    }
    
    if (heatEnabled) loadHeatmap();
  } catch (e) {
    console.warn('Auto-log failed', e);
  }
}

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
  const isMobile = isMobileDevice();
  const initialZoom = isMobile ? 19 : 15;
  map = L.map('map', { layers: [osm] }).setView([52.52, 13.405], initialZoom);
  // (UI overlays are fixed positioned via CSS / JS, do not attach to map pane)
  // Statusleiste NICHT in das UI-Pane verschieben; bleibt als fixed Overlay im Body
  spotsLayer = L.layerGroup().addTo(map);
  lootSpotsLayer = L.layerGroup().addTo(map);
  livePlayersLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  heatLayer = L.heatLayer([], { radius: 25, blur: 15, maxZoom: 17 });

  document.getElementById('btnRegister').addEventListener('click', onRegister);
  document.getElementById('btnLogin').addEventListener('click', onLogin);
  document.getElementById('btnLogout').addEventListener('click', onLogout);
  document.getElementById('btnCenter').addEventListener('click', centerToMe);
    // Nutzerbewegung der Karte deaktiviert Auto-Follow
    map.on('dragstart zoomstart movestart', () => { autoFollow = false; });
  document.getElementById('btnCompass').addEventListener('click', async (ev)=>{ compassEnabled = !compassEnabled; if (compassEnabled) enableCompass(); else disableCompass(); updateCompassButton(); });
  document.getElementById('wakelockBtn').addEventListener('click', async ()=>{ await toggleWakeLock(); });
  
  // Route tracking buttons
  const btnTrackingToggle = document.getElementById('btnTrackingToggle');
  if (btnTrackingToggle) {
    btnTrackingToggle.addEventListener('click', async () => {
      await toggleTracking();
      btnTrackingToggle.setAttribute('aria-pressed', String(trackingEnabled));
      btnTrackingToggle.classList.toggle('active', trackingEnabled);
    });
  }
  
  // layers button toggles the builtin control open/close if possible
  // The layer control is shown in the top-right by default; no bottom toggle needed.

  // user menu: click handler for mobile
  const userMenuBtn = document.getElementById('userMenuBtn');
  const userMenu = document.getElementById('userMenu');
  if (userMenuBtn && userMenu) {
    // init menu label
    if (userMenuBtn) {
      userMenuBtn.setAttribute('title', currentPlayer ? `${currentPlayer.displayName || 'User'}` : 'Guest');
      userMenuBtn.setAttribute('aria-label', currentPlayer ? `${currentPlayer.displayName || 'User'}` : 'Guest');
    }
    
    // Click handler for mobile (and desktop)
    userMenuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const isVisible = userMenu.classList.contains('show');
      if (isVisible) {
        userMenu.classList.remove('show');
        userMenu.setAttribute('aria-hidden', 'true');
        userMenu.style.display = 'none';
      } else {
        userMenu.classList.add('show');
        userMenu.setAttribute('aria-hidden', 'false');
        userMenu.style.display = 'block';
      }
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', (ev) => {
      if (!userMenuBtn.contains(ev.target) && !userMenu.contains(ev.target)) {
        userMenu.classList.remove('show');
        userMenu.setAttribute('aria-hidden', 'true');
        userMenu.style.display = 'none';
      }
    });
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
    const isActive = wakeLockActive;
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
  // Custom overlays for route selection
  const overlays = {
    'Spots': spotsLayer,
    'Loot Spots': lootSpotsLayer,
    'Live Players': livePlayersLayer,
    'Heatmap': heatLayer,
    'Live-Route': routeLayer,
    'Alter Track': L.layerGroup() // Platzhalter, wird dynamisch befüllt
  };
  const layerControl = L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: true }).addTo(map);

  // Layer-Event: Umschalten zwischen Live-Route und Alter Track
  map.on('overlayadd', function(e) {
    if (e.name === 'Live-Route') {
      showLiveRoute = true;
      selectedOldRouteId = null;
      updateRouteDisplay();
    }
    if (e.name === 'Alter Track') {
      showLiveRoute = false;
      // Lade alle alten Routen des Spielers
      if (!currentPlayer || !currentPlayer.id) return showMessage('Kein Spieler angemeldet', 1500);
      fetch(`${baseUrl}/tracking/${currentPlayer.id}/routes`).then(r => r.json()).then(res => {
        oldRoutesList = res.routes || [];
        if (oldRoutesList.length === 0) return showMessage('Keine alten Tracks gefunden', 1500);
        // Zeige Auswahl (prompt)
        const options = oldRoutesList.map((r, i) => `${i+1}: ${new Date(r.startedAt).toLocaleString()} (${r.points.length} Punkte)`).join('\n');
        const idx = parseInt(prompt(`Wähle Track:\n${options}`), 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= oldRoutesList.length) return showMessage('Abbruch', 1000);
        selectedOldRouteId = oldRoutesList[idx].id;
        updateRouteDisplay();
        showMessage('Alter Track angezeigt', 1200);
      });
    }
  });
  // Style the control container
  try {
    const ctrl = document.querySelector('.leaflet-control-layers');
    if (ctrl) {
      ctrl.classList.add('modern-layer-control');
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

  // Ensure messageBox sits in body as last child (so stacking order/DOM order is predictable)
  try {
    const msg = document.getElementById('messageBox');
    if (msg && msg.parentElement !== document.body) document.body.appendChild(msg);
  } catch (e) {}

  // Position statusbar & future toasts relative to the map viewport
  function positionOverlays() {
    try {
      const mapEl = document.getElementById('map');
      const msg = document.getElementById('messageBox');
      if (!mapEl || !msg) return;
      const rect = mapEl.getBoundingClientRect();
      // center X pixel
      const centerX = Math.round(rect.left + rect.width / 2);
      
      // ENSURE the messageBox stays visible and positioned correctly
      msg.style.position = 'fixed';
      msg.style.left = centerX + 'px';
      msg.style.transform = 'translateX(-50%)';
      msg.style.top = Math.max(rect.top + 12, 8) + 'px';
      msg.style.zIndex = '100500';
      msg.style.display = 'flex';
      // width relative to map (70%) up to a cap
      const wanted = Math.round(rect.width * 0.7);
      msg.style.width = Math.min(wanted, 1000) + 'px';
      
      // ensure existing toasts (if any) sit under the status bar
      document.querySelectorAll('.toast-message').forEach((t) => {
        t.style.position = 'fixed';
        t.style.left = centerX + 'px';
        t.style.transform = 'translateX(-50%)';
        t.style.top = Math.max(rect.top + 90, 40) + 'px';
        t.style.zIndex = '100501';
      });
    } catch (e) { console.error('positionOverlays error:', e); }
  }
  // initial position and on resize/scroll
  // Delay first call to ensure CSS is loaded
  setTimeout(() => positionOverlays(), 100);
  window.CG.positionOverlays = positionOverlays;
  window.addEventListener('resize', positionOverlays, { passive: true });
  window.addEventListener('scroll', positionOverlays, { passive: true });
  // Leaflet fires resize on map container changes
  if (map) map.on('resize', positionOverlays);
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
      const lootCount = currentPlayer.stats && currentPlayer.stats.collectedLootSpotsCount ? ` • Loot: ${currentPlayer.stats.collectedLootSpotsCount}` : '';
      if (x) x.innerText = `XP: ${currentPlayer.stats ? currentPlayer.stats.totalXP : 0}  • Level: ${currentPlayer.stats ? currentPlayer.stats.level : 1}${lootCount}`;
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

function centerToMe() {
  // Auto-Follow wieder aktivieren und Standardzoom setzen
  autoFollow = true;
  const stdZoom = getStandardZoom();
  if (playerMarker) {
    const ll = playerMarker.getLatLng();
    map.setView([ll.lat, ll.lng], stdZoom, { animate: true, duration: 0.6 });
  } else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], stdZoom, { animate: true, duration: 0.6 });
      setPlayerPosition({ latitude, longitude });
    });
  } else {
    const c = map.getCenter();
    map.setView([c.lat, c.lng], stdZoom, { animate: true, duration: 0.6 });
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
    document.getElementById('msgStats').style.display = 'none';
  } else {
    if (el) el.innerText = `Player: ${currentPlayer.displayName} (${currentPlayer.id}) role:${currentPlayer.role}`;
    
    // Update stats display
    if (currentPlayer.stats) {
      const statsEl = document.getElementById('msgStats');
      if (statsEl) {
        statsEl.style.display = 'block';
        document.getElementById('playerLevel').innerText = currentPlayer.stats.level || 1;
        document.getElementById('playerXP').innerText = currentPlayer.stats.totalXP || 0;
        const nextLevelXP = (currentPlayer.stats.level || 1) * 100;
        document.getElementById('playerXPNext').innerText = nextLevelXP;
        document.getElementById('lootCount').innerText = currentPlayer.stats.collectedLootSpotsCount || 0;
      }
    }
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
    // Generate loot spots at map center as fallback
    if (!lootSpotsGenerated) {
      const center = map.getCenter();
      const currentPos = { lat: center.lat, lng: center.lng };
      console.log('GPS not available, generating loot spots at map center:', currentPos);
      localLootSpots = generateLocalLootSpotsAround(currentPos);
      lootSpotsGenerated = true;
      displayLootSpots();
    }
    return;
  }
  navigator.geolocation.getCurrentPosition((pos)=>{
    const currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    console.log('GPS fix received:', currentPos);
    const targetZoom = getStandardZoom();
    map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), targetZoom));
    loadSpots(pos.coords.latitude, pos.coords.longitude);
    // update player marker to current GPS position immediately
    setPlayerPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
    
    // Generate loot spots on first GPS fix
    if (!lootSpotsGenerated) {
      console.log('Generating loot spots for first time');
      localLootSpots = generateLocalLootSpotsAround(currentPos);
      lootSpotsGenerated = true;
      displayLootSpots();
    }
    
    // Try to collect nearby loot
    tryCollectNearbyLootSpots(currentPos);
    
    // Try auto-logs for nearby permanent spots
    tryAutoLogNearbySpots(currentPos);
  }, (err)=>{ 
    console.warn('geo err', err); 
    loadSpots();
    // Generate loot spots at map center when GPS denied
    if (!lootSpotsGenerated) {
      const center = map.getCenter();
      const currentPos = { lat: center.lat, lng: center.lng };
      console.log('GPS denied, generating loot spots at map center:', currentPos);
      localLootSpots = generateLocalLootSpotsAround(currentPos);
      lootSpotsGenerated = true;
      displayLootSpots();
    }
  });
  
  // Watch position for continuous updates
  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const currentPos = { lat, lng: lon };
      
      // Update player marker
      setPlayerPosition({ latitude: lat, longitude: lon });
      
      // Map sanft folgen lassen, solange Auto-Follow aktiv ist (adaptiv pan/fly)
      if (autoFollow) {
        const c = map.getCenter();
        const dist = distanceBetween({ lat: c.lat, lng: c.lng }, { lat, lng: lon });
        if (dist > FLY_THRESHOLD_METERS) {
          // weiter Sprung: sanfter Flug, ggf. auf Standardzoom anheben
          const z = Math.max(map.getZoom(), getStandardZoom());
          map.flyTo([lat, lon], z, { animate: true, duration: FOLLOW_PAN_LONG.duration, easeLinearity: FOLLOW_PAN_LONG.easeLinearity });
        } else {
          // kurzer Schritt: sanftes Pan ohne Zoomänderung
          map.panTo([lat, lon], { animate: true, duration: FOLLOW_PAN_SHORT.duration, easeLinearity: FOLLOW_PAN_SHORT.easeLinearity });
        }
      }
      
      // Record route point if tracking is enabled
      recordRoutePoint(lat, lon);
      
      // Try to collect nearby loot spots
      tryCollectNearbyLootSpots(currentPos);
      
      // Try auto-logs for nearby permanent spots
      tryAutoLogNearbySpots(currentPos);
      
      // Emit socket event for other players to see this player moving
      if (window.CG && window.CG.socket && currentPlayer) {
        window.CG.socket.emit('positionUpdate', { 
          playerId: currentPlayer.id, 
          position: { latitude: lat, longitude: lon } 
        });
      }
    },
    (err) => { console.warn('watchPosition error', err); },
    { 
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

async function loadSpots(lat = 52.52, lon = 13.405) {
  const rad = 2000; // 2km radius
  const res = await fetch(`${baseUrl}/spots?lat=${lat}&lon=${lon}&radius=${rad}`, { headers: getAuthHeaders() }).then(r=>r.json());
  spotsLayer.clearLayers();
  window.loadedSpots = {};
  for (const s of res) {
    window.loadedSpots[s.id] = s;
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
  const resp = await fetch(`${baseUrl}/heatmap/${currentPlayer.id}`, { headers: getAuthHeaders() });
  if (!resp.ok) {
    if (resp.status === 401) {
      const infoEl = document.getElementById('msgToken');
      if (infoEl) infoEl.innerText = 'Heatmap: login required or token expired (401)';
      return;
    } else {
      console.warn('heatmap: server returned', resp.status);
      return;
    }
  }
  const res = await resp.json();
  if (!Array.isArray(res)) return;
  const points = res.map(s => [s.position.latitude, s.position.longitude, Math.max(0.1, Math.min(1, s.playerClaimShare))]);
  try {
    if (map && map.hasLayer(heatLayer)) {
      heatLayer.setLatLngs(points.map(p=>[p[0], p[1], p[2]*0.8]));
    }
  } catch (e) {
    console.warn('heatmap render error', e);
  }
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

// centerToMe unified above

// --- Route Tracking Functions ---
async function startTracking() {
  if (!currentPlayer || currentPlayer.mode !== 'LOGGED_IN') {
    showMessage('⚠️ Tracking nur für eingeloggte Spieler verfügbar', 3000);
    return;
  }
  
  try {
    const response = await fetch(`${baseUrl}/tracking/start`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ playerId: currentPlayer.id })
    });
    const data = await response.json();
    
    if (data.route) {
      trackingEnabled = true;
      activeRouteId = data.route.id;
      routePoints = [];
      showMessage('📍 Route-Tracking gestartet', 2000);
      updateRouteDisplay();
    }
  } catch (e) {
    console.error('Failed to start tracking', e);
    showMessage('❌ Tracking-Start fehlgeschlagen', 3000);
  }
}

async function stopTracking() {
  if (!activeRouteId) return;
  
  try {
    const response = await fetch(`${baseUrl}/tracking/${activeRouteId}/stop`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    const data = await response.json();
    
    trackingEnabled = false;
    showMessage(`✓ Route beendet (${routePoints.length} Punkte)`, 3000);
    activeRouteId = null;
  } catch (e) {
    console.error('Failed to stop tracking', e);
  }
}

async function toggleTracking() {
  if (trackingEnabled) {
    await stopTracking();
  } else {
    await startTracking();
  }
}

function recordRoutePoint(lat, lng) {
  if (!trackingEnabled || !activeRouteId) return;
  
  const point = { lat, lng, timestamp: Date.now() };
  routePoints.push(point);
  
  // Send to backend
  fetch(`${baseUrl}/tracking/${activeRouteId}/point`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ 
      position: { latitude: lat, longitude: lng },
      timestamp: point.timestamp
    })
  }).catch(e => console.warn('Failed to send route point', e));
  
  // Update display if visible
  if (routeVisible) {
    updateRouteDisplay();
  }
}

function updateRouteDisplay() {
  routeLayer.clearLayers();
  if (showLiveRoute) {
    if (routePoints.length < 2) return;
    const latLngs = routePoints.map(p => [p.lat, p.lng]);
    const polyline = L.polyline(latLngs, {
      color: '#4f8cff',
      weight: 4,
      opacity: 0.7,
      smoothFactor: 1
    });
    routeLayer.addLayer(polyline);
  } else if (selectedOldRouteId) {
    // Lade und zeige die gewählte alte Route
    fetch(`${baseUrl}/tracking/route/${selectedOldRouteId}`)
      .then(r => r.json())
      .then(data => {
        if (!data.route || !data.route.points || data.route.points.length < 2) return;
        const latLngs = data.route.points.map(p => [p.position.latitude, p.position.longitude]);
        const polyline = L.polyline(latLngs, {
          color: '#10b981',
          weight: 4,
          opacity: 0.7,
          dashArray: '8 6',
          smoothFactor: 1
        });
        routeLayer.addLayer(polyline);
      });
  }
}

async function pollAll() {
  try {
    // refresh live players + heatmap
    const c = map.getCenter();
    loadLivePlayers(c.lat, c.lng);
    if (heatEnabled) loadHeatmap();
  } catch (e) { console.error('poll error', e); }
}

document.getElementById('btnShowLiveRoute').addEventListener('click', () => {
  showLiveRoute = true;
  selectedOldRouteId = null;
  updateRouteDisplay();
  showMessage('Live-Route angezeigt', 1200);
});
document.getElementById('btnShowOldTracks').addEventListener('click', async () => {
  showLiveRoute = false;
  selectedOldRouteId = null;
  // Lade alle alten Routen des Spielers
  if (!currentPlayer || !currentPlayer.id) return showMessage('Kein Spieler angemeldet', 1500);
  const res = await fetch(`${baseUrl}/tracking/${currentPlayer.id}/routes`).then(r => r.json());
  oldRoutesList = res.routes || [];
  if (oldRoutesList.length === 0) return showMessage('Keine alten Tracks gefunden', 1500);
  // Zeige Auswahl (prompt)
  const options = oldRoutesList.map((r, i) => `${i+1}: ${new Date(r.startedAt).toLocaleString()} (${r.points.length} Punkte)`).join('\n');
  const idx = parseInt(prompt(`Wähle Track:\n${options}`), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= oldRoutesList.length) return showMessage('Abbruch', 1000);
  selectedOldRouteId = oldRoutesList[idx].id;
  updateRouteDisplay();
  showMessage('Alter Track angezeigt', 1200);
});
init();

// Expose helper for developer console
// Ensure we extend existing window.CG instead of replacing it to keep earlier properties such as socket
window.CG = Object.assign(window.CG || {}, { loadSpots, loadLivePlayers, pollAll });
