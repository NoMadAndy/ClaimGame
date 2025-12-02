# ClaimGame – Domänenmodell und Spielmechanik :-)

Dieses Dokument beschreibt die Spielmechanik und Spiellogik von **ClaimGame**, einem ortsbasierten GPS-Spiel. Die Beschreibung ist **technologieunabhängig** und kann auf beliebige Plattformen (Mobile, Web, Desktop mit GPS, AR-Geräte etc.) übertragen werden.

---

## 1. Ziele und Grundidee

- Reales Outdoor-GPS-Spiel: Spieler bewegen sich in der echten Welt, ihre Position wird per GPS bestimmt.
- Auf einer Karte sieht der Spieler:
  - Seine eigene Position.
  - Lokale Loot-Spots (nur für ihn gültig).
  - Permanente Spots (global persistente Orte).
- Spieler sammeln:
  - **XP** (Erfahrungspunkte).
  - **Loot/Items**.
  - **Claims** (Gebietskontrolle an Spots).
- Langfristiges Ziel:
  - Möglichst viele permanente Spots in der Umgebung zu kontrollieren.
  - Eine persönliche **Heatmap** der eigenen Präsenz und Kontrolle aufzubauen.

---

## 2. Basis-Typen & Hilfsstrukturen

Diese Typen sind sprachneutral gedacht (können z. B. als Klassen, Interfaces, Structs, Records, Tabellen etc. umgesetzt werden).

```text
Coordinate:
  latitude: float
  longitude: float

Distance:
  meters: float

Timestamp:
  epochMillis: long  // oder geeignetes Datumsformat

PlayerId: string
SpotId: string
LogId: string
ItemId: string
RouteId: string
ClaimId: string
SessionId: string
```

---
## Developer Quickstart — Backend (Dev Server)

Zusätzlich zur Domain-Spezifikation gibt es in diesem Repository einen Prototyp-Backendserver (Express) zum schnellen Entwickeln und Testen.

Starten des Servers (entwicklerfreundlich):

```bash
cd /workspaces/ClaimGame
npm install
npm start
```

Der Server läuft standardmäßig auf Port `5000`.

Wichtige (dev-)Endpunkte:
- `GET /health` — einfache Health-Check-Antwort
- `POST /players/register` — Spieler erstellen (dev, optional no password)
- `POST /auth/register` — Spieler mit Passwort registrieren (gibt JWT zurück)
- `POST /auth/login` — Login mit Player-ID + Passwort (gibt JWT zurück)
 - `POST /auth/login` — Login mit Player-ID + Passwort (gibt JWT zurück)
 - `GET /auth/me` — Liefert den eingeloggten Spieler (JWT required)
- `GET /players/:id` — Spieler abrufen
- `POST /players/:id/position` — Position setzen
- `GET /spots` — alle permanenten Spots abfragen
- `POST /spots` — neuen permanenten Spot erstellen (ADMIN/CREATOR erforderlich; Authorization: Bearer token)
- `POST /spots/:id/logs` — manuelle Logs erstellen (JWT optional, token preferred)
- `POST /spots/:id/auto-log` — Auto-Logs (Cooldowns gelten; JWT optional)
- `GET /heatmap/:playerId` — Heatmap-Daten für einen Spieler (JWT required: only same player or ADMIN can access)
- `POST /tracking/start`, `POST /tracking/:id/point`, `POST /tracking/:id/stop` — Tracking/Route

Test UI und Beispiel-Scripts:
- Ein minimales Dev-UI ist unter `/public/index.html` verfügbar (einfacher Register/Log-Client)
- Ein kleiner Smoke-Test ist vorhanden unter `test/smoke.js` (führt Beispiel-API-Aufrufe aus)

Beispiel: Spieler registrieren mit Passwort & Login (JWT):

```bash
# register
curl -X POST http://localhost:5000/auth/register -H 'Content-Type: application/json' -d '{"displayName":"TestUser", "password":"secret"}'

# login (returns token)
curl -X POST http://localhost:5000/auth/login -H 'Content-Type: application/json' -d '{"id":"<player-id>", "password":"secret"}'

# use token to access heatmap
curl -H "Authorization: Bearer <token>" http://localhost:5000/heatmap/<player-id>
```

