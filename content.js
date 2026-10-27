let isAutoSweeping = false;
let stopRequested = false;
let latestDecryptedVideoBlobUrl = "";
let latestDecryptedImageBlobUrl = "";

// =========================================================
// THE 3-SECTION STATUS & CHANNEL ROOM ARCHITECTURE
// Sec 1: Photos Vault (Set P)
// Sec 2: Videos Vault (Set V)
// Sec 3: Duplicate Quarantine (Set D — 64-bit FNV-1a Hash Deduplicated)
// =========================================================
const statusRoom = {
  photoVault: new Map(),      // fpHash -> record
  videoVault: new Map(),      // fpHash -> record
  duplicateVault: new Map(),  // fpHash -> record
  seenFingerprints: new Set(),
  seenBlobUrls: new Set(),

  reset() {
    this.photoVault.clear();
    this.videoVault.clear();
    this.duplicateVault.clear();
    this.seenFingerprints.clear();
    this.seenBlobUrls.clear();
  }
};

// 64-Bit FNV-1a Mathematical Hash Function
function fnv1a64Hash(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const pendingRpcMap = new Map();
let rpcCounter = 0;

let tabAudioCtx = null;
function engageTabBackgroundLock() {
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request("whatsappswift_tab_scan_lock", () => new Promise(() => {}));
    }
    if (!tabAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        tabAudioCtx = new Ctx();
        const osc = tabAudioCtx.createOscillator();
        const gain = tabAudioCtx.createGain();
        gain.gain.value = 0.00001;
        osc.connect(gain);
        gain.connect(tabAudioCtx.destination);
        osc.start();
      }
    } else if (tabAudioCtx.state === "suspended") {
      tabAudioCtx.resume().catch(() => {});
    }
  } catch (_) {}
}

function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        updateHUDStatus("⚠️ Extension reloaded! Press F5 to refresh WhatsApp Web.");
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({ action: "BG_UNTHROTTLED_SLEEP", ms }, () => done());
      } else {
        setTimeout(done, ms);
      }
    } catch (_) {
      setTimeout(done, ms);
    }
  });
}

function callMainWorld(cmd, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const reqId = ++rpcCounter;
    let handled = false;
    const finish = (val) => {
      if (handled) return;
      handled = true;
      pendingRpcMap.delete(reqId);
      resolve(val);
    };
    sleep(timeoutMs).then(() => finish(null));
    pendingRpcMap.set(reqId, (result) => finish(result));
    window.postMessage({ source: "WASWIFT_CONTENT", cmd, reqId, payload }, "*");
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "WASWIFT_MAIN") return;
  if (event.data.type === "CMD_RESPONSE") {
    const cb = pendingRpcMap.get(event.data.reqId);
    if (cb) cb(event.data.result);
  } else if (event.data.type === "NEW_DECRYPTED_BLOB") {
    if (event.data.ext === "mp4") {
      latestDecryptedVideoBlobUrl = event.data.blobUrl;
    } else {
      latestDecryptedImageBlobUrl = event.data.blobUrl;
    }
  }
});

