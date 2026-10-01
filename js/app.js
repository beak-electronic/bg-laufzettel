import { parseJob } from "./parse.js";
import { generatePdf } from "./pdf.js";
import { initFill, openGeneratedPdf, openFile, pickAndOpen } from "./fill.js";
import { extractSerialFromPayload, isUsableSerial } from "./sn.js";
import {
  scanDataMatrixFromVideo,
  startCamera,
  stopCamera,
  releaseAllCameras,
  releaseAllCamerasAsync,
} from "./scan.js";
import {
  findPdfBySerial,
  pickPdfFolder,
  getPdfFolderHandle,
  clearPdfFolderHandle,
  supportsDirectoryPicker,
  reindexPdfFolder,
  getFolderIndexInfo,
  mergePdfsFromFileList,
  getIdbCatalogStats,
  clearIdbCatalog,
  formatCatalogUpdated,
} from "./catalog.js";

const EXAMPLE = "15x 100.124 BG Endstufe 2718 V2";
const STORAGE_KEY = "bg-gen-settings-v2";
const STORAGE_KEY_LEGACY = "bg-gen-settings-v1";
const SCAN_MODE_KEY = "bg.scanFrameMode";

const $ = (sel) => document.querySelector(sel);

const DEFAULT_SETTINGS = {
  autoShare: true,
  buchstabe: "B",
  startnummer: 1,
  autoIncrement: true,
  sachbearbeiter: "Daniel",
  autoRefreshPrompt: true,
};

const state = {
  queue: [],
  busy: false,
  /** Last generator input — kept until Sichern, restored on close without save. */
  pendingInputText: "",
  jobsExpanded: false,
  jobs: [],
  settings: { ...DEFAULT_SETTINGS },
  cameraStream: null,
  scanAbort: null,
  scanning: false,
  lastPayload: "",
  lastSerial: "",
  bannerDismissed: false,
};

function padStartnummer(n) {
  const num = Math.max(0, parseInt(n, 10) || 0);
  return String(num).padStart(5, "0");
}

function normalizeBuchstabe(v) {
  const s = String(v || "B").trim().toUpperCase();
  return (s.charAt(0) || "B").replace(/[^A-ZÄÖÜ]/g, "B") || "B";
}

function loadSettings() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) raw = localStorage.getItem(STORAGE_KEY_LEGACY);
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(state.settings, DEFAULT_SETTINGS, parsed);
    }
  } catch (_) {}
  state.settings.buchstabe = normalizeBuchstabe(state.settings.buchstabe);
  state.settings.startnummer = Math.max(0, parseInt(state.settings.startnummer, 10) || 1);
  state.settings.autoShare = state.settings.autoShare !== false;
  state.settings.autoIncrement = state.settings.autoIncrement !== false;
  if (!state.settings.saveMode) state.settings.saveMode = "auto";
  state.settings.sachbearbeiter = String(state.settings.sachbearbeiter || "Daniel").trim() || "Daniel";
  if (typeof state.settings.autoRefreshPrompt !== "boolean") {
    state.settings.autoRefreshPrompt = true;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch (_) {}
}

function jobDefaultsFromSettings() {
  return {
    buchstabe: state.settings.buchstabe,
    startnummer: state.settings.startnummer,
    sachbearbeiter: state.settings.sachbearbeiter,
  };
}

function refreshHomePreview() {
  const snEl = $("#preview-startnummer");
  const sbEl = $("#preview-sachbearbeiter");
  if (!snEl || !sbEl) return;
  const letter = normalizeBuchstabe(state.settings.buchstabe);
  const num = padStartnummer(state.settings.startnummer);
  snEl.textContent = `Startnummer: ${letter}${num}`;
  sbEl.textContent = `Sachbearbeiter Lager: ${state.settings.sachbearbeiter || "—"}`;
}

