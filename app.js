/**
 * Ukulele tuner — mic → YIN pitch detection → note + cents + educational tools.
 *
 * Features:
 *  • Tuner: YIN algorithm with bandpass filter chain and pitch-stability gating
 *  • Chord Practice: string-by-string verification using monophonic pitch detection
 *  • Rhythm Trainer: strum detection, BPM + consistency, optional metronome
 *  • Record & Review: MediaRecorder capture + waveform + pitch variance analysis
 */

import { CHORD_DATA, chordStringNotes, renderChordDiagram } from "./chord-data.js";

const A4_HZ     = 440;
const NOTE_NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];

function hzToMidi(hz) { return 12 * Math.log2(hz / A4_HZ) + 69; }

function midiToNoteName(midi) {
  const n    = Math.round(midi);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const oct  = Math.floor(n / 12) - 1;
  return { name, octave: oct, midi: n };
}

function centsBetween(freq, targetHz) { return 1200 * Math.log2(freq / targetHz); }

function stringTargets(lowG) {
  return [
    { id: "g", label: "G", hz: lowG ? 196.0 : 392.0 },
    { id: "c", label: "C", hz: 261.6255653005986 },
    { id: "e", label: "E", hz: 329.62755691287 },
    { id: "a", label: "A", hz: 440.0 },
  ];
}

// ── YIN pitch detection ───────────────────────────────────────────────────────

function yinPitch(buffer, sampleRate) {
  const n     = buffer.length;
  const halfN = Math.floor(n / 2);

  let rms = 0;
  for (let i = 0; i < n; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.015) return { hz: null, rms, clarity: 0 };

  const minHz   = 170;
  const maxHz   = 1050;
  const minLag  = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag  = Math.min(halfN - 1, Math.ceil(sampleRate / minHz));

  const diff = new Float32Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    for (let i = 0; i < halfN; i++) {
      const d = buffer[i] - buffer[i + tau];
      diff[tau] += d * d;
    }
  }

  const cmnd   = new Float32Array(maxLag + 1);
  cmnd[0]      = 1;
  let runSum   = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runSum    += diff[tau];
    cmnd[tau]  = runSum > 0 ? (diff[tau] * tau) / runSum : 1;
  }

  const THRESHOLD = 0.12;
  let bestLag = -1;
  for (let tau = minLag; tau < maxLag; tau++) {
    if (cmnd[tau] < THRESHOLD && cmnd[tau] <= cmnd[tau + 1]) { bestLag = tau; break; }
  }

  if (bestLag < 0) {
    let minVal = Infinity;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmnd[tau] < minVal) { minVal = cmnd[tau]; bestLag = tau; }
    }
    if (minVal > 0.35) return { hz: null, rms, clarity: 1 - minVal };
  }

  const t     = bestLag;
  const y1    = t > minLag ? cmnd[t - 1] : cmnd[t];
  const y2    = cmnd[t];
  const y3    = t < maxLag ? cmnd[t + 1] : cmnd[t];
  const denom = y1 - 2 * y2 + y3;
  const delta = Math.abs(denom) > 1e-12 ? 0.5 * (y1 - y3) / denom : 0;
  return { hz: sampleRate / (t + delta), rms, clarity: 1 - y2 };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const el = {
  // Tuner
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
  // Chord practice
  chordGrid:     document.getElementById("chord-grid"),
  chordDetail:   document.getElementById("chord-detail"),
  // Rhythm
  bpmDisplay:          document.getElementById("bpm-display"),
  consistencyDisplay:  document.getElementById("consistency-display"),
  beatTrail:           document.getElementById("beat-trail"),
  metronomeToggle:     document.getElementById("metronome-toggle"),
  metronomeSlider:     document.getElementById("metronome-slider"),
  metronomeBpmLabel:   document.getElementById("metronome-bpm-label"),
  rhythmHint:          document.getElementById("rhythm-hint"),
  // Record
  btnRecord:        document.getElementById("btn-record"),
  recordTimer:      document.getElementById("record-timer"),
  waveformCanvas:   document.getElementById("waveform-canvas"),
  playbackControls: document.getElementById("playback-controls"),
  playbackAudio:    document.getElementById("playback-audio"),
  btnPlay:          document.getElementById("btn-play"),
  btnSave:          document.getElementById("btn-save"),
  analysisCard:     document.getElementById("analysis-card"),
  recordHint:       document.getElementById("record-hint"),
};

