const NOTE_NAMES = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];
const GUITAR_STRINGS = [
  { name: "e", midi: 64 },
  { name: "B", midi: 59 },
  { name: "G", midi: 55 },
  { name: "D", midi: 50 },
  { name: "A", midi: 45 },
  { name: "E", midi: 40 },
];
const MIN_NOTE_SECONDS = 0.16;
const MAX_SAME_NOTE_SECONDS = 0.9;
const SILENCE_END_SECONDS = 0.45;
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
const AUDD_API_TOKEN = "fcda76a39370412486f19a29b0997e29";

const ui = {
  listenButton: document.querySelector("#listenButton"),
  resetButton: document.querySelector("#resetButton"),
  currentNote: document.querySelector("#currentNote"),
  currentFrequency: document.querySelector("#currentFrequency"),
  wavePath: document.querySelector("#wavePath"),
  permissionError: document.querySelector("#permissionError"),
  levelBar: document.querySelector("#levelBar"),
  levelText: document.querySelector("#levelText"),
  identifyButton: document.querySelector("#identifyButton"),
  songName: document.querySelector("#songName"),
  songLinks: document.querySelector("#songLinks"),
  playSteps: document.querySelector("#playSteps"),
  chordList: document.querySelector("#chordList"),
  guitarTab: document.querySelector("#guitarTab"),
};

let audioContext = null;
let analyser = null;
let stream = null;
let animationId = null;
let startedAt = 0;
let lastSignalAt = 0;
let lastPitchAt = 0;
let noteTimeline = [];
let activeTimelineNote = null;
let state = freshState();
let isIdentifying = false;

function freshState() {
  return {
    histogram: Array(12).fill(0),
    samples: 0,
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
  if (rms < 0.006) return null;

  const minLag = Math.floor(sampleRate / 1200);
  const maxLag = Math.min(Math.floor(sampleRate / 65), buffer.length - 1);
  let bestLag = -1;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    for (let i = 0; i < buffer.length - lag; i += 1) {
      correlation += buffer[i] * buffer[i + lag];
    }
    correlation /= buffer.length - lag;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestCorrelation < 0.002) return null;
  const frequency = sampleRate / bestLag;
  if (frequency < 65 || frequency > 1200) return null;
  return { frequency, rms };
}

function detectDominantPitch(frequencyData, sampleRate) {
  const binHz = sampleRate / (frequencyData.length * 2);
  const minBin = Math.ceil(70 / binHz);
  const maxBin = Math.min(Math.floor(1100 / binHz), frequencyData.length - 2);
  let bestBin = -1;
  let bestValue = 0;

  for (let bin = minBin; bin <= maxBin; bin += 1) {
    const value = frequencyData[bin];
    const isPeak = value > frequencyData[bin - 1] && value >= frequencyData[bin + 1];
    if (isPeak && value > bestValue) {
      bestValue = value;
      bestBin = bin;
    }
  }

  if (bestBin < 0 || bestValue < 32) return null;
  const left = frequencyData[bestBin - 1] || 0;
  const center = frequencyData[bestBin] || 0;
  const right = frequencyData[bestBin + 1] || 0;
  const correction = (left - right) / Math.max(2 * (left - 2 * center + right), 1);
  let frequency = (bestBin + Math.max(-0.5, Math.min(0.5, correction))) * binHz;
  while (frequency > 880) frequency /= 2;
  if (frequency < 65 || frequency > 1200) return null;
  return { frequency, rms: bestValue / 255 };
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
  const previous = activeTimelineNote;
  if (!previous) return positions.find((position) => position.fret <= 12) || positions[0] || null;

  return positions
    .map((position) => ({
      ...position,
      score: Math.abs(position.fret - previous.fret) + (position.string === previous.string ? 0 : 2),
    }))
    .sort((a, b) => a.score - b.score)[0] || null;
}

function chordScore(chord) {
  const chordHits = chord.notes.reduce((total, note) => total + state.histogram[note], 0);
  const allHits = state.histogram.reduce((total, value) => total + value, 0) || 1;
  return chordHits / allHits;
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
  const likelyChords = CHORDS.map((chord) => ({ ...chord, score: chordScore(chord) }))
    .filter((chord) => chord.score > 0.38)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  ui.chordList.innerHTML = likelyChords.length
    ? likelyChords.map((chord) => `<div class="chord-card"><div><strong>${chord.name}</strong><span>Griff: ${chord.shape}</span></div>${chordBox(chord.shape)}</div>`).join("")
    : `<p class="empty">Fuer Akkorde braucht die App mehrere stabile Noten.</p>`;

  renderGuitarTab();
  renderPlaySteps();
}

