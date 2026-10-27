(function () {
  if (window.__whatsAppSwiftV2Loaded) return;
  window.__whatsAppSwiftV2Loaded = true;

  // Stores decrypted WhatsApp Media Blobs: blobUrl -> { blob, size, mime, ext, createdAt }
  const blobVault = new Map();
  // Ordered list of most recently created large video/image blobs (for instant fallback when a video is still buffering in DOM!)
  const recentMediaBlobs = [];

  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;

  function mimeToExt(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("video/mp4") || m.includes("video/")) return "mp4";
    if (m.includes("image/png")) return "png";
    if (m.includes("image/webp")) return "webp";
    if (m.includes("image/gif")) return "gif";
    if (m.includes("audio/ogg") || m.includes("audio/")) return "ogg";
    return "jpg";
  }

  // 1. Hook URL.createObjectURL to capture every decrypted Status & Channel media blob
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL.apply(this, arguments);
    try {
      if (obj instanceof Blob && obj.size > 10000) {
        const mime = (obj.type || "").toLowerCase();
        if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) {
          const entry = {
            blobUrl,
            blob: obj,
            size: obj.size,
            mime,
            ext: mimeToExt(mime),
            createdAt: Date.now()
          };
          blobVault.set(blobUrl, entry);
          recentMediaBlobs.unshift(entry);

          if (recentMediaBlobs.length > 180) {
            const removed = recentMediaBlobs.pop();
            if (removed && blobVault.size > 200) {
              blobVault.delete(removed.blobUrl);
            }
          }

          // Notify content script immediately when a new video or large image blob is decrypted
          window.postMessage(
            {
              source: "WASWIFT_MAIN",
              type: "NEW_DECRYPTED_BLOB",
              blobUrl,
              size: obj.size,
              mime,
              ext: entry.ext
            },
            "*"
          );
        }
      }
    } catch (_) {}
    return blobUrl;
  };

  // 2. Prevent WhatsApp from revoking Status/Channel blobs before download finishes
  URL.revokeObjectURL = function (blobUrl) {
    if (blobVault.has(blobUrl)) return;
    return origRevokeObjectURL.apply(this, arguments);
  };

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function resolveBlobUrlForDownload(blobUrl, preferVideoFallback = false) {
    try {
      let entry = blobUrl ? blobVault.get(blobUrl) : null;

      // If blobUrl wasn't in vault, try fetching it directly from page context
      if (!entry && blobUrl && blobUrl.startsWith("blob:")) {
        try {
          const res = await fetch(blobUrl);
          if (res.ok) {
            const blob = await res.blob();
            if (blob.size > 10000) {
              entry = {
                blobUrl,
                blob,
                size: blob.size,
                mime: blob.type || (preferVideoFallback ? "video/mp4" : "image/jpeg"),
                ext: mimeToExt(blob.type || (preferVideoFallback ? "video/mp4" : "image/jpeg"))
              };
              blobVault.set(blobUrl, entry);
            }
          }
        } catch (_) {}
      }

      // Fallback: If video is currently buffering/playing in Status viewer and DOM src wasn't readable, grab the newest decrypted video/image blob!
      if (!entry) {
        if (preferVideoFallback) {
          entry = recentMediaBlobs.find((b) => b.ext === "mp4") || recentMediaBlobs[0];
        } else {
          entry = recentMediaBlobs[0];
        }
      }

      if (!entry || !entry.blob) return { ok: false };

      const dataUrl = await blobToDataUrl(entry.blob);
      const headSample = dataUrl.slice(0, 256);
      const tailSample = dataUrl.slice(-256);

      return {
        ok: true,
        blobUrl: entry.blobUrl,
        dataUrl,
        size: entry.size,
        mime: entry.mime,
        ext: entry.ext,
        signatureSeed: `${entry.size}|${entry.mime}|${headSample}|${tailSample}`
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "WASWIFT_CONTENT") return;
    const { cmd, reqId, payload } = event.data;

    if (cmd === "RESOLVE_STATUS_BLOB") {
      const result = await resolveBlobUrlForDownload(payload.blobUrl, payload.preferVideo);
      window.postMessage({ source: "WASWIFT_MAIN", type: "CMD_RESPONSE", reqId, result }, "*");
    }
  });
})();