// ── Audio state ───────────────────────────────────────────────────────────────

let audioContext     = null;
let mediaStream      = null;
let analyser         = null;
let dataBuffer       = null;
let rafId            = null;
let selectedStringId = "g";

const HOLD_MS        = 3200;
let holdHz           = null;
let lastSignalAt     = 0;
let displayingHold   = false;

const STABILITY_FRAMES = 2;
let pitchHistory = [];

// ── Tab navigation ────────────────────────────────────────────────────────────

let activePanel = "panel-tuner";

function switchTab(panelId) {
  document.querySelectorAll(".panel").forEach(p => { p.hidden = p.id !== panelId; });
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.setAttribute("aria-selected", b.dataset.panel === panelId ? "true" : "false"));
  activePanel = panelId;
  if (panelId === "panel-rhythm") {
    sizeCanvas(el.beatTrail);
    updateRhythmHint();
  }
  if (panelId === "panel-record") {
    sizeCanvas(el.waveformCanvas);
    updateRecordHint();
  }
}

// ── Canvas sizing (DPR-aware) ─────────────────────────────────────────────────

function sizeCanvas(canvas) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;
  if (!cssW) return;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
}

// ── Chord practice ────────────────────────────────────────────────────────────

let chordPractice = {
  active:         false,
  chordId:        null,
  strumDirection: "down",  // "down" | "up" — instructed direction
  armed:          true,    // ready to detect next strum onset
  collecting:     false,   // in post-strum pitch-collection window
  collectUntil:   0,       // performance.now() deadline
  cooldownUntil:  0,       // performance.now() — don't re-arm until after this
  pitchSamples:   [],      // hz values captured after strum
  lastResult:     null,    // { pass, score } | null
};

const CHORD_CATEGORIES = [
  { key: "essential", label: "Essential" },
  { key: "minor",     label: "Minor" },
  { key: "seventh",   label: "7th Chords" },
];

function renderChordPanel() {
  el.chordGrid.innerHTML = "";
  for (const { key, label } of CHORD_CATEGORIES) {
    const chords = CHORD_DATA.filter(c => c.category === key);
    if (!chords.length) continue;

    const section = document.createElement("div");
    section.className = "chord-section";

    const heading = document.createElement("p");
    heading.className   = "chord-section-label";
    heading.textContent = label;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "chord-section-grid";
    for (const chord of chords) {
      const btn = document.createElement("button");
      btn.type        = "button";
      btn.className   = "chord-chip";
      btn.dataset.id  = chord.id;
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = chord.id;
      btn.addEventListener("click", () => selectChord(chord.id));
      grid.appendChild(btn);
    }

    section.appendChild(grid);
    el.chordGrid.appendChild(section);
  }
}

function selectChord(chordId) {
  stopChordPractice();
  // Toggle off if clicking same chord
  const wasSelected = chordPractice.chordId === chordId && !el.chordDetail.hidden;
  document.querySelectorAll(".chord-chip").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.id === chordId && !wasSelected ? "true" : "false"));

  if (wasSelected) {
    el.chordDetail.hidden = true;
    chordPractice.chordId = null;
    return;
  }

  chordPractice.chordId = chordId;
  const chord = CHORD_DATA.find(c => c.id === chordId);
  renderChordDetail(chord);
  el.chordDetail.hidden = false;
}

function renderChordDetail(chord) {
  const svg = renderChordDiagram(chord, 130);
  el.chordDetail.innerHTML = "";

  const header = document.createElement("div");
  header.className = "chord-detail-header";

  const info = document.createElement("div");
  info.className = "chord-detail-info";
  info.innerHTML = `
    <p class="chord-detail-name">${chord.name}</p>
    <p class="chord-detail-tones">Notes: ${chord.tones.join(" · ")}</p>
  `;

  const startBtn = document.createElement("button");
  startBtn.type      = "button";
  startBtn.className = "btn btn-secondary";
  startBtn.textContent = "▶ Practice";
  startBtn.style.marginTop = "0.35rem";
  startBtn.addEventListener("click", startChordPractice);

  info.appendChild(startBtn);
  header.appendChild(svg);
  header.appendChild(info);
  el.chordDetail.appendChild(header);

  const practiceArea = document.createElement("div");
  practiceArea.className = "chord-practice-area";
  practiceArea.id        = "practice-area";
  el.chordDetail.appendChild(practiceArea);
}

