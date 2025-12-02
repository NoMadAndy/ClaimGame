const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 5004;
const JWT_SECRET = process.env.JWT_SECRET || 'claimgame-dev-secret';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Minimal file DB wrapper
function readJSON(file) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('readJSON error', e);
    return null;
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(obj, null, 2));
}

// In-memory stores with file persistence
let store = {
  players: {},
  spots: {},
  logs: {},
  routes: {},
};

function loadStore() {
  const data = readJSON('store.json');
  if (data) store = data;
}
function saveStore() {
  writeJSON('store.json', store);
}

loadStore();

// Helper functions
function now() { return Date.now(); }
function distanceMeters(a, b) {
  // Haversine approximation
  const R = 6371000; // meters
  const rad = Math.PI/180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const lat1 = a.latitude * rad;
  const lat2 = b.latitude * rad;
  const sinDLat = Math.sin(dLat/2);
  const sinDLon = Math.sin(dLon/2);
  const A = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  const C = 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1-A));
  return R * C;
}

function calculateLevel(totalXP) {
  const level = 1 + Math.floor(totalXP / 100);
  const nextLevel = level * 100;
  const xpToNextLevel = Math.max(0, nextLevel - totalXP);
  return { level, xpToNextLevel };
}

function ensurePlayerStats(player) {
  if (!player.stats) player.stats = { totalXP: 0, collectedLootSpotsCount: 0, level: 1, xpToNextLevel: 0 };
  const lvl = calculateLevel(player.stats.totalXP);
  player.stats.level = lvl.level;
  player.stats.xpToNextLevel = lvl.xpToNextLevel;
}

// Seed demo data if empty
function seedIfEmpty() {
  if (Object.keys(store.players).length === 0) {
    const id = 'player-admin';
    const player = {
      id,
      mode: 'LOGGED_IN',
      role: 'ADMIN',
      displayName: 'Admin',
      color: '#FF0000',
      stats: { totalXP: 0, collectedLootSpotsCount: 0, level: 1, xpToNextLevel: 0 },
      // hashed password for admin: 'admin'
      passwordHash: bcrypt.hashSync('admin', 8),
      inventory: { items: {} },
      lastSeenPosition: null,
      lastAutoLogAt: {},
    };
    ensurePlayerStats(player);
    store.players[id] = player;
  }
  // Ensure default admin has a password (if created before)
  if (store.players['player-admin'] && !store.players['player-admin'].passwordHash) {
    store.players['player-admin'].passwordHash = bcrypt.hashSync('admin', 8);
    saveStore();
  }
  if (Object.keys(store.spots).length === 0) {
    const spots = [
      { id: 'spot-1', position: { latitude: 52.52, longitude: 13.405 }, name: 'Brandenburger Tor', description: 'Historic place', baseXP: 20, autoXP: 5, claimInfo: { totalClaimPoints: 0, perPlayerClaimPoints: {} } },
      { id: 'spot-2', position: { latitude: 52.5205, longitude: 13.4095 }, name: 'Checkpoint Charlie', description: 'Historical', baseXP: 15, autoXP: 5, claimInfo: { totalClaimPoints: 0, perPlayerClaimPoints: {} } }
    ];
    for (const s of spots) store.spots[s.id] = s;
  }
  saveStore();
}
seedIfEmpty();

// Auth helpers
function signToken(player) {
  const payload = { id: player.id, role: player.role, displayName: player.displayName };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Invalid authorization header' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const player = store.players[payload.id];
    if (!player) return res.status(401).json({ error: 'Player not found' });
    req.user = player; // attach player object
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function tryAuthenticate(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const player = store.players[payload.id];
    if (!player) return null;
    return player;
  } catch (e) {
    return null;
  }
}

function getPlayerFromReq(req, bodyPlayerId) {
  // Prefer token-based user (either via middleware or tryAuthenticate)
  if (req.user) return req.user;
  const t = tryAuthenticate(req);
  if (t) return t;
  if (bodyPlayerId) return store.players[bodyPlayerId];
  return null;
}

// Basic health
app.get('/health', (req, res) => res.json({ status: 'ok', time: now() }));

