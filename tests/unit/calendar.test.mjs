// Calendar math. Run with `npm run test:unit` (no emulator needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CALENDAR_PRESETS, yearLength, addDays, dayNumber, formatDate, isValidDate, weekdayName, periodsToText, textToPeriods,
} from '../../public/js/calendar.js';

const { harptos: H, greyhawk: G, golarion: P, eberron: E } = CALENDAR_PRESETS;

test('year lengths, with leap years', () => {
  assert.equal(yearLength(H, 1491), 365);
  assert.equal(yearLength(H, 1492), 366); // Shieldmeet year
  assert.equal(yearLength(G, 576), 364);
  assert.equal(yearLength(P, 4724), 366);
  assert.equal(yearLength(P, 4725), 365);
  assert.equal(yearLength(E, 998), 336);
});

test('Shieldmeet follows Midsummer only in leap years', () => {
  const mid = (year) => ({ year, period: 9, day: 1 });
  assert.equal(formatDate(H, addDays(H, mid(1492), 1)), 'Shieldmeet 1492 DR');
  assert.equal(formatDate(H, addDays(H, mid(1492), 2)), '1 Eleasis 1492 DR');
  assert.equal(formatDate(H, addDays(H, mid(1491), 1)), '1 Eleasis 1491 DR');
  assert.equal(isValidDate(H, { year: 1491, period: 10, day: 1 }), false);
});

test('year boundaries and round trips', () => {
  assert.equal(formatDate(H, addDays(H, { year: 1491, period: 17, day: 30 }, 1)), '1 Hammer 1492 DR');
  assert.equal(formatDate(H, addDays(H, { year: 1492, period: 0, day: 1 }, -1)), '30 Nightal 1491 DR');
  const start = { year: 1491, period: 0, day: 1 };
  assert.equal(dayNumber(H, { year: 1493, period: 0, day: 1 }) - dayNumber(H, start), 365 + 366);
  for (const n of [1, 29, 30, 365, 1000, -1000]) assert.deepEqual(addDays(H, addDays(H, start, n), -n), start);
});

test('leap day in a month (Golarion) and multi-day festivals (Greyhawk)', () => {
  assert.equal(formatDate(P, addDays(P, { year: 4724, period: 1, day: 28 }, 1)), '29 Calistril 4724 AR');
  assert.equal(formatDate(P, addDays(P, { year: 4725, period: 1, day: 28 }, 1)), '1 Pharast 4725 AR');
  assert.equal(formatDate(G, { year: 576, period: 0, day: 3 }), '3 Needfest 576 CY');
  assert.equal(formatDate(H, { year: 1491, period: 1, day: 1 }), 'Midwinter 1491 DR');
});

test('weekdays need an anchor date', () => {
  assert.equal(weekdayName(G, { year: 576, period: 1, day: 1 }), '');
  const anchored = { ...G, week: { ...G.week, anchor: { year: 576, period: 0, day: 1, weekday: 0 } } };
  assert.equal(weekdayName(anchored, { year: 576, period: 1, day: 1 }), 'Starday'); // 7 festival days later
  assert.equal(weekdayName(anchored, { year: 577, period: 0, day: 1 }), 'Starday'); // 364 = 52 weeks
});

test('calendar text round trip and errors', () => {
  const again = textToPeriods(periodsToText(H));
  assert.equal(again.length, H.periods.length);
  assert.deepEqual(again.find((p) => p.name === 'Shieldmeet'), { name: 'Shieldmeet', days: 0, festival: true, leapDays: 1 });
  assert.throws(() => textToPeriods('Hammer'), /Line 1/);
  assert.throws(() => textToPeriods(''), /at least one month/);
});
