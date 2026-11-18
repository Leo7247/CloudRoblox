const SITE_PASSWORD = "262767";
const BEACON_SUBSCRIBE_URL = "https://ntfy.sh/cloudroblox-leo7247-262767-rig/json?poll=1&since=latest";
const WEBRTC_GRACE_MS = 5500;

const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turns:openrelay.metered.ca:443?transport=tcp"
    ],
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

// Screens
const lockScreen = document.getElementById("lockScreen");
const lockCard = document.getElementById("lockCard");
const lobby = document.getElementById("lobby");
const offlineScreen = document.getElementById("offlineScreen");
const streamContainer = document.getElementById("streamContainer");

// Controls
const passwordInput = document.getElementById("passwordInput");
const unlockBtn = document.getElementById("unlockBtn");
const lockError = document.getElementById("lockError");
const serverUrlInput = document.getElementById("serverUrl");
const toggleManualBtn = document.getElementById("toggleManualBtn");
const manualBox = document.getElementById("manualBox");
const qualitySelect = document.getElementById("qualitySelect");
const connectBtn = document.getElementById("connectBtn");
const statusText = document.getElementById("statusText");
const rigStatusPill = document.getElementById("rigStatusPill");
const rigStatusLabel = document.getElementById("rigStatusLabel");
const offlineReason = document.getElementById("offlineReason");
const retryBtn = document.getElementById("retryBtn");

// Stream & HUD
const remoteVideo = document.getElementById("remoteVideo");
const streamCanvas = document.getElementById("streamCanvas");
const canvasCtx = streamCanvas.getContext("2d");
const touchLayer = document.getElementById("touchLayer");
const statMode = document.getElementById("statMode");
const statPing = document.getElementById("statPing");
const statFps = document.getElementById("statFps");
const statBitrate = document.getElementById("statBitrate");
const openRobloxBtn = document.getElementById("openRobloxBtn");
const inputModeBtn = document.getElementById("inputModeBtn");
const escBtn = document.getElementById("escBtn");
const audioBtn = document.getElementById("audioBtn");
const hudToggleBtn = document.getElementById("hudToggleBtn");
const hudBody = document.getElementById("hudBody");
const toastBanner = document.getElementById("toastBanner");
const chatBtn = document.getElementById("chatBtn");
const chatBar = document.getElementById("chatBar");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");
const closeChatBtn = document.getElementById("closeChatBtn");

let pc = null;
let ws = null;
let inputChannel = null;
let statsTimer = null;
let webrtcFallbackTimer = null;
let wakeLock = null;
let intentionalClose = false;
let isStreaming = false;
let streamMode = "p2p";
let inputMode = "touch"; // "touch" (Roblox Mobile UI) or "mouse" (Desktop click)
let tunnelFramesCount = 0;
let tunnelBytesCount = 0;
let renderingFrame = false;
let toastTimer = null;

function showScreen(target) {
  [lockScreen, lobby, offlineScreen, streamContainer].forEach((el) => {
    el.classList.add("hidden");
  });
  target.classList.remove("hidden");
}

function showToast(text) {
  clearTimeout(toastTimer);
  toastBanner.textContent = text;
  toastBanner.classList.remove("hidden");
  toastTimer = setTimeout(() => {
    toastBanner.classList.add("hidden");
  }, 2600);
}

toggleManualBtn.addEventListener("click", () => {
  manualBox.classList.toggle("hidden");
});

