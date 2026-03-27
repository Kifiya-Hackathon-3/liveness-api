/**
 * Liveness demo: blink count + smile hold using MediaPipe Face Landmarker (local).
 */
import {
  FaceLandmarker,
  FilesetResolver,
} from "https://esm.sh/@mediapipe/tasks-vision@0.10.14";

const MP_VERSION = "0.10.14";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const BLINK = {
  closed: 0.52,
  open: 0.25,
  minOpenMs: 90,
  minClosedMs: 70,
};
const SMILE = { threshold: 0.45, holdFrames: 12 };
const REQUIRED_BLINKS = 2;

const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const pill = document.getElementById("status-pill");
const instruction = document.getElementById("instruction");
const hint = document.getElementById("hint");
const progressBar = document.getElementById("progress-bar");
const btnStart = document.getElementById("btn-start");
const btnReset = document.getElementById("btn-reset");

/** @type {FaceLandmarker | null} */
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
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function resetFlow() {
  phase = "need_face";
  blinkState = "open";
  blinkStateSince = performance.now();
  blinkCount = 0;
  smileFrames = 0;
  noFaceFrames = 0;
  setProgress(0);
  instruction.textContent = "Position your face in the frame.";
  hint.textContent = "Good lighting helps. Stay centered.";
  setPill("active", "Looking for face");
  btnReset.hidden = true;
}

function fail(message) {
  phase = "fail";
  running = false;
  instruction.textContent = message;
  hint.textContent = "Tap “Try again” to restart.";
  setPill("fail", "Failed");
  setProgress(0);
  btnStart.hidden = false;
  btnStart.disabled = false;
  btnReset.hidden = false;
}

function pass() {
  phase = "pass";
  running = false;
  instruction.textContent = "Liveness check passed.";
  hint.textContent = "This was a client-side demo only.";
  setPill("ok", "Live");
  setProgress(100);
  btnStart.hidden = false;
  btnStart.disabled = false;
  btnReset.hidden = false;
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
    instruction.textContent = `Blink ${REQUIRED_BLINKS} times.`;
    hint.textContent = "Natural, full blinks work best.";
    blinkState = "open";
    blinkStateSince = now;
    return;
  }

  if (phase === "blinks") {
    const b = eyeBlinkMax(blends);
    updateBlinkFsm(b, now);
    if (blinkCount >= REQUIRED_BLINKS) {
      phase = "smile";
      instruction.textContent = "Hold a clear smile for a moment.";
      hint.textContent = "Show teeth optional — a real smile is enough.";
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
  instruction.textContent = "Loading model…";
  hint.textContent = "First run may take a few seconds.";
  setPill("idle", "Loading");

  try {
    if (!faceLandmarker) {
      await initModel();
    }
    await startWebcam();
    running = true;
    btnStart.hidden = true;
    resetFlow();
    loop();
  } catch (e) {
    console.error(e);
    instruction.textContent = "Could not start camera or model.";
    hint.textContent =
      e?.message ||
      "Check permissions, HTTPS or localhost, and try another browser.";
    setPill("fail", "Error");
    btnStart.disabled = false;
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
