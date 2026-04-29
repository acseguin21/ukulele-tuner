/**
 * Ukulele tuner — mic → pitch detection (YIN algorithm) → note + cents vs selected string.
 *
 * Uses the Web Audio API with a bandpass filter chain to reject background noise and
 * speech, followed by the YIN pitch detection algorithm which produces a clarity score
 * that makes it easy to distinguish periodic (musical) signals from aperiodic noise.
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
 * YIN pitch detection algorithm (de Cheveigné & Kawahara, 2002).
 *
 * Computes the cumulative mean normalised difference function (CMND) and finds
 * the first lag whose value drops below an aperiodicity threshold. Returns a
 * clarity score (0–1): high values (~0.9+) indicate a clean periodic signal;
 * low values indicate noise or speech. Parabolic interpolation gives sub-sample
 * frequency accuracy.
 *
 * @param {Float32Array} buffer     - Raw PCM samples from AnalyserNode
 * @param {number}       sampleRate
 * @returns {{ hz: number|null, rms: number, clarity: number }}
 */
function yinPitch(buffer, sampleRate) {
  const n = buffer.length;
  const halfN = Math.floor(n / 2);

  let rms = 0;
  for (let i = 0; i < n; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.015) return { hz: null, rms, clarity: 0 };

  // Limit search range to ukulele strings + small margin (Low G = 196 Hz).
  const minHz = 170;
  const maxHz = 1050;
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(halfN - 1, Math.ceil(sampleRate / minHz));

  // Step 1: difference function d(tau) = sum (x[i] - x[i+tau])^2
  const diff = new Float32Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    for (let i = 0; i < halfN; i++) {
      const delta = buffer[i] - buffer[i + tau];
      diff[tau] += delta * delta;
    }
  }

  // Step 2: cumulative mean normalised difference function
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let runSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runSum += diff[tau];
    cmnd[tau] = runSum > 0 ? (diff[tau] * tau) / runSum : 1;
  }

  // Step 3: first local minimum below aperiodicity threshold
  const THRESHOLD = 0.12; // lower = stricter periodicity requirement
  let bestLag = -1;
  for (let tau = minLag; tau < maxLag; tau++) {
    if (cmnd[tau] < THRESHOLD && cmnd[tau] <= cmnd[tau + 1]) {
      bestLag = tau;
      break;
    }
  }

  // Fall back to the global minimum when threshold is not met
  if (bestLag < 0) {
    let minVal = Infinity;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmnd[tau] < minVal) { minVal = cmnd[tau]; bestLag = tau; }
    }
    // Reject signals that are too aperiodic even at the minimum (likely noise/speech)
    if (minVal > 0.35) return { hz: null, rms, clarity: 1 - minVal };
  }

  // Step 4: parabolic interpolation for sub-sample accuracy
  const t = bestLag;
  const y1 = t > minLag ? cmnd[t - 1] : cmnd[t];
  const y2 = cmnd[t];
  const y3 = t < maxLag ? cmnd[t + 1] : cmnd[t];
  const denom = y1 - 2 * y2 + y3;
  const delta = Math.abs(denom) > 1e-12 ? 0.5 * (y1 - y3) / denom : 0;
  const hz = sampleRate / (t + delta);
  const clarity = 1 - y2; // 1 = perfectly periodic, 0 = pure noise

  return { hz, rms, clarity };
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

/**
 * Require two consecutive frames with a stable pitch (within ±20 cents) before
 * accepting a reading. Prevents transient noise bursts or single-frame glitches
 * from triggering the display.
 */
const STABILITY_FRAMES = 2;
let pitchHistory = [];

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
      "Aloha — you're in tune! Re-pluck to confirm if the needle keeps wiggling.";
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
  const { hz, rms, clarity } = yinPitch(dataBuffer, audioContext.sampleRate);
  const now = performance.now();

  // Require both a strong RMS signal and high periodicity (clarity).
  // clarity >= 0.88 rejects most speech and broadband noise while accepting
  // the clean, sustained tone of a plucked string.
  const candidate = hz != null && rms >= 0.015 && clarity >= 0.88;

  if (candidate) {
    // Accumulate pitch history and check stability across consecutive frames
    pitchHistory.push(hz);
    if (pitchHistory.length > STABILITY_FRAMES) pitchHistory.shift();

    const stable =
      pitchHistory.length >= STABILITY_FRAMES &&
      pitchHistory.every((h) => Math.abs(1200 * Math.log2(h / hz)) <= 20);

    if (stable) {
      lastSignalAt = now;
      holdHz = hz;
      applyReading(hz, false);
    }
  } else {
    pitchHistory = [];
    if (holdHz != null && now - lastSignalAt < HOLD_MS) {
      applyReading(holdHz, true);
    } else {
      holdHz = null;
      showWaitingForPluck();
    }
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
  pitchHistory  = [];

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
    // Disable browser-side processing so the raw mic signal reaches the analyser.
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    el.hint.textContent = "Microphone permission denied or unavailable.";
    return;
  }

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);

  // Bandpass filter chain: highpass removes low rumble and the bulk of male
  // speech fundamentals; lowpass removes high-frequency hiss and content the
  // YIN algorithm doesn't need above ~1 kHz.
  const hipass = audioContext.createBiquadFilter();
  hipass.type = "highpass";
  hipass.frequency.value = 150; // Hz — below Low G (196 Hz)
  hipass.Q.value = 0.7;

  const lopass = audioContext.createBiquadFilter();
  lopass.type = "lowpass";
  lopass.frequency.value = 1100; // Hz — above A4 harmonics
  lopass.Q.value = 0.7;

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.15; // reduced for quicker response

  source.connect(hipass);
  hipass.connect(lopass);
  lopass.connect(analyser);
  dataBuffer = new Float32Array(analyser.fftSize);

  holdHz = null;
  lastSignalAt = 0;
  displayingHold = false;
  pitchHistory = [];

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
