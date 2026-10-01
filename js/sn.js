/**
 * Serial / Etikett extraction from DataMatrix / barcode payloads (BG Laufzettel).
 * Rule: SN = text after the last hyphen "-"; bare payloads accepted as-is.
 * BG etikett often looks like B00001 (letter + digits).
 */

/** UI / placeholder tokens that must never trigger a PDF search. */
const PLACEHOLDER_SERIALS = new Set(["", "—", "–", "−", "-", "‑", "‒"]);

/** Unicode dashes/minus → ASCII hyphen. */
function normalizeDashes(text) {
  return String(text ?? "").replace(
    /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g,
    "-"
  );
}

/**
 * @param {string} raw
 * @returns {string} trimmed serial or empty string
 */
export function extractSerialFromPayload(raw) {
  const text = normalizeDashes(String(raw ?? "")).trim();
  if (!text) return "";
  const idx = text.lastIndexOf("-");
  if (idx === -1) return text;
  const sn = text.slice(idx + 1).trim();
  return sn;
}

/**
 * BG etikett (letter+digits, e.g. B00001) or generic alphanumeric serial.
 * @param {string} sn
 * @returns {boolean}
 */
export function looksLikeSerial(sn) {
  const s = String(sn || "").trim();
  if (!s) return false;
  // BG Etikett: Buchstabe + Ziffern (B00001)
  if (/^[A-ZÄÖÜ]\d{4,12}$/i.test(s)) return true;
  // Bare alphanumeric / Geräte-style — must contain at least one digit
  return /^[A-Z0-9][A-Z0-9._]{3,40}$/i.test(s) && /\d/.test(s);
}

/**
 * True when SN is non-empty, not a UI placeholder, and looks valid.
 * @param {string} sn
 * @returns {boolean}
 */
export function isUsableSerial(sn) {
  const s = String(sn ?? "").trim();
  if (!s || PLACEHOLDER_SERIALS.has(s)) return false;
  return looksLikeSerial(s);
}

/**
 * Collect serial-like tokens from free text (PDF content / filename).
 * @param {string} text
 * @returns {string[]} unique raw tokens (not necessarily canonicalized)
 */
export function extractSerialTokensFromText(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const found = new Set();
  // Prefer BG etikett first, then longer alnum tokens
  const re = /\b([A-ZÄÖÜ]\d{4,12}|[A-Z0-9][A-Z0-9._]{4,40})\b/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const tok = m[1].trim();
    if (looksLikeSerial(tok)) found.add(tok);
  }
  return [...found];
}
