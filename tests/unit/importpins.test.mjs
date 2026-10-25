// CSV parsing and pin import planning. Run with `npm run test:unit`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, readPinRows, planPinImport } from '../../public/js/importpins.js';

const pinTypes = [
  { id: 'city', label: 'Town/City', kind: 'base' },
  { id: 'notable', label: 'Notable location', kind: 'base' },
  { id: 'faction', label: "Lords' Alliance", kind: 'ring' },
];
const size = { width: 2576, height: 1667 };
const plan = (csv, pins = [], options) => planPinImport(readPinRows(csv), { pins, pinTypes, size }, options);

test('quoted fields keep commas, quotes and line breaks', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n');
  assert.deepEqual(rows[1].cells, ['x, y', 'say "hi"\nthere']);
  assert.equal(rows.length, 2);
  assert.throws(() => parseCsv('a\n"open'), /never closed/);
});

test('rows report the line they start on', () => {
  const r = readPinRows('name,x,y,description\nA,1,2,"two\nlines"\nB,3,4,\n');
  assert.deepEqual(r.map((x) => x.line), [2, 4]);
});

test('missing required columns are refused', () => {
  assert.throws(() => readPinRows('name,x\nA,1\n'), /"y"/);
});

test('types and rings match by id or label, ignoring case; extra columns are ignored', () => {
  const p = plan('name,x,y,type,rings,category\nA,10,20,town/city,lords\' alliance,forest\nB,1,1,NOTABLE,faction,\n');
  assert.equal(p.add.length, 2);
  assert.deepEqual(p.add[0].data, { name: 'A', x: 10, y: 20, baseType: 'city', rings: ['faction'], visibility: 'hidden', description: '' });
  assert.equal(p.add[1].data.baseType, 'notable');
});

test('new pins default to hidden and the first base type', () => {
  const p = plan('name,x,y\nA,5,5\n');
  assert.equal(p.add[0].data.visibility, 'hidden');
  assert.equal(p.add[0].data.baseType, 'city');
});

test('bad rows become errors with their line numbers', () => {
  const p = plan('name,x,y,rings,visibility\n,1,1,,\nB,abc,1,,\nC,9999,1,,\nD,1,1,nope,\nE,1,1,,secret\nF,1,1,,\nf,2,2,,\n');
  assert.deepEqual(p.errors.map((e) => e.line), [2, 3, 4, 5, 6, 8]);
  assert.match(p.errors[5].message, /same name as line 7/);
  assert.equal(p.add.length, 1);
});

test('unknown types are listed, then mapped', () => {
  const csv = 'name,x,y,type\nA,1,1,Landmark\nB,1,1,landmark\nC,1,1,city\n';
  const first = plan(csv);
  assert.deepEqual(first.unknownTypes, ['Landmark', 'landmark']);
  assert.equal(first.add.length, 1);
  const second = plan(csv, [], { typeMap: { Landmark: 'notable', landmark: 'notable' } });
  assert.deepEqual(second.unknownTypes, []);
  assert.equal(second.add.length, 3);
});

test('name matches are skipped by default, or updated', () => {
  const pins = [{ id: 'p1', name: 'Waterdeep', x: 0, y: 0, baseType: 'notable', rings: ['faction'], visibility: 'public', description: 'Old' }];
  const csv = 'name,x,y,type\nwaterdeep,100,200,city\n';
  assert.deepEqual(plan(csv, pins).skip, [{ line: 2, name: 'waterdeep', id: 'p1' }]);
  const up = plan(csv, pins, { onMatch: 'update' }).update[0];
  assert.equal(up.id, 'p1');
  assert.deepEqual(up.data, { name: 'Waterdeep', x: 100, y: 200, baseType: 'city', rings: ['faction'], visibility: 'public', description: 'Old' });
});