Persistenz:
- Der Dev-Server verwendet eine einfache Datei-basierte Persistenz (`data/store.json`). Für Produktion bitte eine richtige Datenbank einsetzen.

Falls gewünscht, kann ich nun:
- Die API weiter modularisieren (Model-Module, Router-Module, Controller-Layer)
- Authentifizierung hinzufügen (JWT oder Sessions)
- WebSocket-Livefeatures einbauen (position/live-players)

Sag mir, welche Prioritäten du möchtest, dann arbeite ich die nächsten Schritte ab.

### 2.1 Enums / Aufzählungstypen

```text
PlayerMode:
  - GUEST          // Offline, lokale Daten
  - LOGGED_IN      // Server-gebundener Account

PlayerRole:
  - PLAYER
  - ADMIN
  - CREATOR        // ggf. Sonderrolle, meist gleiche Rechte wie ADMIN beim Spot-Erstellen

LogType:
  - MANUAL         // Manuelles Loggen durch Klick auf Spot
  - AUTO           // Automatisches Loggen beim Vorbeigehen

TrackingState:
  - TRACKING_ON
  - TRACKING_OFF

RouteVisibilityState:
  - ROUTE_VISIBLE
  - ROUTE_HIDDEN

HeatmapState:
  - HEATMAP_ON
  - HEATMAP_OFF
```

---

## 3. Spielobjekte / Datenstrukturen

### 3.1 Spieler

```text
Player:
  id: PlayerId
  mode: PlayerMode         // GUEST oder LOGGED_IN
  role: PlayerRole         // PLAYER / ADMIN / CREATOR
  displayName?: string     // optional Name oder E-Mail
  color?: ColorDefinition  // individuelle Spielerfarbe

  stats: PlayerStats
  inventory: Inventory

PlayerStats:
  totalXP: int
  collectedLootSpotsCount: int
  level: int
  xpToNextLevel: int
```

Level-Berechnung:

```text
function calculateLevel(totalXP: int) -> (level: int, xpToNextLevel: int):
  level = 1 + floor(totalXP / 100)
  nextLevelThreshold = level * 100
  xpToNextLevel = max(0, nextLevelThreshold - totalXP)
  return (level, xpToNextLevel)
```

> Hinweis: `Player.stats.level` und `xpToNextLevel` können bei jeder XP-Änderung neu berechnet oder bei Ladevorgängen aktualisiert werden.

### 3.2 Inventar & Items

```text
Inventory:
  items: Map<ItemId, ItemStack>

ItemStack:
  itemId: ItemId
  name: string
  quantity: int
  description?: string
```

- Items werden typischerweise durch Loot-Spots vergeben.
- Die konkrete Bedeutung einzelner Items ist erweiterbar (Buffs, Boni, kosmetische Items etc.).

### 3.3 Lokale Loot-Spots („City-Loot“)

Lokale Loot-Spots existieren **nur** für die aktuelle Session bzw. lokal für den Spieler.

```text
LootSpot:
  id: string                 // lokal eindeutige ID
  position: Coordinate
  createdAt: Timestamp
  collectedAt?: Timestamp
  xpReward: int              // z. B. 10 XP
  itemReward?: ItemStack     // optionales Item
  isCollected: bool
```

### 3.4 Permanente Spots

```text
PermanentSpot:
  id: SpotId
  position: Coordinate
  name: string
  description?: string
  baseXP: int                // XP für manuelles Loggen
  autoXP: int                // XP für Auto-Log
  claimInfo: SpotClaimInfo   // aggregierte Claim-Daten
```

```text
SpotClaimInfo:
  totalClaimPoints: float
  perPlayerClaimPoints: Map<PlayerId, float>  // inkl. aktuellem Spieler

  // Hilfsfunktionen:
  function getPlayerClaimPoints(playerId: PlayerId) -> float
  function getPlayerClaimShare(playerId: PlayerId) -> float:
    if totalClaimPoints == 0: return 0
    return getPlayerClaimPoints(playerId) / totalClaimPoints
```

### 3.5 Claims / Gebietskontrolle

Die einzelnen Claim-Aktionen werden durch Logs (LogEntries) abgebildet.

```text
ClaimChange:
  playerId: PlayerId
  spotId: SpotId
  deltaClaimPoints: float    // positive Erhöhung
  timestamp: Timestamp
  sourceLogId: LogId         // Referenz zu zugehörigem Log
```