function setStatus(text, kind = "") {
  const el = document.body.classList.contains("scan-open")
    ? ($("#scan-status") || $("#status"))
    : $("#status");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function showScanView() {
  const home = $("#home");
  const scan = $("#scan-view");
  home?.classList.add("hidden");
  scan?.classList.remove("hidden");
  document.body.classList.add("scan-open");
  document.body.classList.remove("fill-open");
  setStatus("Bereit – Etikett scannen");
}

async function showHomeFromScan() {
  await stopScanning({ silent: true });
  try {
    releaseAllCameras();
  } catch (_) {}
  const home = $("#home");
  const scan = $("#scan-view");
  scan?.classList.add("hidden");
  home?.classList.remove("hidden");
  document.body.classList.remove("scan-open");
}

function refreshJobsHeader() {
  const n = state.jobs.length;
  const arrow = state.jobsExpanded ? "▾" : "▸";
  const suffix = n ? ` (${n})` : "";
  $("#jobs-header").textContent = `${arrow} Aufträge${suffix}`;
}

function renderJobs() {
  const list = $("#jobs-list");
  list.innerHTML = "";
  for (const item of state.jobs) {
    const li = document.createElement("li");
    li.className = `job job-${item.status}`;
    li.textContent = item.label;
    list.appendChild(li);
  }
  refreshJobsHeader();
}

function updateJob(id, patch) {
  const item = state.jobs.find((j) => j.id === id);
  if (!item) return;
  Object.assign(item, patch);
  renderJobs();
}

async function shareOrDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const file = new File([blob], filename, { type: "application/pdf" });

  if (state.settings.autoShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return "aborted";
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "download";
}

async function processQueue() {
  if (state.busy) return;
  const next = state.queue.shift();
  if (!next) return;

  state.busy = true;
  const { id, job } = next;
  updateJob(id, {
    status: "running",
    label: `Läuft… · ${job.stueckzahl}x · ${job.baugruppe}`,
  });
  setStatus(`Erzeuge: ${job.pdfStem}.pdf`, "busy");

  try {
    const { bytes, filename } = await generatePdf(job);
    await openGeneratedPdf(bytes, filename, { pendingQty: job.stueckzahl });
    updateJob(id, { status: "done", label: `Fertig · ${filename}` });
    setStatus(`Geöffnet: ${filename}`, "ok");
    // Startnummer rises only after successful save in stamp mode (see onStampSaved).
  } catch (err) {
    console.error(err);
    updateJob(id, { status: "error", label: `Fehler · ${job.baugruppe}` });
    setStatus(`Fehler: ${err.message || err}`, "error");
    showToast(String(err.message || err));
  } finally {
    state.busy = false;
    if (state.queue.length) {
      setStatus("Warteschlange…", "busy");
      queueMicrotask(() => processQueue());
    }
  }
}

function enqueueFromText(text) {
  let job;
  try {
    job = parseJob(text, jobDefaultsFromSettings());
  } catch (err) {
    showToast(String(err.message || err));
    setStatus("Fehler", "error");
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sn = `${job.buchstabe}${padStartnummer(job.startnummer)}`;
  const item = {
    id,
    job,
    status: "waiting",
    label: `Wartend · ${job.stueckzahl}x · ${job.baugruppe} · ${sn} · ${job.sachbearbeiter}`,
  };
  state.jobs.push(item);
  state.queue.push({ id, job });
  renderJobs();
  setStatus("Warteschlange…", "busy");
  processQueue();
}

function onSubmit() {
  const input = $("#job-input");
  const text = input.value.trim();
  if (!text) return;
  // Keep the line filled until Sichern; after Schließen ohne Speichern restore the same text.
  state.pendingInputText = text;
  try { sessionStorage.setItem('bg-gen-pending-input', text); } catch (_) {}
  input.value = text;
  input.focus();
  enqueueFromText(text);
}

function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function syncGenSettingsForm() {
  const autoShare = $("#settings-autoshare");
  const buchstabe = $("#settings-buchstabe");
  const startnummer = $("#settings-startnummer");
  const autoInc = $("#settings-auto-increment");
  const sach = $("#settings-sachbearbeiter");
  if (autoShare) autoShare.checked = !!state.settings.autoShare;
  const saveMode = document.getElementById("settings-save-mode");
  if (saveMode) saveMode.value = state.settings.saveMode || "auto";
  if (buchstabe) buchstabe.value = normalizeBuchstabe(state.settings.buchstabe);
  if (startnummer) startnummer.value = padStartnummer(state.settings.startnummer);
  if (autoInc) autoInc.checked = !!state.settings.autoIncrement;
  if (sach) sach.value = state.settings.sachbearbeiter || "";
  const autoPrompt = $("#settings-auto-refresh-prompt");
  if (autoPrompt) autoPrompt.checked = state.settings.autoRefreshPrompt !== false;
  refreshCatalogUi().catch(() => {});
}

function readGenSettingsFromForm() {
  const autoShare = $("#settings-autoshare");
  const buchstabe = $("#settings-buchstabe");
  const startnummer = $("#settings-startnummer");
  const autoInc = $("#settings-auto-increment");
  const sach = $("#settings-sachbearbeiter");
  if (autoShare) state.settings.autoShare = !!autoShare.checked;
  const saveMode = document.getElementById("settings-save-mode");
  if (saveMode) state.settings.saveMode = saveMode.value || "auto";
  if (buchstabe) state.settings.buchstabe = normalizeBuchstabe(buchstabe.value);
  if (startnummer) {
    const n = parseInt(String(startnummer.value).replace(/\D/g, ""), 10);
    state.settings.startnummer = Number.isFinite(n) ? n : 1;
  }
  if (autoInc) state.settings.autoIncrement = !!autoInc.checked;
  if (sach) {
    state.settings.sachbearbeiter = String(sach.value || "").trim() || "Daniel";
  }
  const autoPrompt = $("#settings-auto-refresh-prompt");
  if (autoPrompt) state.settings.autoRefreshPrompt = !!autoPrompt.checked;
}

function openGenSettings() {
  const dlg = $("#gen-settings-dialog");
  syncGenSettingsForm();
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeGenSettings() {
  const dlg = $("#gen-settings-dialog");
  readGenSettingsFromForm();
  saveSettings();
  refreshHomePreview();
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW register failed", err);
    });
  });
}