// =========================================================
// 1. BULLETPROOF CONTACT STATUS VIEWER DETECTOR
// Works even when video is buffering (0:09 spinner) or src is set on currentSrc!
// =========================================================
function findActiveStatusViewerModal() {
  // Strategy A: Explicit WhatsApp Status V3 Modal attributes
  const explicit = document.querySelector(
    '[data-animate-status-v3-modal-background="true"], [data-testid="status-v3-player"], div[data-animate-modal-backdrop="true"]'
  );
  if (explicit && explicit.offsetParent !== null) return explicit;

  // Strategy B: Any visible <video> element outside the left sidebar (#pane-side) and outside #main chat
  const allVideos = Array.from(document.querySelectorAll("video"));
  for (const v of allVideos) {
    if (v.closest("#pane-side") || v.closest("#main")) continue;
    const r = v.getBoundingClientRect();
    if (r.width >= 180 && r.height >= 180) {
      return findTopOverlayContainer(v);
    }
  }

  // Strategy C: Look for Status Player top-right Pause / Mute buttons or "Reply..." input outside #main
  const pauseOrMute = document.querySelector(
    'span[data-icon="status-media-controls-pause"], span[data-icon="status-media-controls-play"], span[data-icon="status-media-controls-mute"], span[data-icon="status-media-controls-unmute"], button[aria-label="Pause"], button[aria-label="Mute"]'
  );
  if (pauseOrMute && !pauseOrMute.closest("#main")) {
    return findTopOverlayContainer(pauseOrMute);
  }

  // Strategy D: Any large image (width >= 220px) rendered in a full-screen overlay outside #main and #pane-side
  const allImgs = Array.from(document.querySelectorAll("img"));
  for (const img of allImgs) {
    if (img.closest("#pane-side") || img.closest("#main")) continue;
    const r = img.getBoundingClientRect();
    if (r.width >= 220 && r.height >= 220) {
      return findTopOverlayContainer(img);
    }
  }

  return null;
}

function findTopOverlayContainer(childEl) {
  let curr = childEl.parentElement;
  let best = childEl.parentElement;
  while (curr && curr !== document.body && curr !== document.documentElement) {
    const r = curr.getBoundingClientRect();
    if (r.width >= window.innerWidth * 0.55 && r.height >= window.innerHeight * 0.65) {
      best = curr;
    }
    curr = curr.parentElement;
  }
  return best || document.body;
}

// =========================================================
// 2. WHATSAPP CHANNEL STATUS DETECTOR (UPDATES / CHANNELS TAB)
// Detects when the user is viewing a WhatsApp Channel or Updates drawer
// =========================================================
function findActiveWhatsAppChannelView() {
  // Check if #main or the active panel is a WhatsApp Channel (contains "followers" or Channel header/updates)
  const mainPane = document.querySelector("#main");
  if (mainPane) {
    const headerText = (mainPane.querySelector("header")?.innerText || "").toLowerCase();
    const hasFollowersText =
      headerText.includes("follower") ||
      headerText.includes("channel") ||
      Boolean(mainPane.querySelector('[data-testid*="newsletter"], [data-icon*="newsletter"], [aria-label*="channel" i]'));

    // Also check if the user is in the Updates/Channels tab side panel
    const isUpdatesTabOpen = Boolean(
      document.querySelector('[aria-label*="Channels" i], [aria-label*="Updates" i], [data-icon*="status-v3"], [data-icon*="newsletter"]')
    );

    if (hasFollowersText) {
      return mainPane;
    }
  }

  // Also check if a full-screen Media Viewer (when you click a photo/video inside a WhatsApp Channel) is open
  const mediaViewer = document.querySelector('[data-animate-media-viewer="true"]');
  if (mediaViewer) return mediaViewer;

  return null;
}

function getContactOrChannelName(viewerRoot, isChannel = false) {
  try {
    if (isChannel) {
      const header = document.querySelector("#main header") || viewerRoot?.querySelector("header");
      if (header) {
        const titleSpan = header.querySelector('span[dir="auto"]');
        const raw = (titleSpan?.innerText || titleSpan?.textContent || "").trim();
        if (raw) {
          return "Channel_" + raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim().replace(/\s+/g, "_").slice(0, 40);
        }
      }
      return "WhatsApp_Channel";
    }

    if (viewerRoot) {
      const spans = Array.from(viewerRoot.querySelectorAll('span[dir="auto"], div[role="button"] span'));
      for (const s of spans) {
        const txt = (s.innerText || s.textContent || "").trim();
        if (
          txt &&
          txt.length >= 2 &&
          txt.length <= 45 &&
          !txt.toLowerCase().includes("today") &&
          !txt.toLowerCase().includes("yesterday") &&
          !txt.toLowerCase().includes("reply") &&
          !txt.toLowerCase().includes("type a") &&
          !/^\d{1,2}:\d{2}/.test(txt)
        ) {
          const clean = txt.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim().replace(/\s+/g, "_");
          if (clean) return clean;
        }
      }
    }
  } catch (_) {}
  return isChannel ? "WhatsApp_Channel" : "WhatsApp_Status";
}

