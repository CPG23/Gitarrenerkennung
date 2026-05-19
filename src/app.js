const NOTE_NAMES = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];
const GUITAR_STRINGS = [
  { name: "e", midi: 64 },
  { name: "B", midi: 59 },
  { name: "G", midi: 55 },
  { name: "D", midi: 50 },
  { name: "A", midi: 45 },
  { name: "E", midi: 40 },
];
const CHORDS = [
  { name: "C Dur", notes: [0, 4, 7], shape: "x32010" },
  { name: "D Dur", notes: [2, 6, 9], shape: "xx0232" },
  { name: "E Dur", notes: [4, 8, 11], shape: "022100" },
  { name: "F Dur", notes: [5, 9, 0], shape: "133211" },
  { name: "G Dur", notes: [7, 11, 2], shape: "320003" },
  { name: "A Dur", notes: [9, 1, 4], shape: "x02220" },
  { name: "B Dur", notes: [11, 3, 6], shape: "x24442" },
  { name: "A Moll", notes: [9, 0, 4], shape: "x02210" },
  { name: "B Moll", notes: [11, 2, 6], shape: "x24432" },
  { name: "C Moll", notes: [0, 3, 7], shape: "x35543" },
  { name: "D Moll", notes: [2, 5, 9], shape: "xx0231" },
  { name: "E Moll", notes: [4, 7, 11], shape: "022000" },
  { name: "F Moll", notes: [5, 8, 0], shape: "133111" },
  { name: "G Moll", notes: [7, 10, 2], shape: "355333" },
];

const ui = {
  listenButton: document.querySelector("#listenButton"),
  resetButton: document.querySelector("#resetButton"),
  currentNote: document.querySelector("#currentNote"),
  currentFrequency: document.querySelector("#currentFrequency"),
  wavePath: document.querySelector("#wavePath"),
  permissionError: document.querySelector("#permissionError"),
  levelBar: document.querySelector("#levelBar"),
  levelText: document.querySelector("#levelText"),
  musicType: document.querySelector("#musicType"),
  tempo: document.querySelector("#tempo"),
  elapsed: document.querySelector("#elapsed"),
  noteList: document.querySelector("#noteList"),
  guitarHelp: document.querySelector("#guitarHelp"),
  chordList: document.querySelector("#chordList"),
  toneChips: document.querySelector("#toneChips"),
  songTimeline: document.querySelector("#songTimeline"),
  guitarTab: document.querySelector("#guitarTab"),
};

let audioContext = null;
let analyser = null;
let stream = null;
let animationId = null;
let startedAt = 0;
let lastPeak = 0;
let detectedNotes = [];
let noteTimeline = [];
let activeTimelineNote = null;
let state = freshState();

function freshState() {
  return {
    histogram: Array(12).fill(0),
    beatPeaks: [],
    samples: 0,
    lowEnergy: 0,
    highEnergy: 0,
  };
}

function frequencyToMidi(frequency) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function midiToNote(midi) {
  const noteIndex = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { index: noteIndex, label: `${NOTE_NAMES[noteIndex]}${octave}` };
}

function detectPitch(buffer, sampleRate) {
  let rms = 0;
  for (let i = 0; i < buffer.length; i += 1) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.012) return null;

  const correlations = new Array(buffer.length).fill(0);
  for (let lag = 0; lag < buffer.length; lag += 1) {
    for (let i = 0; i < buffer.length - lag; i += 1) correlations[lag] += buffer[i] * buffer[i + lag];
  }

  let d = 0;
  while (correlations[d] > correlations[d + 1]) d += 1;
  let maxValue = -1;
  let maxPosition = -1;
  for (let i = d; i < correlations.length; i += 1) {
    if (correlations[i] > maxValue) {
      maxValue = correlations[i];
      maxPosition = i;
    }
  }
  if (maxPosition <= 0) return null;
  const frequency = sampleRate / maxPosition;
  if (frequency < 65 || frequency > 1200) return null;
  return { frequency, rms };
}

function guitarPositions(midi) {
  return GUITAR_STRINGS.flatMap((guitarString) => {
    const fret = midi - guitarString.midi;
    if (fret < 0 || fret > 15) return [];
    return [{ string: guitarString.name, fret }];
  }).slice(0, 4);
}

function preferredGuitarPosition(midi) {
  const positions = guitarPositions(midi);
  return positions.find((position) => position.fret <= 12) || positions[0] || null;
}

function chordScore(chord) {
  const chordHits = chord.notes.reduce((total, note) => total + state.histogram[note], 0);
  const allHits = state.histogram.reduce((total, value) => total + value, 0) || 1;
  return chordHits / allHits;
}

function getBpm() {
  if (state.beatPeaks.length < 4) return 0;
  const intervals = state.beatPeaks.slice(1).map((peak, index) => peak - state.beatPeaks[index]);
  const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  return Math.round(60000 / average);
}

