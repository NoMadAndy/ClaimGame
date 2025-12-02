// Simple smoke test using built-in fetch (Node 18+)
(async ()=>{
  try {
    const base = 'http://localhost:5000';
    console.log('Ping health');
    let r = await fetch(base + '/health');
    console.log(await r.json());
    console.log('Register player');
      r = await fetch(base + '/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ displayName: 'SmokePlayer', role: 'PLAYER', password: 'smokePass' }) });
      const body = await r.json();
    console.log(body);
    const player = body.player;
      const token = body.token;
    console.log('List spots');
    r = await fetch(base + '/spots');
    const spots = await r.json();
    console.log('Spots length', spots.length);
    if (spots.length>0) {
      const spot = spots[0];
      console.log('Manual log to spot', spot.id);
      r = await fetch(base + `/spots/${spot.id}/logs`, { method: 'POST', headers: {'Content-Type':'application/json', 'Authorization': 'Bearer ' + token}, body: JSON.stringify({ playerId: player.id, distance: 5, note: 'smoke' }) });
      console.log(await r.json());
    }
    // test admin login and create spot
    console.log('Login admin');
    r = await fetch(base + '/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: 'player-admin', password: 'admin' }) });
    const admin = await r.json();
    console.log('Admin login', admin);
    if (admin.token) {
      console.log('Create spot as admin');
      r = await fetch(base + '/spots', { method: 'POST', headers: {'Content-Type':'application/json', 'Authorization': 'Bearer ' + admin.token}, body: JSON.stringify({ creatorId: admin.player.id, position: { latitude: 52.521, longitude: 13.405 }, name: 'SmokeAdminSpot' }) });
      console.log(await r.json());
    }
    console.log('Smoke test complete');
  } catch (e) { console.error('Smoke error', e); process.exit(1); }
})();
