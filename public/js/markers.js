// SVG marker drawing. A pin is one base shape (fill color + shape from its
// base type) plus zero or more concentric rings (one per ring type), inner
// to outer by ringOrder.

const CORE = 7;      // base shape radius in px
const RING_W = 3.5;  // ring stroke width
const RING_GAP = 1;  // gap between rings

function shapePath(shape, r) {
  switch (shape) {
    case 'diamond': { const d = r * 1.25; return `<polygon points="0,${-d} ${d},0 0,${d} ${-d},0"/>`; }
    case 'square': { const s = r * 0.9; return `<rect x="${-s}" y="${-s}" width="${2 * s}" height="${2 * s}" rx="1.5"/>`; }
    case 'triangle': { const t = r * 1.25; return `<polygon points="0,${-t} ${t * 0.95},${t * 0.7} ${-t * 0.95},${t * 0.7}"/>`; }
    default: return `<circle r="${r}"/>`;
  }
}

const safeColor = (c) => (/^#[0-9a-f]{3,8}$|^[a-z]+$/i.test(c || '') ? c : '#777');

// baseType / ringTypes are pinType objects (ringTypes already sorted).
export function pinSvg(baseType, ringTypes, { hidden = false, selected = false } = {}) {
  const ringRadius = (i) => CORE + 2 + RING_GAP + RING_W / 2 + i * (RING_W + RING_GAP);
  const outer = ringTypes.length ? ringRadius(ringTypes.length - 1) + RING_W / 2 : CORE + 2;
  const half = Math.ceil(outer + (selected ? 6 : 2));
  const size = half * 2;
  const rings = ringTypes.map((t, i) =>
    `<circle r="${ringRadius(i)}" fill="none" stroke="${safeColor(t.color)}" stroke-width="${RING_W}"/>`).join('');
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
    return `<svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true"><circle r="7" fill="none" stroke="${safeColor(type.color)}" stroke-width="3.5"/></svg>`;
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
