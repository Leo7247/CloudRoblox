const lobby = document.getElementById("lobby");
const streamContainer = document.getElementById("streamContainer");
const remoteVideo = document.getElementById("remoteVideo");
const touchLayer = document.getElementById("touchLayer");
const serverUrlInput = document.getElementById("serverUrl");
const pinInput = document.getElementById("pinInput");
const qualitySelect = document.getElementById("qualitySelect");
const connectBtn = document.getElementById("connectBtn");
const statusText = document.getElementById("statusText");
const statPing = document.getElementById("statPing");
const statFps = document.getElementById("statFps");

// Restore saved settings
serverUrlInput.value = localStorage.getItem("cr_url") || "";
pinInput.value = localStorage.getItem("cr_pin") || "";

let pc = null;
let ws = null;
let inputChannel = null;
let statsTimer = null;

connectBtn.addEventListener("click", startSession);
document.getElementById("disconnectBtn").addEventListener("click", cleanupSession);
document.getElementById("fullscreenBtn").addEventListener("click", () => {
  if (!document.fullscreenElement && streamContainer.requestFullscreen) {
    streamContainer.requestFullscreen().catch(() => {});
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
});

// Prevent iPad Safari pinch-zoom gestures
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });

async function startSession() {
  const rawUrl = serverUrlInput.value.trim().replace(/\/$/, "");
  const pin = pinInput.value.trim();
  if (!rawUrl || !pin) {
    statusText.textContent = "Enter both your Tunnel URL and Access PIN.";
    return;
  }

  localStorage.setItem("cr_url", rawUrl);
  localStorage.setItem("cr_pin", pin);
  statusText.textContent = "Connecting to Mac mini M4...";

  const wsUrl = rawUrl.replace(/^http/, "ws") + "/ws";
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", pin }));
  };

  ws.onerror = () => {
    statusText.textContent = "WebSocket failed. Check your Cloudflare Tunnel URL.";
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "auth_fail") {
      statusText.textContent = "Invalid PIN.";
      cleanupSession();
      return;
    }

    if (msg.type === "auth_ok") {
      statusText.textContent = "Negotiating 60 FPS WebRTC stream...";
      await initWebRTC();
      return;
    }

    if (msg.type === "answer" && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription({
        sdp: msg.sdp,
        type: msg.sdpType
      }));
    }
  };
}

async function initWebRTC() {
  const [maxWidth, fps] = qualitySelect.value.split(",").map(Number);

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" }
    ]
  });

  // Unreliable, unordered data channel = zero head-of-line blocking for touch inputs
  inputChannel = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });

  inputChannel.onopen = () => {
    lobby.classList.add("hidden");
    streamContainer.classList.remove("hidden");
    remoteVideo.play().catch(() => {});
    startTelemetry();
  };

  inputChannel.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.t === "pong") {
      const rtt = Math.round(performance.now() - data.ts);
      statPing.textContent = `${rtt} ms`;
    }
  };

  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
  };

  pc.onicecandidate = async (event) => {
    if (!event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "offer",
        sdp: pc.localDescription.sdp,
        sdpType: pc.localDescription.type,
        maxWidth,
        fps
      }));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
}

// Compute exact normalized (0..1) coordinates inside the rendered video rectangle
function getNormalizedPoint(clientX, clientY) {
  const vw = remoteVideo.videoWidth || 16;
  const vh = remoteVideo.videoHeight || 9;
  const cw = touchLayer.clientWidth;
  const ch = touchLayer.clientHeight;

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

  const x = Math.max(0, Math.min(1, (clientX - offsetX) / renderW));
  const y = Math.max(0, Math.min(1, (clientY - offsetY) / renderH));
  return { x, y };
}

function sendTouchBatch(touchList, state) {
  if (!inputChannel || inputChannel.readyState !== "open") return;
  const touches = [];
  for (let i = 0; i < touchList.length; i++) {
    const t = touchList[i];
    const { x, y } = getNormalizedPoint(t.clientX, t.clientY);
    touches.push({ id: t.identifier, x, y, state });
  }
  if (touches.length > 0) {
    inputChannel.send(JSON.stringify({ t: "touch", touches }));
  }
}

touchLayer.addEventListener("touchstart", (e) => {
  e.preventDefault();
  remoteVideo.muted = false;
  remoteVideo.play().catch(() => {});
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

function startTelemetry() {
  let lastFrames = 0;
  let lastTime = performance.now();

  statsTimer = setInterval(() => {
    if (inputChannel && inputChannel.readyState === "open") {
      inputChannel.send(JSON.stringify({ t: "ping", ts: performance.now() }));
    }
    if (remoteVideo.getVideoPlaybackQuality) {
      const q = remoteVideo.getVideoPlaybackQuality();
      const now = performance.now();
      const fps = Math.round(((q.totalVideoFrames - lastFrames) * 1000) / (now - lastTime));
      lastFrames = q.totalVideoFrames;
      lastTime = now;
      if (fps > 0) statFps.textContent = `${fps} FPS`;
    }
  }, 1000);
}

function cleanupSession() {
  clearInterval(statsTimer);
  if (inputChannel) inputChannel.close();
  if (pc) pc.close();
  if (ws) ws.close();
  pc = null;
  ws = null;
  inputChannel = null;
  streamContainer.classList.add("hidden");
  lobby.classList.remove("hidden");
}