// --- Automatic Tunnel Discovery + Live Health Check ---
async function resolveRigUrl() {
  const manualOverride = serverUrlInput.value.trim().replace(/\/$/, "");
  if (manualOverride) return manualOverride;

  const params = new URLSearchParams(window.location.search);
  const queryUrl = params.get("url");
  if (queryUrl) return queryUrl.trim().replace(/\/$/, "");

  try {
    const res = await fetch(`${BEACON_SUBSCRIBE_URL}&_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return "";
    const rawText = await res.text();
    const lines = rawText.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const evt = JSON.parse(lines[i]);
      if (evt.event === "message" && evt.message) {
        const data = JSON.parse(evt.message);
        if (data.url && data.url.startsWith("https://")) {
          return data.url.trim().replace(/\/$/, "");
        }
        return "";
      }
    }
  } catch (_) {}
  return "";
}

async function checkRigHealth() {
  rigStatusPill.className = "rig-pill checking";
  rigStatusLabel.textContent = "FINDING RIG...";

  const targetUrl = await resolveRigUrl();
  if (!targetUrl) {
    rigStatusPill.className = "rig-pill offline";
    rigStatusLabel.textContent = "OFFLINE";
    return "";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch(`${targetUrl}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (res.ok) {
      rigStatusPill.className = "rig-pill online";
      rigStatusLabel.textContent = "M4 ONLINE";
      return targetUrl;
    }
  } catch (_) {
    clearTimeout(timer);
  }

  rigStatusPill.className = "rig-pill offline";
  rigStatusLabel.textContent = "OFFLINE";
  return "";
}

// --- Passcode Lock Gate ---
function handleUnlock(e) {
  if (e) e.preventDefault();
  const entered = passwordInput.value.trim();
  if (entered === SITE_PASSWORD) {
    lockError.textContent = "";
    sessionStorage.setItem("cr_unlocked", "1");
    showScreen(lobby);
    checkRigHealth();
  } else {
    lockError.textContent = "Incorrect passcode.";
    lockCard.classList.remove("shake");
    void lockCard.offsetWidth;
    lockCard.classList.add("shake");
    passwordInput.value = "";
  }
}

lockCard.addEventListener("submit", handleUnlock);
unlockBtn.addEventListener("click", handleUnlock);
passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleUnlock(e);
});

if (sessionStorage.getItem("cr_unlocked") === "1") {
  showScreen(lobby);
  checkRigHealth();
}

// --- Navigation & Stream Actions ---
connectBtn.addEventListener("click", startSession);
retryBtn.addEventListener("click", startSession);

document.getElementById("disconnectBtn").addEventListener("click", () => {
  intentionalClose = true;
  cleanupSession();
  statusText.textContent = "";
  showScreen(lobby);
  checkRigHealth();
});

document.getElementById("fullscreenBtn").addEventListener("click", () => {
  if (!document.fullscreenElement && streamContainer.requestFullscreen) {
    streamContainer.requestFullscreen().catch(() => {});
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
});

hudToggleBtn.addEventListener("click", () => {
  const collapsed = hudBody.classList.toggle("hidden");
  hudToggleBtn.textContent = collapsed ? "▶" : "◀";
});

// One-tap Open / Focus Roblox on Windows 11
openRobloxBtn.addEventListener("click", () => {
  sendControlMessage({ t: "launch_roblox" });
  showToast("Opening Roblox on Windows 11...");
});

// Switch between Native Roblox Multi-Touch (👆) and Desktop Mouse Click (🖱️)
inputModeBtn.addEventListener("click", () => {
  inputMode = inputMode === "touch" ? "mouse" : "touch";
  inputModeBtn.textContent = inputMode === "touch" ? "👆" : "🖱️";
  showToast(inputMode === "touch" ? "Touch Mode: Roblox Mobile Controls" : "Mouse Mode: Desktop Clicks");
});

// ESC key for Roblox menu
escBtn.addEventListener("click", () => {
  sendControlMessage({ t: "key", key: "esc" });
});

audioBtn.addEventListener("click", () => {
  remoteVideo.muted = !remoteVideo.muted;
  remoteVideo.volume = 1.0;
  remoteVideo.play().catch(() => {});
  updateAudioButton();
});

function updateAudioButton() {
  if (remoteVideo.muted) {
    audioBtn.textContent = "🔇";
    audioBtn.classList.add("muted-pulse");
  } else {
    audioBtn.textContent = "🔊";
    audioBtn.classList.remove("muted-pulse");
  }
}

chatBtn.addEventListener("click", () => {
  chatBar.classList.toggle("hidden");
  if (!chatBar.classList.contains("hidden")) {
    chatInput.focus();
  }
});

closeChatBtn.addEventListener("click", () => {
  chatBar.classList.add("hidden");
});

function sendControlMessage(obj) {
  const raw = JSON.stringify(obj);
  if (streamMode === "p2p" && inputChannel && inputChannel.readyState === "open") {
    inputChannel.send(raw);
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(raw);
  }
}

function sendChatMessage() {
  const text = chatInput.value;
  if (text) {
    sendControlMessage({ t: "chat", text });
  }
  chatInput.value = "";
  chatBar.classList.add("hidden");
}

sendChatBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (_) {}
}