const CHORD_ONSET      = 0.032;   // lower than rhythm trainer — catches softer strums
const CHORD_RELEASE    = 0.014;
const COLLECT_MS       = 800;    // longer window to capture the full chord ring
const CHORD_COOLDOWN   = 1200;   // ms after collection ends before re-arming
const MIN_COLLECT_RMS  = 0.012;  // ignore near-silent frames during collection

function startChordPractice() {
  if (!audioContext) {
    const area = document.getElementById("practice-area");
    if (area) area.innerHTML = `<p class="hint" style="text-align:center">Start the microphone on the Tune tab first.</p>`;
    return;
  }
  chordPractice.active         = true;
  chordPractice.armed          = true;
  chordPractice.collecting     = false;
  chordPractice.pitchSamples   = [];
  chordPractice.lastResult     = null;
  chordPractice.strumDirection = "down";
  renderStrumUI();
}

function stopChordPractice() {
  chordPractice.active     = false;
  chordPractice.collecting = false;
}

function renderStrumUI() {
  const area = document.getElementById("practice-area");
  if (!area) return;

  const dir   = chordPractice.strumDirection;
  const arrow = dir === "down" ? "↓" : "↑";
  const label = dir === "down" ? "Strum Down" : "Strum Up";

  const result = chordPractice.lastResult;
  let feedbackHtml = `<p class="strum-waiting">Waiting for strum…</p>`;
  if (result) {
    const pct  = Math.round(result.score * 100);
    const pass = result.pass;
    feedbackHtml = `
      <div class="strum-result ${pass ? "pass" : "fail"}">
        <span class="strum-result-icon">${pass ? "✓" : "✗"}</span>
        <span>${pass ? "Sounds good!" : "Check your fingering"}</span>
      </div>
      <div class="strum-score-bar">
        <div class="strum-score-fill" style="width:${pct}%;background:${pass ? "var(--in-tune)" : "var(--flat-color)"}"></div>
      </div>
      <p class="strum-score-label">${pct}% of notes matched</p>
    `;
  }

  area.innerHTML = `
    <div class="strum-cue">
      <span class="strum-arrow">${arrow}</span>
      <span class="strum-label">${label}</span>
    </div>
    <div class="live-meter" id="live-meter">
      <div class="live-note-row">
        <span class="live-note-name mono" id="live-note-name">—</span>
        <span class="live-nearest" id="live-nearest">nearest: —</span>
        <span class="live-cents mono" id="live-cents"></span>
      </div>
      <div class="live-needle-track">
        <div class="live-needle-center"></div>
        <div class="live-needle-bar" id="live-needle-bar"></div>
      </div>
      <div class="live-needle-labels">
        <span style="color:var(--flat-color)">flat</span>
        <span>in tune</span>
        <span style="color:var(--sharp-color)">sharp</span>
      </div>
    </div>
    <div class="strum-feedback">${feedbackHtml}</div>
    <button type="button" class="btn btn-secondary" id="stop-practice-btn"
      style="margin-top:0.75rem;font-size:0.82rem;padding:0.5rem 0.9rem;width:100%">
      Stop
    </button>
  `;
  document.getElementById("stop-practice-btn")?.addEventListener("click", () => {
    stopChordPractice();
    area.innerHTML = "";
  });
}

function updateLiveMeter(hz, clarity) {
  const noteName = document.getElementById("live-note-name");
  const nearest  = document.getElementById("live-nearest");
  const centsEl  = document.getElementById("live-cents");
  const bar      = document.getElementById("live-needle-bar");
  if (!noteName || !bar) return;

  if (!hz || clarity < 0.55) {
    noteName.textContent = "—";
    nearest.textContent  = "nearest: —";
    centsEl.textContent  = "";
    bar.style.left       = "50%";
    bar.style.background = "var(--muted)";
    return;
  }

  const chord = CHORD_DATA.find(c => c.id === chordPractice.chordId);
  const notes = chordStringNotes(chord, el.lowG.checked).filter(n => !n.muted);

  // Find nearest chord tone
  let bestNote = null, bestCents = Infinity;
  for (const n of notes) {
    const c = centsBetween(hz, n.hz);
    if (Math.abs(c) < Math.abs(bestCents)) { bestCents = c; bestNote = n; }
  }

  const { name, octave } = midiToNoteName(hzToMidi(hz));
  noteName.textContent = `${name}${octave}`;
  nearest.textContent  = `nearest: ${bestNote?.noteName ?? "—"}`;

  const absCents = Math.round(Math.abs(bestCents));
  const sign     = bestCents > 0 ? "+" : bestCents < 0 ? "−" : "";
  centsEl.textContent = `${sign}${absCents}¢`;

  // Position: ±100¢ maps to 0–100% of the track
  const pct   = Math.max(0, Math.min(100, 50 + (bestCents / 100) * 50));
  const color = absCents <= 20 ? "var(--in-tune)"
              : absCents <= 50 ? "var(--warm)"
              : "var(--flat-color)";
  bar.style.left       = `${pct}%`;
  bar.style.background = color;
  centsEl.style.color  = color;
}

