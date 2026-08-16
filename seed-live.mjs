// Local fixture: three games in progress, each exercising a different state.
import { createStore } from './lib/store.js';
import { sync } from './lib/sync.js';

const s = createStore({ backend: 'sqlite', path: './dev.db' });
await s.migrate();

const teams = [
  { id: 1, name: 'Colony', abbreviation: 'COL', division: 'Open', country: 'Australia', seed: 1 },
  { id: 2, name: 'Aethers Warsaw', abbreviation: 'AEW', division: 'Open', country: 'Poland', seed: 44 },
  { id: 3, name: 'Scandal', abbreviation: 'SCD', division: "Women's", country: 'USA', seed: 2 },
  { id: 4, name: 'Spice', abbreviation: 'SPC', division: "Women's", country: 'Japan', seed: 19 },
  { id: 5, name: 'PELT', abbreviation: 'PELT', division: 'Mixed', country: 'Ireland', seed: 40 },
  { id: 6, name: 'Chilli Heat', abbreviation: 'CHL', division: 'Mixed', country: 'South Africa', seed: 41 },
];

const mk = (id, h, a, hs, as, div, secsAgo, elapsedMin) => ({
  id, homeTeamId: h, awayTeamId: a, division: div, poolName: 'Pool A', poolId: 9,
  startsAt: new Date(Date.now() - elapsedMin * 60000).toISOString(),
  status: 'live', ongoing: true,
  homeScore: hs, awayScore: as, valid: true, homeLabel: null, awayLabel: null,
  lastEventNum: hs + as,
  lastEventAt: new Date(Date.now() - secsAgo * 1000).toISOString(),
  timerStart: Math.floor((Date.now() - elapsedMin * 60000) / 1000),
  timeCap: 100,
});

const games = [
  mk(1, 1, 2, 4, 11, 'Open', 70, 40),       // top seed in deep trouble
  mk(2, 3, 4, 8, 9, "Women's", 6, 45),      // tight, point just scored -> suspended
  mk(3, 5, 6, 13, 12, 'Mixed', 80, 105),    // past the time cap
];

const res = await sync(s, {
  force: true,
  fetcher: async () => ({
    heartbeat: { cacheVersion: 'dev' },
    teams,
    fieldSizes: { Open: 48, "Women's": 40, Mixed: 48 },
    games,
  }),
});

console.log('created:', res.games.created, ' livePoints:', res.livePoints);
console.log(JSON.stringify(
  await s.query('SELECT id,live_home_score,live_away_score,time_cap FROM games')));
s.close();