function wireGenSettingsInputs() {
  const buchstabe = $("#settings-buchstabe");
  const startnummer = $("#settings-startnummer");
  if (buchstabe) {
    const forceUpper = () => {
      buchstabe.value = normalizeBuchstabe(buchstabe.value);
    };
    buchstabe.addEventListener("input", forceUpper);
    buchstabe.addEventListener("blur", forceUpper);
  }
  if (startnummer) {
    startnummer.addEventListener("blur", () => {
      const n = parseInt(String(startnummer.value).replace(/\D/g, ""), 10);
      startnummer.value = padStartnummer(Number.isFinite(n) ? n : 1);
    });
  }
}

function syncThemeChrome() {
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const color = dark ? "#1c1c1e" : "#ffffff";
  let metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  if (!metas.length) {
    const m = document.createElement("meta");
    m.name = "theme-color";
    document.head.appendChild(m);
    metas = [m];
  }
  for (const m of metas) {
    if (!m.media || m.media.includes("prefers-color-scheme") || m.getAttribute("content")) {
      if (!m.media) m.setAttribute("content", color);
      else if (m.media.includes("dark") && dark) m.setAttribute("content", color);
      else if (m.media.includes("light") && !dark) m.setAttribute("content", color);
    }
  }
  let live = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!live) {
    live = document.createElement("meta");
    live.name = "theme-color";
    document.head.insertBefore(live, document.head.firstChild);
  }
  live.setAttribute("content", color);
}

/* —— Scannen —— */

function setScanUi(active) {
  const panel = $("#scan-panel");
  const btnStart = $("#btn-scan-start");
  const btnStop = $("#btn-scan-stop");
  panel?.classList.toggle("hidden", !active);
  btnStart?.classList.toggle("hidden", active);
  btnStop?.classList.toggle("hidden", !active);
  if (active) applyHomeScanMode(getHomeScanMode());
}