function getActiveStatusMediaElement(viewerRoot) {
  const searchRoot = viewerRoot || document.body;

  // 1. Check for ANY visible <video> element (even if src is in currentSrc or still buffering!)
  const videos = Array.from(searchRoot.querySelectorAll("video")).filter((v) => {
    if (v.closest("#pane-side")) return false;
    const r = v.getBoundingClientRect();
    return r.width >= 160 && r.height >= 160;
  });

  if (videos.length > 0) {
    const v = videos[0];
    const sourceEl = v.querySelector("source");
    const blobUrl = v.currentSrc || v.src || sourceEl?.src || latestDecryptedVideoBlobUrl;
    return {
      el: v,
      blobUrl,
      isVideo: true
    };
  }

  // 2. Check for large Status/Channel Photo (width >= 180px, strictly ignoring small 40px profile avatars)
  const imgs = Array.from(searchRoot.querySelectorAll("img")).filter((img) => {
    if (img.closest("#pane-side")) return false;
    const r = img.getBoundingClientRect();
    const w = Math.max(img.naturalWidth || 0, r.width || 0);
    const h = Math.max(img.naturalHeight || 0, r.height || 0);
    return w >= 180 && h >= 180 && (img.src || "").startsWith("blob:");
  });

  if (imgs.length > 0) {
    imgs.sort((a, b) => {
      const areaA = (a.naturalWidth || a.clientWidth) * (a.naturalHeight || a.clientHeight);
      const areaB = (b.naturalWidth || b.clientWidth) * (b.naturalHeight || b.clientHeight);
      return areaB - areaA;
    });
    return {
      el: imgs[0],
      blobUrl: imgs[0].src,
      isVideo: false
    };
  }

  return null;
}

// =========================================================
// ZERO-CRASH FLOATING HOVER BUTTON (Works on WhatsApp Channel Photos/Videos & Status Media!)
// =========================================================
let floatingHoverBtn = null;
let hoveredMediaTarget = null;

function initHoverDownloadSystem() {
  if (floatingHoverBtn) return;

  floatingHoverBtn = document.createElement("button");
  floatingHoverBtn.id = "waswift-floating-hover-btn";
  floatingHoverBtn.className = "wa-floating-hover-btn";
  floatingHoverBtn.innerHTML = "⬇ Download Status";
  floatingHoverBtn.style.display = "none";

  floatingHoverBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoveredMediaTarget) return;
    await downloadHoveredMediaElement(hoveredMediaTarget, floatingHoverBtn);
  });

  document.documentElement.appendChild(floatingHoverBtn);

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!floatingHoverBtn) return;
      if (e.target === floatingHoverBtn || floatingHoverBtn.contains(e.target)) return;

      const statusModal = findActiveStatusViewerModal();
      const channelView = findActiveWhatsAppChannelView();
      if (!statusModal && !channelView) {
        floatingHoverBtn.style.display = "none";
        return;
      }

      const mediaEl = e.target?.closest?.("video, img");
      if (!mediaEl || mediaEl.closest("#pane-side")) return;

      const rect = mediaEl.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 140) return;

      hoveredMediaTarget = {
        el: mediaEl,
        isVideo: mediaEl.tagName.toLowerCase() === "video",
        isChannel: Boolean(channelView && !statusModal)
      };

      floatingHoverBtn.style.top = `${Math.max(12, rect.top + 12)}px`;
      floatingHoverBtn.style.left = `${Math.max(12, rect.left + 12)}px`;
      floatingHoverBtn.style.display = "block";
    },
    { passive: true }
  );
}

