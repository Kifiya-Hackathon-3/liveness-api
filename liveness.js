/**
 * Liveness demo: blink count + smile hold using MediaPipe Face Landmarker (local).
 * MediaPipe is loaded dynamically so we can show a clear error if a CDN is blocked
 * (common when the in-editor browser works but the system browser does not).
 */

const MP_VERSION = "0.10.14";
// Load all ML assets via this origin (Go reverse-proxies jsdelivr / GCS) so adblock
// or strict browser policies that block third-party CDNs still work like the IDE embedded browser.
// Main bundle uses jsDelivr +esm (Rollup) instead of esm.sh — esm often returns 403 behind some networks.
const ORIGIN =
  typeof window !== "undefined" && window.location?.origin
    ? window.location.origin.replace(/\/$/, "")
    : "";
const MP_MODULE = `${ORIGIN}/proxy/jsdelivr/npm/@mediapipe/tasks-vision@${MP_VERSION}/+esm`;
const WASM_BASE = `${ORIGIN}/proxy/jsdelivr/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL = `${ORIGIN}/proxy/gcs/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;

const BLINK = {
  closed: 0.52,
  open: 0.25,
  minOpenMs: 90,
  minClosedMs: 70,
};
const SMILE = { threshold: 0.45, holdFrames: 12 };
const REQUIRED_BLINKS = 2;
const CFG = window.LIVENESS_CONFIG || {};
const API_BASE = CFG.apiBase || window.API_BASE || "http://localhost:8080";
const SUBJECT_ID = CFG.subjectId || window.SUBJECT_ID || "sub_demo";
const TOKEN = CFG.apiToken || window.API_TOKEN || "dummy.jwt.token";
const SUCCESS_REDIRECT = CFG.successRedirect || "";
const FAIL_REDIRECT = CFG.failRedirect || "";
const APP_SCHEME = CFG.appScheme || "";
const APP_DEEP_LINK_PATH = (CFG.appDeepLinkPath || "liveness/result").replace(
  /^\/+/,
  ""
);
const ANDROID_PACKAGE = CFG.androidPackage || "";
const NAVIGATE_ON_RESULT = CFG.navigateOnResult !== false;
const STATE = CFG.state || "";
const EMBEDDED = CFG.embedded === true;
const AUTO_START = CFG.autoStart === true;

const IS_ANDROID_WEB =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");

const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const pill = document.getElementById("status-pill");
const instruction = document.getElementById("instruction");
const hint = document.getElementById("hint");
const progressBar = document.getElementById("progress-bar");
const btnStart = document.getElementById("btn-start");
const btnReset = document.getElementById("btn-reset");
const stepFace = document.getElementById("step-face");
const stepBlink = document.getElementById("step-blink");
const stepSmile = document.getElementById("step-smile");
function localhostLikeHostname() {
  const h = (window.location.hostname || "").toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h.endsWith(".localhost")
  );
}

// Prefer the browser's secure-context flag; also allow loopback hostnames when
// some embedded webviews misreport isSecureContext.
const isSecureLike =
  window.isSecureContext === true || localhostLikeHostname();

const stepItems = [stepFace, stepBlink, stepSmile].filter(Boolean);

