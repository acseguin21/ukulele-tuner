// Chord data and helpers for ukulele.
// String indices: 0=g, 1=C, 2=E, 3=A (left→right in standard diagram view).
// Fret values in `tabs`: 0=open, -1=muted.

export const CHORD_DATA = [
  {
    id: "C",
    name: "C major",
    tabs: [0, 0, 0, 3],
    fingers: [{ string: 3, fret: 3, finger: 3 }],
    open: [0, 1, 2],
    muted: [],
    baseFret: 1,
    tones: ["C", "E", "G"],
  },
  {
    id: "Am",
    name: "A minor",
    tabs: [2, 0, 0, 0],
    fingers: [{ string: 0, fret: 2, finger: 2 }],
    open: [1, 2, 3],
    muted: [],
    baseFret: 1,
    tones: ["A", "C", "E"],
  },
  {
    id: "F",
    name: "F major",
    tabs: [2, 0, 1, 0],
    fingers: [
      { string: 2, fret: 1, finger: 1 },
      { string: 0, fret: 2, finger: 2 },
    ],
    open: [1, 3],
    muted: [],
    baseFret: 1,
    tones: ["F", "A", "C"],
  },
  {
    id: "G",
    name: "G major",
    tabs: [0, 2, 3, 2],
    fingers: [
      { string: 1, fret: 2, finger: 1 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 3, finger: 3 },
    ],
    open: [0],
    muted: [],
    baseFret: 1,
    tones: ["G", "B", "D"],
  },
  {
    id: "G7",
    name: "G7",
    tabs: [0, 2, 1, 2],
    fingers: [
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 2, finger: 2 },
      { string: 3, fret: 2, finger: 3 },
    ],
    open: [0],
    muted: [],
    baseFret: 1,
    tones: ["G", "B", "D", "F"],
  },
  {
    id: "D",
    name: "D major",
    tabs: [2, 2, 2, 0],
    fingers: [
      { string: 0, fret: 2, finger: 1 },
      { string: 1, fret: 2, finger: 2 },
      { string: 2, fret: 2, finger: 3 },
    ],
    open: [3],
    muted: [],
    baseFret: 1,
    tones: ["D", "F♯", "A"],
  },
  {
    id: "Dm",
    name: "D minor",
    tabs: [2, 2, 1, 0],
    fingers: [
      { string: 2, fret: 1, finger: 1 },
      { string: 0, fret: 2, finger: 2 },
      { string: 1, fret: 2, finger: 3 },
    ],
    open: [3],
    muted: [],
    baseFret: 1,
    tones: ["D", "F", "A"],
  },
  {
    id: "E7",
    name: "E7",
    tabs: [1, 2, 0, 2],
    fingers: [
      { string: 0, fret: 1, finger: 1 },
      { string: 1, fret: 2, finger: 2 },
      { string: 3, fret: 2, finger: 3 },
    ],
    open: [2],
    muted: [],
    baseFret: 1,
    tones: ["E", "G♯", "B", "D"],
  },
  {
    id: "A7",
    name: "A7",
    tabs: [0, 1, 0, 0],
    fingers: [{ string: 1, fret: 1, finger: 1 }],
    open: [0, 2, 3],
    muted: [],
    baseFret: 1,
    tones: ["A", "C♯", "E", "G"],
  },
];

// Open string Hz: [g, C, E, A]
const OPEN_STD  = [392.0, 261.6255653005986, 329.62755691287, 440.0];
const OPEN_LOWG = [196.0, 261.6255653005986, 329.62755691287, 440.0];
const NOTE_NAMES_CD = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];

/** Returns 4-element array { noteName, hz, muted } — one per string. */
export function chordStringNotes(chord, lowG = false) {
  const open = lowG ? OPEN_LOWG : OPEN_STD;
  return chord.tabs.map((fret, s) => {
    if (fret < 0) return { noteName: "X", hz: null, muted: true };
    const hz   = open[s] * Math.pow(2, fret / 12);
    const midi = Math.round(12 * Math.log2(hz / 440) + 69);
    const name = NOTE_NAMES_CD[((midi % 12) + 12) % 12];
    const oct  = Math.floor(midi / 12) - 1;
    return { noteName: `${name}${oct}`, hz, muted: false };
  });
}

// ── SVG chord diagram ────────────────────────────────────────────────────────