async function downloadHoveredMediaElement(targetInfo, btnEl) {
  const origText = btnEl.innerHTML;
  btnEl.disabled = true;
  btnEl.innerHTML = "⏳ Saving...";

  try {
    const el = targetInfo.el;
    const isVideo = targetInfo.isVideo;
    const blobUrl =
      el.currentSrc ||
      el.src ||
      el.querySelector?.("source")?.src ||
      (isVideo ? latestDecryptedVideoBlobUrl : latestDecryptedImageBlobUrl);

    const folderName = getContactOrChannelName(
      findActiveStatusViewerModal() || findActiveWhatsAppChannelView(),
      targetInfo.isChannel
    );

    createOrShowHUD(folderName);
    const resolved = await callMainWorld(
      "RESOLVE_STATUS_BLOB",
      { blobUrl, preferVideo: isVideo },
      5500
    );

    if (!resolved || !resolved.ok || !resolved.dataUrl) {
      updateHUDStatus("⚠️ Click the video/photo once so WhatsApp decrypts it, then click Download!");
      btnEl.innerHTML = "⚠️ Click Video First";
      return;
    }

    const fpHash = fnv1a64Hash(resolved.signatureSeed || `${resolved.size}|${blobUrl}`);
    const shortHash = fpHash.slice(0, 10);
    const filename = `${folderName}_${shortHash}.${resolved.ext}`;

    const record = {
      username: folderName,
      shortcode: shortHash,
      url: resolved.dataUrl,
      filename,
      isVideo: resolved.ext === "mp4"
    };

    await safeSendMessage({ action: "QUEUE_SINGLE_MEDIA", items: [record] });
    updateHUDStatus(`✅ Saved ${filename} to Downloads/WhatsApp_Status/${folderName}/!`);
    btnEl.innerHTML = "✓ Saved!";
  } finally {
    setTimeout(() => {
      btnEl.disabled = false;
      btnEl.innerHTML = origText;
    }, 1800);
  }
}

// =========================================================
// PERMANENT DOCK + TOP STATUS BAR CONTROLLER
// =========================================================
function syncStatusAndChannelUi() {
  initHoverDownloadSystem();

  const statusViewer = findActiveStatusViewerModal();
  const channelView = findActiveWhatsAppChannelView();

  // Always keep the bottom-right 3-Room Status HUD available on WhatsApp Web!
  const activeName = statusViewer
    ? getContactOrChannelName(statusViewer, false)
    : channelView
    ? getContactOrChannelName(channelView, true)
    : "WhatsApp_Status";

  createOrShowHUD(activeName);
  ensureTopActionBar(statusViewer, channelView, activeName);

  // If a Contact Status or Channel Media Viewer is open, passively capture its decrypted blob into the 3-Section Room
  if (statusViewer) {
    captureCurrentStatusIntoRoom(statusViewer, activeName, false);
  } else if (channelView) {
    harvestVisibleChannelMediaIntoRoom(channelView, activeName);
  }
}

setTimeout(syncStatusAndChannelUi, 900);
setInterval(syncStatusAndChannelUi, 650);

function ensureTopActionBar(statusViewer, channelView, activeName) {
  let bar = document.getElementById("waswift-status-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "waswift-status-bar";
    bar.innerHTML = `
      <button id="wa-dl-this-status" class="wa-status-btn">⬇ Download This Status</button>
      <button id="wa-dl-all-contact" class="wa-status-btn wa-status-btn-all">⚡ Download All (Auto-Step / Channel)</button>
      <button id="wa-dl-room-vault" class="wa-status-btn wa-status-btn-vault">📦 Save Captured (0)</button>
    `;
    document.documentElement.appendChild(bar);

    document.getElementById("wa-dl-this-status").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await downloadCurrentSingleStatus();
    });

    document.getElementById("wa-dl-all-contact").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleDownloadAllClick();
    });

    document.getElementById("wa-dl-room-vault").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await flushEntireStatusRoomToDisk();
    });
  }

  // Show the top bar whenever a Status OR a WhatsApp Channel is open!
  if (statusViewer || channelView) {
    bar.style.display = "flex";
  } else {
    bar.style.display = "none";
  }

  const vaultBtn = document.getElementById("wa-dl-room-vault");
  const totalUnique = statusRoom.photoVault.size + statusRoom.videoVault.size;
  if (vaultBtn) {
    vaultBtn.textContent = `📦 Save Captured (${totalUnique})`;
  }
}