// Players
app.post('/players/register', (req, res) => {
  const { displayName, role, password } = req.body || {};
  const id = uuidv4();
  const player = { id, mode: 'LOGGED_IN', role: role || 'PLAYER', displayName: displayName || `Player-${id.slice(0,6)}`, color: '#00AAFF', stats: { totalXP: 0, collectedLootSpotsCount: 0, level: 1, xpToNextLevel: 0 }, inventory: { items: {} }, lastSeenPosition: null, lastAutoLogAt: {} };
  if (password) player.passwordHash = bcrypt.hashSync(password, 8);
  ensurePlayerStats(player);
  store.players[id] = player;
  saveStore();
  // If password provided, return token for immediate login
  if (player.passwordHash) {
    const token = signToken(player);
    return res.json({ player, token });
  }
  res.json({ player });
});

// Authentication endpoints (JWT)
app.post('/auth/register', (req, res) => {
  const { displayName, role, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const id = uuidv4();
  const player = { id, mode: 'LOGGED_IN', role: role || 'PLAYER', displayName: displayName || `Player-${id.slice(0,6)}`, color: '#00AAFF', stats: { totalXP: 0, collectedLootSpotsCount: 0, level: 1, xpToNextLevel: 0 }, inventory: { items: {} }, lastSeenPosition: null, lastAutoLogAt: {} };
  player.passwordHash = bcrypt.hashSync(password, 8);
  ensurePlayerStats(player);
  store.players[id] = player;
  saveStore();
  // create refresh token and token
  player.refreshToken = uuidv4();
  const token = signToken(player);
  res.json({ player, token, refreshToken: player.refreshToken });
});

app.post('/auth/login', (req, res) => {
  const { id, password } = req.body || {};
  // allow login by id (player id) for this dev flow
  if (!id || !password) return res.status(400).json({ error: 'id & password required' });
  const player = store.players[id];
  if (!player || !player.passwordHash) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = bcrypt.compareSync(password, player.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  player.refreshToken = uuidv4();
  const token = signToken(player);
  saveStore();
  res.json({ player, token, refreshToken: player.refreshToken });
});

app.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  // find player by refresh token
  const players = Object.values(store.players);
  const p = players.find(pp => pp.refreshToken === refreshToken);
  if (!p) return res.status(401).json({ error: 'Invalid refreshToken' });
  // rotate refresh token
  p.refreshToken = uuidv4();
  const token = signToken(p);
  saveStore();
  res.json({ player: p, token, refreshToken: p.refreshToken });
});

app.post('/auth/logout', authenticateToken, (req, res) => {
  // clear refresh token for logged-in user
  const player = req.user;
  if (player) {
    delete player.refreshToken;
    saveStore();
  }
  res.json({ ok: true });
});

app.get('/auth/me', authenticateToken, (req, res) => {
  res.json({ player: req.user });
});