function evaluateStrum() {
  const chord   = CHORD_DATA.find(c => c.id === chordPractice.chordId);
  const notes   = chordStringNotes(chord, el.lowG.checked).filter(n => !n.muted);
  const samples = chordPractice.pitchSamples.filter(h => h != null);
  if (samples.length < 3) return { pass: false, score: 0 };

  let matches = 0;
  for (const hz of samples) {
    const closestCents = Math.min(...notes.map(n => Math.abs(centsBetween(hz, n.hz))));
    if (closestCents <= 60) matches++;
  }
  const score = matches / samples.length;
  return { pass: score >= 0.5, score };
}

function chordFrame(hz, rms, clarity, now) {
  if (!chordPractice.active || !chordPractice.chordId) return;

  updateLiveMeter(hz, clarity);

  // ── collection window: gather pitches after strum onset ───────────────────
  if (chordPractice.collecting) {
    if (now < chordPractice.collectUntil) {
      if (hz && clarity > 0.6 && rms >= MIN_COLLECT_RMS) chordPractice.pitchSamples.push(hz);
    } else {
      chordPractice.collecting    = false;
      chordPractice.cooldownUntil = now + CHORD_COOLDOWN;
      chordPractice.lastResult    = evaluateStrum();
      chordPractice.strumDirection = chordPractice.strumDirection === "down" ? "up" : "down";
      renderStrumUI();
    }
    return;
  }

  // ── cooldown: wait before re-arming so decay doesn't retrigger ───────────
  if (now < chordPractice.cooldownUntil) return;

  // ── re-arm on release ─────────────────────────────────────────────────────
  if (!chordPractice.armed && rms < CHORD_RELEASE) {
    chordPractice.armed = true;
  }

  // ── detect strum onset ────────────────────────────────────────────────────
  if (chordPractice.armed && rms >= CHORD_ONSET) {
    chordPractice.armed        = false;
    chordPractice.collecting   = true;
    chordPractice.collectUntil = now + COLLECT_MS;
    chordPractice.pitchSamples = [];
  }
}

// ── Rhythm trainer ────────────────────────────────────────────────────────────

const ONSET_THRESHOLD   = 0.045;
const RELEASE_THRESHOLD = 0.018;
const MIN_STRUM_GAP_MS  = 150;

let strumArmed       = true;
let lastStrumAt      = 0;
let strumTimestamps  = [];

let metronomeCtx         = null;
let metronomeBpm         = 80;
let metronomeActive      = false;
let metronomeIntervalId  = null;
let metronomeNextBeat    = 0;

function rhythmFrame(rms, now) {
  detectStrum(rms, now);
  drawBeatTrail(now);
}

function detectStrum(rms, now) {
  if (strumArmed && rms >= ONSET_THRESHOLD) {
    if (now - lastStrumAt > MIN_STRUM_GAP_MS) {
      recordStrum(now);
      lastStrumAt = now;
    }
    strumArmed = false;
  } else if (!strumArmed && rms < RELEASE_THRESHOLD) {
    strumArmed = true;
  }
}

function recordStrum(now) {
  strumTimestamps.push(now);
  if (strumTimestamps.length > 16) strumTimestamps.shift();
  updateRhythmUI();
}

function computeRhythmStats() {
  if (strumTimestamps.length < 3) return { bpm: 0, consistencyPct: 0 };
  const intervals = [];
  for (let i = 1; i < strumTimestamps.length; i++)
    intervals.push(strumTimestamps[i] - strumTimestamps[i - 1]);

  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const clean  = intervals.filter(iv => iv < median * 3 && iv > 50);
  if (clean.length < 1) return { bpm: 0, consistencyPct: 0 };

  const mean     = clean.reduce((s, v) => s + v, 0) / clean.length;
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length;
  const stddev   = Math.sqrt(variance);
  const bpm      = Math.round(60000 / mean);
  const cv       = stddev / mean;
  const consistencyPct = Math.max(0, Math.round((1 - cv / 0.25) * 100));

  return { bpm, consistencyPct };
}