async function handleDownloadAllClick() {
  const statusViewer = findActiveStatusViewerModal();
  if (statusViewer) {
    await sweepAndDownloadAllStatusesForContact();
    return;
  }
  const channelView = findActiveWhatsAppChannelView();
  if (channelView) {
    await scanAndDownloadWhatsAppChannel(channelView);
    return;
  }
  await flushEntireStatusRoomToDisk();
}

// =========================================================
// CORE CAPTURE & DOWNLOAD LOGIC (CONTACT STATUS + CHANNEL STATUS)
// =========================================================
async function captureCurrentStatusIntoRoom(viewerRoot, contactName, forceResolve = false) {
  const activeMedia = getActiveStatusMediaElement(viewerRoot);
  const blobUrl = activeMedia?.blobUrl || latestDecryptedVideoBlobUrl || latestDecryptedImageBlobUrl;
  const isVideo = activeMedia ? activeMedia.isVideo : Boolean(latestDecryptedVideoBlobUrl);

  if (!blobUrl && !forceResolve) return null;
  if (!forceResolve && blobUrl && statusRoom.seenBlobUrls.has(blobUrl)) return null;
  if (blobUrl) statusRoom.seenBlobUrls.add(blobUrl);

  const resolved = await callMainWorld(
    "RESOLVE_STATUS_BLOB",
    { blobUrl, preferVideo: isVideo },
    5500
  );
  if (!resolved || !resolved.ok || !resolved.dataUrl) return null;

  return partitionResolvedBlobIntoRoom(resolved, contactName);
}

function partitionResolvedBlobIntoRoom(resolved, folderName) {
  const fpHash = fnv1a64Hash(resolved.signatureSeed || `${resolved.size}|${resolved.blobUrl}`);
  const shortHash = fpHash.slice(0, 10);
  const filename = `${folderName}_${shortHash}.${resolved.ext}`;

  const record = {
    username: folderName,
    shortcode: shortHash,
    url: resolved.dataUrl,
    filename,
    isVideo: resolved.ext === "mp4"
  };

  if (statusRoom.seenFingerprints.has(fpHash)) {
    statusRoom.duplicateVault.set(fpHash, record);
  } else {
    statusRoom.seenFingerprints.add(fpHash);
    if (record.isVideo) {
      statusRoom.videoVault.set(fpHash, record);
    } else {
      statusRoom.photoVault.set(fpHash, record);
    }
  }

  updateRoomHUDCounters();
  safeSendMessage({
    action: "UPDATE_ROOM_COUNTS",
    gridCount: statusRoom.photoVault.size,
    reelsCount: statusRoom.videoVault.size,
    dupsCount: statusRoom.duplicateVault.size
  });

  return record;
}

// Harvests all decrypted photos/videos inside a WhatsApp Channel feed into the 3-Section Room
async function harvestVisibleChannelMediaIntoRoom(channelRoot, channelName) {
  const mediaEls = Array.from(
    channelRoot.querySelectorAll('video, img[src^="blob:"]')
  ).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 130 && r.height >= 130;
  });

  for (const el of mediaEls) {
    const isVideo = el.tagName.toLowerCase() === "video";
    const blobUrl = el.currentSrc || el.src || el.querySelector?.("source")?.src;
    if (!blobUrl || statusRoom.seenBlobUrls.has(blobUrl)) continue;
    statusRoom.seenBlobUrls.add(blobUrl);

    const resolved = await callMainWorld(
      "RESOLVE_STATUS_BLOB",
      { blobUrl, preferVideo: isVideo },
      4500
    );
    if (resolved && resolved.ok && resolved.dataUrl) {
      partitionResolvedBlobIntoRoom(resolved, channelName);
    }
  }
}