Claims können rein aggregiert im Backend gehalten werden (Summe aller ClaimChanges pro Spot & Spieler) oder als eigener Aggregat-Speicher.

### 3.6 Logs (Interaktionen mit Spots)

```text
LogEntry:
  id: LogId
  spotId: SpotId
  playerId: PlayerId
  type: LogType              // MANUAL oder AUTO
  distanceAtLog: Distance
  note?: string              // optionale Notiz (nur MANUAL)
  xpGained: int
  claimPointsGained: float
  createdAt: Timestamp
```

- Jeder Log erzeugt:
  - XP-Gewinn für den Spieler.
  - Claim-Punkte auf den Spot.
  - Einen Eintrag im Log-System (historische Nachverfolgung möglich).

### 3.7 Tracking, Route & Routenpunkte

```text
RoutePoint:
  position: Coordinate
  timestamp: Timestamp

Route:
  id: RouteId
  playerId: PlayerId
  points: List<RoutePoint>
  startedAt: Timestamp
  endedAt?: Timestamp
```

- Pro Session kann es eine aktive Route geben.
- Beim Deaktivieren des Trackings wird `endedAt` gesetzt; die Route bleibt als Historie bestehen (wenn persistiert).

### 3.8 Heatmap (eigene Claims)

Die Heatmap visualisiert den Einfluss des Spielers auf die Spots.

```text
HeatmapSpotContribution:
  spotId: SpotId
  position: Coordinate
  playerClaimPoints: float
  playerClaimShare: float    // Anteil in [0,1], aus SpotClaimInfo berechnet
```

- Die Visualisierung kann Intensität (z. B. Farbe, Helligkeit, Radius) basierend auf `playerClaimShare` und/oder `playerClaimPoints` berechnen.

### 3.9 Live-Spieler

```text
LivePlayerSnapshot:
  playerId: PlayerId
  displayName?: string
  position: Coordinate
  lastActivity: Timestamp
  color?: ColorDefinition
```

- Diese Daten werden in Intervallen vom Server geliefert und clientseitig angezeigt.

---

## 4. Session- und Spielzustand

Der **GameState** verwaltet den gesamten aktuellen Zustand aus Sicht eines Clients:

```text
GameState:
  sessionId: SessionId
  player: Player
  mode: PlayerMode                   // gespiegelt aus player.mode
  currentPosition?: Coordinate       // letztes gültiges GPS-Update
  lastGPSUpdateAt?: Timestamp

  // Kartenkontext
  mapViewportCenter?: Coordinate

  // Loot-Spots (lokal)
  localLootSpots: List<LootSpot>

  // Permanente Spots im aktuellen Umkreis
  loadedPermanentSpots: Map<SpotId, PermanentSpot>

  // Tracking & Route
  trackingState: TrackingState
  activeRoute?: Route
  routeVisibility: RouteVisibilityState

  // Heatmap
  heatmapState: HeatmapState
  heatmapData: List<HeatmapSpotContribution>

  // Live-Spieler
  livePlayers: List<LivePlayerSnapshot>

  // Cooldowns / Auto-Logs
  autoLogCooldowns: Map<SpotId, Timestamp>  // Zeitpunkt des letzten Auto-Logs pro Spot

  // UI-Zustände (logiknah)
  isInventoryOpen: bool
  isStatsOpen: bool
  isAdminPanelOpen: bool
  isSpotCreationModeOn: bool
```

---

## 5. Spielablauf & Zustandsübergänge

### 5.1 Spielstart & Initialisierung

**Event:** `onGameStart()`

1. Prüfen, ob ein eingeloggter Spieler vorhanden ist:
   - Wenn ja:
     - `PlayerMode = LOGGED_IN`.
     - Spielerprofil und Stats vom Server laden.
     - `GameState.player` initialisieren.
   - Wenn nein:
     - `PlayerMode = GUEST`.
     - Lokale, ggf. gespeicherte Daten laden (XP, Inventar, Loot-Zähler).
     - Falls keine Daten vorhanden, neuen Guest-Spieler mit zufälliger `PlayerId` erzeugen.

2. UI/HUD initialisieren:
   - Anzeige: Spielername (falls vorhanden), XP, Level, Loot-Zähler.

