// In-game calendars. A calendar is data, so one set of functions handles
// the Forgotten Realms, Greyhawk, Golarion, Eberron and homebrew calendars:
//
//   { name, yearSuffix,
//     periods: [{ name, days, festival?, leapDays? }],   // in year order
//     leap: { every, offset } | null,   // leap years: (year - offset) % every == 0
//     week: { length, names } | null }  // names optional (Harptos tendays are numbered)
//
// A period is a month or a festival. In a leap year each period gets its
// leapDays (0 by default) added, so Shieldmeet is a festival of 0 days with
// leapDays 1, and Golarion's Calistril is a month of 28 days with leapDays 1.
//
// Dates are { year, period, day }: period is the index into periods and day
// counts from 1. dayNumber() turns a date into a running day count, which
// is only ever compared or subtracted, so its zero point does not matter.

export const CALENDAR_PRESETS = {
  harptos: {
    name: 'Calendar of Harptos (Forgotten Realms)',
    yearSuffix: 'DR',
    periods: [
      { name: 'Hammer', days: 30 }, { name: 'Midwinter', days: 1, festival: true },
      { name: 'Alturiak', days: 30 }, { name: 'Ches', days: 30 }, { name: 'Tarsakh', days: 30 },
      { name: 'Greengrass', days: 1, festival: true },
      { name: 'Mirtul', days: 30 }, { name: 'Kythorn', days: 30 }, { name: 'Flamerule', days: 30 },
      { name: 'Midsummer', days: 1, festival: true }, { name: 'Shieldmeet', days: 0, leapDays: 1, festival: true },
      { name: 'Eleasis', days: 30 }, { name: 'Eleint', days: 30 },
      { name: 'Highharvestide', days: 1, festival: true },
      { name: 'Marpenoth', days: 30 }, { name: 'Uktar', days: 30 },
      { name: 'Feast of the Moon', days: 1, festival: true },
      { name: 'Nightal', days: 30 },
    ],
    leap: { every: 4, offset: 0 }, // Shieldmeet years: 1488, 1492 DR...
    week: { length: 10, names: [] },
  },
  greyhawk: {
    name: 'Common Year (Greyhawk)',
    yearSuffix: 'CY',
    periods: [
      { name: 'Needfest', days: 7, festival: true },
      { name: 'Fireseek', days: 28 }, { name: 'Readying', days: 28 }, { name: 'Coldeven', days: 28 },
      { name: 'Growfest', days: 7, festival: true },
      { name: 'Planting', days: 28 }, { name: 'Flocktime', days: 28 }, { name: 'Wealsun', days: 28 },
      { name: 'Richfest', days: 7, festival: true },
      { name: 'Reaping', days: 28 }, { name: 'Goodmonth', days: 28 }, { name: 'Harvester', days: 28 },
      { name: 'Brewfest', days: 7, festival: true },
      { name: 'Patchwall', days: 28 }, { name: "Ready'reat", days: 28 }, { name: 'Sunsebb', days: 28 },
    ],
    leap: null,
    week: { length: 7, names: ['Starday', 'Sunday', 'Moonday', 'Godsday', 'Waterday', 'Earthday', 'Freeday'] },
  },
  golarion: {
    name: 'Absalom Reckoning (Golarion)',
    yearSuffix: 'AR',
    periods: [
      { name: 'Abadius', days: 31 }, { name: 'Calistril', days: 28, leapDays: 1 }, { name: 'Pharast', days: 31 },
      { name: 'Gozran', days: 30 }, { name: 'Desnus', days: 31 }, { name: 'Sarenith', days: 30 },
      { name: 'Erastus', days: 31 }, { name: 'Arodus', days: 31 }, { name: 'Rova', days: 30 },
      { name: 'Lamashan', days: 31 }, { name: 'Neth', days: 30 }, { name: 'Kuthona', days: 31 },
    ],
    leap: { every: 4, offset: 0 }, // Pathfinder 2e; 1e used every 8 years
    week: { length: 7, names: ['Moonday', 'Toilday', 'Wealday', 'Oathday', 'Fireday', 'Starday', 'Sunday'] },
  },
  eberron: {
    name: 'Galifar Calendar (Eberron)',
    yearSuffix: 'YK',
    periods: ['Zarantyr', 'Olarune', 'Therendor', 'Eyre', 'Dravago', 'Nymm', 'Lharvion', 'Barrakas', 'Rhaan', 'Sypheros', 'Aryth', 'Vult']
      .map((name) => ({ name, days: 28 })),
    leap: null,
    week: { length: 7, names: ['Sul', 'Mol', 'Zol', 'Wir', 'Zor', 'Far', 'Sar'] },
  },
};