function getHomeScanMode() {
  try {
    const v = localStorage.getItem(SCAN_MODE_KEY);
    if (v === "barcode" || v === "datamatrix") return v;
  } catch (_) {}
  return "datamatrix";
}

function applyHomeScanMode(mode) {
  const m = mode === "barcode" ? "barcode" : "datamatrix";
  try {
    localStorage.setItem(SCAN_MODE_KEY, m);
  } catch (_) {}
  const reticle = $("#scan-panel .scan-reticle");
  if (reticle) reticle.setAttribute("data-mode", m);
  document.querySelectorAll("#scan-panel .scan-mode-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-scan-mode") === m);
  });
  const hint = $("#scan-mode-hint");
  if (hint) {
    hint.textContent =
      m === "barcode"
        ? "Länglichen Barcode in den Rahmen halten."
        : "Kleinen DataMatrix-Code in den Rahmen halten.";
  }
  if (state.scanning) {
    setStatus(
      m === "barcode" ? "Barcode in den Rahmen halten…" : "DataMatrix in den Rahmen halten…",
      "busy"
    );
  }
}

async function stopScanning({ silent = false } = {}) {
  const ac = state.scanAbort;
  state.scanAbort = null;
  if (ac) {
    try {
      ac.abort();
    } catch (_) {}
  }
  const video = $("#scan-video");
  const stream = state.cameraStream;
  state.cameraStream = null;
  state.scanning = false;
  try {
    stopCamera(stream, video);
  } catch (_) {}
  try {
    releaseAllCameras();
  } catch (_) {}
  setScanUi(false);
  if (!silent) {
    /* status left to caller */
  }
}

export async function ensureCamerasReleased() {
  await stopScanning({ silent: true });
  try {
    await releaseAllCamerasAsync(250);
  } catch (_) {
    try {
      releaseAllCameras();
    } catch (_) {}
  }
}

async function startScanning() {
  let video = $("#scan-video");
  if (!video) return;

  await stopScanning({ silent: true });
  await new Promise((r) => setTimeout(r, 120));

  try {
    setStatus("Kamera wird gestartet…", "busy");
    state.cameraStream = await startCamera(video);
    video = $("#scan-video") || video;
    state.scanning = true;
    setScanUi(true);
    applyHomeScanMode(getHomeScanMode());

    const ac = new AbortController();
    state.scanAbort = ac;
    const payload = await scanDataMatrixFromVideo(video, {
      signal: ac.signal,
      getMode: () => getHomeScanMode(),
    });
    await stopScanning({ silent: true });
    await releaseAllCamerasAsync(300);
    setStatus("Code erkannt…", "ok");
    await handlePayload(payload, "Kamera");
    await releaseAllCamerasAsync(100);
  } catch (err) {
    await stopScanning({ silent: true });
    releaseAllCameras();
    if (err && err.name === "AbortError") {
      setStatus("Scan abgebrochen");
      return;
    }
    console.error(err);
    const msg = err?.message || String(err);
    setStatus("Kamerafehler", "error");
    const busy =
      /NotReadable|TrackStart|Device in use|could not start|AbortError/i.test(msg) ||
      err?.name === "NotReadableError";
    const readonlyish = /readonly property|Assignment to constant/i.test(msg);
    showToast(
      busy
        ? "Kamera noch belegt — bitte einen Moment warten und erneut „Kamera starten“ tippen."
        : msg.includes("getUserMedia") || msg.includes("Permission") || err?.name === "NotAllowedError"
          ? "Kamerazugriff verweigert oder nicht verfügbar."
          : readonlyish
            ? "Kamera-Start fehlgeschlagen (iOS). Bitte Seite neu laden und erneut versuchen."
            : msg
    );
  }
}

