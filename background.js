let downloadQueue = [];
let activeDownloads = 0;

let adaptiveConcurrency = 6;
const MIN_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

const EWMA_ALPHA = 0.35;
let ewmaVelocityFps = 0;
let lastCompletionWindowTs = Date.now();
let completionsInWindow = 0;
let currentSessionEpoch = 0;

const sessionFileLock = new Set();
const downloadMap = new Map();
const pendingSleeps = [];

let stats = {
  username: "",
  status: "Contact & Channel Status Ready",
  gridCount: 0,
  reelsCount: 0,
  dupsCount: 0,
  scanned: 0,
  downloaded: 0,
  failed: 0,
  concurrency: 6,
  velocityFps: 0
};

function flushDueSleeps() {
  const now = Date.now();
  for (let i = pendingSleeps.length - 1; i >= 0; i--) {
    if (now >= pendingSleeps[i].wakeAt) {
      const entry = pendingSleeps.splice(i, 1)[0];
      try { entry.resolve({ ok: true }); } catch (_) {}
    }
  }
}

async function ensureBackgroundKeepAlive(tabId) {
  if (tabId) {
    try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (_) {}
  }
  try {
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Keep WhatsAppSwift status & channel downloader active in background."
        });
      }
    }
  } catch (_) {}
  try {
    chrome.alarms.create("waswift_v2_watchdog", { periodInMinutes: 0.25 });
  } catch (_) {}
}

async function closeBackgroundKeepAlive() {
  try {
    chrome.alarms.clear("waswift_v2_watchdog");
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "whatsappswift_offscreen_port") {
    port.onMessage.addListener((msg) => {
      if (msg.type === "HEARTBEAT") {
        flushDueSleeps();
        if (downloadQueue.length > 0 && activeDownloads < Math.floor(adaptiveConcurrency)) {
          processQueue();
        }
      }
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "waswift_v2_watchdog") {
    flushDueSleeps();
    processQueue();
    broadcastStats();
  }
});

function sanitizeWindowsName(name, fallback = "Status") {
  if (!name) return fallback;
  let clean = String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.+$/g, "").trim();
  if (!clean || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(clean)) clean = `${fallback}_${clean}`;
  return clean;
}

function buildSafeRelativePath(username, filename) {
  const safeUser = sanitizeWindowsName(username, "Contact");
  const parts = String(filename || "status.jpg").split(".");
  const ext = sanitizeWindowsName(parts.pop() || "jpg", "jpg");
  const base = sanitizeWindowsName(parts.join("."), "status");
  return `WhatsApp_Status/${safeUser}/${base}.${ext}`;
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (downloadMap.has(downloadItem.id)) {
    const entry = downloadMap.get(downloadItem.id);
    const forcedPath = buildSafeRelativePath(entry.item.username, entry.item.filename);
    suggest({ filename: forcedPath, conflictAction: "uniquify" });
    return;
  }
  suggest();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "OFFSCREEN_HEARTBEAT") {
    flushDueSleeps();
    if (downloadQueue.length > 0 && activeDownloads < Math.floor(adaptiveConcurrency)) {
      processQueue();
    }
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "BG_UNTHROTTLED_SLEEP") {
    ensureBackgroundKeepAlive(sender?.tab?.id);
    const ms = Math.max(20, Number(message.ms) || 300);
    pendingSleeps.push({ wakeAt: Date.now() + ms, resolve: sendResponse });
    setTimeout(flushDueSleeps, ms);
    return true;
  }
  else if (message.action === "UPDATE_ROOM_COUNTS") {
    stats.gridCount = message.gridCount || 0;
    stats.reelsCount = message.reelsCount || 0;
    stats.dupsCount = message.dupsCount || 0;
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "QUEUE_MEDIA" || message.action === "QUEUE_SINGLE_MEDIA") {
    ensureBackgroundKeepAlive(sender?.tab?.id);
    const items = message.items || [];
    for (const item of items) {
      const cleanUser = sanitizeWindowsName(item.username || "WhatsApp_Status");
      const fileKey = `${cleanUser}/${item.filename}`;

      if (message.action === "QUEUE_MEDIA" && sessionFileLock.has(fileKey)) {
        continue;
      }

      sessionFileLock.add(fileKey);
      stats.username = cleanUser;
      stats.scanned++;
      const qObj = { ...item, username: cleanUser, epoch: currentSessionEpoch, retries: 0 };
      if (message.action === "QUEUE_SINGLE_MEDIA") {
        qObj.isSinglePriority = true;
        downloadQueue.unshift(qObj);
      } else {
        downloadQueue.push(qObj);
      }
    }
    stats.status = `Saving Statuses (${stats.downloaded} / ${stats.scanned})...`;
    broadcastStats();
    processQueue();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "SCAN_FINISHED") {
    if (activeDownloads === 0 && downloadQueue.length === 0) {
      stats.status = "Completed";
      closeBackgroundKeepAlive();
    }
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "USER_EXPLICIT_STOP") {
    currentSessionEpoch++;
    downloadQueue = [];
    for (const [dlId] of downloadMap.entries()) {
      downloadMap.delete(dlId);
      try { chrome.downloads.cancel(dlId, () => {}); } catch (_) {}
    }
    activeDownloads = 0;
    stats.status = "Stopped";
    closeBackgroundKeepAlive();
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "GET_STATS") {
    sendResponse(stats);
    return false;
  }
  return false;
});