function updateRhythmUI() {
  const { bpm, consistencyPct } = computeRhythmStats();
  el.bpmDisplay.textContent         = bpm > 0 ? bpm : "—";
  el.consistencyDisplay.textContent = bpm > 0 ? `${consistencyPct}%` : "—";
}

function drawBeatTrail(now) {
  const canvas = el.beatTrail;
  if (!canvas.width) return;
  const dpr  = window.devicePixelRatio || 1;
  const W    = canvas.width / dpr;
  const H    = canvas.height / dpr;
  const ctx  = canvas.getContext("2d");
  const WINDOW_MS = 4000;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const { consistencyPct } = computeRhythmStats();

  for (const ts of strumTimestamps) {
    const age    = now - ts;
    if (age > WINDOW_MS) continue;
    const x      = ((WINDOW_MS - age) / WINDOW_MS) * W;
    const alpha  = 1 - age / WINDOW_MS;
    // Colour by consistency: green if good, amber if poor
    const colour = consistencyPct >= 70 ? `rgba(46,204,113,${alpha})` : `rgba(255,193,59,${alpha})`;
    ctx.beginPath();
    ctx.arc(x, H / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  ctx.restore();
}

function updateRhythmHint() {
  el.rhythmHint.hidden = !!audioContext;
}

function scheduleMetronomeClick(time) {
  const osc  = metronomeCtx.createOscillator();
  const gain = metronomeCtx.createGain();
  osc.connect(gain);
  gain.connect(metronomeCtx.destination);
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.3, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  osc.start(time);
  osc.stop(time + 0.05);
}

function metronomeScheduler() {
  const lookahead = 0.1; // seconds
  while (metronomeNextBeat < metronomeCtx.currentTime + lookahead) {
    scheduleMetronomeClick(metronomeNextBeat);
    metronomeNextBeat += 60 / metronomeBpm;
  }
}

function startMetronome(bpm) {
  metronomeBpm = bpm;
  if (!metronomeCtx || metronomeCtx.state === "closed") {
    metronomeCtx = new AudioContext();
  } else if (metronomeCtx.state === "suspended") {
    metronomeCtx.resume();
  }
  metronomeNextBeat   = metronomeCtx.currentTime + 0.05;
  metronomeIntervalId = setInterval(metronomeScheduler, 25);
  metronomeActive     = true;
  el.metronomeToggle.textContent = "Stop metronome";
  el.metronomeToggle.classList.add("btn-record");
  el.metronomeToggle.classList.remove("btn-secondary");
}

function stopMetronome() {
  clearInterval(metronomeIntervalId);
  metronomeActive = false;
  el.metronomeToggle.textContent = "Start metronome";
  el.metronomeToggle.classList.remove("btn-record");
  el.metronomeToggle.classList.add("btn-secondary");
}

// ── Recording ─────────────────────────────────────────────────────────────────

let recMediaRecorder = null;
let recChunks        = [];
let recBlob          = null;
let recObjectUrl     = null;
let recIsRecording   = false;
let recStartTime     = 0;
let recPitchLog      = [];   // { t, hz }
let recRmsLog        = [];   // { t, rms }
let recLastLogTime   = 0;
let recTimerInterval = null;
let recStopTimeout   = null;

function recordFrame(hz, rms, now) {
  const elapsed = now - recStartTime;
  if (elapsed - recLastLogTime >= 50) {
    recPitchLog.push({ t: elapsed, hz: hz ?? null });
    recRmsLog.push({ t: elapsed, rms });
    recLastLogTime = elapsed;
    drawWaveform();
  }
}

async function startRecording() {
  if (!mediaStream) {
    await startMic();
    if (!mediaStream) return;
  }

  recChunks      = [];
  recPitchLog    = [];
  recRmsLog      = [];
  recLastLogTime = 0;
  recStartTime   = performance.now();
  recIsRecording = true;

  const mimeType =
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" :
    MediaRecorder.isTypeSupported("audio/webm")             ? "audio/webm" :
    MediaRecorder.isTypeSupported("audio/mp4")              ? "audio/mp4"  : "";

  recMediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
  recMediaRecorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
  recMediaRecorder.onstop          = finalizeRecording;
  recMediaRecorder.start(100);

  recStopTimeout = setTimeout(stopRecording, 30000);
  recTimerInterval = setInterval(updateRecordTimer, 250);

  el.btnRecord.setAttribute("aria-pressed", "true");
  el.btnRecord.querySelector(".rec-label").textContent = "Stop";
  el.analysisCard.hidden    = true;
  el.playbackControls.hidden = true;
  el.recordHint.hidden      = true;
}

function stopRecording() {
  if (!recIsRecording) return;
  clearTimeout(recStopTimeout);
  clearInterval(recTimerInterval);
  recIsRecording = false;
  recMediaRecorder?.stop();
  el.btnRecord.setAttribute("aria-pressed", "false");
  el.btnRecord.querySelector(".rec-label").textContent = "Record";
  el.recordTimer.textContent = "0:00 / 0:30";
}

function finalizeRecording() {
  const type   = recMediaRecorder?.mimeType || "audio/webm";
  recBlob      = new Blob(recChunks, { type });
  if (recObjectUrl) URL.revokeObjectURL(recObjectUrl);
  recObjectUrl = URL.createObjectURL(recBlob);

  el.playbackAudio.src        = recObjectUrl;
  el.btnSave.href             = recObjectUrl;
  el.btnSave.download         = type.includes("mp4") ? "uke-recording.mp4" : "uke-recording.webm";
  el.playbackControls.hidden  = false;

  drawWaveform();
  renderAnalysis();
  el.analysisCard.hidden = false;
}

function updateRecordTimer() {
  const elapsed = performance.now() - recStartTime;
  const secs    = Math.floor(elapsed / 1000);
  const m       = Math.floor(secs / 60);
  const s       = secs % 60;
  el.recordTimer.textContent = `${m}:${s.toString().padStart(2, "0")} / 0:30`;
}

function drawWaveform(currentSec = null) {
  const canvas = el.waveformCanvas;
  if (!canvas.width || !recRmsLog.length) return;
  const dpr  = window.devicePixelRatio || 1;
  const W    = canvas.width / dpr;
  const H    = canvas.height / dpr;
  const ctx  = canvas.getContext("2d");

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const total = recRmsLog[recRmsLog.length - 1].t || 1;
  const BAR_W = 2;

  ctx.fillStyle = "rgba(255,107,71,0.55)";
  for (const { t, rms } of recRmsLog) {
    const x = (t / total) * W;
    const h = Math.min(rms * 10, 1) * (H / 2);
    ctx.fillRect(x - BAR_W / 2, H / 2 - h, BAR_W, h * 2);
  }

  if (currentSec !== null) {
    const px = (currentSec * 1000 / total) * W;
    ctx.strokeStyle = "#ffc13b";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
  }

  ctx.restore();
}

function analyzeRecording() {
  const valid = recPitchLog.filter(p => p.hz !== null).map(p => p.hz);
  if (valid.length < 4) return null;

  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cents  = valid.map(h => 1200 * Math.log2(h / median));
  const mean   = cents.reduce((s, v) => s + v, 0) / cents.length;
  const stddev = Math.sqrt(cents.reduce((s, v) => s + (v - mean) ** 2, 0) / cents.length);
  const durationSec = (recRmsLog[recRmsLog.length - 1]?.t ?? 0) / 1000;

  return { stddev, noteCount: valid.length, durationSec };
}

function renderAnalysis() {
  const result = analyzeRecording();
  el.analysisCard.innerHTML = "";

  const title = document.createElement("p");
  title.className   = "analysis-title";
  title.textContent = "Analysis";
  el.analysisCard.appendChild(title);

  if (!result) {
    const msg = document.createElement("p");
    msg.className   = "analysis-detail";
    msg.textContent = "No sustained notes detected — try playing for longer.";
    el.analysisCard.appendChild(msg);
    return;
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - result.stddev * 2.5)));

  const barRow = document.createElement("div");
  barRow.className = "analysis-bar-row";
  barRow.innerHTML = `
    <span class="analysis-bar-label">Steadiness</span>
    <div class="analysis-bar-track">
      <div class="analysis-bar-fill" style="width:${score}%"></div>
    </div>
    <span class="analysis-bar-pct">${score}%</span>
  `;
  el.analysisCard.appendChild(barRow);

  const detail = document.createElement("p");
  detail.className = "analysis-detail";
  const cents = Math.round(result.stddev);
  if (result.stddev < 8) {
    detail.textContent = `Pitch variance ~${cents}¢ — very steady. Great intonation!`;
    detail.style.color = "var(--in-tune)";
  } else if (result.stddev < 20) {
    detail.textContent = `Pitch variance ~${cents}¢ — decent for a beginner. Work on sustaining even pressure behind the fret.`;
    detail.style.color = "var(--warm)";
  } else {
    detail.textContent = `Pitch variance ~${cents}¢ — pitch wandered quite a bit. Try pressing firmly just behind the fret, not on top of it.`;
    detail.style.color = "var(--flat-color)";
  }
  el.analysisCard.appendChild(detail);
}