// 1. Download Current Single Status (Contact Status or Open Channel Media)
async function downloadCurrentSingleStatus() {
  const viewer = findActiveStatusViewerModal() || findActiveWhatsAppChannelView() || document.body;
  const isChannel = Boolean(!findActiveStatusViewerModal() && findActiveWhatsAppChannelView());
  const folderName = getContactOrChannelName(viewer, isChannel);

  createOrShowHUD(folderName);
  updateHUDStatus(`Capturing HD Status from @${folderName}...`);

  const btn = document.getElementById("wa-dl-this-status");
  const hudBtn = document.getElementById("wa-hud-dl-curr");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Saving..."; }
  if (hudBtn) { hudBtn.disabled = true; hudBtn.textContent = "⏳ Saving..."; }

  try {
    const record = await captureCurrentStatusIntoRoom(viewer, folderName, true);
    if (!record) {
      updateHUDStatus("⚠️ Video/Photo is still buffering! Wait 1 second for spinner to finish, then click Download.");
      return;
    }

    await safeSendMessage({
      action: "QUEUE_SINGLE_MEDIA",
      items: [record]
    });
    updateHUDStatus(`✅ Saved ${record.filename} to Downloads/WhatsApp_Status/${folderName}/!`);
  } finally {
    setTimeout(() => {
      if (btn) { btn.disabled = false; btn.textContent = "⬇ Download This Status"; }
      if (hudBtn) { hudBtn.disabled = false; hudBtn.textContent = "⬇ This Status"; }
    }, 1200);
  }
}

// 2. Auto-Step & Bulk Download All Statuses for Current Contact
async function sweepAndDownloadAllStatusesForContact() {
  if (isAutoSweeping) return;
  const viewer = findActiveStatusViewerModal();
  if (!viewer) return;

  isAutoSweeping = true;
  stopRequested = false;
  engageTabBackgroundLock();

  const startContact = getContactOrChannelName(viewer, false);
  createOrShowHUD(startContact);
  updateHUDStatus(`Auto-stepping all Statuses for @${startContact}...`);

  const allBtn = document.getElementById("wa-dl-all-contact");
  if (allBtn) { allBtn.disabled = true; allBtn.textContent = "⏳ Auto-Stepping..."; }

  try {
    const contactBatch = [];
    const contactSeenHashes = new Set();
    let stepCount = 0;

    while (!stopRequested && stepCount < 45) {
      stepCount++;
      const currViewer = findActiveStatusViewerModal();
      if (!currViewer) break;

      const currContact = getContactOrChannelName(currViewer, false);
      if (currContact !== startContact && stepCount > 1) break;

      const record = await captureCurrentStatusIntoRoom(currViewer, startContact, true);
      if (record && !contactSeenHashes.has(record.shortcode)) {
        contactSeenHashes.add(record.shortcode);
        contactBatch.push(record);
      }

      updateHUDStatus(
        `Scanning @${startContact} Status (Slide ${stepCount} • Captured: ${contactBatch.length})...`
      );

      const nextClicked = triggerNextStatusSlide(currViewer);
      if (!nextClicked) break;

      await sleep(800);
    }

    if (contactBatch.length > 0) {
      await safeSendMessage({ action: "QUEUE_MEDIA", items: contactBatch });
      await safeSendMessage({ action: "SCAN_FINISHED" });
      updateHUDStatus(`✅ Bulk Downloading ${contactBatch.length} Statuses for @${startContact}!`);
    } else {
      updateHUDStatus("⚠️ Wait for the Status video spinner to finish loading, then click again.");
    }
  } finally {
    isAutoSweeping = false;
    if (allBtn) {
      allBtn.disabled = false;
      allBtn.textContent = "⚡ Download All (Auto-Step / Channel)";
    }
  }
}