function strongestNotes() {
  return state.histogram
    .map((count, index) => ({ count, index, name: NOTE_NAMES[index] }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function classifyMusic() {
  const bpm = getBpm();
  const spread = strongestNotes().length;
  if (state.samples < 40) return "Noch zu wenig Material";
  if (spread <= 3 && bpm < 85) return "Ruhige Melodie / Ballade";
  if (bpm > 118 && state.highEnergy > state.lowEnergy * 1.3) return "Pop, Rock oder tanzbare Musik";
  if (spread > 7 && bpm < 110) return "Melodisch komplex, moeglich Jazz/Folk";
  if (state.lowEnergy > state.highEnergy * 1.4) return "Basslastige Musik";
  if (bpm >= 85 && bpm <= 118) return "Mittleres Tempo, wahrscheinlich Pop/Folk";
  return "Unklare Mischung";
}

function setWave(data) {
  const points = data.length ? data : Array.from({ length: 60 }, (_, i) => Math.sin(i / 4) * 0.08);
  const path = points
    .map((value, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * 100;
      const y = 50 - value * 42;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  ui.wavePath.setAttribute("d", path);
}

function chordBox(shape) {
  return `<div class="chord-box" aria-label="Gitarrengriff ${shape}">
    ${shape.split("").map((fret, index) => `<div class="string-track" data-string="${index}">
      <span class="${fret === "x" ? "muted" : "open"}">${fret}</span>
      ${["1", "2", "3", "4"].map((position) => `<i class="${fret === position ? "finger" : ""}"></i>`).join("")}
    </div>`).join("")}
  </div>`;
}

function render() {
  const bpm = getBpm();
  const topNotes = strongestNotes();
  ui.musicType.textContent = classifyMusic();
  ui.tempo.textContent = bpm ? `${bpm} BPM` : "--";
  ui.elapsed.textContent = startedAt ? `${((performance.now() - startedAt) / 1000).toFixed(1)} Sekunden analysiert` : "Noch keine Aufnahme";

  ui.noteList.innerHTML = detectedNotes.length
    ? detectedNotes.map((note) => `<div class="note-card"><strong>${note.label}</strong><span>${note.frequency.toFixed(1)} Hz</span></div>`).join("")
    : `<p class="empty">Druecke auf Zuhoeren und spiele Musik in der Naehe des Mikrofons.</p>`;

  ui.toneChips.innerHTML = topNotes.length
    ? topNotes.map((note) => `<span>${note.name}</span>`).join("")
    : `<span>--</span>`;

  const likelyChords = CHORDS.map((chord) => ({ ...chord, score: chordScore(chord) }))
    .filter((chord) => chord.score > 0.38)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  ui.chordList.innerHTML = likelyChords.length
    ? likelyChords.map((chord) => `<div class="chord-card"><div><strong>${chord.name}</strong><span>Griff: ${chord.shape}</span></div>${chordBox(chord.shape)}</div>`).join("")
    : `<p class="empty">Fuer Akkorde braucht die App mehrere stabile Noten.</p>`;

  renderSongTimeline();
  renderGuitarTab();
}

function resetAnalysis() {
  detectedNotes = [];
  noteTimeline = [];
  activeTimelineNote = null;
  state = freshState();
  startedAt = audioContext ? performance.now() : 0;
  ui.currentNote.textContent = "--";
  ui.currentFrequency.textContent = "Warte auf Ton";
  ui.levelBar.style.width = "0%";
  ui.levelText.textContent = "0%";
  ui.guitarHelp.innerHTML = `<p class="empty">Sobald ein Ton erkannt wird, erscheinen hier spielbare Saiten und Buende.</p>`;
  setWave([]);
  render();
}

function addTimelineNote(note, midi, frequency, positions) {
  const now = startedAt ? (performance.now() - startedAt) / 1000 : 0;
  const playable = preferredGuitarPosition(midi);
  const last = activeTimelineNote;

  if (last && last.label === note.label) {
    last.end = now;
    last.frequency = frequency;
    return;
  }

  if (last && now - last.start < 0.18) {
    last.end = now;
    return;
  }

  const entry = {
    label: note.label,
    noteName: NOTE_NAMES[note.index],
    midi,
    frequency,
    start: now,
    end: now,
    string: playable?.string || "-",
    fret: playable?.fret ?? "-",
    positions,
  };
  noteTimeline.push(entry);
  activeTimelineNote = entry;
  if (noteTimeline.length > 96) noteTimeline.shift();
}

function renderSongTimeline() {
  ui.songTimeline.innerHTML = noteTimeline.length
    ? `<div class="timeline-list">${noteTimeline.slice(-24).map((entry) => `
        <div class="timeline-item">
          <strong>${entry.label}</strong>
          <span>${entry.start.toFixed(1)}s</span>
          <em>${entry.string}-Saite, Bund ${entry.fret}</em>
        </div>
      `).join("")}</div>`
    : `<p class="empty">Starte eine Aufnahme. Die App sammelt dann eine spielbare Tonfolge.</p>`;
}

function renderGuitarTab() {
  if (!noteTimeline.length) {
    ui.guitarTab.textContent = "Noch keine Tabulatur vorhanden.";
    return;
  }

  const strings = ["e", "B", "G", "D", "A", "E"];
  const rows = Object.fromEntries(strings.map((name) => [name, `${name}|`]));
  const cleaned = noteTimeline
    .filter((entry) => entry.string !== "-" && entry.fret !== "-")
    .slice(-32);

  for (const entry of cleaned) {
    const fret = String(entry.fret);
    const width = Math.max(3, fret.length + 1);
    for (const name of strings) {
      rows[name] += name === entry.string ? fret.padEnd(width, "-") : "-".repeat(width);
    }
  }

  const notes = cleaned.map((entry) => `${entry.label}@${entry.start.toFixed(1)}s`).join("  ");
  ui.guitarTab.textContent = `${strings.map((name) => rows[name]).join("\n")}\n\nNoten: ${notes || "Noch keine spielbaren Noten erkannt."}`;
}

function stopListening() {
  cancelAnimationFrame(animationId);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();
  stream = null;
  audioContext = null;
  analyser = null;
  startedAt = 0;
  ui.listenButton.innerHTML = `<span aria-hidden="true">o</span><span>Zuhoeren</span>`;
}

function analyzeFrame() {
  if (!analyser || !audioContext) return;
  const timeData = new Float32Array(analyser.fftSize);
  const frequencyData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(timeData);
  analyser.getByteFrequencyData(frequencyData);

  const pitch = detectPitch(timeData, audioContext.sampleRate);
  const rms = Math.sqrt(timeData.reduce((sum, value) => sum + value * value, 0) / timeData.length);
  const level = Math.min(1, rms * 7);
  ui.levelBar.style.width = `${Math.round(level * 100)}%`;
  ui.levelText.textContent = `${Math.round(level * 100)}%`;
  setWave(Array.from(timeData.filter((_, index) => index % 18 === 0)).slice(0, 80));

  let lowEnergy = 0;
  let highEnergy = 0;
  for (let i = 0; i < frequencyData.length; i += 1) {
    if (i < frequencyData.length * 0.18) lowEnergy += frequencyData[i];
    if (i > frequencyData.length * 0.38) highEnergy += frequencyData[i];
  }

  if (rms > 0.05 && performance.now() - lastPeak > 260) {
    lastPeak = performance.now();
    state.beatPeaks = [...state.beatPeaks.slice(-18), performance.now()];
  }

  if (pitch) {
    const midi = frequencyToMidi(pitch.frequency);
    const note = midiToNote(midi);
    const positions = guitarPositions(midi);
    ui.currentNote.textContent = note.label;
    ui.currentFrequency.textContent = `${pitch.frequency.toFixed(1)} Hz`;
    detectedNotes = [{ ...note, midi, frequency: pitch.frequency, positions }, ...detectedNotes.filter((item) => item.label !== note.label)].slice(0, 10);
    addTimelineNote(note, midi, pitch.frequency, positions);
    state.histogram[note.index] += 1;
    state.samples += 1;
    state.lowEnergy = state.lowEnergy * 0.92 + lowEnergy * 0.08;
    state.highEnergy = state.highEnergy * 0.92 + highEnergy * 0.08;
    ui.guitarHelp.innerHTML = `<div class="guitar-help">
      <p>Aktueller Ton: <strong>${note.label}</strong></p>
      <div class="positions">${positions.length ? positions.map((position) => `<span>${position.string}-Saite, Bund ${position.fret}</span>`).join("") : `<span>Ton liegt ausserhalb der einfachen Gitarrenlage.</span>`}</div>
    </div>`;
  } else {
    state.lowEnergy = state.lowEnergy * 0.94 + lowEnergy * 0.06;
    state.highEnergy = state.highEnergy * 0.94 + highEnergy * 0.06;
  }

  render();
  animationId = requestAnimationFrame(analyzeFrame);
}

async function startListening() {
  ui.permissionError.hidden = true;
  resetAnalysis();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    startedAt = performance.now();
    lastPeak = 0;
    ui.listenButton.innerHTML = `<span aria-hidden="true">x</span><span>Stoppen</span>`;
    animationId = requestAnimationFrame(analyzeFrame);
  } catch (error) {
    ui.permissionError.textContent = "Mikrofonzugriff wurde nicht erlaubt oder ist in diesem Browser nicht verfuegbar.";
    ui.permissionError.hidden = false;
  }
}

ui.listenButton.addEventListener("click", () => {
  if (audioContext) stopListening();
  else startListening();
});
ui.resetButton.addEventListener("click", resetAnalysis);
window.addEventListener("beforeunload", stopListening);
setWave([]);
render();
