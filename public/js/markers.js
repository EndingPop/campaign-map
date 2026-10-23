// SVG marker drawing. A pin is one base shape (fill color + shape from its
// base type) plus zero or more concentric rings (one per ring type), inner
// to outer by ringOrder.

const CORE = 7;      // base shape radius in px
const RING_W = 3.5;  // ring stroke width
const RING_GAP = 1.5; // gap between rings (room for each ring's edge)
const EDGE = 0.75;   // ring edge width on each side

function shapePath(shape, r) {
  switch (shape) {
    case 'diamond': { const d = r * 1.25; return `<polygon points="0,${-d} ${d},0 0,${d} ${-d},0"/>`; }
    case 'square': { const s = r * 0.9; return `<rect x="${-s}" y="${-s}" width="${2 * s}" height="${2 * s}" rx="1.5"/>`; }
    case 'triangle': { const t = r * 1.25; return `<polygon points="0,${-t} ${t * 0.95},${t * 0.7} ${-t * 0.95},${t * 0.7}"/>`; }
    default: return `<circle r="${r}"/>`;
  }
}

const safeColor = (c) => (/^#[0-9a-f]{3,8}$|^[a-z]+$/i.test(c || '') ? c : '#777');

// Relative luminance (WCAG 2) of a #rgb or #rrggbb color; null for anything else.
function luminance(c) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c || '');
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (x) => x + x);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const DARK_EDGE = '#1f2a36';
const LIGHT_EDGE = '#ffffff';
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
// The edge drawn around a ring: white or dark, whichever contrasts more with
// the ring's own color, so any ring reads on parchment, forest and water.
export function ringEdge(color) {
  const l = luminance(color);
  if (l == null) return DARK_EDGE;
  return contrast(l, 1) >= contrast(l, luminance(DARK_EDGE)) ? LIGHT_EDGE : DARK_EDGE;
}
const ringCircle = (r, color, width) =>
  `<circle r="${r}" fill="none" stroke="${ringEdge(safeColor(color))}" stroke-width="${width + 2 * EDGE}"/>`
  + `<circle r="${r}" fill="none" stroke="${safeColor(color)}" stroke-width="${width}"/>`;

// baseType / ringTypes are pinType objects (ringTypes already sorted).
export function pinSvg(baseType, ringTypes, { hidden = false, selected = false } = {}) {
  const ringRadius = (i) => CORE + 2 + RING_GAP + RING_W / 2 + i * (RING_W + RING_GAP);
  const outer = ringTypes.length ? ringRadius(ringTypes.length - 1) + RING_W / 2 + EDGE : CORE + 2;
  const half = Math.ceil(outer + (selected ? 6 : 2));
  const size = half * 2;
  const rings = ringTypes.map((t, i) => ringCircle(ringRadius(i), t.color, RING_W)).join('');
  const base = `<g fill="${safeColor(baseType?.color)}" stroke="#fff" stroke-width="1.5">${shapePath(baseType?.shape, CORE)}</g>`;
  const halo = selected ? `<circle r="${outer + 3.5}" fill="none" stroke="#c9a227" stroke-width="2.5"/>` : '';
  const dash = hidden ? `<circle r="${outer + 1.5}" fill="none" stroke="#1f2a36" stroke-width="1.2" stroke-dasharray="3 2"/>` : '';
  return {
    size,
    html: `<svg width="${size}" height="${size}" viewBox="${-half} ${-half} ${size} ${size}" style="opacity:${hidden ? 0.55 : 1}" aria-hidden="true">${halo}${rings}${base}${dash}</svg>`,
  };
}

// Small legend swatch for a pin type in the filter list.
export function typeSwatch(type) {
  if (type.kind === 'ring') {
    return `<svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true">${ringCircle(7, type.color, 3.5)}</svg>`;
  }
  return `<svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true"><g fill="${safeColor(type.color)}" stroke="#fff" stroke-width="1.5">${shapePath(type.shape, 7)}</g></svg>`;
}

// The party's current position: brass disc with a slow pulse.
export const PARTY_SIZE = 48;
export const partySvg = `<svg width="48" height="48" viewBox="-24 -24 48 48" aria-hidden="true">
  <circle class="party-pulse" r="10" fill="none" stroke="#c9a227" stroke-width="3"/>
  <circle r="9" fill="#c9a227" stroke="#1f2a36" stroke-width="2.5"/>
  <path d="M0,-5 L1.6,-1.6 L5,0 L1.6,1.6 L0,5 L-1.6,1.6 L-5,0 L-1.6,-1.6Z" fill="#1f2a36"/>
</svg>`;