/** @param {{ mode: string, failAt?: string }} ui */
function setStepListUI(ui) {
  if (!stepItems.length) return;
  stepItems.forEach((el) => {
    el.classList.remove("step--done", "step--current", "step--todo", "step--error");
    el.removeAttribute("aria-current");
  });

  const mark = (idx, ...classes) => {
    const el = stepItems[idx];
    if (!el) return;
    classes.forEach((c) => el.classList.add(c));
  };

  switch (ui.mode) {
    case "intro":
      mark(0, "step--todo");
      mark(1, "step--todo");
      mark(2, "step--todo");
      break;
    case "loading":
      mark(0, "step--current");
      stepItems[0]?.setAttribute("aria-current", "step");
      mark(1, "step--todo");
      mark(2, "step--todo");
      break;
    case "need_face":
      mark(0, "step--current");
      stepItems[0]?.setAttribute("aria-current", "step");
      mark(1, "step--todo");
      mark(2, "step--todo");
      break;
    case "blinks":
      mark(0, "step--done");
      mark(1, "step--current");
      stepItems[1]?.setAttribute("aria-current", "step");
      mark(2, "step--todo");
      break;
    case "smile":
      mark(0, "step--done");
      mark(1, "step--done");
      mark(2, "step--current");
      stepItems[2]?.setAttribute("aria-current", "step");
      break;
    case "pass":
      mark(0, "step--done");
      mark(1, "step--done");
      mark(2, "step--done");
      break;
    case "fail": {
      const at = ui.failAt || "need_face";
      if (at === "blinks") {
        mark(0, "step--done");
        mark(1, "step--error");
        stepItems[1]?.setAttribute("aria-current", "step");
        mark(2, "step--todo");
      } else if (at === "smile") {
        mark(0, "step--done");
        mark(1, "step--done");
        mark(2, "step--error");
        stepItems[2]?.setAttribute("aria-current", "step");
      } else {
        mark(0, "step--error");
        stepItems[0]?.setAttribute("aria-current", "step");
        mark(1, "step--todo");
        mark(2, "step--todo");
      }
      break;
    }
    default:
      break;
  }
}

if (EMBEDDED) {
  document.documentElement.classList.add("embedded");
  document.body.classList.add("embedded");
}

/** @type {any} */
let faceLandmarker = null;
let running = false;
let lastVideoTime = -1;
let rafId = 0;

/** @type {"idle"|"need_face"|"blinks"|"smile"|"pass"|"fail"} */
let phase = "idle";

let blinkState = "open";
let blinkStateSince = 0;
let blinkCount = 0;
let smileFrames = 0;
let noFaceFrames = 0;
let livenessSessionId = null;

function buildDeepLink(base, payload) {
  if (!base) return "";
  try {
    const u = new URL(base);
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== "" && v != null) u.searchParams.set(k, String(v));
    });
    return u.toString();
  } catch (_) {
    const q = new URLSearchParams();
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== "" && v != null) q.set(k, String(v));
    });
    const hasQuery = base.includes("?");
    return `${base}${hasQuery ? "&" : "?"}${q.toString()}`;
  }
}

function resolveRedirect(status, score, message) {
  const base =
    status === "PASSED" ? SUCCESS_REDIRECT : FAIL_REDIRECT;
  if (base) {
    return buildDeepLink(base, {
      status,
      score,
      session_id: livenessSessionId || "",
      subject_id: SUBJECT_ID,
      state: STATE,
      message,
    });
  }
  if (APP_SCHEME) {
    return buildDeepLink(`${APP_SCHEME}://${APP_DEEP_LINK_PATH}`, {
      status,
      score,
      session_id: livenessSessionId || "",
      subject_id: SUBJECT_ID,
      state: STATE,
      message,
    });
  }
  return "";
}

/** Android: intent://…#Intent;scheme=…;package=…;end — works when raw scheme nav is swallowed by Chrome/WebView. */
function buildAndroidIntentUrl(fullUrl, androidPackage) {
  if (!androidPackage || !fullUrl) return "";
  try {
    const u = new URL(fullUrl);
    const scheme = (u.protocol || "").replace(/:$/, "");
    if (!scheme || scheme === "http" || scheme === "https") return "";
    const path = `${u.hostname}${u.pathname}${u.search || ""}`.replace(
      /^\/+/,
      ""
    );
    const encodedFallback = encodeURIComponent(
      typeof window !== "undefined" ? window.location.href : fullUrl
    );
    return `intent://${path}#Intent;scheme=${scheme};package=${androidPackage};S.browser_fallback_url=${encodedFallback};end`;
  } catch {
    return "";
  }
}