function updateResultPreview(payload, sn) {
  const payloadEl = $("#result-payload");
  const snEl = $("#result-serial");
  if (payloadEl) payloadEl.textContent = payload || "—";
  if (snEl) snEl.textContent = sn || "—";
  $("#result-box")?.classList.toggle("hidden", !sn);
}

async function openMatchedOrOfferPicker(sn) {
  if (!isUsableSerial(sn)) {
    setStatus("Etikettnummer fehlt oder ungültig", "error");
    return false;
  }
  setStatus(`Suche Laufzettel für ${sn}…`, "busy");
  const hit = await findPdfBySerial(sn);
  if (hit) {
    await ensureCamerasReleased();
    await openFile(hit.file, hit.fileHandle);
    setStatus(`Geöffnet: ${hit.file.name}`, "ok");
    showToast(`BG Laufzettel ${sn} geöffnet`);
    return true;
  }

  setStatus("Kein passendes PDF gefunden", "error");
  const box = $("#not-found-box");
  const snSpan = $("#not-found-sn");
  if (snSpan) snSpan.textContent = sn;
  box?.classList.remove("hidden");
  showToast(`Keine Datei für „${sn}“ gefunden. Bitte manuell öffnen oder PDFs aktualisieren.`);
  return false;
}

async function handlePayload(payload, source = "") {
  const text = String(payload || "").trim();
  if (!text) {
    showToast("Leerer Code");
    return;
  }
  const sn = extractSerialFromPayload(text);
  state.lastPayload = text;
  state.lastSerial = sn;
  updateResultPreview(text, sn);
  $("#not-found-box")?.classList.add("hidden");

  if (!isUsableSerial(sn)) {
    setStatus("Etikettnummer nicht erkannt", "error");
    showToast("Keine gültige Etikett-/Seriennummer erkannt (z. B. B00001).");
    return;
  }

  setStatus(`Etikett ${sn}${source ? ` (${source})` : ""}`, "ok");
  await openMatchedOrOfferPicker(sn);
}

function triggerPdfCatalogPick() {
  const input = $("#pdf-catalog-input");
  if (!input) return;
  input.value = "";
  input.click();
}

async function onPdfCatalogFilesSelected() {
  const input = $("#pdf-catalog-input");
  const files = input?.files;
  if (!files || !files.length) return;
  try {
    setStatus("PDFs werden indexiert…", "busy");
    const result = await mergePdfsFromFileList(files);
    input.value = "";
    hideRefreshBanner();
    await refreshCatalogUi();
    setStatus(`${result.imported} PDF(s) übernommen · Katalog: ${result.total}`, "ok");
    showToast(
      result.imported
        ? `${result.imported} PDF(s) aktualisiert (gesamt ${result.total})`
        : "Keine PDF-Dateien gewählt"
    );
  } catch (err) {
    console.error(err);
    setStatus("PDF-Import fehlgeschlagen", "error");
    showToast(err?.message || "PDFs konnten nicht gespeichert werden.");
  }
}

function showRefreshBanner() {
  const banner = $("#pdf-refresh-banner");
  if (!banner || state.bannerDismissed) return;
  banner.classList.remove("hidden");
}

function hideRefreshBanner() {
  $("#pdf-refresh-banner")?.classList.add("hidden");
}

function dismissRefreshBanner() {
  state.bannerDismissed = true;
  hideRefreshBanner();
}

async function refreshCatalogUi() {
  await refreshFolderLabel();
  await refreshIdbLabel();
  syncCatalogPlatformUi();
}

function syncCatalogPlatformUi() {
  const hasDir = supportsDirectoryPicker();
  const folderBlock = $("#settings-folder-block");
  const idbBlock = $("#settings-idb-block");
  const pickBtn = $("#btn-pick-folder");
  const clearBtn = $("#btn-clear-folder");

  if (folderBlock) {
    folderBlock.classList.toggle("is-unsupported", !hasDir);
  }
  if (pickBtn) {
    pickBtn.disabled = !hasDir;
    pickBtn.title = hasDir
      ? "Ordner mit BG-Laufzettel-PDFs wählen"
      : "In diesem Browser nicht verfügbar (z. B. iPad Safari)";
  }
  if (clearBtn) {
    clearBtn.disabled = !hasDir;
  }
  if (idbBlock) {
    idbBlock.classList.toggle("is-primary", !hasDir);
  }
}

