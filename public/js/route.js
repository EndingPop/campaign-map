// Route geometry. Each stop may carry `path`: the bend points the DM clicked
// along the road from the previous stop. The drawn route passes through
// every stop and bend point, smoothed with a centripetal Catmull-Rom curve
// so a few clicks follow a winding road without sharp corners.

// All points of the route, in order: stop 1, bends into stop 2, stop 2, ...
export function routePoints(stops) {
  const pts = [];
  stops.forEach((s, i) => {
    if (i > 0 && Array.isArray(s.path)) for (const p of s.path) pts.push({ x: p.x, y: p.y });
    pts.push({ x: s.x, y: s.y });
  });
  return pts;
}

// The travel mode id of the leg into a stop (stops saved before travel
// modes existed have none, and count as 'road').
export const modeIdOf = (stop) => stop.travel || 'road';

// Splits the route into drawable pieces. `lineOf(modeId)` says how a mode is
// drawn: 'path' legs follow their bend points and consecutive legs of the
// same mode are smoothed as one run; 'arc' legs (teleports, say) are a
// separate curve straight from the previous stop, so road curves never bend
// toward them.
//   { kind: 'path', mode, points: [...] }  smooth these
//   { kind: 'arc', mode, from, to }        draw as an arc
export function routeSegments(stops, lineOf = (m) => (m === 'teleport' ? 'arc' : 'path')) {
  const segs = [];
  let run = [];
  let runMode = null;
  const closeRun = () => { if (run.length > 1) segs.push({ kind: 'path', mode: runMode, points: run }); };
  stops.forEach((s, i) => {
    const here = { x: s.x, y: s.y };
    if (i === 0) { run = [here]; runMode = null; return; }
    const mode = modeIdOf(s);
    const prev = { x: stops[i - 1].x, y: stops[i - 1].y };
    if (lineOf(mode) === 'arc') {
      closeRun();
      segs.push({ kind: 'arc', mode, from: prev, to: here });
      run = [here]; runMode = null;
      return;
    }
    if (runMode !== null && runMode !== mode) { closeRun(); run = [prev]; }
    runMode = mode;
    if (Array.isArray(s.path)) for (const p of s.path) run.push({ x: p.x, y: p.y });
    run.push(here);
  });
  closeRun();
  return segs;
}

// The points of the leg into stop i as drawn: an arc, or the smoothed path.
export function legPoints(stops, i, line = 'path') {
  const prev = stops[i - 1];
  const s = stops[i];
  if (line === 'arc') return arcPoints(prev, s);
  return smoothPath([{ x: prev.x, y: prev.y }, ...(Array.isArray(s.path) ? s.path : []), { x: s.x, y: s.y }]);
}

// A gentle arc from a to b (quadratic curve bowed to one side by `bulge`
// times the distance), so a teleport reads differently from a road.
export function arcPoints(a, b, bulge = 0.15, steps = 24) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const c = { x: (a.x + b.x) / 2 - dy * bulge, y: (a.y + b.y) / 2 + dx * bulge };
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
  }
  return out;
}

// Length of a polyline in map pixels.
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

// Pixel length of the leg into stop i: along the drawn (smoothed) road for
// 'path' legs, straight across for 'arc' legs. The first stop has no leg.
// Whether a leg counts toward travel time is the travel mode's business.
export function legPixels(stops, i, line = 'path') {
  if (i < 1) return 0;
  const prev = stops[i - 1];
  if (line === 'arc') return Math.hypot(stops[i].x - prev.x, stops[i].y - prev.y);
  const pts = [{ x: prev.x, y: prev.y }, ...(Array.isArray(stops[i].path) ? stops[i].path : []), { x: stops[i].x, y: stops[i].y }];
  return pathLength(smoothPath(pts));
}

// Centripetal Catmull-Rom (alpha 0.5) through every input point; it does not
// overshoot or loop at sharp turns. `steps` samples per segment.
export function smoothPath(points, steps = 10) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  const ext = [points[0], ...points, points[points.length - 1]];
  const tj = (ti, a, b) => ti + Math.max(Math.hypot(b.x - a.x, b.y - a.y) ** 0.5, 1e-4);
  for (let i = 1; i < ext.length - 2; i++) {
    const [p0, p1, p2, p3] = [ext[i - 1], ext[i], ext[i + 1], ext[i + 2]];
    if (p1.x === p2.x && p1.y === p2.y) continue;
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let s = 1; s <= steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const lerp = (a, b, ta, tb) => ({
        x: ((tb - t) / (tb - ta)) * a.x + ((t - ta) / (tb - ta)) * b.x,
        y: ((tb - t) / (tb - ta)) * a.y + ((t - ta) / (tb - ta)) * b.y,
      });
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}