function openDeepLink(target) {
  if (!target || !NAVIGATE_ON_RESULT) return;
  const isHttp = /^https?:/i.test(target);
  if (isHttp) {
    window.location.assign(target);
    return;
  }
  if (IS_ANDROID_WEB && ANDROID_PACKAGE) {
    const intent = buildAndroidIntentUrl(target, ANDROID_PACKAGE);
    if (intent) {
      window.location.assign(intent);
      return;
    }
  }
  window.location.assign(target);
}

function maybeDeepLink(status, score, message) {
  const payload = {
    type: "LIVENESS_RESULT",
    status,
    score,
    session_id: livenessSessionId || "",
    subject_id: SUBJECT_ID,
    state: STATE,
    message,
  };
  if (window.ReactNativeWebView?.postMessage) {
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  // Flutter InAppWebView
  if (window.flutter_inappwebview?.callHandler) {
    window.flutter_inappwebview.callHandler("livenessResult", payload);
  }
  // iOS WKWebView (Flutter webview_flutter / typical native bridge)
  if (window.webkit?.messageHandlers?.livenessResult) {
    window.webkit.messageHandlers.livenessResult.postMessage(payload);
  }
  // Generic iframe/Web parent
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(payload, "*");
  }

  const target = resolveRedirect(status, score, message);
  if (!target) return;
  setTimeout(() => openDeepLink(target), 600);
}

function setPill(kind, text) {
  pill.textContent = text;
  pill.className = "pill";
  pill.classList.add(
    kind === "ok"
      ? "pill--ok"
      : kind === "fail"
        ? "pill--fail"
        : kind === "active"
          ? "pill--active"
          : "pill--idle"
  );
}

function setProgress(pct) {
  progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function blendScore(blendshapes, ...names) {
  if (!blendshapes?.categories?.length) return 0;
  const map = new Map(
    blendshapes.categories.map((c) => [c.categoryName, c.score])
  );
  for (const n of names) {
    const v = map.get(n);
    if (v != null) return v;
  }
  const lower = new Map(
    blendshapes.categories.map((c) => [c.categoryName.toLowerCase(), c.score])
  );
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v != null) return v;
  }
  return 0;
}

function eyeBlinkMax(blendshapes) {
  const left = blendScore(blendshapes, "eyeBlink_L", "eyeBlinkLeft");
  const right = blendScore(blendshapes, "eyeBlink_R", "eyeBlinkRight");
  return Math.max(left, right);
}

function smileScore(blendshapes) {
  return Math.max(
    blendScore(blendshapes, "mouthSmile_L", "mouthSmileLeft"),
    blendScore(blendshapes, "mouthSmile_R", "mouthSmileRight"),
    blendScore(blendshapes, "mouthSmile")
  );
}