async function refreshFolderLabel() {
  const el = $("#settings-folder-label");
  if (!el) return;
  if (!supportsDirectoryPicker()) {
    el.textContent =
      "Ordnerwahl nicht verfügbar in diesem Browser. Bitte PDFs aus Dateien aktualisieren.";
    return;
  }
  const handle = await getPdfFolderHandle();
  const info = getFolderIndexInfo();
  if (handle?.name) {
    const countPart =
      info.folderName === handle.name && info.count >= 0
        ? ` · ${info.count} Treffer beim Start eingelesen`
        : "";
    el.textContent = `Aktueller Ordner: ${handle.name}${countPart}`;
  } else {
    el.textContent = "Kein Ordner gewählt (nur Katalog).";
  }
}

async function refreshIdbLabel() {
  const el = $("#settings-idb-label");
  if (!el) return;
  const stats = await getIdbCatalogStats();
  if (!stats.count) {
    el.textContent = "Keine PDFs im Katalog gespeichert.";
    return;
  }
  const when = formatCatalogUpdated(stats.lastUpdated);
  el.textContent = `${stats.count} PDF(s) gespeichert · zuletzt aktualisiert: ${when}`;
}

async function startupCatalogRefresh() {
  syncCatalogPlatformUi();

  if (supportsDirectoryPicker()) {
    const handle = await getPdfFolderHandle();
    if (!handle) {
      await refreshCatalogUi();
      return;
    }
    setStatus("PDF-Ordner wird neu eingelesen…", "busy");
    const result = await reindexPdfFolder();
    await refreshCatalogUi();
    if (result.ok) {
      setStatus(
        result.count
          ? `Ordner „${result.folderName || handle.name}“: ${result.count} Treffer eingelesen`
          : `Ordner „${result.folderName || handle.name}“: keine PDFs gefunden`,
        "ok"
      );
    } else if (result.reason === "permission") {
      setStatus("PDF-Ordner: Zugriff verweigert", "error");
      showToast("Ordnerzugriff nicht erteilt — in den Einstellungen erneut wählen.");
    }
    return;
  }

  const stats = await getIdbCatalogStats();
  await refreshCatalogUi();
  const wantPrompt = state.settings.autoRefreshPrompt !== false;
  if (wantPrompt) {
    showRefreshBanner();
    if (stats.count > 0) {
      setStatus(`Katalog: ${stats.count} PDF(s) · ggf. aktualisieren`, "ok");
    } else {
      setStatus("Bereit – PDFs aus Dateien aktualisieren oder scannen");
    }
  } else {
    setStatus(
      stats.count
        ? `Bereit · Katalog: ${stats.count} PDF(s)`
        : "Bereit"
    );
  }
}