3. GPS-Listener aktivieren:
   - Auf erstes Positionsupdate warten (`onGPSUpdate()`).

### 5.2 GPS-Updates

**Event:** `onGPSUpdate(newPosition: Coordinate, timestamp: Timestamp)`

1. `GameState.currentPosition` und `lastGPSUpdateAt` aktualisieren.
2. Wenn es der erste GPS-Fix ist:
   - Karte auf `newPosition` fokussieren (`mapViewportCenter = newPosition`).
   - Lokale Loot-Spots generieren (`generateLocalLootSpotsAround(newPosition)`).
   - Permanente Spots im Umkreis laden (`loadPermanentSpotsAround(newPosition)`).
3. Karte folgt dem Spieler (abhängig von UI-Logik; z. B. Karte zentrieren oder nur bei Bedarf nachführen).
4. Weitere Logiken:
   - `tryCollectNearbyLootSpots()`
   - `tryCreateAutoLogsForNearbyPermanentSpots()`
   - `recordPositionIfTrackingIsOn()`
   - Optional: `sendCurrentPositionToServerIfLoggedIn()`

---

## 6. Lokale Loot-Spots (Mini-Spiel)

### 6.1 Generierung

```text
function generateLocalLootSpotsAround(center: Coordinate) -> List<LootSpot>:
  // z. B. 5 Spots in Radius 50–150 m
  for i in 1..N:
    randomAngle = random(0, 2π)
    randomRadius = random(50, 150)   // in Metern
    position = moveCoordinate(center, randomAngle, randomRadius)
    create LootSpot with:
      id = generateLocalId()
      position = position
      xpReward = 10
      itemReward = optionalItem()
      isCollected = false
  return list
```

Beim ersten GPS-Fix:

```text
GameState.localLootSpots = generateLocalLootSpotsAround(currentPosition)
```

### 6.2 Einsammeln

```text
function tryCollectNearbyLootSpots():
  if GameState.currentPosition == null: return

  for each lootSpot in GameState.localLootSpots where lootSpot.isCollected == false:
    dist = distanceBetween(GameState.currentPosition, lootSpot.position)

    if dist.meters <= LOOT_COLLECTION_RADIUS (z. B. 25 m):
      collectLootSpot(lootSpot, dist)
```

```text
function collectLootSpot(lootSpot: LootSpot, dist: Distance):
  lootSpot.isCollected = true
  lootSpot.collectedAt = now()

  // XP-Vergabe
  gainedXP = lootSpot.xpReward

  if GameState.mode == LOGGED_IN:
    // Anfrage an Backend:
    //   - lootSpot eingesammelt
    //   - XP erhöhen
    // Backend liefert neuen Player-Status (XP, Inventar etc.)
    updatedPlayer = backend.collectLootSpot(GameState.player.id, lootSpot)
    GameState.player = updatedPlayer
  else:
    // Lokale Anpassung
    GameState.player.stats.totalXP += gainedXP
    GameState.player.stats.collectedLootSpotsCount += 1
    addItemToInventory(GameState.player.inventory, lootSpot.itemReward)
    recalcPlayerLevelStats()

    // Lokalen Zustand persistent speichern (z. B. in Datei/LocalStorage)

  // Feedback an Spieler (HUD/Popup):
  showLootCollectedMessage(
    totalCollected = GameState.player.stats.collectedLootSpotsCount,
    currentXP = GameState.player.stats.totalXP,
    distance = dist
  )
```

---

## 7. Permanente Spots & Logging

### 7.1 Laden von Spots

```text
function loadPermanentSpotsAround(center: Coordinate):
  // typischerweise Server-Request:
  spots = backend.getPermanentSpotsInRadius(center, RADIUS)
  for each spot in spots:
    GameState.loadedPermanentSpots[spot.id] = spot
```

### 7.2 Manuelles Loggen

**Event:** `onPermanentSpotClicked(spotId: SpotId)`

```text
function onPermanentSpotClicked(spotId: SpotId):
  spot = GameState.loadedPermanentSpots[spotId]

  if GameState.mode == GUEST:
    showLoginHint("Manuelles Loggen ist nur für eingeloggte Spieler sinnvoll.")
    return

  // Distanz berechnen
  if GameState.currentPosition == null:
    dist = null
  else:
    dist = distanceBetween(GameState.currentPosition, spot.position)

  // UI: Eingabe optionaler Notiz anfordern
  note = askPlayerForOptionalLogNote()

  // Log erstellen
  performManualLog(spot, dist, note)
```