function resetAnalysis() {
  noteTimeline = [];
  activeTimelineNote = null;
  state = freshState();
  startedAt = audioContext ? performance.now() : 0;
  ui.currentNote.textContent = "--";
  ui.currentFrequency.textContent = audioContext ? "Hoert zu" : "Bereit";
  ui.songLinks.hidden = true;
  ui.songLinks.innerHTML = "";
  ui.levelBar.style.width = "0%";
  ui.levelText.textContent = "0%";
  setWave([]);
  render();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAudioStream() {
  if (stream) return stream;
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

async function recordSongSample(sourceStream, durationMs = 9000) {
  const chunks = [];
  const recorder = new MediaRecorder(sourceStream);
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.start();
  await wait(durationMs);
  recorder.stop();
  await new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
}

async function identifySong() {
  if (isIdentifying) return;
  isIdentifying = true;
  ui.identifyButton.disabled = true;
  ui.songName.textContent = "Hoere 9 Sekunden zu und erkenne den Song...";

  let temporaryStream = null;
  try {
    const sourceStream = stream || await getAudioStream();
    if (!stream) temporaryStream = sourceStream;
    const audioBlob = await recordSongSample(sourceStream);
    const formData = new FormData();
    formData.append("api_token", AUDD_API_TOKEN);
    formData.append("return", "spotify,apple_music");
    formData.append("file", audioBlob, "song-sample.webm");

    const response = await fetch("https://api.audd.io/", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    if (data.status !== "success") {
      ui.songName.textContent = data.error?.error_message || "Song-Erkennung fehlgeschlagen.";
      return;
    }
    if (!data.result) {
      ui.songName.textContent = "Kein Song erkannt. Spiele den Song lauter oder laenger ab.";
      return;
    }

    const artist = data.result.artist || "Unbekannter Kuenstler";
    const title = data.result.title || "Unbekannter Titel";
    const album = data.result.album ? ` (${data.result.album})` : "";
    ui.songName.textContent = `${artist} - ${title}${album}`;
    renderSongLinks(artist, title);
  } catch (error) {
    ui.songName.textContent = "Song-Erkennung nicht moeglich. Token, Internet oder Mikrofon pruefen.";
  } finally {
    if (temporaryStream) temporaryStream.getTracks().forEach((track) => track.stop());
    isIdentifying = false;
    ui.identifyButton.disabled = false;
  }
}

function renderSongLinks(artist, title) {
  const query = encodeURIComponent(`${artist} ${title}`);
  ui.songLinks.hidden = false;
  ui.songLinks.innerHTML = `
    <a href="https://www.google.com/search?q=${query}+guitar+chords" target="_blank" rel="noreferrer">Akkorde suchen</a>
    <a href="https://www.google.com/search?q=${query}+guitar+tab" target="_blank" rel="noreferrer">Original-TAB suchen</a>
  `;
}

function addTimelineNote(note, midi, frequency, positions) {
  const now = startedAt ? (performance.now() - startedAt) / 1000 : 0;
  const playable = preferredGuitarPosition(midi);
  const last = activeTimelineNote;

  if (last && last.label === note.label && now - last.start < MAX_SAME_NOTE_SECONDS) {
    last.end = now;
    last.frequency = frequency;
    return;
  }

  if (last && now - last.start < MIN_NOTE_SECONDS) {
    last.end = now;
    return;
  }

  if (last) last.end = Math.max(last.end, now);

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
  if (noteTimeline.length > 160) noteTimeline.shift();
}

function closeActiveNote() {
  if (!activeTimelineNote || !startedAt) return;
  const now = (performance.now() - startedAt) / 1000;
  activeTimelineNote.end = Math.max(activeTimelineNote.end, now);
  activeTimelineNote = null;
}

function renderGuitarTab() {
  if (!noteTimeline.length) {
    ui.guitarTab.textContent = "Druecke auf Zuhoeren und spiele den Song ab.\nDie erkannte Melodie erscheint hier als Gitarren-TAB.";
    return;
  }

  const strings = ["e", "B", "G", "D", "A", "E"];
  const rows = Object.fromEntries(strings.map((name) => [name, `${name}|`]));
  let timeRow = "t|";
  const cleaned = noteTimeline
    .filter((entry) => entry.string !== "-" && entry.fret !== "-")
    .slice(-80);

  for (const [index, entry] of cleaned.entries()) {
    const fret = String(entry.fret);
    const next = cleaned[index + 1];
    const duration = Math.max(0.25, (next?.start ?? entry.end + 0.35) - entry.start);
    const width = Math.max(3, Math.min(10, Math.round(duration * 5)), fret.length + 1);
    for (const name of strings) {
      rows[name] += name === entry.string ? fret.padEnd(width, "-") : "-".repeat(width);
    }
    const marker = `${entry.start.toFixed(1)}s`;
    timeRow += marker.length <= width ? marker.padEnd(width, "-") : `${Math.round(entry.start)}s`.padEnd(width, "-");
  }

  const notes = cleaned.map((entry) => `${entry.label} ${entry.start.toFixed(1)}s`).join("  ");
  ui.guitarTab.textContent = `${timeRow}\n${strings.map((name) => rows[name]).join("\n")}\n\nAblauf: ${notes || "Noch keine spielbaren Noten erkannt."}`;
}

function playableNotes(limit = 32) {
  return noteTimeline
    .filter((entry) => entry.string !== "-" && entry.fret !== "-")
    .slice(-limit);
}

function renderPlaySteps() {
  const notes = playableNotes();
  if (!notes.length) {
    ui.playSteps.innerHTML = `<li>Druecke auf Zuhoeren und spiele den Song ab.</li>`;
    return;
  }

  ui.playSteps.innerHTML = notes
    .map((entry, index) => {
      const next = notes[index + 1];
      const holdFor = Math.max(0.25, (next?.start ?? entry.end + 0.35) - entry.start);
      return `<li><strong>${entry.start.toFixed(1)}s</strong> ${entry.string}-Saite, Bund ${entry.fret}, Note ${entry.label}, ca. ${holdFor.toFixed(1)}s halten</li>`;
    })
    .join("");
}

function stopListening() {
  cancelAnimationFrame(animationId);
  closeActiveNote();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();
  stream = null;
  audioContext = null;
  analyser = null;
  startedAt = 0;
  ui.currentFrequency.textContent = noteTimeline.length ? "TAB erstellt" : "Bereit";
  ui.listenButton.innerHTML = `<span aria-hidden="true">o</span><span>Zuhoeren</span>`;
}

function analyzeFrame() {
  if (!analyser || !audioContext) return;
  const timeData = new Float32Array(analyser.fftSize);
  const frequencyData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(timeData);
  analyser.getByteFrequencyData(frequencyData);

  const pitch = detectPitch(timeData, audioContext.sampleRate) || detectDominantPitch(frequencyData, audioContext.sampleRate);
  const rms = Math.sqrt(timeData.reduce((sum, value) => sum + value * value, 0) / timeData.length);
  const level = Math.min(1, rms * 7);
  ui.levelBar.style.width = `${Math.round(level * 100)}%`;
  ui.levelText.textContent = `${Math.round(level * 100)}%`;
  setWave(Array.from(timeData.filter((_, index) => index % 18 === 0)).slice(0, 80));
  if (rms > 0.01) lastSignalAt = performance.now();

  if (pitch) {
    const midi = frequencyToMidi(pitch.frequency);
    const note = midiToNote(midi);
    const positions = guitarPositions(midi);
    ui.currentNote.textContent = note.label;
    ui.currentFrequency.textContent = `${pitch.frequency.toFixed(1)} Hz`;
    lastPitchAt = performance.now();
    addTimelineNote(note, midi, pitch.frequency, positions);
    state.histogram[note.index] += 1;
    state.samples += 1;
  } else if (audioContext) {
    const now = performance.now();
    if (activeTimelineNote && now - lastPitchAt > SILENCE_END_SECONDS * 1000) closeActiveNote();
    if (now - startedAt > 1800 && now - lastSignalAt > 1600) {
      ui.currentNote.textContent = "--";
      ui.currentFrequency.textContent = "Kein Ton am Mikrofon";
    } else if (now - lastPitchAt > 900 && now - lastSignalAt < 1000) {
      ui.currentNote.textContent = "--";
      ui.currentFrequency.textContent = "Signal da, suche Note";
    }
  }

  render();
  animationId = requestAnimationFrame(analyzeFrame);
}

async function startListening() {
  ui.permissionError.hidden = true;
  resetAnalysis();
  try {
    stream = await getAudioStream();
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    startedAt = performance.now();
    lastSignalAt = startedAt;
    lastPitchAt = 0;
    ui.currentNote.textContent = "--";
    ui.currentFrequency.textContent = "Hoert zu";
    ui.listenButton.innerHTML = `<span aria-hidden="true">x</span><span>Stoppen</span>`;
    animationId = requestAnimationFrame(analyzeFrame);
    identifySong();
  } catch (error) {
    ui.permissionError.textContent = "Mikrofonzugriff wurde nicht erlaubt oder ist in diesem Browser nicht verfuegbar.";
    ui.permissionError.hidden = false;
  }
}

ui.listenButton.addEventListener("click", () => {
  if (audioContext) stopListening();
  else startListening();
});
ui.identifyButton.addEventListener("click", identifySong);
ui.resetButton.addEventListener("click", resetAnalysis);
window.addEventListener("beforeunload", stopListening);
setWave([]);
render();