const NS = "http://www.w3.org/2000/svg";

function mk(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Renders a ukulele chord diagram as an SVG DOM element.
 * @param {object} chord  - entry from CHORD_DATA
 * @param {number} width  - SVG width in px (height is derived)
 */
export function renderChordDiagram(chord, width = 120) {
  const STRINGS  = 4;
  const FRETS    = 4;
  const PL       = 16;               // pad left (room for muted/open markers)
  const PR       = 10;               // pad right
  const PT       = 22;               // pad top (room for open-string circles)
  const PB       = 10;               // pad bottom
  const NUT_H    = 4;                // nut thickness

  const innerW   = width - PL - PR;
  const colStep  = innerW / (STRINGS - 1);
  const rowStep  = Math.round(width * 0.27);
  const innerH   = rowStep * FRETS;
  const totalH   = PT + NUT_H + innerH + PB;
  const fretY    = PT + NUT_H;      // y where fret 1 begins

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${totalH}`);
  svg.setAttribute("width",   width);
  svg.setAttribute("height",  totalH);
  svg.setAttribute("aria-label", `${chord.name} chord diagram`);
  svg.setAttribute("role", "img");

  // Nut (thick bar) or position label
  if (chord.baseFret === 1) {
    svg.appendChild(mk("rect", {
      x: PL, y: PT, width: innerW, height: NUT_H, fill: "#fef3e4", rx: 1,
    }));
  } else {
    const t = document.createElementNS(NS, "text");
    t.textContent = `${chord.baseFret}fr`;
    t.setAttribute("x", width - 2);
    t.setAttribute("y", fretY + rowStep * 0.65);
    t.setAttribute("font-size", "9");
    t.setAttribute("fill", "#9ab8cc");
    t.setAttribute("text-anchor", "end");
    svg.appendChild(t);
  }

  // Fret lines
  for (let f = 0; f <= FRETS; f++) {
    svg.appendChild(mk("line", {
      x1: PL, y1: fretY + f * rowStep, x2: PL + innerW, y2: fretY + f * rowStep,
      stroke: "rgba(255,255,255,0.18)", "stroke-width": 1,
    }));
  }

  // String lines
  for (let s = 0; s < STRINGS; s++) {
    const x = PL + s * colStep;
    svg.appendChild(mk("line", {
      x1: x, y1: fretY, x2: x, y2: fretY + innerH,
      stroke: "rgba(255,255,255,0.28)", "stroke-width": 1.5,
    }));
  }

  // Open string circles
  for (const s of chord.open) {
    const x = PL + s * colStep;
    svg.appendChild(mk("circle", {
      cx: x, cy: PT - 7, r: 4,
      fill: "none", stroke: "#9ab8cc", "stroke-width": 1.5,
    }));
  }

  // Muted string ✕
  for (const s of chord.muted) {
    const x = PL + s * colStep;
    const y = PT - 7;
    for (const [dx, dy] of [[-3.5,-3.5],[3.5,3.5],[-3.5,3.5],[3.5,-3.5]].slice(0,2).concat([[3.5,-3.5],[-3.5,3.5]])) {
      // two lines forming X
    }
    svg.appendChild(mk("line", { x1: x-3.5, y1: y-3.5, x2: x+3.5, y2: y+3.5, stroke:"#9ab8cc","stroke-width":1.5,"stroke-linecap":"round" }));
    svg.appendChild(mk("line", { x1: x+3.5, y1: y-3.5, x2: x-3.5, y2: y+3.5, stroke:"#9ab8cc","stroke-width":1.5,"stroke-linecap":"round" }));
  }

  // Finger dots
  const dotR = Math.min(colStep, rowStep) * 0.34;
  for (const f of chord.fingers) {
    const x      = PL + f.string * colStep;
    const relF   = f.fret - chord.baseFret + 1;
    const y      = fretY + (relF - 0.5) * rowStep;
    svg.appendChild(mk("circle", { cx: x, cy: y, r: dotR, fill: "#ff6b47" }));
    const t = document.createElementNS(NS, "text");
    t.textContent = f.finger;
    t.setAttribute("x", x);
    t.setAttribute("y", y + dotR * 0.38);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-size", Math.round(dotR * 1.15));
    t.setAttribute("font-weight", "700");
    t.setAttribute("fill", "#1a0800");
    svg.appendChild(t);
  }

  return svg;
}
