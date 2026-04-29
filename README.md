# Ukulele Tuner

A free, browser-based ukulele tuner and learning tool. No app download, no plugin, no account — just open the page, allow microphone access, and start playing.

**[Live demo → tunemyukulele.surf](https://tunemyukulele.surf)**

---

## Features

### Tuner
- **Standard & Low G tuning** — supports both high G (G4 C4 E4 A4) and low G (G3 C4 E4 A4 / baritone / linear) tunings
- **Hold-on-silence** — the reading stays frozen for ~3 seconds after the string stops ringing so you can adjust the peg without re-plucking
- **Cent-accurate meter** — YIN pitch detection algorithm with a clarity gate for strong noise rejection
- **Plain-text guidance** — tells you exactly which direction to turn the peg and by roughly how many cents

### Chord Practice
- Choose from 9 beginner chords (C, Am, F, G, G7, D, Dm, E7, A7)
- SVG chord diagram with finger positions
- Pluck each string one at a time — the mic verifies your pitch and auto-advances when it's in tune (±25 cents tolerance)

### Rhythm Trainer
- Strum freely and see your BPM and consistency percentage in real time
- Beat trail canvas shows the timing of your last 4 seconds of strums
- Built-in metronome (40–200 BPM) with a Web Audio click track

### Record & Review
- Record up to 30 seconds of playing directly in the browser
- Waveform display with a scrubbing playhead
- Pitch steadiness analysis — measures cents variance across the recording and gives written feedback
- Download the recording as a `.webm` file

### General
- **No dependencies** — vanilla HTML, CSS, and JavaScript (ES modules); zero build step required
- Works on desktop and mobile browsers (Chrome, Firefox, Safari)

## How to use

1. Open [tunemyukulele.surf](https://tunemyukulele.surf).
2. On the **Tune** tab, click **Start microphone** and choose **Allow**.
3. Select the string you're tuning (**G**, **C**, **E**, or **A**), pluck it, and follow the meter.
4. Switch to **Chords**, **Rhythm**, or **Record** from the bottom tab bar — the microphone stays active across tabs.

## Running locally

The Web Audio API requires a secure context (`https://` or `localhost`). Opening `index.html` directly as a `file://` URL will block microphone access in most browsers.

**Option 1 — Python (no install needed on macOS/Linux):**

```bash
cd ~/path/to/ukulele-tuner
python3 -m http.server 8765
# then open http://localhost:8765
```

**Option 2 — Node.js:**

```bash
npx serve .
# then open the URL shown in the terminal
```

**Option 3 — VS Code:** install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension and click **Go Live**.

## How it works

Audio is captured via `getUserMedia`, passed through a bandpass filter (150–1100 Hz) to reject speech and low-frequency rumble, and fed into a Web Audio `AnalyserNode` with a 4096-sample window. Each animation frame the raw PCM buffer is analysed using the **YIN algorithm** (de Cheveigné & Kawahara 2002):

1. Compute RMS — frames below the noise floor are ignored.
2. Compute the cumulative mean normalized difference function (CMND) across candidate periods.
3. Find the first lag below the aperiodicity threshold (0.12) using parabolic interpolation for sub-sample accuracy.
4. Gate the result with a **clarity score** — ambiguous frames (clarity < 0.85) are discarded.
5. Require two consecutive stable frames (within ±20 cents) before updating the display, preventing transient noise from registering as a pitch.

After the signal drops, the last detected pitch is held for 3.2 seconds so you can read the result while adjusting the peg.

## License

MIT — see [LICENSE](LICENSE).
