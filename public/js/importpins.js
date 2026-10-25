// Pin import from CSV: parsing and planning, kept free of the DOM and the
// database so they can be unit tested (tests/unit/importpins.test.mjs).
//
// CSV columns (header row required, any order, extra columns ignored):
//   name, x, y        required; x and y on the map's coordinate grid
//   type              base pin type, by id or label (case-insensitive)
//   rings             ring pin types, by id or label, separated by ";"
//   description       optional text
//   visibility        "hidden" (default) or "public"

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
// Returns rows as arrays of strings, each with the line it started on.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push({ line: rowLine, cells: row });
      row = [];
      line++;
      rowLine = line;
    } else field += c;
  }
  if (quoted) throw new Error(`Line ${rowLine}: a quoted field is never closed.`);
  if (field !== '' || row.length) { row.push(field); rows.push({ line: rowLine, cells: row }); }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

// Header names to records: [{ line, name, x, y, type, rings, description, visibility }].
export function readPinRows(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The file is empty.');
  const header = rows[0].cells.map((c) => c.trim().toLowerCase());
  for (const need of ['name', 'x', 'y']) {
    if (!header.includes(need)) throw new Error(`The first line must name the columns, including "${need}". It reads: ${rows[0].cells.join(', ')}`);
  }
  const col = (cells, name) => { const i = header.indexOf(name); return i < 0 ? '' : (cells[i] ?? '').trim(); };
  return rows.slice(1).map(({ line, cells }) => ({
    line,
    name: col(cells, 'name'),
    x: col(cells, 'x'),
    y: col(cells, 'y'),
    type: col(cells, 'type'),
    rings: col(cells, 'rings'),
    description: col(cells, 'description'),
    visibility: col(cells, 'visibility'),
  }));
}

const norm = (s) => String(s || '').trim().toLowerCase();

// Plans the import. Nothing is written here.
//   rows       from readPinRows
//   pins       existing pins [{ id, name, ... }]
//   pinTypes   [{ id, label, kind: 'base' | 'ring' }]
//   size       { width, height } of the coordinate grid
//   options    { onMatch: 'skip' | 'update', typeMap: { [unknown type value]: base type id } }
// Rows match existing pins by name, ignoring case.
// Returns { add, update, skip, errors, unknownTypes }:
//   add / update: [{ line, id?, data }] with data = { name, x, y, baseType, rings, visibility, description }
//   skip: [{ line, name, id }] rows matching an existing pin, left alone
//   errors: [{ line, message }]
//   unknownTypes: type values that match no base type and have no entry in typeMap
export function planPinImport(rows, { pins, pinTypes, size }, { onMatch = 'skip', typeMap = {} } = {}) {
  const bases = pinTypes.filter((t) => t.kind === 'base');
  const rings = pinTypes.filter((t) => t.kind === 'ring');
  const find = (list, v) => list.find((t) => norm(t.id) === norm(v) || norm(t.label) === norm(v));
  const byName = new Map();
  for (const p of pins) if (!byName.has(norm(p.name))) byName.set(norm(p.name), p);
  const seen = new Map();
  const out = { add: [], update: [], skip: [], errors: [], unknownTypes: [] };
  const unknown = new Set();
  const defaultBase = bases[0]?.id;

  for (const r of rows) {
    const fail = (message) => out.errors.push({ line: r.line, message: `${r.name ? `"${r.name}": ` : ''}${message}` });
    if (!r.name) { fail('no name.'); continue; }
    if (r.name.length > 100) { fail('name longer than 100 characters.'); continue; }
    const x = Number(r.x);
    const y = Number(r.y);
    if (r.x === '' || r.y === '' || !Number.isFinite(x) || !Number.isFinite(y)) { fail('x and y must be numbers.'); continue; }
    if (x < 0 || y < 0 || x > size.width || y > size.height) { fail(`(${x}, ${y}) is outside the map (0 to ${size.width} across, 0 to ${size.height} down).`); continue; }
    let baseType;
    if (!r.type) baseType = defaultBase;
    else if (find(bases, r.type)) baseType = find(bases, r.type).id;
    else if (typeMap[r.type] && bases.some((b) => b.id === typeMap[r.type])) baseType = typeMap[r.type];
    else { unknown.add(r.type); continue; }
    if (!baseType) { fail('there are no base pin types to use.'); continue; }
    const ringIds = [];
    let badRing = null;
    for (const v of r.rings.split(';').map((s) => s.trim()).filter(Boolean)) {
      const t = find(rings, v);
      if (!t) { badRing = v; break; }
      if (!ringIds.includes(t.id)) ringIds.push(t.id);
    }
    if (badRing) { fail(`unknown ring type "${badRing}".`); continue; }
    const vis = norm(r.visibility) || 'hidden';
    if (!['hidden', 'public'].includes(vis)) { fail(`visibility must be "hidden" or "public", not "${r.visibility}".`); continue; }
    if (r.description.length > 5000) { fail('description longer than 5000 characters.'); continue; }
    const key = norm(r.name);
    if (seen.has(key)) { fail(`same name as line ${seen.get(key)}.`); continue; }
    seen.set(key, r.line);
    const data = { name: r.name, x: Math.round(x), y: Math.round(y), baseType, rings: ringIds, visibility: vis, description: r.description };
    const match = byName.get(key);
    if (!match) out.add.push({ line: r.line, data });
    // An update moves the pin and sets its type; rings, description and
    // visibility change only where the row fills them in.
    else if (onMatch === 'update') {
      out.update.push({ line: r.line, id: match.id, data: {
        name: match.name, x: data.x, y: data.y, baseType,
        rings: r.rings ? ringIds : match.rings || [],
        visibility: r.visibility ? vis : match.visibility || 'hidden',
        description: r.description || match.description || '',
      } });
    }
    else out.skip.push({ line: r.line, name: r.name, id: match.id });
  }
  out.unknownTypes = [...unknown];
  return out;
}