```text
function performManualLog(spot: PermanentSpot, dist: Distance?, note: string?):
  request = {
    playerId: GameState.player.id
    spotId: spot.id
    type: MANUAL
    distance: dist
    note: note
  }

  response = backend.createManualLog(request)

  // response enthält:
  // - xpGained
  // - claimPointsGained
  // - updatedPlayer
  // - updatedSpotClaimInfo

  GameState.player = response.updatedPlayer
  // Spot-ClaimInfo aktualisieren
  GameState.loadedPermanentSpots[spot.id].claimInfo = response.updatedSpotClaimInfo

  // Feedback:
  showLogResult(
    spotName = spot.name,
    xpGained = response.xpGained,
    distance = dist,
    playerClaimShare = response.updatedSpotClaimInfo.getPlayerClaimShare(GameState.player.id)
  )
```

### 7.3 Automatisches Loggen (Auto-Logs)

**Teil von `onGPSUpdate`:**

```text
function tryCreateAutoLogsForNearbyPermanentSpots():
  if GameState.mode == GUEST:
    return  // Auto-Logs nur für eingeloggte Spieler sinnvoll

  if GameState.currentPosition == null:
    return

  for each spot in GameState.loadedPermanentSpots:
    dist = distanceBetween(GameState.currentPosition, spot.position)

    if dist.meters <= AUTO_LOG_RADIUS (z. B. 10 m):
      if isAutoLogOnCooldown(spot.id):
        continue

      performAutoLog(spot, dist)
```

```text
function isAutoLogOnCooldown(spotId: SpotId) -> bool:
  lastAutoLogAt = GameState.autoLogCooldowns[spotId]
  if lastAutoLogAt == null:
    return false
  return now() - lastAutoLogAt < AUTO_LOG_COOLDOWN (z. B. 5 Minuten)
```

```text
function performAutoLog(spot: PermanentSpot, dist: Distance):
  request = {
    playerId: GameState.player.id
    spotId: spot.id
    type: AUTO
    distance: dist
  }

  response = backend.createAutoLog(request)

  GameState.player = response.updatedPlayer
  GameState.loadedPermanentSpots[spot.id].claimInfo = response.updatedSpotClaimInfo
  GameState.autoLogCooldowns[spot.id] = now()

  showLogResult(
    spotName = spot.name,
    xpGained = response.xpGained,
    distance = dist,
    playerClaimShare = response.updatedSpotClaimInfo.getPlayerClaimShare(GameState.player.id)
  )
```

---

## 8. Tracking, Route & Live-Spieler

### 8.1 Tracking ein/aus

**Event:** `onTrackingToggle()`

```text
function onTrackingToggle():
  if GameState.mode == GUEST:
    // optional: Hinweis, dass Tracking nur im eingeloggten Modus sinnvoll ist
    showInfo("Tracking ist nur für eingeloggte Spieler verfügbar.")
    return

  if GameState.trackingState == TRACKING_OFF:
    startTracking()
  else:
    stopTracking()
```

```text
function startTracking():
  GameState.trackingState = TRACKING_ON
  GameState.activeRoute = new Route(
    id = generateRouteId(),
    playerId = GameState.player.id,
    startedAt = now(),
    points = []
  )
```

```text
function stopTracking():
  GameState.trackingState = TRACKING_OFF
  if GameState.activeRoute != null:
    GameState.activeRoute.endedAt = now()
    // optional: Route an Backend senden und speichern
    backend.saveRoute(GameState.activeRoute)
```

### 8.2 Routenpunkte bei GPS-Updates

```text
function recordPositionIfTrackingIsOn():
  if GameState.trackingState != TRACKING_ON:
    return
  if GameState.currentPosition == null:
    return

  point = RoutePoint(
    position = GameState.currentPosition,
    timestamp = now()
  )
  GameState.activeRoute.points.append(point)

  // Optional: Routeposition an Backend senden für Live-Features
  backend.sendTrackingUpdate(GameState.player.id, point)
```

### 8.3 Routenanzeige

**Event:** `onRouteVisibilityToggle()`