// 3. Scan & Bulk Download WhatsApp Channel Statuses (Scrolls Channel Feed -> Deduplicates in 3-Room -> Downloads All)
async function scanAndDownloadWhatsAppChannel(channelRoot) {
  if (isAutoSweeping) return;
  isAutoSweeping = true;
  stopRequested = false;
  engageTabBackgroundLock();

  const channelName = getContactOrChannelName(channelRoot, true);
  createOrShowHUD(channelName);
  updateHUDStatus(`Scanning WhatsApp Channel @${channelName} into 3-Room Vault...`);

  const allBtn = document.getElementById("wa-dl-all-contact");
  if (allBtn) { allBtn.disabled = true; allBtn.textContent = "⏳ Scanning Channel..."; }

  try {
    const scroller =
      channelRoot.querySelector('[data-testid="conversation-panel-messages"]') ||
      channelRoot.querySelector('div[role="application"]')?.parentElement ||
      channelRoot;

    let idleTicks = 0;
    let lastRoomSize = statusRoom.photoVault.size + statusRoom.videoVault.size;

    while (!stopRequested && idleTicks < 5) {
      await harvestVisibleChannelMediaIntoRoom(channelRoot, channelName);

      // Scroll up/down through Channel history to load more Channel statuses
      if (scroller && scroller.scrollTop > 200) {
        scroller.scrollBy(0, -1200);
      } else if (scroller) {
        scroller.scrollBy(0, 1200);
      }
      await sleep(750);
      await harvestVisibleChannelMediaIntoRoom(channelRoot, channelName);

      const currSize = statusRoom.photoVault.size + statusRoom.videoVault.size;
      updateHUDStatus(
        `Channel Scan (@${channelName}) • Photos: ${statusRoom.photoVault.size} | Videos: ${statusRoom.videoVault.size} | Dups: ${statusRoom.duplicateVault.size}`
      );

      if (currSize > lastRoomSize) {
        idleTicks = 0;
        lastRoomSize = currSize;
      } else {
        idleTicks++;
      }
    }

    await flushEntireStatusRoomToDisk();
  } finally {
    isAutoSweeping = false;
    if (allBtn) {
      allBtn.disabled = false;
      allBtn.textContent = "⚡ Download All (Auto-Step / Channel)";
    }
  }
}

function triggerNextStatusSlide(viewerRoot) {
  try {
    const buttons = Array.from(viewerRoot.querySelectorAll('button, div[role="button"]'));
    const nextBtn = buttons.find((b) => {
      const label = (b.getAttribute("aria-label") || b.getAttribute("title") || "").toLowerCase();
      if (label.includes("next")) return true;
      const r = b.getBoundingClientRect();
      return r.left > window.innerWidth * 0.65 && r.top > 100 && r.top < window.innerHeight - 100;
    });

    if (nextBtn) {
      nextBtn.click();
      return true;
    }

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, bubbles: true })
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function flushEntireStatusRoomToDisk() {
  const allUnique = [
    ...Array.from(statusRoom.photoVault.values()),
    ...Array.from(statusRoom.videoVault.values())
  ];

  if (allUnique.length === 0) {
    await downloadCurrentSingleStatus();
    return;
  }

  updateHUDStatus(
    `🚀 Bulk Downloading ${allUnique.length} Statuses (Photos: ${statusRoom.photoVault.size} | Videos: ${statusRoom.videoVault.size} | Dups Blocked: ${statusRoom.duplicateVault.size})...`
  );

  await safeSendMessage({ action: "QUEUE_MEDIA", items: allUnique });
  await safeSendMessage({ action: "SCAN_FINISHED" });
}