function showOffline(reasonText) {
  cleanupSession();
  if (reasonText) offlineReason.textContent = reasonText;
  showScreen(offlineScreen);
}

async function startSession() {
  intentionalClose = false;
  isStreaming = false;
  streamMode = "p2p";
  connectBtn.disabled = true;
  retryBtn.disabled = true;
  showScreen(lobby);
  statusText.textContent = "1/3 Pinging Mac mini M4...";

  const liveUrl = await checkRigHealth();
  if (!liveUrl) {
    showOffline("Your Mac mini M4 is offline, asleep, or start.bat hasn't finished booting yet.");
    return;
  }

  statusText.textContent = "2/3 Authenticating session...";
  const wsUrl = liveUrl.replace(/^http/, "ws") + "/ws";
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", pin: SITE_PASSWORD }));
  };

  ws.onerror = () => {
    if (!intentionalClose) {
      showOffline("Could not open stream socket. Check that start.bat is running.");
    }
  };

  ws.onclose = () => {
    if (!intentionalClose) {
      showOffline("Connection closed. Your Mac mini M4 went offline.");
    }
  };

  ws.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryFrame(event.data);
      return;
    }

    const msg = JSON.parse(event.data);

    if (msg.type === "auth_fail") {
      intentionalClose = true;
      cleanupSession();
      sessionStorage.removeItem("cr_unlocked");
      lockError.textContent = "Passcode mismatch with host_server.py.";
      showScreen(lockScreen);
      return;
    }

    if (msg.type === "error") {
      intentionalClose = true;
      showOffline(msg.message || "Windows 11 host reported a stream error.");
      return;
    }

    if (msg.type === "auth_ok") {
      statusText.textContent = "3/3 Connecting 60 FPS stream...";
      await initWebRTC();
      return;
    }

    if (msg.type === "answer" && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription({
        sdp: msg.sdp,
        type: msg.sdpType
      }));
    }

    if (msg.type === "fallback_started") {
      activateStreamView("tunnel");
    }

    if (msg.t === "toast") {
      showToast(msg.text);
    }

    if (msg.t === "pong") {
      const rtt = Math.round(performance.now() - msg.ts);
      statPing.textContent = `${rtt} ms`;
    }
  };
}

function activateStreamView(mode) {
  clearTimeout(webrtcFallbackTimer);
  streamMode = mode;
  isStreaming = true;
  connectBtn.disabled = false;
  retryBtn.disabled = false;
  statMode.textContent = mode === "p2p" ? "P2P" : "TUNNEL";

  if (mode === "p2p") {
    remoteVideo.classList.remove("hidden");
    streamCanvas.classList.add("hidden");
    remoteVideo.muted = false;
    remoteVideo.volume = 1.0;
    remoteVideo.play().then(updateAudioButton).catch(updateAudioButton);
  } else {
    remoteVideo.classList.add("hidden");
    streamCanvas.classList.remove("hidden");
    audioBtn.classList.add("hidden");
  }

  showScreen(streamContainer);
  requestWakeLock();
  startTelemetry();
}

function switchToTunnelFallback() {
  if (isStreaming || intentionalClose) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  statusText.textContent = "NAT blocked P2P UDP — switching to Direct Cloudflare Tunnel...";
  if (pc) {
    pc.close();
    pc = null;
  }
  const [maxWidth, fps] = qualitySelect.value.split(",").map(Number);
  ws.send(JSON.stringify({
    type: "fallback_stream",
    maxWidth,
    fps
  }));
}