function updateRecordHint() {
  el.recordHint.hidden = !!audioContext;
}

// ── Tuner UI helpers ──────────────────────────────────────────────────────────

function buildStringButtons() {
  el.stringButtons.innerHTML = "";
  for (const t of stringTargets(el.lowG.checked)) {
    const b = document.createElement("button");
    b.type      = "button";
    b.className = "string-btn";
    b.dataset.id = t.id;
    b.setAttribute("aria-pressed", t.id === selectedStringId ? "true" : "false");
    b.innerHTML = `<span class="name">${t.label}</span><span class="hz">${Math.round(t.hz)} Hz</span>`;
    b.addEventListener("click", () => {
      selectedStringId = t.id;
      for (const child of el.stringButtons.children)
        child.setAttribute("aria-pressed", child.dataset.id === selectedStringId ? "true" : "false");
      updateTargetLine();
      if (holdHz != null) applyReading(holdHz, displayingHold);
    });
    el.stringButtons.appendChild(b);
  }
}

function selectedTargetHz() {
  return stringTargets(el.lowG.checked).find(x => x.id === selectedStringId)?.hz ?? null;
}

function updateTargetLine() {
  const t = stringTargets(el.lowG.checked).find(x => x.id === selectedStringId);
  if (t) el.targetLine.textContent = `Target: ${t.label} ≈ ${t.hz.toFixed(2)} Hz`;
}

