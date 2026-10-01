/**
 * Resolve a BG Laufzettel PDF by etikett / serial.
 * IndexedDB catalog (separate from Geräte): blob + filename + text-derived serial keys.
 * Order: directory handle (Chrome/Edge) → IndexedDB blob catalog (iPad / content index).
 */

import * as pdfjsLib from "../vendor/pdf.min.mjs";
import { extractSerialTokensFromText, looksLikeSerial } from "./sn.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdf.worker.min.mjs",
  import.meta.url
).href;

const IDB_NAME = "bg-laufzettel-catalog-v1";
const IDB_VERSION = 1;
const IDB_STORE_HANDLES = "handles";
const IDB_STORE_PDFS = "pdfs";
const DIR_KEY = "pdf-folder";
const META_KEY = "pdf-catalog-meta";

/** @type {Map<string, FileSystemFileHandle>} canonicalSerial → file handle */
let folderPdfMap = new Map();
/** @type {string|null} */
let folderIndexName = null;
/** @type {number|null} */
let folderIndexAt = null;

export function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === "function";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_HANDLES)) {
        db.createObjectStore(IDB_STORE_HANDLES);
      }
      if (!db.objectStoreNames.contains(IDB_STORE_PDFS)) {
        db.createObjectStore(IDB_STORE_PDFS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(store, key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    if (value === null || value === undefined) {
      tx.objectStore(store).delete(key);
    } else {
      tx.objectStore(store).put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbCount(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

async function idbClearStore(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function normalizeDashes(text) {
  return String(text ?? "").replace(
    /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g,
    "-"
  );
}

export function canonicalizeSerial(sn) {
  return normalizeDashes(String(sn ?? "").trim()).toUpperCase();
}

/**
 * Serial from PDF filename: etikett-like stem, or text after last hyphen.
 * e.g. B00001.pdf → B00001; DE-…-B00001.pdf → B00001; BG Endstufe V2.pdf → stem
 */
export function serialFromPdfFilename(name) {
  const stem = normalizeDashes(String(name || "").replace(/\.pdf$/i, "")).trim();
  if (!stem) return "";
  if (looksLikeSerial(stem)) return stem;
  const i = stem.lastIndexOf("-");
  if (i >= 0 && i < stem.length - 1) {
    const sn = stem.slice(i + 1).trim();
    if (sn && looksLikeSerial(sn)) return sn;
  }
  return stem;
}

export function filenameMatchesSerial(name, serial) {
  const sn = canonicalizeSerial(serial);
  if (!sn || !isPdfFilename(name)) return false;
  const fromName = canonicalizeSerial(serialFromPdfFilename(name));
  if (fromName === sn) return true;
  // Substring token in filename stem
  const stem = canonicalizeSerial(String(name || "").replace(/\.pdf$/i, ""));
  return stem === sn || stem.includes(sn) || new RegExp(`(^|[^A-Z0-9])${escapeRegExp(sn)}([^A-Z0-9]|$)`).test(stem);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPdfFilename(name) {
  return /\.pdf$/i.test(String(name || ""));
}

function catalogDocKey(name) {
  return canonicalizeSerial(String(name || "").replace(/\.pdf$/i, "")) || canonicalizeSerial(name);
}

export async function savePdfFolderHandle(handle) {
  if (!handle) return;
  await idbSet(IDB_STORE_HANDLES, DIR_KEY, handle);
}

export async function getPdfFolderHandle() {
  try {
    return await idbGet(IDB_STORE_HANDLES, DIR_KEY);
  } catch (_) {
    return null;
  }
}

export async function clearPdfFolderHandle() {
  try {
    await idbSet(IDB_STORE_HANDLES, DIR_KEY, null);
  } catch (_) {}
  folderPdfMap.clear();
  folderIndexName = null;
  folderIndexAt = null;
}

async function ensureDirPermission(handle) {
  if (!handle) return false;
  try {
    if (handle.queryPermission) {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm === "granted") return true;
      if (handle.requestPermission) {
        perm = await handle.requestPermission({ mode: "read" });
        return perm === "granted";
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

export async function reindexPdfFolder() {
  const dir = await getPdfFolderHandle();
  if (!dir) {
    folderPdfMap.clear();
    folderIndexName = null;
    folderIndexAt = null;
    return { ok: false, reason: "no-handle", count: 0 };
  }
  if (!(await ensureDirPermission(dir))) {
    return { ok: false, reason: "permission", count: 0, folderName: dir.name };
  }

  const next = new Map();
  try {
    if (typeof dir.entries === "function") {
      for await (const [name, handle] of dir.entries()) {
        if (!handle || handle.kind !== "file") continue;
        if (!isPdfFilename(name)) continue;
        const key = canonicalizeSerial(serialFromPdfFilename(name));
        if (key) next.set(key, handle);
        // Also index bare etikett tokens found in the filename
        for (const tok of extractSerialTokensFromText(name)) {
          const ck = canonicalizeSerial(tok);
          if (ck) next.set(ck, handle);
        }
      }
    } else if (typeof dir.values === "function") {
      for await (const handle of dir.values()) {
        if (!handle || handle.kind !== "file") continue;
        const name = handle.name || "";
        if (!isPdfFilename(name)) continue;
        const key = canonicalizeSerial(serialFromPdfFilename(name));
        if (key) next.set(key, handle);
        for (const tok of extractSerialTokensFromText(name)) {
          const ck = canonicalizeSerial(tok);
          if (ck) next.set(ck, handle);
        }
      }
    }
  } catch (err) {
    console.warn("reindexPdfFolder failed", err);
    return { ok: false, reason: "scan-failed", count: 0, folderName: dir.name };
  }

  folderPdfMap = next;
  folderIndexName = dir.name || null;
  folderIndexAt = Date.now();
  return { ok: true, count: next.size, folderName: dir.name };
}

export function getFolderIndexInfo() {
  return {
    count: folderPdfMap.size,
    folderName: folderIndexName,
    indexedAt: folderIndexAt,
  };
}

export async function pickPdfFolder() {
  if (!supportsDirectoryPicker()) {
    throw new Error("Ordnerauswahl wird von diesem Browser nicht unterstützt.");
  }
  const handle = await window.showDirectoryPicker({ mode: "read" });
  await savePdfFolderHandle(handle);
  await reindexPdfFolder();
  return handle;
}

async function getCatalogMeta() {
  try {
    return (await idbGet(IDB_STORE_HANDLES, META_KEY)) || null;
  } catch (_) {
    return null;
  }
}

async function setCatalogMeta(meta) {
  await idbSet(IDB_STORE_HANDLES, META_KEY, meta);
}

export async function getIdbCatalogStats() {
  let count = 0;
  try {
    count = await idbCount(IDB_STORE_PDFS);
  } catch (_) {
    count = 0;
  }
  const meta = await getCatalogMeta();
  return {
    count,
    lastUpdated: meta?.lastUpdated ?? null,
  };
}

/**
 * Extract plain text from a PDF ArrayBuffer via pdf.js.
 * @param {ArrayBuffer} data
 * @returns {Promise<string>}
 */
async function extractPdfText(data) {
  const copy = data.slice(0);
  const loadingTask = pdfjsLib.getDocument({ data: copy });
  const pdf = await loadingTask.promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const line = (tc.items || []).map((it) => (it && it.str) || "").join(" ");
    parts.push(line);
  }
  try {
    await pdf.destroy();
  } catch (_) {}
  return parts.join("\n");
}

/**
 * Build index fields for a PDF (filename + content serials).
 * @param {string} name
 * @param {ArrayBuffer} data
 */
async function buildIndexFields(name, data) {
  const serialKeys = new Set();
  const fromName = serialFromPdfFilename(name);
  if (fromName && looksLikeSerial(fromName)) {
    serialKeys.add(canonicalizeSerial(fromName));
  }
  for (const tok of extractSerialTokensFromText(name)) {
    serialKeys.add(canonicalizeSerial(tok));
  }

  let text = "";
  try {
    text = await extractPdfText(data);
  } catch (err) {
    console.warn("PDF text extract failed", name, err);
  }
  for (const tok of extractSerialTokensFromText(text)) {
    serialKeys.add(canonicalizeSerial(tok));
  }

  const haystack = canonicalizeSerial(`${name}\n${text}`);
  return {
    serialKeys: [...serialKeys].filter(Boolean),
    haystack,
  };
}

/**
 * Merge/replace PDFs from a multi-file pick.
 * Key = canonical filename stem. Indexes etikett numbers from filename + PDF text.
 * @param {FileList|File[]} fileList
 * @returns {Promise<{imported: number, total: number}>}
 */
export async function mergePdfsFromFileList(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && isPdfFilename(f.name));
  if (!files.length) {
    const stats = await getIdbCatalogStats();
    return { imported: 0, total: stats.count };
  }

  const prepared = [];
  for (const file of files) {
    const docKey = catalogDocKey(file.name);
    if (!docKey) continue;
    const data = await file.arrayBuffer();
    const index = await buildIndexFields(file.name, data);
    prepared.push({
      key: docKey,
      record: {
        name: file.name,
        type: file.type || "application/pdf",
        data,
        updatedAt: Date.now(),
        serialKeys: index.serialKeys,
        haystack: index.haystack,
      },
    });
  }

  if (!prepared.length) {
    const stats = await getIdbCatalogStats();
    return { imported: 0, total: stats.count };
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_PDFS, "readwrite");
    const store = tx.objectStore(IDB_STORE_PDFS);
    for (const item of prepared) {
      store.put(item.record, item.key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const total = await idbCount(IDB_STORE_PDFS);
  await setCatalogMeta({ lastUpdated: Date.now(), count: total });
  return { imported: prepared.length, total };
}

/**
 * Upsert a saved PDF into the catalog (re-index content).
 * @param {Blob|ArrayBuffer|Uint8Array} blob
 * @param {string} name
 */
export async function upsertSavedPdf(blob, name) {
  const docKey = catalogDocKey(name);
  if (!docKey || !blob) return { ok: false };
  let data;
  if (blob instanceof ArrayBuffer) data = blob;
  else if (blob instanceof Uint8Array)
    data = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  else data = await blob.arrayBuffer();

  const index = await buildIndexFields(name || `${docKey}.pdf`, data);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_PDFS, "readwrite");
    tx.objectStore(IDB_STORE_PDFS).put(
      {
        name: name || `${docKey}.pdf`,
        type: "application/pdf",
        data,
        updatedAt: Date.now(),
        serialKeys: index.serialKeys,
        haystack: index.haystack,
      },
      docKey
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const total = await idbCount(IDB_STORE_PDFS);
  await setCatalogMeta({ lastUpdated: Date.now(), count: total });
  return { ok: true, serial: docKey, total };
}

export async function clearIdbCatalog() {
  await idbClearStore(IDB_STORE_PDFS);
  await setCatalogMeta({ lastUpdated: null, count: 0 });
}

async function findInFolderMap(serial) {
  const key = canonicalizeSerial(serial);
  const handle = folderPdfMap.get(key) || folderPdfMap.get(serial);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    return { file, fileHandle: handle, source: "folder" };
  } catch (_) {
    return null;
  }
}

async function findInDirectoryHandle(serial) {
  const dir = await getPdfFolderHandle();
  if (!dir || !(await ensureDirPermission(dir))) return null;
  const raw = String(serial || "").trim();
  const canon = canonicalizeSerial(raw);
  const nameTries = new Set([
    `${raw}.pdf`,
    `${raw}.PDF`,
    `${canon}.pdf`,
    `${canon}.PDF`,
    `${raw.toLowerCase()}.pdf`,
    `${raw.toLowerCase()}.PDF`,
  ]);
  for (const name of nameTries) {
    try {
      const fileHandle = await dir.getFileHandle(name);
      const file = await fileHandle.getFile();
      return { file, fileHandle, source: "folder" };
    } catch (_) {
      /* not in folder */
    }
  }
  try {
    if (typeof dir.entries === "function") {
      for await (const [name, handle] of dir.entries()) {
        if (!handle || handle.kind !== "file") continue;
        if (!filenameMatchesSerial(name, serial)) continue;
        const file = await handle.getFile();
        return { file, fileHandle: handle, source: "folder" };
      }
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function fileFromIdbEntry(entry) {
  const bytes = entry.data;
  const name = entry.name || "Laufzettel.pdf";
  const type = entry.type || "application/pdf";
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const file = new File([blob], name, { type });
  return { file, fileHandle: null, source: "idb" };
}

/**
 * Prefer exact serialKeys hit; else substring/token in haystack or filename.
 */
async function findInIdbCatalog(serial) {
  const canon = canonicalizeSerial(serial);
  if (!canon) return null;
  try {
    const db = await openDb();
    /** @type {{entry: object, rank: number}|null} */
    let best = null;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_PDFS, "readonly");
      const store = tx.objectStore(IDB_STORE_PDFS);
      const req = store.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const entry = cursor.value;
        if (!entry?.data) {
          cursor.continue();
          return;
        }
        const keys = Array.isArray(entry.serialKeys)
          ? entry.serialKeys.map(canonicalizeSerial)
          : [];
        if (keys.includes(canon)) {
          if (!best || best.rank > 0) best = { entry, rank: 0 };
        } else {
          const name = String(entry.name || "");
          if (filenameMatchesSerial(name, serial)) {
            if (!best || best.rank > 1) best = { entry, rank: 1 };
          } else {
            const hay = String(entry.haystack || canonicalizeSerial(name));
            const tokenOk =
              hay === canon ||
              hay.includes(canon) ||
              new RegExp(`(^|[^A-Z0-9])${escapeRegExp(canon)}([^A-Z0-9]|$)`).test(hay);
            if (tokenOk && (!best || best.rank > 2)) {
              best = { entry, rank: 2 };
            }
          }
        }
        cursor.continue();
      };
    });

    if (!best) return null;
    return fileFromIdbEntry(best.entry);
  } catch (_) {
    return null;
  }
}

function isPlaceholderSerial(serial) {
  const s = String(serial || "").trim();
  return !s || s === "—" || s === "–" || s === "−" || s === "-" || s === "‑" || s === "‒";
}

/**
 * @param {string} sn
 * @returns {Promise<{file: File, fileHandle: FileSystemFileHandle|null, source: string}|null>}
 */
export async function findPdfBySerial(sn) {
  const serial = String(sn || "").trim();
  if (isPlaceholderSerial(serial)) return null;

  const fromMap = await findInFolderMap(serial);
  if (fromMap) return fromMap;

  const fromDir = await findInDirectoryHandle(serial);
  if (fromDir) return fromDir;

  const fromIdb = await findInIdbCatalog(serial);
  if (fromIdb) return fromIdb;

  return null;
}

export function formatCatalogUpdated(ts) {
  if (!ts) return "noch nie";
  try {
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toLocaleString("de-DE");
  }
}