async function handleBinaryFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2 || bytes[0] !== 1) return;

  tunnelFramesCount++;
  tunnelBytesCount += bytes.byteLength;

  if (renderingFrame) return;
  renderingFrame = true;

  try {
    const jpegBlob = new Blob([bytes.subarray(1)], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(jpegBlob);
    if (streamCanvas.width !== bitmap.width || streamCanvas.height !== bitmap.height) {
      streamCanvas.width = bitmap.width;
      streamCanvas.height = bitmap.height;
    }
    canvasCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } catch (_) {
  } finally {
    renderingFrame = false;
  }
}

function applyMaxBitrate(sdp, maxKbps) {
  return sdp.replace(
    /(m=video .*\r\n)/g,
    `$1b=AS:${maxKbps}\r\nb=TIAS:${maxKbps * 1000}\r\n`
  );
}

async function initWebRTC() {
  const [maxWidth, fps, maxKbps] = qualitySelect.value.split(",").map(Number);

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  inputChannel = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });

  inputChannel.onopen = () => {
    activateStreamView("p2p");
  };

  inputChannel.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.t === "pong") {
      const rtt = Math.round(performance.now() - data.ts);
      statPing.textContent = `${rtt} ms`;
    } else if (data.t === "toast") {
      showToast(data.text);
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    if (pc.iceConnectionState === "failed" && !isStreaming) {
      switchToTunnelFallback();
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === "failed" && !isStreaming) {
      switchToTunnelFallback();
    } else if ((pc.connectionState === "failed" || pc.connectionState === "disconnected") && isStreaming && !intentionalClose) {
      showOffline("Lost connection to your Mac mini M4. The computer went offline.");
    }
  };

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const mediaStream = new MediaStream();
  remoteVideo.srcObject = mediaStream;

  pc.ontrack = (event) => {
    mediaStream.addTrack(event.track);
  };

  webrtcFallbackTimer = setTimeout(switchToTunnelFallback, WEBRTC_GRACE_MS);

  let offerSent = false;
  const sendOfferNow = () => {
    if (offerSent || !pc || !ws || ws.readyState !== WebSocket.OPEN) return;
    offerSent = true;
    const boostedSdp = applyMaxBitrate(pc.localDescription.sdp, maxKbps);
    ws.send(JSON.stringify({
      type: "offer",
      sdp: boostedSdp,
      sdpType: pc.localDescription.type,
      maxWidth,
      fps
    }));
  };

  const iceGatherTimer = setTimeout(sendOfferNow, 3000);
  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      clearTimeout(iceGatherTimer);
      sendOfferNow();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
}

// Compute exact normalized (0..1) coordinates inside whichever surface is active
function getNormalizedPoint(clientX, clientY) {
  const rect = touchLayer.getBoundingClientRect();
  const vw = (streamMode === "p2p" ? remoteVideo.videoWidth : streamCanvas.width) || 16;
  const vh = (streamMode === "p2p" ? remoteVideo.videoHeight : streamCanvas.height) || 9;
  const cw = rect.width;
  const ch = rect.height;

  const videoRatio = vw / vh;
  const containerRatio = cw / ch;

  let renderW, renderH, offsetX, offsetY;
  if (containerRatio > videoRatio) {
    renderH = ch;
    renderW = ch * videoRatio;
    offsetX = (cw - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = cw;
    renderH = cw / videoRatio;
    offsetX = 0;
    offsetY = (ch - renderH) / 2;
  }

  const x = Math.max(0, Math.min(1, (clientX - rect.left - offsetX) / renderW));
  const y = Math.max(0, Math.min(1, (clientY - rect.top - offsetY) / renderH));
  return { x, y };
}

function sendTouchBatch(touchList, state) {
  if (inputMode === "mouse") {
    if (touchList.length > 0) {
      const t = touchList[0];
      const { x, y } = getNormalizedPoint(t.clientX, t.clientY);
      sendControlMessage({ t: "mouse", x, y, action: state });
    }
    return;
  }

  const touches = [];
  for (let i = 0; i < touchList.length; i++) {
    const t = touchList[i];
    const { x, y } = getNormalizedPoint(t.clientX, t.clientY);
    touches.push({ id: t.identifier, x, y, state });
  }
  if (touches.length > 0) {
    sendControlMessage({ t: "touch", touches });
  }
}

touchLayer.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (streamMode === "p2p" && remoteVideo.muted) {
    remoteVideo.muted = false;
    remoteVideo.volume = 1.0;
    remoteVideo.play().then(updateAudioButton).catch(() => {});
  }
  sendTouchBatch(e.changedTouches, "down");
}, { passive: false });