```text
function onRouteVisibilityToggle():
  if GameState.routeVisibility == ROUTE_VISIBLE:
    GameState.routeVisibility = ROUTE_HIDDEN
  else:
    GameState.routeVisibility = ROUTE_VISIBLE

  // UI: Route-Layer auf Karte ein-/ausblenden
```

### 8.4 Live-Spieler

Regelmäßiger Timer oder Server-Push:

```text
function updateLivePlayers():
  if GameState.mode != LOGGED_IN:
    GameState.livePlayers = []
    return

  snapshots = backend.getLivePlayerSnapshots(around = GameState.currentPosition)
  GameState.livePlayers = snapshots
```

- UI: Für jeden `LivePlayerSnapshot` wird ein Marker auf der Karte angezeigt.

---

## 9. Heatmap der eigenen Claims

### 9.1 Aktivierung / Deaktivierung

**Event:** `onHeatmapToggle()`

```text
function onHeatmapToggle():
  if GameState.mode != LOGGED_IN:
    showInfo("Heatmap ist nur für eingeloggte Spieler verfügbar.")
    return

  if GameState.heatmapState == HEATMAP_OFF:
    enableHeatmap()
  else:
    disableHeatmap()
```

```text
function enableHeatmap():
  GameState.heatmapState = HEATMAP_ON
  GameState.heatmapData = backend.getPlayerHeatmapData(GameState.player.id)
  // UI: Heatmap-Layer darstellen (Intensität basierend auf claimShare/claimPoints)
```

```text
function disableHeatmap():
  GameState.heatmapState = HEATMAP_OFF
  // UI: Heatmap-Layer ausblenden
```

- `backend.getPlayerHeatmapData` liefert für alle Spots, an denen der Spieler Claim-Punkte hat, entsprechende Einträge.

---

## 10. Guest-/Offline-Mode vs. eingeloggter Mode

### 10.1 Guest-/Offline-Mode

- `PlayerMode = GUEST`
- Persistenz:
  - Lokale Speicherung von:
    - XP
    - Loot-Zähler
    - Inventar
  - Keine globalen Claims, Logs oder Heatmaps.
- Einschränkungen:
  - Kein manuelles Loggen permanenten Spots (oder nur mit stark eingeschränktem Nutzen).
  - Keine Auto-Logs.
  - Kein Tracking mit Server-Synchronisation.
  - Keine Live-Spieler und keine Heatmap.

### 10.2 Eingeloggter Mode

- `PlayerMode = LOGGED_IN`
- Persistenz:
  - Server ist **Source of Truth** für:
    - XP & Level
    - Inventar
    - Claims
    - Logs
    - Routen
- Features:
  - Volle Nutzung aller Funktionen:
    - Manuelles Loggen
    - Auto-Logs
    - Tracking & Route
    - Live-Spieler
    - Heatmap
    - Admin-/Creator-Funktionen (abhängig von Rolle)

---

## 11. Admin- / Creator-Funktionen

### 11.1 Spot-Erstellmodus

**Event:** `onSpotCreationModeToggle()`

```text
function onSpotCreationModeToggle():
  if GameState.player.role not in {ADMIN, CREATOR}:
    showInfo("Spot-Erstellung nur für Admins/Creator verfügbar.")
    return

  GameState.isSpotCreationModeOn = !GameState.isSpotCreationModeOn
```

### 11.2 Spot-Erstellung auf der Karte

**Event:** `onMapClickedForSpotCreation(position: Coordinate)`

```text
function onMapClickedForSpotCreation(position: Coordinate):
  if !GameState.isSpotCreationModeOn:
    return
  if GameState.player.role not in {ADMIN, CREATOR}:
    return

  // UI: Dialog öffnen zur Eingabe der Spot-Daten
  input = askAdminForSpotDetails(
    defaultBaseXP = 20,
    defaultAutoXP = 5
  )

  request = {
    creatorId: GameState.player.id
    position: position
    name: input.name
    description: input.description
    baseXP: input.baseXP
    autoXP: input.autoXP
  }

  newSpot = backend.createPermanentSpot(request)

  // Spot sofort lokal in die Karte einfügen
  GameState.loadedPermanentSpots[newSpot.id] = newSpot
```

### 11.3 Admin-Oberfläche