app.get('/players/:id', (req, res) => {
  const p = store.players[req.params.id];
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// update position
app.post('/players/:id/position', (req, res) => {
  // allow token or player id
  const p = store.players[req.params.id];
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { position } = req.body || {};
  p.lastSeenPosition = position;
  store.players[req.params.id] = p;
  saveStore();
  // emit via socket.io
  try {
    io.emit('playerMoved', { playerId: p.id, displayName: p.displayName, position: p.lastSeenPosition, color: p.color });
  } catch(e) {}
  res.json({ ok: true });
});

// Loot collection endpoint
app.post('/players/:id/loot', (req, res) => {
  const p = store.players[req.params.id];
  if (!p) return res.status(404).json({ error: 'Player not found' });
  
  const { lootSpotId, xpReward, itemReward, distance } = req.body || {};
  if (!lootSpotId || !xpReward) return res.status(400).json({ error: 'lootSpotId and xpReward required' });
  
  ensurePlayerStats(p);
  if (!p.inventory) p.inventory = { items: {} };
  
  // Add XP
  addXpToPlayer(p, xpReward);
  
  // Add item if present
  if (itemReward && itemReward.name) {
    const itemId = itemReward.name;
    if (!p.inventory.items[itemId]) {
      p.inventory.items[itemId] = { name: itemReward.name, quantity: 0, description: itemReward.description || '' };
    }
    p.inventory.items[itemId].quantity += (itemReward.quantity || 1);
  }
  
  // Track collected loot count
  p.stats.collectedLootSpotsCount = (p.stats.collectedLootSpotsCount || 0) + 1;
  
  saveStore();
  res.json({ 
    ok: true, 
    player: p,
    xpGained: xpReward,
    itemGained: itemReward,
    distance: distance
  });
});

// Spots
app.get('/spots', (req, res) => {
  // optional radius & center
  const centerLat = parseFloat(req.query.lat);
  const centerLon = parseFloat(req.query.lon);
  const radius = req.query.radius ? parseFloat(req.query.radius) : null; // meters
  const arr = Object.values(store.spots);
  if (!isNaN(centerLat) && !isNaN(centerLon) && radius) {
    const centered = { latitude: centerLat, longitude: centerLon };
    const filtered = arr.filter(s => distanceMeters(centered, s.position) <= radius);
    return res.json(filtered);
  }
  res.json(arr);
});

app.post('/spots', (req, res) => {
  // require auth if token is present
  let creator = tryAuthenticate(req);
  const { creatorId, position, name, description, baseXP, autoXP } = req.body || {};
  if (!creator) creator = store.players[creatorId];
  if (!creator || (creator.role !== 'ADMIN' && creator.role !== 'CREATOR')) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const id = uuidv4();
  const spot = { id, position, name, description, baseXP: baseXP || 20, autoXP: autoXP || 5, claimInfo: { totalClaimPoints: 0, perPlayerClaimPoints: {} } };
  store.spots[id] = spot;
  saveStore();
  res.json({ spot });
});

// Logs & claim
function addXpToPlayer(player, xp) {
  player.stats.totalXP += xp;
  ensurePlayerStats(player);
}

function addClaimPoints(spot, playerId, points) {
  spot.claimInfo.totalClaimPoints = (spot.claimInfo.totalClaimPoints || 0) + points;
  if (!spot.claimInfo.perPlayerClaimPoints) spot.claimInfo.perPlayerClaimPoints = {};
  spot.claimInfo.perPlayerClaimPoints[playerId] = (spot.claimInfo.perPlayerClaimPoints[playerId] || 0) + points;
}

app.post('/spots/:id/logs', (req, res) => {
  // manual log
  const spotId = req.params.id;
  const spot = store.spots[spotId];
  if (!spot) return res.status(404).json({ error: 'Spot not found' });
  const { playerId, distance, note } = req.body || {};
  const player = getPlayerFromReq(req, playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const xpGained = spot.baseXP;
  const claimPoints = 1.0 + (distance ? Math.max(0, (100 - Math.min(100, distance))) / 100 : 1.0); // e.g., closer = more points
  addXpToPlayer(player, xpGained);
  addClaimPoints(spot, player.id, claimPoints);
  const logId = uuidv4();
  const logEntry = { id: logId, spotId, playerId: player.id, type: 'MANUAL', distanceAtLog: distance || null, note: note || null, xpGained, claimPointsGained: claimPoints, createdAt: now() };
  store.logs[logId] = logEntry;
  saveStore();
  res.json({ xpGained, claimPointsGained: claimPoints, updatedPlayer: player, updatedSpotClaimInfo: spot.claimInfo });
});

app.post('/spots/:id/auto-log', (req, res) => {
  // auto log with cooldowns
  const spotId = req.params.id;
  const spot = store.spots[spotId];
  if (!spot) return res.status(404).json({ error: 'Spot not found' });
  const { playerId, distance } = req.body || {};
  const player = getPlayerFromReq(req, playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const nowTime = now();
  const last = player.lastAutoLogAt && player.lastAutoLogAt[spotId] ? player.lastAutoLogAt[spotId] : 0;
  const COOLDOWN = 5 * 60 * 1000; // 5 minutes
  if (nowTime - last < COOLDOWN) {
    return res.status(429).json({ error: 'Auto-log cooldown' });
  }
  const xpGained = spot.autoXP || 5;
  const claimPoints = 0.5 + Math.max(0, (10 - Math.min(10, distance || 0))) / 10; // less than manual
  addXpToPlayer(player, xpGained);
  addClaimPoints(spot, player.id, claimPoints);
  const logId = uuidv4();
  const logEntry = { id: logId, spotId, playerId: player.id, type: 'AUTO', distanceAtLog: distance || null, note: null, xpGained, claimPointsGained: claimPoints, createdAt: now() };
  store.logs[logId] = logEntry;
  if (!player.lastAutoLogAt) player.lastAutoLogAt = {};
  player.lastAutoLogAt[spotId] = nowTime;
  saveStore();
  res.json({ xpGained, claimPointsGained: claimPoints, updatedPlayer: player, updatedSpotClaimInfo: spot.claimInfo });
});

// Loot (local) -> for guests handled client-side; backend for logged-in
app.post('/players/:id/collect-loot', (req, res) => {
  const playerId = req.params.id;
  const player = getPlayerFromReq(req, playerId) || store.players[playerId];
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { xpReward, itemReward } = req.body || {};
  const xp = xpReward || 10;
  addXpToPlayer(player, xp);
  player.stats.collectedLootSpotsCount = (player.stats.collectedLootSpotsCount || 0) + 1;
  if (itemReward) {
    player.inventory.items[itemReward.itemId] = (player.inventory.items[itemReward.itemId] || 0) + (itemReward.quantity || 1);
  }
  saveStore();
  res.json({ updatedPlayer: player });
});

// Heatmap
app.get('/heatmap/:playerId', (req, res) => {
  const player = store.players[req.params.playerId];
  // allow only the same player to access their heatmap unless admin
  const authUser = tryAuthenticate(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  if (authUser.id !== player.id && authUser.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const list = Object.values(store.spots).filter(s => s.claimInfo && s.claimInfo.perPlayerClaimPoints && s.claimInfo.perPlayerClaimPoints[player.id]);
  const result = list.map(s => ({ spotId: s.id, position: s.position, playerClaimPoints: s.claimInfo.perPlayerClaimPoints[player.id], playerClaimShare: s.claimInfo.totalClaimPoints ? s.claimInfo.perPlayerClaimPoints[player.id]/s.claimInfo.totalClaimPoints : 0 }));
  res.json(result);
});

// Tracking routes
app.post('/tracking/start', (req, res) => {
  const { playerId } = req.body || {};
  const player = getPlayerFromReq(req, playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const id = uuidv4();
  const route = { id, playerId, points: [], startedAt: now(), endedAt: null };
  store.routes[id] = route;
  saveStore();
  res.json({ route });
});

app.post('/tracking/:id/point', (req, res) => {
  const routeId = req.params.id;
  const route = store.routes[routeId];
  if (!route) return res.status(404).json({ error: 'Route not found' });
  const { position, timestamp } = req.body || {};
  route.points.push({ position, timestamp: timestamp || now() });
  saveStore();
  res.json({ ok: true });
});

app.post('/tracking/:id/stop', (req, res) => {
  const routeId = req.params.id;
  const route = store.routes[routeId];
  if (!route) return res.status(404).json({ error: 'Route not found' });
  route.endedAt = now();
  saveStore();
  res.json({ route });
});

// Live players snapshot (filter by radius optional)
app.get('/livePlayers', (req, res) => {
  const centerLat = parseFloat(req.query.lat);
  const centerLon = parseFloat(req.query.lon);
  const radius = req.query.radius ? parseFloat(req.query.radius) : null; // meters
  const players = Object.values(store.players).filter(p => p.lastSeenPosition);
  if (!isNaN(centerLat) && !isNaN(centerLon) && radius) {
    const center = { latitude: centerLat, longitude: centerLon };
    const filtered = players.filter(p => distanceMeters(center, p.lastSeenPosition) <= radius).map(p => ({ playerId: p.id, displayName: p.displayName, position: p.lastSeenPosition, lastActivity: p.lastSeenAt || now(), color: p.color }));
    return res.json(filtered);
  }
  res.json(players.map(p => ({ playerId: p.id, displayName: p.displayName, position: p.lastSeenPosition, lastActivity: p.lastSeenAt || now(), color: p.color })));
});

// Admin endpoints: list logs
app.get('/logs', (req, res) => {
  res.json(Object.values(store.logs));
});

// Basic public UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create server for socket.io
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

// Socket authentication
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const player = store.players[payload.id];
      if (!player) return next(new Error('invalid token'));
      socket.player = player;
    } catch (e) {
      return next(new Error('invalid token'));
    }
  }
  next();
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id, socket.player && socket.player.id);
  // client may send positionUpdate
  socket.on('positionUpdate', (payload) => {
    const player = socket.player || (payload && store.players[payload.playerId]);
    if (!player) return;
    player.lastSeenPosition = payload.position;
    player.lastSeenAt = now();
    store.players[player.id] = player;
    saveStore();
    // broadcast to all clients
    const snapshot = { playerId: player.id, displayName: player.displayName, position: player.lastSeenPosition, color: player.color };
    io.emit('playerMoved', snapshot);
  });
  // when client disconnects
  socket.on('disconnect', () => { /* noop */ });
});

server.listen(PORT, () => {
  console.log(`ClaimGame backend running on http://localhost:${PORT}`);
});