touchLayer.addEventListener("touchmove", (e) => {
  e.preventDefault();
  sendTouchBatch(e.changedTouches, "move");
}, { passive: false });

touchLayer.addEventListener("touchend", (e) => {
  e.preventDefault();
  sendTouchBatch(e.changedTouches, "up");
}, { passive: false });

touchLayer.addEventListener("touchcancel", (e) => {
  e.preventDefault();
  sendTouchBatch(e.changedTouches, "up");
}, { passive: false });

// Trackpad / External Mouse support on iPad
let mouseDown = false;
touchLayer.addEventListener("mousedown", (e) => {
  mouseDown = true;
  const { x, y } = getNormalizedPoint(e.clientX, e.clientY);
  sendControlMessage({ t: "mouse", x, y, action: "down" });
});
touchLayer.addEventListener("mousemove", (e) => {
  if (!mouseDown) return;
  const { x, y } = getNormalizedPoint(e.clientX, e.clientY);
  sendControlMessage({ t: "mouse", x, y, action: "move" });
});
window.addEventListener("mouseup", (e) => {
  if (!mouseDown) return;
  mouseDown = false;
  const { x, y } = getNormalizedPoint(e.clientX, e.clientY);
  sendControlMessage({ t: "mouse", x, y, action: "up" });
});

function startTelemetry() {
  clearInterval(statsTimer);
  let lastFrames = 0;
  let lastBytes = 0;
  let lastTime = performance.now();

  statsTimer = setInterval(async () => {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;

    sendControlMessage({ t: "ping", ts: now });

    if (streamMode === "p2p") {
      if (remoteVideo.getVideoPlaybackQuality) {
        const q = remoteVideo.getVideoPlaybackQuality();
        const fps = Math.round((q.totalVideoFrames - lastFrames) / dt);
        lastFrames = q.totalVideoFrames;
        if (fps > 0) statFps.textContent = `${fps} FPS`;
      }
      if (pc) {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            const mbps = (((report.bytesReceived - lastBytes) * 8) / (dt * 1_000_000)).toFixed(1);
            lastBytes = report.bytesReceived;
            if (Number(mbps) >= 0) statBitrate.textContent = `${mbps} Mbps`;
          }
        });
      }
    } else {
      const fps = Math.round(tunnelFramesCount / dt);
      const mbps = ((tunnelBytesCount * 8) / (dt * 1_000_000)).toFixed(1);
      tunnelFramesCount = 0;
      tunnelBytesCount = 0;
      statFps.textContent = `${fps} FPS`;
      statBitrate.textContent = `${mbps} Mbps`;
    }

    lastTime = now;
  }, 1000);
}

function cleanupSession() {
  clearTimeout(webrtcFallbackTimer);
  clearInterval(statsTimer);
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  connectBtn.disabled = false;
  retryBtn.disabled = false;
  isStreaming = false;
  audioBtn.classList.remove("hidden");
  chatBar.classList.add("hidden");
  if (inputChannel) inputChannel.close();
  if (pc) pc.close();
  if (ws) ws.close();
  pc = null;
  ws = null;
  inputChannel = null;
}
