// Backup checking and restore planning. Run with `npm run test:unit`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBackup, planRestore, summarize } from '../../public/js/restore.js';

const base = { exportedAt: '2026-10-13T00:00:00Z', pins: [{ id: 'p1', name: 'A', notes: [] }], waypoints: [], pinTypes: [], members: [] };
const current = {
  ...base,
  npcs: [{ id: 'n1', notes: [{ id: 'k1' }] }], npcSecrets: [{ id: 'n1' }], affiliations: [{ id: 'a1' }], travelModes: [{ id: 'road' }],
  sessions: [{ id: '2026-10-11', notes: [{ id: 'r1' }] }], sessionSecrets: [{ id: '2026-10-11' }],
  plans: [{ id: 'pl1' }], dmPlans: [{ id: 'd1' }], handouts: [{ id: 'h1' }], images: [{ id: 'i1' }],
};
const NEW = ['npcs', 'npcSecrets', 'affiliations', 'travelModes', 'sessions', 'sessionSecrets', 'plans', 'dmPlans', 'handouts', 'images'];

test('a 1.0 backup leaves newer collections alone', () => {
  const ops = planRestore(parseBackup(JSON.stringify(base)), current);
  assert.equal(ops.filter((o) => NEW.includes(o.path[0])).length, 0);
  assert.equal(summarize(base).sessions, null);
});

test('a backup with empty lists empties them, notes included', () => {
  const empty = Object.fromEntries(NEW.map((k) => [k, []]));
  const ops = planRestore(parseBackup(JSON.stringify({ ...base, ...empty })), current).map((o) => `${o.op} ${o.path.join('/')}`);
  for (const p of ['npcs/n1/notes/k1', 'npcs/n1', 'sessions/2026-10-11/notes/r1', 'sessions/2026-10-11', 'sessionSecrets/2026-10-11',
    'plans/pl1', 'dmPlans/d1', 'handouts/h1', 'images/i1']) assert.ok(ops.includes(`delete ${p}`), p);
});

test('restores sessions with their notes, and images before handouts', () => {
  const bk = { ...base, sessions: [{ id: '2026-10-18', title: 'Two', notes: [{ id: 'r2', text: 'x' }] }], images: [{ id: 'i2', data: 'd' }], handouts: [{ id: 'h2', imageId: 'i2' }] };
  const ops = planRestore(parseBackup(JSON.stringify(bk)), { ...base });
  const paths = ops.map((o) => o.path.join('/'));
  assert.ok(paths.includes('sessions/2026-10-18'));
  assert.ok(paths.includes('sessions/2026-10-18/notes/r2'));
  assert.ok(paths.indexOf('images/i2') < paths.indexOf('handouts/h2'));
  assert.equal(ops.find((o) => o.path.join('/') === 'sessions/2026-10-18').data.notes, undefined);
});

test('rejects malformed new lists', () => {
  assert.throws(() => parseBackup(JSON.stringify({ ...base, plans: {} })), /plans/);
  assert.throws(() => parseBackup(JSON.stringify({ ...base, sessions: [{ id: 's', notes: [{}] }] })), /note without an id/);
});