function wireScanUi() {
  $("#btn-go-scan")?.addEventListener("click", () => showScanView());
  $("#btn-scan-back")?.addEventListener("click", () => {
    showHomeFromScan().catch(() => {});
  });
  $("#btn-scan-start")?.addEventListener("click", () => startScanning());
  document.querySelectorAll("#scan-panel .scan-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyHomeScanMode(btn.getAttribute("data-scan-mode") || "datamatrix");
    });
  });
  applyHomeScanMode(getHomeScanMode());
  $("#btn-scan-stop")?.addEventListener("click", () => stopScanning());
  $("#btn-not-found-open")?.addEventListener("click", (e) => {
    e.preventDefault();
    pickAndOpen();
  });
  $("#btn-pick-folder")?.addEventListener("click", async () => {
    try {
      const handle = await pickPdfFolder();
      const info = getFolderIndexInfo();
      showToast(`Ordner „${handle.name}“ · ${info.count} Treffer eingelesen`);
      await refreshCatalogUi();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      showToast(err?.message || "Ordner konnte nicht gewählt werden");
    }
  });
  $("#btn-clear-folder")?.addEventListener("click", async () => {
    await clearPdfFolderHandle();
    await refreshCatalogUi();
    showToast("Ordnerzuordnung entfernt");
  });
  $("#btn-refresh-pdfs")?.addEventListener("click", () => triggerPdfCatalogPick());
  $("#btn-banner-refresh-pdfs")?.addEventListener("click", () => triggerPdfCatalogPick());
  $("#btn-banner-dismiss")?.addEventListener("click", () => dismissRefreshBanner());
  $("#pdf-catalog-input")?.addEventListener("change", () => onPdfCatalogFilesSelected());
  $("#btn-clear-idb-catalog")?.addEventListener("click", async () => {
    await clearIdbCatalog();
    await refreshCatalogUi();
    showToast("Gespeicherte PDFs gelöscht");
  });
  $("#settings-auto-refresh-prompt")?.addEventListener("change", () => {
    readGenSettingsFromForm();
    saveSettings();
  });
}

function init() {
  loadSettings();
  syncThemeChrome();
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncThemeChrome();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (_) {}
  setStatus("Bereit");
  refreshJobsHeader();
  refreshHomePreview();
  wireGenSettingsInputs();
  try {
    const pending = sessionStorage.getItem('bg-gen-pending-input');
    if (pending) {
      state.pendingInputText = pending;
      const input = $("#job-input");
      if (input) input.value = pending;
    }
  } catch (_) {}

  $("#job-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  });
  $("#btn-send").addEventListener("click", onSubmit);
  $("#btn-gen-settings").addEventListener("click", openGenSettings);
  $("#example-link").addEventListener("click", (e) => {
    e.preventDefault();
    const input = $("#job-input");
    input.value = EXAMPLE;
    state.pendingInputText = EXAMPLE;
    try { sessionStorage.setItem('bg-gen-pending-input', EXAMPLE); } catch (_) {}
    input.focus();
  });
  $("#jobs-header").addEventListener("click", () => {
    state.jobsExpanded = !state.jobsExpanded;
    $("#jobs-panel").classList.toggle("hidden", !state.jobsExpanded);
    refreshJobsHeader();
  });
  $("#gen-settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    closeGenSettings();
  });
  $("#btn-gen-settings-done").addEventListener("click", (e) => {
    e.preventDefault();
    closeGenSettings();
  });

  const exVals = document.querySelector("#example-link .example-values");
  if (exVals) exVals.textContent = EXAMPLE;

  wireScanUi();
  initFill();
  registerSW();
  startupCatalogRefresh().catch((err) => {
    console.warn("startup catalog refresh", err);
  });
}

init();

/** Called from fill.js after a successful Sichern in stamp mode. */
export function onStampSaved(pendingQty) {
  const qty = parseInt(pendingQty, 10) || 0;
  if (qty && state.settings.autoIncrement) {
    state.settings.startnummer =
      (parseInt(state.settings.startnummer, 10) || 0) + qty;
    saveSettings();
    refreshHomePreview();
    syncGenSettingsForm();
  }
  // Clear generator input only after Sichern of a generated job (not PDF öffnen).
  state.pendingInputText = "";
  try { sessionStorage.removeItem('bg-gen-pending-input'); } catch (_) {}
  const input = $("#job-input");
  if (input) input.value = "";
}

export function getSaveMode() {
  return state.settings.saveMode || "auto";
}

/** After Schließen ohne Speichern — keep last generator text in the pill. */
export function restorePendingJobInput() {
  const input = $("#job-input");
  if (!input) return;
  if (!state.pendingInputText) {
    try { state.pendingInputText = sessionStorage.getItem('bg-gen-pending-input') || ''; } catch (_) {}
  }
  if (state.pendingInputText) {
    input.value = state.pendingInputText;
  }
}