**Event:** `onAdminPanelToggle()`

```text
function onAdminPanelToggle():
  if GameState.player.role not in {ADMIN, CREATOR}:
    showInfo("Admin-Bereich nur für berechtigte Rollen zugänglich.")
    return

  GameState.isAdminPanelOpen = !GameState.isAdminPanelOpen
  // UI: Admin-Interface öffnen/schließen
```

Mögliche Funktionen im Admin-Panel (logisch):

- Liste aller Spots.
- Editieren von Name, Beschreibung, XP-Werten.
- Deaktivieren/Löschen von Spots.
- Einsicht in Claim-Verteilungen.

---

## 12. UI-Aktionen (logische Buttons / Menüs)

Alle UI-Elemente rufen **logische Events** auf, die den `GameState` verändern.

- **Home**:
  - `onHomeClicked()`: Wechselt zur Home-/Übersichtsansicht (kein direkter Einfluss auf Kernlogik).

- **Inventar**:
  - `onInventoryToggle()`:
    ```text
    GameState.isInventoryOpen = !GameState.isInventoryOpen
    ```
    - Bei Öffnen:
      - Wenn Daten noch nicht geladen (im Online-Modus), ggf. Backend-Abfrage.

- **Stats**:
  - `onStatsToggle()`:
    ```text
    // öffnet/schließt Stat-Overlay
    ```

- **Spots**:
  - `onSpotsViewClicked()`:
    - Karte so zoomen/zentrieren, dass alle `loadedPermanentSpots` sichtbar sind (Berechnung eines Bounding-Box-Viewports).

- **Heatmap**:
  - `onHeatmapToggle()`:
    - wie in Abschnitt 9 beschrieben.

- **Tracking**:
  - `onTrackingToggle()`:
    - wie in Abschnitt 8.1 beschrieben.

- **Route**:
  - `onRouteVisibilityToggle()`:
    - wie in Abschnitt 8.3 beschrieben.

- **Spot-Erstellung** (nur berechtigte Rollen):
  - `onSpotCreationModeToggle()`:
    - wie in Abschnitt 11.1 beschrieben.

- **Admin**:
  - `onAdminPanelToggle()`:
    - wie in Abschnitt 11.3 beschrieben.

---

## 13. Konsistenz & Spielmotivation

### 13.1 Konsistenzregeln

- **XP & Level**:
  - Jede Änderung von `totalXP` triggert eine Neuberechnung von `level` und `xpToNextLevel`.
- **Claims**:
  - Jeder Log erzeugt eine genau definierte Menge `claimPointsGained`.
  - `totalClaimPoints` eines Spots ist immer die Summe all seiner Claim-Punkte über alle Spieler.
- **Heatmap**:
  - Heatmap-Daten basieren auf denselben Claim-Daten wie die Spot-Anzeige.
  - Kein separater, widersprüchlicher Speicher.

### 13.2 Motivation / Feedback-Schleifen

- **Kurzfristige Belohnung**:
  - Einsammeln von Loot-Spots (XP + Items).
  - Sofortiges Feedback nach Logs (XP, Distanz, Claim-Anteil).
- **Mittelfristige Ziele**:
  - Level-Aufstieg durch stetiges Sammeln von XP.
  - Ausbau des eigenen Inventars.
- **Langfristige Ziele**:
  - Aufbau der eigenen Claim-Heatmap.
  - Kontrolle über viele Spots in der Region.
  - Wettbewerb mit anderen Spielern um Claim-Anteile.

---

## 14. Übertragbarkeit auf technische Plattformen

Die hier beschriebenen Strukturen und Abläufe sind so modelliert, dass sie unabhängig von:

- Konkreten Kartenbibliotheken (z. B. Leaflet, Google Maps, Mapbox, OpenLayers).
- Rahmenwerken (z. B. Unity, Unreal, React Native, Flutter).
- Backend-Technologien (z. B. REST, GraphQL, WebSockets, gRPC).

umsetzbar sind.

Die Kernidee ist:

- **GameState** als zentrale Datenstruktur.
- **Events** (GPS-Updates, Klicks, Button-Aktionen) führen zu klar definierten **State-Transitionen**.
- Persistenz- und Netzwerkschichten sind austauschbar, solange sie die hier beschriebenen Daten- und Funktionsverträge erfüllen.
