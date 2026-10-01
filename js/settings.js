const LS_INITIALS = 'bg-lz.initials';
const LS_COLOR = 'bg-lz.colorIndex';
const LS_LAST_COL_DATE_ONLY = 'bg-lz.lastColDateOnly';
const LS_SMD_STAMP_ENABLED = 'bg-lz.smdStampEnabled';
const LS_SMD_INITIALS = 'bg-lz.smdInitials';
const LS_SMD_COLOR = 'bg-lz.smdColorIndex';
const LS_INITIALS_LEGACY = 'bg.initials';
const LS_COLOR_LEGACY = 'bg.colorIndex';
const LS_LAST_COL_DATE_ONLY_LEGACY = 'bg.lastColDateOnly';
const LS_SMD_STAMP_ENABLED_LEGACY = 'bg.smdStampEnabled';
const LS_SMD_INITIALS_LEGACY = 'bg.smdInitials';
const LS_SMD_COLOR_LEGACY = 'bg.smdColorIndex';

export const DARK_COLORS = [
  { r: 0.08, g: 0.2, b: 0.55 }, // navy (default)
  { r: 0.1, g: 0.1, b: 0.12 }, // near black
  { r: 0.45, g: 0.12, b: 0.12 }, // dark red
  { r: 0.12, g: 0.38, b: 0.22 }, // forest
  { r: 0.35, g: 0.18, b: 0.45 }, // purple
  { r: 0.45, g: 0.28, b: 0.08 }, // brown
  { r: 0.08, g: 0.35, b: 0.4 }, // teal
  { r: 0.25, g: 0.25, b: 0.28 }, // charcoal
];

/** Column index for „Baugruppe gebucht“ (last process column). */
export const LAST_COLUMN_INDEX = 7;

/** Column index for „Bestückung SMD & Reflow“ (COL_HEADERS[1] in pdf.js). */
export const SMD_COLUMN_INDEX = 1;

function clampIndex(i) {
  return Math.max(0, Math.min(DARK_COLORS.length - 1, i | 0));
}

function readLs(primary, legacy) {
  try {
    const v = localStorage.getItem(primary);
    if (v != null && String(v).length) return v;
    const old = localStorage.getItem(legacy);
    if (old != null && String(old).length) {
      try { localStorage.setItem(primary, old); } catch (_) {}
      return old;
    }
  } catch (_) {}
  return null;
}

export function loadSettings() {
  let initials = readLs(LS_INITIALS, LS_INITIALS_LEGACY);
  if (!initials || !String(initials).trim()) initials = 'SG';
  const colorRaw = readLs(LS_COLOR, LS_COLOR_LEGACY);
  // Fresh install / unset → forest green (index 3)
  const colorIndex = clampIndex(parseInt(colorRaw != null ? colorRaw : '3', 10));
  const lastColRaw = readLs(LS_LAST_COL_DATE_ONLY, LS_LAST_COL_DATE_ONLY_LEGACY);
  // Default OFF when unset (full stamp with initials)
  const lastColumnDateOnly = lastColRaw === null ? false : lastColRaw === '1' || lastColRaw === 'true';

  const smdEnabledRaw = readLs(LS_SMD_STAMP_ENABLED, LS_SMD_STAMP_ENABLED_LEGACY);
  // Default ON when unset
  const smdStampEnabled = smdEnabledRaw === null ? true : smdEnabledRaw === '1' || smdEnabledRaw === 'true';
  let smdInitials = readLs(LS_SMD_INITIALS, LS_SMD_INITIALS_LEGACY);
  if (!smdInitials || !String(smdInitials).trim()) smdInitials = 'DK';
  const smdColorRaw = readLs(LS_SMD_COLOR, LS_SMD_COLOR_LEGACY);
  // Fresh install / unset → navy (index 0)
  const smdColorIndex = clampIndex(parseInt(smdColorRaw != null ? smdColorRaw : '0', 10));

  return {
    initials: String(initials).trim(),
    colorIndex,
    lastColumnDateOnly,
    smdStampEnabled,
    smdInitials: String(smdInitials).trim(),
    smdColorIndex,
    /** @type {string|null} document-only, not persisted */
    dateOverride: null,
  };
}

export function saveInitials(initials) {
  const v = String(initials || '').trim() || 'SG';
  try {
    localStorage.setItem(LS_INITIALS, v);
    localStorage.setItem(LS_INITIALS_LEGACY, v);
  } catch (_) {}
  return v;
}

export function saveColorIndex(index) {
  const i = String(clampIndex(index));
  try {
    localStorage.setItem(LS_COLOR, i);
    localStorage.setItem(LS_COLOR_LEGACY, i);
  } catch (_) {}
}

export function saveLastColumnDateOnly(on) {
  const v = on ? '1' : '0';
  try {
    localStorage.setItem(LS_LAST_COL_DATE_ONLY, v);
    localStorage.setItem(LS_LAST_COL_DATE_ONLY_LEGACY, v);
  } catch (_) {}
}

export function saveSmdStampEnabled(on) {
  const v = on ? '1' : '0';
  try {
    localStorage.setItem(LS_SMD_STAMP_ENABLED, v);
    localStorage.setItem(LS_SMD_STAMP_ENABLED_LEGACY, v);
  } catch (_) {}
}

export function saveSmdInitials(initials) {
  const v = String(initials || '').trim() || 'DK';
  try {
    localStorage.setItem(LS_SMD_INITIALS, v);
    localStorage.setItem(LS_SMD_INITIALS_LEGACY, v);
  } catch (_) {}
  return v;
}

export function saveSmdColorIndex(index) {
  const i = String(clampIndex(index));
  try {
    localStorage.setItem(LS_SMD_COLOR, i);
    localStorage.setItem(LS_SMD_COLOR_LEGACY, i);
  } catch (_) {}
}

export function todayShortGerman(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.`;
}

/** Save-day suffix (dd.MM.yy) in Europe/Berlin. */
export function todaySaveSuffixGerman(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `(${get('day')}.${get('month')}.${get('year')})`;
}

/**
 * Append or replace German short date suffix before .pdf
 * e.g. "BG Endstufe 2718 V2.pdf" → "BG Endstufe 2718 V2 (13.09.26).pdf"
 */
export function withSaveDateSuffix(filename) {
  let name = String(filename || 'Laufzettel.pdf');
  if (!/\.pdf$/i.test(name)) name = `${name}.pdf`;
  const stem = name.replace(/\.pdf$/i, '');
  const cleaned = stem.replace(/\s*\(\d{2}\.\d{2}\.\d{2}\)\s*$/, '').trim();
  return `${cleaned} ${todaySaveSuffixGerman()}.pdf`;
}

export function normalizeDateString(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!s.endsWith('.')) s += '.';
  return s;
}

export function stampDateString(settings) {
  const override = settings.dateOverride ? String(settings.dateOverride).trim() : '';
  if (override) return normalizeDateString(override);
  return todayShortGerman();
}

export function colorCss(index) {
  const c = DARK_COLORS[clampIndex(index)];
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

export function colorRgb01(index) {
  return DARK_COLORS[clampIndex(index)];
}
