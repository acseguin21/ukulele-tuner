/**
 * Ukulele tuner — mic → pitch detection (autocorrelation) → note + cents vs selected string.
 *
 * Uses the Web Audio API (AnalyserNode) and a time-domain autocorrelation algorithm
 * with parabolic interpolation for sub-sample accuracy.
 */

const A4_HZ = 440;
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

function hzToMidi(hz) {
  return 12 * Math.log2(hz / A4_HZ) + 69;
}

function midiToNoteName(midi) {
  const n = Math.round(midi);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return { name, octave, midi: n };
}

function centsBetween(freq, targetHz) {
  return 1200 * Math.log2(freq / targetHz);
}

/** Standard ukulele: G4 C4 E4 A4 (high G). Low G uses G3. */
function stringTargets(lowG) {
  return [
    { id: "g", label: "G", hz: lowG ? 196.0 : 392.0 },
    { id: "c", label: "C", hz: 261.6255653005986 },
    { id: "e", label: "E", hz: 329.62755691287 },
    { id: "a", label: "A", hz: 440.0 },
  ];
}

/**
 * Estimates the fundamental frequency of a signal via normalised autocorrelation
 * with parabolic interpolation around the best peak.
 *
 * @param {Float32Array} buffer  - Raw PCM samples from AnalyserNode
 * @param {number}       sampleRate
 * @returns {{ hz: number|null, rms: number }}
 */
function autocorrelatePitch(buffer, sampleRate) {
  const n = buffer.length;

  let rms = 0;
  for (let i = 0; i < n; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return { hz: null, rms };

  const minHz = 70;
  const maxHz = 1200;
  let minPeriod = Math.max(2, Math.floor(sampleRate / maxHz));
  let maxPeriod = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / minHz));

  let bestOffset = -1;
  let bestCorr = 0;
  for (let period = minPeriod; period <= maxPeriod; period++) {
    let corr = 0;
    for (let i = 0; i < n - period; i++) corr += buffer[i] * buffer[i + period];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestOffset = period;
    }
  }

  if (bestOffset <= 0 || bestCorr < 1e-6) return { hz: null, rms };

  // Parabolic interpolation for sub-sample refinement
  const p = bestOffset;
  const computeCorr = (lag) => {
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += buffer[i] * buffer[i + lag];
    return c;
  };
  const y1 = p > minPeriod ? computeCorr(p - 1) : bestCorr;
  const y2 = bestCorr;
  const y3 = p < maxPeriod ? computeCorr(p + 1) : bestCorr;
  const denom = y1 - 2 * y2 + y3;
  const delta = Math.abs(denom) > 1e-12 ? 0.5 * (y1 - y3) / denom : 0;
  const hz = sampleRate / (p + delta);

  return { hz, rms };
}

// ── DOM refs ────────────────────────────────────────────────────────────────

const el = {
  btnMic:        document.getElementById("btn-mic"),
  lowG:          document.getElementById("low-g"),
  stringButtons: document.getElementById("string-buttons"),
  freq:          document.getElementById("freq-display"),
  hint:          document.getElementById("signal-hint"),
  note:          document.getElementById("note-display"),
  cents:         document.getElementById("cents-display"),
  tuneDirection: document.getElementById("tune-direction"),
  needle:        document.getElementById("needle"),
  targetLine:    document.getElementById("target-line"),
  meterCard:     document.getElementById("meter-card"),
};

// ── Audio state ─────────────────────────────────────────────────────────────

let audioContext  = null;
let mediaStream   = null;
let analyser      = null;
let dataBuffer    = null;
let rafId         = null;
let selectedStringId = "g";

/** Last stable pitch while the string was ringing; shown for HOLD_MS after signal drops. */
const HOLD_MS = 3200;
let holdHz          = null;
let lastSignalAt    = 0;
let displayingHold  = false;

// ── UI helpers ──────────────────────────────────────────────────────────────

function buildStringButtons() {
  el.stringButtons.innerHTML = "";
  for (const t of stringTargets(el.lowG.checked)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "string-btn";
    b.dataset.id = t.id;
    b.setAttribute("aria-pressed", t.id === selectedStringId ? "true" : "false");
    b.innerHTML = `<span class="name">${t.label}</span><span class="hz">${Math.round(t.hz)} Hz</span>`;
    b.addEventListener("click", () => {
      selectedStringId = t.id;
      for (const child of el.stringButtons.children) {
        child.setAttribute("aria-pressed", child.dataset.id === selectedStringId ? "true" : "false");
      }
      updateTargetLine();
      if (holdHz != null) applyReading(holdHz, displayingHold);
    });
    el.stringButtons.appendChild(b);
  }
}

function selectedTargetHz() {
  return stringTargets(el.lowG.checked).find((x) => x.id === selectedStringId)?.hz ?? null;
}

function updateTargetLine() {
  const t = stringTargets(el.lowG.checked).find((x) => x.id === selectedStringId);
  if (t) el.targetLine.textContent = `Target: ${t.label} ≈ ${t.hz.toFixed(2)} Hz`;
}