function resizeCanvas() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function drawLandmarks(landmarks) {
  if (!landmarks?.length) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(61, 156, 245, 0.85)";
  const step = 6;
  for (let i = 0; i < landmarks.length; i += step) {
    const p = landmarks[i];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function initModel() {
  let FaceLandmarker;
  let FilesetResolver;
  try {
    ({ FaceLandmarker, FilesetResolver } = await import(MP_MODULE));
  } catch (e) {
    console.error(e);
    throw new Error(
      "Could not load MediaPipe via this server’s /proxy routes. Check the liveness-check process logs and DevTools → Network."
    );
  }
  const resolver = await FilesetResolver.forVisionTasks(WASM_BASE);
  faceLandmarker = await FaceLandmarker.createFromOptions(resolver, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

async function startWebcam() {
  const hasModern = !!navigator.mediaDevices?.getUserMedia;
  const hasLegacy =
    !!navigator.getUserMedia ||
    !!navigator.webkitGetUserMedia ||
    !!navigator.mozGetUserMedia;
  if (!hasModern && !hasLegacy) {
    throw new Error("Camera API unavailable in this webview/browser");
  }
  if (!isSecureLike) {
    throw new Error("Camera requires https or localhost secure context");
  }

  let preferredDeviceId = "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cam = devices.find((d) => d.kind === "videoinput");
    preferredDeviceId = cam?.deviceId || "";
  } catch (_) {
    // Some webviews block enumerateDevices pre-permission; ignore and continue.
  }

  const attempts = [
    preferredDeviceId
      ? { video: { deviceId: { exact: preferredDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }
      : null,
    { video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: true, audio: false },
  ].filter(Boolean);

  let lastErr = null;
  for (const constraints of attempts) {
    try {
      const stream = hasModern
        ? await navigator.mediaDevices.getUserMedia(constraints)
        : await new Promise((resolve, reject) => {
            const legacy =
              navigator.getUserMedia ||
              navigator.webkitGetUserMedia ||
              navigator.mozGetUserMedia;
            legacy.call(navigator, constraints, resolve, reject);
          });
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play();
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("Starting videoinput failed");
}

async function createLivenessSession() {
  const res = await fetch(`${API_BASE}/v1/kyc/liveness/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ subject_id: SUBJECT_ID }),
  });
  if (!res.ok) throw new Error("failed to create liveness session");
  const json = await res.json();
  livenessSessionId = json.id;
}

async function submitLivenessResult(score) {
  if (!livenessSessionId) return;
  await fetch(`${API_BASE}/v1/kyc/liveness/sessions/${livenessSessionId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ score }),
  });
}

function resetFlow() {
  phase = "need_face";
  blinkState = "open";
  blinkStateSince = performance.now();
  blinkCount = 0;
  smileFrames = 0;
  noFaceFrames = 0;
  setProgress(0);
  setStepListUI({ mode: "need_face" });
  instruction.textContent = "Step 1 — show your face clearly.";
  hint.textContent =
    "Fill the frame with your face, look at the camera, and avoid strong backlight.";
  setPill("active", "Looking for face");
  btnReset.hidden = true;
}

function fail(message) {
  const failAt = phase;
  phase = "fail";
  running = false;
  setStepListUI({ mode: "fail", failAt });
  instruction.textContent = message;
  hint.textContent = "Read the steps above, then tap “Try again”.";
  setPill("fail", "Failed");
  setProgress(0);
  btnStart.hidden = false;
  btnStart.disabled = false;
  btnReset.hidden = false;
  submitLivenessResult(0.2).catch(console.error);
  maybeDeepLink("FAILED", 0.2, message);
}

function pass() {
  phase = "pass";
  running = false;
  setStepListUI({ mode: "pass" });
  instruction.textContent = "All steps complete — liveness passed.";
  hint.textContent =
    "You can close this screen or tap “Try again” to run another check.";
  setPill("ok", "Live");
  setProgress(100);
  btnStart.hidden = false;
  btnStart.disabled = false;
  btnReset.hidden = false;
  submitLivenessResult(0.92).catch(console.error);
  maybeDeepLink("PASSED", 0.92, "liveness passed");
}

function updateBlinkFsm(blinkVal, now) {
  if (blinkState === "open") {
    if (blinkVal >= BLINK.closed) {
      const sinceOpen = now - blinkStateSince;
      if (sinceOpen >= BLINK.minOpenMs) {
        blinkState = "closed";
        blinkStateSince = now;
      }
    }
  } else {
    if (blinkVal <= BLINK.open) {
      const closedDur = now - blinkStateSince;
      if (closedDur >= BLINK.minClosedMs) {
        blinkCount += 1;
        blinkState = "open";
        blinkStateSince = now;
        hint.textContent = `Blinks: ${blinkCount} / ${REQUIRED_BLINKS}`;
        setProgress((blinkCount / (REQUIRED_BLINKS + 1)) * 66);
      }
    }
  }
}

function onResult(result, now) {
  const hasFace = result.faceLandmarks?.length > 0;
  const landmarks = hasFace ? result.faceLandmarks[0] : null;
  const blends = hasFace ? result.faceBlendshapes?.[0] : null;

  if (hasFace) {
    noFaceFrames = 0;
    drawLandmarks(landmarks);
  } else {
    noFaceFrames += 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (phase === "blinks" || phase === "smile") {
      if (noFaceFrames > 45) {
        fail("Face lost — stay in frame.");
      }
    }
    return;
  }

  if (phase === "need_face") {
    setPill("active", "Face detected");
    phase = "blinks";
    setStepListUI({ mode: "blinks" });
    instruction.textContent = `Step 2 — blink ${REQUIRED_BLINKS} times.`;
    hint.textContent = "Close your eyes fully, then open — repeat until the counter updates.";
    blinkState = "open";
    blinkStateSince = now;
    return;
  }

  if (phase === "blinks") {
    const b = eyeBlinkMax(blends);
    updateBlinkFsm(b, now);
    if (blinkCount >= REQUIRED_BLINKS) {
      phase = "smile";
      setStepListUI({ mode: "smile" });
      instruction.textContent = "Step 3 — hold a clear smile.";
      hint.textContent =
        "Keep smiling steadily until the bar finishes (about one second).";
      setProgress(66);
    }
    return;
  }

  if (phase === "smile") {
    const s = smileScore(blends);
    if (s >= SMILE.threshold) {
      smileFrames += 1;
      setProgress(66 + (smileFrames / SMILE.holdFrames) * 34);
      if (smileFrames >= SMILE.holdFrames) {
        pass();
      }
    } else {
      smileFrames = Math.max(0, smileFrames - 2);
    }
  }
}

function loop() {
  if (!running || !faceLandmarker) return;
  resizeCanvas();
  const now = performance.now();
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = faceLandmarker.detectForVideo(video, now);
    onResult(result, now);
  }
  if (running) {
    rafId = requestAnimationFrame(loop);
  }
}

btnStart.addEventListener("click", async () => {
  btnStart.disabled = true;
  setStepListUI({ mode: "loading" });
  instruction.textContent = "Starting camera…";
  hint.textContent =
    "When your browser asks, tap “Allow” so we can see your face for this check.";
  setPill("idle", "Loading");

  try {
    await startWebcam();
    instruction.textContent = "Loading face detection…";
    hint.textContent = "First run may take a few seconds; keep the page open.";
    if (!faceLandmarker) await initModel();
    await createLivenessSession().catch(() => {
      // Keep camera flow alive even if session call is unavailable.
      // Session will remain null and result submit is skipped.
    });
    running = true;
    btnStart.hidden = true;
    resetFlow();
    loop();
  } catch (e) {
    console.error(e);
    setStepListUI({ mode: "intro" });
    instruction.textContent = "Could not start camera or model.";
    const name = e?.name || "";
    const msg = e?.message || "Starting videoinput failed";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      hint.textContent =
        "Camera permission denied. Allow camera access in app/browser settings and retry.";
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      hint.textContent =
        "No camera device found. Check emulator/device camera availability.";
    } else if (name === "NotReadableError" || name === "TrackStartError") {
      hint.textContent =
        "Camera is busy or blocked by another app. Close other camera apps and retry.";
    } else if (name === "OverconstrainedError") {
      hint.textContent =
        "Requested camera settings were not supported. Retry with default camera.";
    } else {
      hint.textContent =
        `${msg}. Check app WebView camera permission callback and ensure https/localhost origin.`;
    }
    setPill("fail", "Error");
    btnStart.disabled = false;
    btnStart.hidden = false;
  }
});

btnReset.addEventListener("click", () => {
  if (!faceLandmarker || !video.srcObject) {
    btnStart.click();
    return;
  }
  running = true;
  btnStart.hidden = true;
  btnReset.hidden = true;
  resetFlow();
  loop();
});

setStepListUI({ mode: "intro" });
setPill("idle", "Ready");
setProgress(0);

if (AUTO_START) {
  setTimeout(() => btnStart.click(), 350);
}