function setNeedleCents(cents) {
  el.needle.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
}

function clearTuneDirection() {
  el.tuneDirection.textContent = "";
  el.tuneDirection.className   = "tune-direction is-empty";
}

function setTuneDirection(cents) {
  const rounded = Math.round(cents);
  const abs     = Math.abs(rounded);
  if (abs <= 5) {
    el.tuneDirection.textContent = "Aloha — you're in tune! Re-pluck to confirm if the needle keeps wiggling.";
    el.tuneDirection.className   = "tune-direction ok";
    return;
  }
  if (rounded > 0) {
    el.tuneDirection.textContent = `Too sharp by ~${abs} cents — pitch is too high. Loosen the string until the needle moves toward centre.`;
    el.tuneDirection.className   = "tune-direction sharp";
  } else {
    el.tuneDirection.textContent = `Too flat by ~${abs} cents — pitch is too low. Tighten the string until the needle moves toward centre.`;
    el.tuneDirection.className   = "tune-direction flat";
  }
}

function applyReading(hz, isHolding) {
  displayingHold       = isHolding;
  el.freq.textContent  = `${hz.toFixed(1)} Hz`;
  el.hint.textContent  = isHolding ? "Holding last reading — pluck again for a fresh measurement." : "";

  const { name, octave } = midiToNoteName(hzToMidi(hz));
  el.note.textContent = `${name}${octave}`;

  const target = selectedTargetHz();
  let isInTune = false;
  if (target) {
    const cents   = centsBetween(hz, target);
    const rounded = Math.round(cents);
    const abs     = Math.abs(rounded);
    isInTune      = abs <= 5;
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
  displayingHold       = false;
  el.freq.textContent  = "— Hz";
  el.hint.textContent  = "Pluck the selected string — listening…";
  el.note.textContent  = "—";
  el.cents.textContent = "";
  el.cents.classList.remove("in-tune");
  clearTuneDirection();
  setNeedleCents(0);
  el.meterCard.classList.remove("is-holding", "is-in-tune");
}

// ── Audio engine ──────────────────────────────────────────────────────────────

function tunerFrame(hz, rms, clarity, now) {
  const candidate = hz != null && rms >= 0.015 && clarity >= 0.88;

  if (candidate) {
    pitchHistory.push(hz);
    if (pitchHistory.length > STABILITY_FRAMES) pitchHistory.shift();

    const stable =
      pitchHistory.length >= STABILITY_FRAMES &&
      pitchHistory.every(h => Math.abs(1200 * Math.log2(h / hz)) <= 20);

    if (stable) {
      lastSignalAt = now;
      holdHz       = hz;
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
}

function tick() {
  if (!analyser || !dataBuffer || !audioContext) return;

  analyser.getFloatTimeDomainData(dataBuffer);
  const { hz, rms, clarity } = yinPitch(dataBuffer, audioContext.sampleRate);
  const now = performance.now();

  tunerFrame(hz, rms, clarity, now);
  if (activePanel === "panel-rhythm") rhythmFrame(rms, now);
  if (recIsRecording) recordFrame(hz, rms, now);
  if (chordPractice.active) chordFrame(hz, rms, clarity, now);

  rafId = requestAnimationFrame(tick);
}

function stopMic() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  mediaStream?.getTracks().forEach(tr => tr.stop());
  mediaStream  = null;
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
  el.freq.textContent  = "— Hz";
  el.hint.textContent  = "Mic off";
  el.note.textContent  = "—";
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

  audioContext  = new AudioContext();
  const source  = audioContext.createMediaStreamSource(mediaStream);

  const hipass  = audioContext.createBiquadFilter();
  hipass.type   = "highpass";
  hipass.frequency.value = 150;
  hipass.Q.value = 0.7;

  const lopass  = audioContext.createBiquadFilter();
  lopass.type   = "lowpass";
  lopass.frequency.value = 1100;
  lopass.Q.value = 0.7;

  analyser      = audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.15;

  source.connect(hipass);
  hipass.connect(lopass);
  lopass.connect(analyser);
  dataBuffer = new Float32Array(analyser.fftSize);

  holdHz        = null;
  lastSignalAt  = 0;
  displayingHold = false;
  pitchHistory  = [];

  el.btnMic.textContent = "Stop microphone";
  el.btnMic.setAttribute("aria-pressed", "true");
  el.hint.textContent   = "Pluck the selected string — listening…";

  updateRhythmHint();
  updateRecordHint();
  tick();
}

// ── Event listeners ───────────────────────────────────────────────────────────

el.btnMic.addEventListener("click", () => {
  if (audioContext) stopMic(); else startMic();
});

el.lowG.addEventListener("change", () => {
  buildStringButtons();
  updateTargetLine();
  if (holdHz != null) applyReading(holdHz, displayingHold);
});

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.panel));
});