function setNeedleCents(cents) {
  el.needle.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
}

function clearTuneDirection() {
  el.tuneDirection.textContent = "";
  el.tuneDirection.className = "tune-direction is-empty";
}

function setTuneDirection(cents) {
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  if (abs <= 5) {
    el.tuneDirection.textContent =
      "In tune! If the needle still wiggles, adjust only a hair or re-pluck to confirm.";
    el.tuneDirection.className = "tune-direction ok";
    return;
  }
  if (rounded > 0) {
    el.tuneDirection.textContent = `Too sharp by ~${abs} cents — pitch is too high. Loosen the string until the needle moves toward centre.`;
    el.tuneDirection.className = "tune-direction sharp";
  } else {
    el.tuneDirection.textContent = `Too flat by ~${abs} cents — pitch is too low. Tighten the string until the needle moves toward centre.`;
    el.tuneDirection.className = "tune-direction flat";
  }
}

function applyReading(hz, isHolding) {
  displayingHold = isHolding;

  el.freq.textContent = `${hz.toFixed(1)} Hz`;
  el.hint.textContent = isHolding
    ? "Holding last reading — pluck again for a fresh measurement."
    : "";

  const { name, octave } = midiToNoteName(hzToMidi(hz));
  el.note.textContent = `${name}${octave}`;

  const target = selectedTargetHz();
  let isInTune = false;

  if (target) {
    const cents = centsBetween(hz, target);
    const rounded = Math.round(cents);
    const abs = Math.abs(rounded);
    isInTune = abs <= 5;

    if (isInTune) {
      el.cents.textContent = "in tune";
      el.cents.classList.add("in-tune");
    } else {
      el.cents.textContent = `${abs} cents ${rounded > 0 ? "sharp" : "flat"}`;
      el.cents.classList.remove("in-tune");
    }
    setTuneDirection(cents);
    setNeedleCents(cents);
  } else {
    el.cents.textContent = "";
    el.cents.classList.remove("in-tune");
    clearTuneDirection();
    setNeedleCents(0);
  }

  el.meterCard.classList.toggle("is-holding", isHolding && !isInTune);
  el.meterCard.classList.toggle("is-in-tune", isInTune);
}

function showWaitingForPluck() {
  displayingHold = false;
  el.freq.textContent = "— Hz";
  el.hint.textContent = "Pluck the selected string — listening…";
  el.note.textContent = "—";
  el.cents.textContent = "";
  el.cents.classList.remove("in-tune");
  clearTuneDirection();
  setNeedleCents(0);
  el.meterCard.classList.remove("is-holding", "is-in-tune");
}

// ── Audio engine ─────────────────────────────────────────────────────────────

function tick() {
  if (!analyser || !dataBuffer || !audioContext) return;

  analyser.getFloatTimeDomainData(dataBuffer);
  const { hz, rms } = autocorrelatePitch(dataBuffer, audioContext.sampleRate);
  const now = performance.now();
  const live = hz != null && rms >= 0.008;

  if (live) {
    lastSignalAt = now;
    holdHz = hz;
    applyReading(hz, false);
  } else if (holdHz != null && now - lastSignalAt < HOLD_MS) {
    applyReading(holdHz, true);
  } else {
    holdHz = null;
    showWaitingForPluck();
  }

  rafId = requestAnimationFrame(tick);
}

function stopMic() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  mediaStream?.getTracks().forEach((tr) => tr.stop());
  mediaStream = null;
  audioContext?.close().catch(() => {});
  audioContext  = null;
  analyser      = null;
  dataBuffer    = null;
  holdHz        = null;
  lastSignalAt  = 0;
  displayingHold = false;

  el.btnMic.textContent = "Start microphone";
  el.btnMic.setAttribute("aria-pressed", "false");
  el.freq.textContent = "— Hz";
  el.hint.textContent = "Mic off";
  el.note.textContent = "—";
  el.cents.textContent = "";
  el.cents.classList.remove("in-tune");
  clearTuneDirection();
  setNeedleCents(0);
  el.meterCard.classList.remove("is-holding", "is-in-tune");
}

async function startMic() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    el.hint.textContent = "Microphone permission denied or unavailable.";
    return;
  }

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);
  dataBuffer = new Float32Array(analyser.fftSize);

  holdHz = null;
  lastSignalAt = 0;
  displayingHold = false;

  el.btnMic.textContent = "Stop microphone";
  el.btnMic.setAttribute("aria-pressed", "true");
  el.hint.textContent = "Pluck the selected string — listening…";
  tick();
}

// ── Event listeners ──────────────────────────────────────────────────────────

el.btnMic.addEventListener("click", () => {
  if (audioContext) stopMic();
  else startMic();
});

el.lowG.addEventListener("change", () => {
  buildStringButtons();
  updateTargetLine();
  if (holdHz != null) applyReading(holdHz, displayingHold);
});

window.addEventListener("beforeunload", stopMic);

// ── Init ─────────────────────────────────────────────────────────────────────

buildStringButtons();
updateTargetLine();
