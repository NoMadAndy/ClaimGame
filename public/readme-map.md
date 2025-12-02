# Map Dev UI

This page demonstrates a simple Leaflet integration for the ClaimGame dev server.

- `map.html` shows a map with permanent spots (from `/spots`), a player-created heatmap from `/heatmap/:id`, and live players via `/livePlayers`.
- Use the Register button to create a local test player and interact with the map (manual/auto logs, spot creation for admin roles).

Notes:
- Heatmap is by player only and uses per-spot `playerClaimShare` values to compute intensity.
- This is a development example — production-ready frontends will need real auth and map optimization.

To run:

```bash
cd /workspaces/ClaimGame
npm start
# open http://localhost:5000/map.html
```