function processQueue() {
  const maxAllowed = Math.floor(adaptiveConcurrency);
  while (activeDownloads < maxAllowed && downloadQueue.length > 0) {
    const item = downloadQueue.shift();
    if (!item) continue;
    activeDownloads++;
    startDownload(item);
  }
}

function startDownload(item) {
  const filePath = buildSafeRelativePath(item.username, item.filename);
  try {
    chrome.downloads.download(
      { url: item.url, filename: filePath, conflictAction: "uniquify", saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          handleDownloadFailure(item);
        } else {
          downloadMap.set(downloadId, { item, startedAt: Date.now(), epoch: item.epoch });
        }
      }
    );
  } catch (_) {
    handleDownloadFailure(item);
  }
}

function handleDownloadFailure(item) {
  activeDownloads = Math.max(0, downloadMap.size);
  if (item.retries < 2 && stats.status !== "Stopped") {
    item.retries++;
    downloadQueue.push(item);
    processQueue();
  } else {
    stats.failed++;
    checkCompletion();
    broadcastStats();
    processQueue();
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadMap.has(delta.id)) return;
  const entry = downloadMap.get(delta.id);
  if (delta.state && delta.state.current === "complete") {
    downloadMap.delete(delta.id);
    activeDownloads = Math.max(0, downloadMap.size);
    stats.downloaded++;

    completionsInWindow++;
    const windowSec = (Date.now() - lastCompletionWindowTs) / 1000;
    if (windowSec >= 0.8) {
      ewmaVelocityFps = Number((EWMA_ALPHA * (completionsInWindow / windowSec) + (1 - EWMA_ALPHA) * ewmaVelocityFps).toFixed(1));
      stats.velocityFps = ewmaVelocityFps;
      completionsInWindow = 0;
      lastCompletionWindowTs = Date.now();
    }
    checkCompletion();
    broadcastStats();
    processQueue();
  } else if (delta.state && delta.state.current === "interrupted") {
    downloadMap.delete(delta.id);
    handleDownloadFailure(entry.item);
  }
});

function checkCompletion() {
  if (stats.status === "Stopped") return;
  if (activeDownloads === 0 && downloadQueue.length === 0 && stats.scanned > 0) {
    stats.status = `✅ Saved ${stats.downloaded} / ${stats.scanned} Statuses!`;
    closeBackgroundKeepAlive();
  } else if (stats.scanned > 0) {
    stats.status = `Saving Statuses (${stats.downloaded} / ${stats.scanned})...`;
  }
}

function broadcastStats() {
  try {
    chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;
      for (const tab of tabs) {
        if (!tab?.id) continue;
        try {
          chrome.tabs.sendMessage(tab.id, { action: "STATS_UPDATE", stats }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) {}
      }
    });
  } catch (_) {}
}