// Metronome toggle
el.metronomeToggle.addEventListener("click", () => {
  if (metronomeActive) stopMetronome();
  else startMetronome(metronomeBpm);
});

// Metronome slider
el.metronomeSlider.addEventListener("input", () => {
  metronomeBpm = Number(el.metronomeSlider.value);
  el.metronomeBpmLabel.textContent = `${metronomeBpm} BPM`;
  if (metronomeActive) {
    // Restart with new tempo
    clearInterval(metronomeIntervalId);
    metronomeNextBeat   = metronomeCtx.currentTime + 0.05;
    metronomeIntervalId = setInterval(metronomeScheduler, 25);
  }
});

// Metronome preset buttons
document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    metronomeBpm = Number(btn.dataset.bpm);
    el.metronomeSlider.value        = metronomeBpm;
    el.metronomeBpmLabel.textContent = `${metronomeBpm} BPM`;
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (metronomeActive) {
      clearInterval(metronomeIntervalId);
      metronomeNextBeat   = metronomeCtx.currentTime + 0.05;
      metronomeIntervalId = setInterval(metronomeScheduler, 25);
    }
  });
});

// Record button
el.btnRecord.addEventListener("click", () => {
  if (recIsRecording) stopRecording(); else startRecording();
});

// Playback
el.btnPlay.addEventListener("click", () => {
  if (el.playbackAudio.paused) {
    el.playbackAudio.play();
    el.btnPlay.textContent = "⏸ Pause";
  } else {
    el.playbackAudio.pause();
    el.btnPlay.textContent = "▶ Play";
  }
});

el.playbackAudio.addEventListener("ended", () => {
  el.btnPlay.textContent = "▶ Play";
});

el.playbackAudio.addEventListener("timeupdate", () => {
  drawWaveform(el.playbackAudio.currentTime);
});

window.addEventListener("beforeunload", stopMic);

// ── Init ──────────────────────────────────────────────────────────────────────

buildStringButtons();
updateTargetLine();
renderChordPanel();