export function isLeapYear(cal, year) {
  const l = cal?.leap;
  if (!l || !(l.every > 0)) return false;
  return (((year - (l.offset || 0)) % l.every) + l.every) % l.every === 0;
}

export function periodDays(cal, period, year) {
  const p = cal.periods[period];
  if (!p) return 0;
  return (p.days || 0) + (isLeapYear(cal, year) ? p.leapDays || 0 : 0);
}

const baseYearLength = (cal) => cal.periods.reduce((n, p) => n + (p.days || 0), 0);
const leapExtra = (cal) => cal.periods.reduce((n, p) => n + (p.leapDays || 0), 0);
export const yearLength = (cal, year) => baseYearLength(cal) + (isLeapYear(cal, year) ? leapExtra(cal) : 0);

// Leap years before `year`, up to a constant (only differences are used).
function leapsBefore(cal, year) {
  const l = cal.leap;
  if (!l || !(l.every > 0) || !leapExtra(cal)) return 0;
  return Math.floor((year - 1 - (l.offset || 0)) / l.every);
}

export function isValidDate(cal, d) {
  return !!cal && !!d && Number.isInteger(d.year) && Number.isInteger(d.period) && Number.isInteger(d.day)
    && d.day >= 1 && d.day <= periodDays(cal, d.period, d.year);
}

export function dayNumber(cal, d) {
  let n = d.year * baseYearLength(cal) + leapsBefore(cal, d.year) * leapExtra(cal);
  for (let i = 0; i < d.period; i++) n += periodDays(cal, i, d.year);
  return n + d.day - 1;
}

// The date `days` after d (or before, if negative).
export function addDays(cal, d, days) {
  if (!yearLength(cal, d.year)) return d;
  let year = d.year;
  let left = dayNumber(cal, d) - dayNumber(cal, { year, period: 0, day: 1 }) + days; // day of year, 0-based
  while (left < 0) { year -= 1; left += yearLength(cal, year); }
  while (left >= yearLength(cal, year)) { left -= yearLength(cal, year); year += 1; }
  let period = 0;
  while (left >= periodDays(cal, period, year)) { left -= periodDays(cal, period, year); period += 1; }
  return { year, period, day: left + 1 };
}

// "15 Kythorn 1491 DR", "Midsummer 1491 DR" (one-day festival), "3 Needfest 576 CY".
export function formatDate(cal, d) {
  if (!isValidDate(cal, d)) return '';
  const p = cal.periods[d.period];
  const year = `${d.year}${cal.yearSuffix ? ` ${cal.yearSuffix}` : ''}`;
  if (p.festival && periodDays(cal, d.period, d.year) === 1) return `${p.name} ${year}`;
  return `${d.day} ${p.name} ${year}`;
}

// The weekday name, when the calendar names its days and the DM has said
// which weekday one known date fell on (week.anchor = { year, period, day, weekday }).
export function weekdayName(cal, d) {
  const w = cal?.week;
  if (!w?.names?.length || !w.anchor || !isValidDate(cal, d) || !isValidDate(cal, w.anchor)) return '';
  const diff = dayNumber(cal, d) - dayNumber(cal, w.anchor);
  const i = (((w.anchor.weekday || 0) + diff) % w.names.length + w.names.length) % w.names.length;
  return w.names[i];
}

// The calendar as editable text, one period per line:
//   Hammer 30
//   Midwinter 1 festival
//   Shieldmeet 0 festival leap 1
export function periodsToText(cal) {
  return cal.periods.map((p) => [p.name, p.days, p.festival ? 'festival' : '', p.leapDays ? `leap ${p.leapDays}` : '']
    .filter((x) => x !== '').join(' ')).join('\n');
}

// Parses the text above. Throws an Error naming the bad line.
export function textToPeriods(text) {
  const periods = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(.+?)\s+(\d+)((?:\s+(?:festival|leap\s+\d+))*)\s*$/i.exec(line);
    if (!m) throw new Error(`Line ${i + 1} ("${line}") needs a name and a number of days, like "Hammer 30" or "Midwinter 1 festival".`);
    const p = { name: m[1].trim().slice(0, 60), days: Number(m[2]) };
    if (/festival/i.test(m[3])) p.festival = true;
    const leap = /leap\s+(\d+)/i.exec(m[3]);
    if (leap && Number(leap[1])) p.leapDays = Number(leap[1]);
    periods.push(p);
  });
  if (!periods.length) throw new Error('A calendar needs at least one month.');
  if (!periods.some((p) => p.days > 0)) throw new Error('At least one month needs some days.');
  return periods;
}