// =========================================================
// THE PERMANENT 3-SECTION STATUS & CHANNEL ROOM HUD
// Always accessible in bottom-right of WhatsApp Web!
// =========================================================
function createOrShowHUD(contactName) {
  let hud = document.getElementById("whatsappswift-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "whatsappswift-hud";
    hud.innerHTML = `
      <div class="wa-hud-header">
        <span class="wa-hud-title">🟢 WhatsAppSwift v2.0 — <strong id="wa-hud-user">@${contactName}</strong></span>
        <button id="wa-hud-close" title="Minimize">✕</button>
      </div>
      <div class="wa-hud-status" id="wa-hud-status">Ready: Contact Status + Channel Status Mode</div>
      <div class="wa-hud-grid-3">
        <div class="wa-stat-box wa-room-photos">
          <span class="wa-stat-val" id="wa-stat-photos">0</span>
          <span class="wa-stat-lbl">Sec 1: Photos</span>
        </div>
        <div class="wa-stat-box wa-room-videos">
          <span class="wa-stat-val" id="wa-stat-videos">0</span>
          <span class="wa-stat-lbl">Sec 2: Videos</span>
        </div>
        <div class="wa-stat-box wa-room-dups">
          <span class="wa-stat-val" id="wa-stat-dups">0</span>
          <span class="wa-stat-lbl">Sec 3: Dups</span>
        </div>
      </div>
      <div class="wa-disk-line" id="wa-disk-line">Folder: Downloads/WhatsApp_Status/${contactName}/</div>
      <div class="wa-hud-btn-row">
        <button id="wa-hud-dl-curr" class="wa-start-btn">⬇ This Status</button>
        <button id="wa-hud-dl-all" class="wa-all-btn">⚡ Download All</button>
        <button id="wa-hud-stop" class="wa-stop-btn">Stop</button>
      </div>
    `;
    document.documentElement.appendChild(hud);

    document.getElementById("wa-hud-close").addEventListener("click", () => {
      hud.style.display = "none";
    });

    document.getElementById("wa-hud-dl-curr").addEventListener("click", () => {
      downloadCurrentSingleStatus();
    });

    document.getElementById("wa-hud-dl-all").addEventListener("click", () => {
      handleDownloadAllClick();
    });

    document.getElementById("wa-hud-stop").addEventListener("click", async () => {
      stopRequested = true;
      isAutoSweeping = false;
      await safeSendMessage({ action: "USER_EXPLICIT_STOP" });
      updateHUDStatus("Stopped by user.");
    });
  } else {
    const userEl = document.getElementById("wa-hud-user");
    if (userEl && contactName) userEl.textContent = `@${contactName}`;
  }
  updateRoomHUDCounters();
}

function updateRoomHUDCounters() {
  const pEl = document.getElementById("wa-stat-photos");
  const vEl = document.getElementById("wa-stat-videos");
  const dEl = document.getElementById("wa-stat-dups");
  if (pEl) pEl.textContent = statusRoom.photoVault.size;
  if (vEl) vEl.textContent = statusRoom.videoVault.size;
  if (dEl) dEl.textContent = statusRoom.duplicateVault.size;

  const vaultBtn = document.getElementById("wa-dl-room-vault");
  if (vaultBtn) {
    vaultBtn.textContent = `📦 Save Captured (${statusRoom.photoVault.size + statusRoom.videoVault.size})`;
  }
}

function updateHUDStatus(text) {
  const el = document.getElementById("wa-hud-status");
  if (el) el.textContent = text;
}

try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "STATS_UPDATE" && msg.stats) {
      const diskEl = document.getElementById("wa-disk-line");
      if (diskEl && msg.stats.scanned > 0) {
        diskEl.textContent = `Saved: ${msg.stats.downloaded} / ${msg.stats.scanned} Statuses • Speed: ${msg.stats.velocityFps || "Max"}/s`;
      }
    } else if (msg.action === "TRIGGER_SINGLE_FROM_POPUP") {
      downloadCurrentSingleStatus();
      sendResponse({ ok: true });
      return false;
    } else if (msg.action === "TRIGGER_FROM_POPUP") {
      handleDownloadAllClick();
      sendResponse({ ok: true });
      return false;
    }
  });
} catch (_) {}