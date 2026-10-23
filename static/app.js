"use strict";

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has("demo");
const VOICES = { "en-US": "en-US-JennyNeural", "en-AU": "en-AU-NatashaNeural", "en-GB": "en-GB-SoniaNeural" };
const MAX_SECONDS = 60;
const LOW = 80; // phoneme/word score below this is worth practising

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("pc." + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("pc." + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = { items: [], idx: 0, wav: null, wavUrl: null, recording: null, busy: false, results: {} };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const markupToHtml = (m) => esc(m).replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
const band = (score) => (score >= 80 ? "good" : score >= 60 ? "fair" : "poor");
const round = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function showBanner(html) {
  $("banner").innerHTML = html;
  $("banner").hidden = !html;
}

// ---------------------------------------------------------------- sentences & navigation

async function loadSentences() {
  const res = await fetch("/api/sentences");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  state.data = data;
  if (data.decks && data.decks.length) {
    // Folder of decks: a menu picks which one to practise.
    const saved = store.get("deck", data.decks[0]);
    const pick = data.decks.includes(saved) ? saved : data.decks[0];
    $("deckName").innerHTML = `<select id="deckPick">${data.decks.map((d) => `<option${d === pick ? " selected" : ""}>${esc(d)}</option>`).join("")}</select>`;
    $("deckPick").onchange = () => {
      if (state.recording || state.busy) { $("deckPick").value = state.deck; return; }
      showDeck($("deckPick").value);
    };
    showDeck(pick);
    return;
  }
  $("deckName").innerHTML = esc(data.deck) + (DEMO ? '<span class="demoTag">DEMO</span>' : "");
  state.items = [];
  for (const g of data.groups) for (const s of g.sentences) state.items.push({ ...s, title: g.title, slide: g.slide });
  state.items.push({ id: "custom", title: "自由入力", slide: null, markup: "", text: "", custom: true });
  renderList(data.groups);
  select(store.get("idx", 0));
}

function showDeck(deck) {
  state.deck = deck;
  store.set("deck", deck);
  const groups = state.data.groups.filter((g) => g.deck === deck);
  state.items = [];
  for (const g of groups) for (const s of g.sentences) state.items.push({ ...s, title: g.title, slide: g.slide });
  state.items.push({ id: "custom", title: "自由入力", slide: null, markup: "", text: "", custom: true });
  renderList(groups);
  select(store.get("idx:" + deck, 0));
}

function renderList(groups) {
  const best = store.get("best", {});
  const parts = [];
  let i = 0;
  for (const g of groups) {
    parts.push(`<h4>${g.slide}. ${esc(g.title)}</h4>`);
    for (const s of g.sentences) {
      const b = best[s.id];
      parts.push(`<button class="item" data-i="${i}"><span>${esc(s.text)}</span>${b != null ? `<span class="badge ${band(b)}">${b}</span>` : ""}</button>`);
      i++;
    }
  }
  parts.push(`<h4>その他</h4><button class="item" data-i="${i}"><span>✎ 自由入力(好きな英文を練習)</span></button>`);
  $("list").innerHTML = parts.join("");
  markActive();
}

function markActive() {
  document.querySelectorAll(".item").forEach((el) => el.classList.toggle("active", Number(el.dataset.i) === state.idx));
  const active = document.querySelector(".item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function current() {
  const item = state.items[state.idx];
  if (item.custom) return { ...item, text: $("custom").value.trim().replace(/\s+/g, " ") };
  return item;
}

function select(i) {
  if (state.recording || state.busy) return;
  state.idx = Math.max(0, Math.min(state.items.length - 1, Number(i) || 0));
  store.set(state.deck ? "idx:" + state.deck : "idx", state.idx);
  const item = state.items[state.idx];
  $("slideTag").textContent = item.custom ? "自由入力" : `Slide ${item.slide} · ${item.title}`;
  $("pos").textContent = `${state.idx + 1} / ${state.items.length}`;
  $("sentence").innerHTML = item.custom ? "" : markupToHtml(item.markup);
  $("sentence").hidden = !!item.custom;
  $("custom").hidden = !item.custom;
  if (item.custom) $("custom").value = store.get("customText", "");
  setWav(null);
  const prev = state.results[item.id];
  if (prev && !item.custom) renderResult(prev); else $("result").hidden = true;
  markActive();
}

// ---------------------------------------------------------------- Azure token & model voice

let tokenCache = null;
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache;
  const res = await fetch("/api/token");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  tokenCache = { ...data, expires: Date.now() + 7 * 60 * 1000 };
  return tokenCache;
}

const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

async function playModel(text) {
  if (!text) return;
  const locale = $("locale").value;
  const slow = $("rate").value === "slow";
  try {
    if (DEMO) throw new Error("demo");
    const { token, region } = await getToken();
    const cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
    const player = new SpeechSDK.SpeakerAudioDestination();
    const synth = new SpeechSDK.SpeechSynthesizer(cfg, SpeechSDK.AudioConfig.fromSpeakerOutput(player));
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${VOICES[locale]}"><prosody rate="${slow ? "-25%" : "0%"}">${escapeXml(text)}</prosody></voice></speak>`;
    await new Promise((resolve, reject) => synth.speakSsmlAsync(ssml, (r) => {
      synth.close();
      r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted ? resolve() : reject(new Error(r.errorDetails));
    }, (err) => { synth.close(); reject(new Error(err)); }));
  } catch {
    // Fallback: the browser's own voice (works without Azure)
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    u.rate = slow ? 0.75 : 1;
    speechSynthesis.speak(u);
  }
}

// ---------------------------------------------------------------- recording (16 kHz mono WAV)

const WORKLET = `class Rec extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("rec", Rec);`;

async function startRecording() {
  const item = current();
  if (!item.text) { setStatus("練習したい英文を入力してください。", true); return; }
  if (item.custom) store.set("customText", $("custom").value);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    if (DEMO) { fakeRecording(); return; }
    setStatus("マイクを使えませんでした。ブラウザのマイク許可を確認してください。(" + e.message + ")", true);
    return;
  }
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "rec");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute).connect(ctx.destination);
  const chunks = [];
  node.port.onmessage = (e) => {
    chunks.push(e.data);
    let sum = 0;
    for (const v of e.data) sum += v * v;
    $("level").style.width = Math.min(100, Math.sqrt(sum / e.data.length) * 400) + "%";
  };
  const started = Date.now();
  const timer = setInterval(() => {
    const sec = (Date.now() - started) / 1000;
    setStatus(`録音中… ${sec.toFixed(1)} 秒(もう一度押すと停止して採点)`);
    if (sec >= MAX_SECONDS) toggleRecording();
  }, 200);
  state.recording = { stream, ctx, chunks, timer };
  setRecordingUi(true);
}

function fakeRecording() {
  const timer = setInterval(() => setStatus("録音中…(デモ)"), 200);
  state.recording = { fake: true, timer };
  setRecordingUi(true);
}

async function stopRecording() {
  const r = state.recording;
  state.recording = null;
  clearInterval(r.timer);
  setRecordingUi(false);
  $("level").style.width = "0";
  if (r.fake) return encodeWav(new Float32Array(16000), 16000);
  r.stream.getTracks().forEach((t) => t.stop());
  const rate = r.ctx.sampleRate;
  await r.ctx.close();
  const pcm = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of r.chunks) { pcm.set(c, offset); offset += c.length; }
  return encodeWav(resample(pcm, rate, 16000), 16000);
}

function resample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(data.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j];
    out[i] = end > start ? sum / (end - start) : data[start];
  }
  return out;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

function setWav(blob) {
  if (state.wavUrl) URL.revokeObjectURL(state.wavUrl);
  state.wav = blob;
  state.wavUrl = blob ? URL.createObjectURL(blob) : null;
  $("mine").disabled = !blob;
}

function setRecordingUi(on) {
  $("rec").classList.toggle("recording", on);
  $("recLabel").textContent = on ? "■ 停止" : "● 録音";
  for (const id of ["prev", "next", "model", "mine"]) $(id).disabled = on || (id === "mine" && !state.wav);
}

async function toggleRecording() {
  if (state.busy) return;
  if (!state.recording) { await startRecording(); return; }
  state.busy = true;
  try {
    const wav = await stopRecording();
    setWav(wav);
    const item = current();
    setStatus("採点中…");
    const result = await assess(wav, item.text);
    if (!result || !result.words.length) {
      setStatus("音声を認識できませんでした。マイクに近づいて、もう一度読んでみてください。", true);
      return;
    }
    result.id = item.id;
    state.results[item.id] = result;
    recordStats(item, result);
    renderResult(result);
    setStatus(`採点しました(総合 ${round(result.scores.pron)} 点)。単語をクリックすると詳しく見られます。`);
  } catch (e) {
    setStatus("採点できませんでした: " + e.message, true);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- pronunciation assessment

const errType = (w) => (w.PronunciationAssessment && w.PronunciationAssessment.ErrorType) || "None";

async function assess(wav, referenceText) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 500)); return demoResult(referenceText); }
  const locale = $("locale").value;
  const { token, region } = await getToken();
  const cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
  cfg.speechRecognitionLanguage = locale;
  // keep a sentence in one segment even with short pauses
  cfg.setProperty(SpeechSDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "3000");
  const audio = SpeechSDK.AudioConfig.fromWavFileInput(new File([wav], "speech.wav", { type: "audio/wav" }));
  const pa = new SpeechSDK.PronunciationAssessmentConfig(
    referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    true, // miscue: detect omitted / inserted words
  );
  pa.phonemeAlphabet = "IPA";
  pa.nbestPhonemeCount = 5;
  if (locale === "en-US") pa.enableProsodyAssessment = true; // prosody is en-US only
  const recognizer = new SpeechSDK.SpeechRecognizer(cfg, audio);
  pa.applyTo(recognizer);

  const segments = [];
  return new Promise((resolve, reject) => {
    let error = null;
    recognizer.recognized = (_, e) => {
      if (e.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) return;
      const json = JSON.parse(e.result.properties.getProperty(SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult));
      if (json.NBest && json.NBest[0]) segments.push({ ...json.NBest[0], Display: json.DisplayText });
    };
    recognizer.canceled = (_, e) => {
      if (e.reason === SpeechSDK.CancellationReason.Error) error = new Error(e.errorDetails || "Azure error");
    };
    recognizer.sessionStopped = () => {
      recognizer.stopContinuousRecognitionAsync(
        () => { recognizer.close(); error ? reject(error) : resolve(addOmissions(mergeSegments(segments), referenceText)); },
        (err) => { recognizer.close(); reject(new Error(err)); },
      );
    };
    recognizer.startContinuousRecognitionAsync(() => {}, (err) => reject(new Error(err)));
  });
}

/** Combine one or more recognised segments into a single result. */
function mergeSegments(segs) {
  if (!segs.length) return null;
  const pa = (s) => s.PronunciationAssessment || {};
  const display = segs.map((s) => s.Display).filter(Boolean).join(" ");
  if (segs.length === 1) {
    const p = pa(segs[0]);
    return {
      scores: { pron: p.PronScore, accuracy: p.AccuracyScore, fluency: p.FluencyScore, completeness: p.CompletenessScore, prosody: p.ProsodyScore },
      words: segs[0].Words || [],
      display,
    };
  }
  // With a long pause the service returns several segments, each graded against the full
  // reference (words outside the segment come back as Omission). Merge by reference position.
  const refLists = segs.map((s) => (s.Words || []).filter((w) => errType(w) !== "Insertion"));
  let words;
  if (refLists.every((l) => l.length === refLists[0].length)) {
    words = refLists[0].map((_, i) => refLists.map((l) => l[i]).find((w) => errType(w) !== "Omission") || refLists[0][i]);
  } else {
    words = segs.flatMap((s) => (s.Words || []).filter((w) => errType(w) !== "Omission"));
  }
  const graded = words.filter((w) => errType(w) !== "Insertion");
  const accuracy = avg(graded.map((w) => (errType(w) === "Omission" ? 0 : w.PronunciationAssessment.AccuracyScore)));
  const completeness = Math.min(100, (100 * graded.filter((w) => errType(w) !== "Omission").length) / Math.max(1, graded.length));
  const durations = segs.map((s) => (s.Words || []).reduce((n, w) => n + (w.Duration || 0), 0));
  const totalDur = durations.reduce((a, b) => a + b, 0) || 1;
  const fluency = segs.reduce((n, s, i) => n + (pa(s).FluencyScore || 0) * durations[i], 0) / totalDur;
  const prosodies = segs.map((s) => pa(s).ProsodyScore).filter((x) => x != null);
  const prosody = prosodies.length ? avg(prosodies) : undefined;
  // Microsoft's weighting for the overall score
  const sorted = [accuracy, fluency, completeness, prosody].filter((x) => x != null).sort((a, b) => a - b);
  const pron = sorted.length === 4
    ? sorted[0] * 0.4 + sorted[1] * 0.2 + sorted[2] * 0.2 + sorted[3] * 0.2
    : sorted[0] * 0.6 + sorted[1] * 0.2 + sorted[2] * 0.2;
  return { scores: { pron, accuracy, fluency, completeness, prosody }, words, display };
}

const normWord = (w) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/(\d),(?=\d)/g, "$1").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

/**
 * In continuous mode the service drops skipped words from the word list instead of marking
 * them. Align the result with the reference text and put them back as Omission.
 * A gap with both unmatched reference and recognised words is a substitution, not an omission.
 */
function addOmissions(result, referenceText) {
  if (!result) return result;
  const ref = referenceText.split(/\s+/).map(normWord).filter(Boolean);
  const hyp = result.words.map((w) => (errType(w) === "Insertion" || errType(w) === "Omission" ? null : normWord(w.Word)));
  // LCS table
  const n = ref.length, m = hyp.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = hyp[j] !== null && ref[i] === hyp[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, gapRef = [], gapHyp = 0;
  const flush = () => {
    for (const word of gapRef.slice(gapHyp)) {
      out.push({ Word: word, PronunciationAssessment: { AccuracyScore: 0, ErrorType: "Omission" }, Phonemes: [] });
    }
    gapRef = [];
    gapHyp = 0;
  };
  while (i < n || j < m) {
    if (i < n && j < m && hyp[j] !== null && ref[i] === hyp[j]) {
      flush();
      out.push(result.words[j]);
      i++; j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      if (hyp[j] !== null) gapHyp++;
      out.push(result.words[j]);
      j++;
    } else {
      gapRef.push(ref[i]);
      i++;
    }
  }
  flush();
  return { ...result, words: out };
}

// ---------------------------------------------------------------- rendering

const PROSODY_LABELS = {
  UnexpectedBreak: "不自然な区切り(ここで切らずに続けて読む)",
  MissingBreak: "区切りが足りない(ここで少し間を置く)",
  Monotone: "抑揚が平坦(強弱・高低をつける)",
};

function prosodyIssues(w) {
  const out = new Set();
  const et = errType(w);
  if (PROSODY_LABELS[et]) out.add(et);
  const fb = w.PronunciationAssessment && w.PronunciationAssessment.Feedback && w.PronunciationAssessment.Feedback.Prosody;
  if (fb) {
    for (const t of (fb.Break && fb.Break.ErrorTypes) || []) if (PROSODY_LABELS[t]) out.add(t);
    for (const t of (fb.Intonation && fb.Intonation.ErrorTypes) || []) if (PROSODY_LABELS[t]) out.add(t);
  }
  return [...out];
}

function wordClass(w) {
  const et = errType(w);
  if (et === "Omission") return "omit";
  if (et === "Insertion") return "insert";
  return band(w.PronunciationAssessment ? w.PronunciationAssessment.AccuracyScore : 0);
}

function renderResult(result) {
  $("result").hidden = false;
  const s = result.scores;
  const pron = round(s.pron) || 0;
  $("pron").textContent = pron;
  const arc = $("ringArc");
  arc.style.strokeDashoffset = String(326.7 * (1 - pron / 100));
  arc.style.stroke = `var(--${band(pron)})`;

  const rows = [
    ["正確さ", "Accuracy", s.accuracy],
    ["流暢さ", "Fluency", s.fluency],
    ["完全性", "Completeness", s.completeness],
    ["抑揚・リズム", "Prosody", s.prosody],
  ];
  $("bars").innerHTML = rows.map(([ja, en, v]) => {
    if (v == null) return `<div class="bar na"><span>${ja}<small>${en}</small></span><span class="note">en-US 選択時のみ</span><b>–</b></div>`;
    const r = round(v);
    return `<div class="bar"><span>${ja}<small>${en}</small></span><div class="track"><div class="fill" style="width:${r}%;background:var(--${band(r)})"></div></div><b>${r}</b></div>`;
  }).join("");

  $("words").innerHTML = result.words.map((w, i) => {
    const cls = wordClass(w);
    const score = w.PronunciationAssessment && cls !== "omit" && cls !== "insert" ? `<sub>${round(w.PronunciationAssessment.AccuracyScore)}</sub>` : "";
    const flags = prosodyIssues(w).length ? '<span class="flag" aria-label="区切り・抑揚の指摘">⏸</span>' : "";
    return `<button class="word ${cls}" data-w="${i}">${flags}${esc(w.Word)}${score}</button>`;
  }).join("");
  $("detail").hidden = true;
  $("heard").textContent = result.display ? `認識された文: ${result.display}` : "";
  renderPoints(result);
}

function phonemesOf(w) {
  // en-AU/en-GB return blank symbols for numerals ("20"); those carry no usable feedback
  return (w.Phonemes || []).filter((p) => p.Phoneme).map((p) => {
    const pa = p.PronunciationAssessment || {};
    const nbest = pa.NBestPhonemes || [];
    const heard = nbest.length && nbest[0].Phoneme !== p.Phoneme ? nbest[0].Phoneme : null;
    return { ipa: p.Phoneme, score: pa.AccuracyScore ?? 0, heard };
  });
}

/** "今回のポイント": the weakest sounds and prosody issues in this attempt. */
function renderPoints(result) {
  const byIpa = new Map();
  for (const w of result.words) {
    if (["Omission", "Insertion"].includes(errType(w))) continue;
    for (const p of phonemesOf(w)) {
      if (p.score >= LOW) continue;
      const e = byIpa.get(p.ipa) || { ipa: p.ipa, scores: [], words: new Set(), heard: new Set() };
      e.scores.push(p.score);
      e.words.add(w.Word);
      if (p.heard) e.heard.add(p.heard);
      byIpa.set(p.ipa, e);
    }
  }
  const worst = [...byIpa.values()].sort((a, b) => avg(a.scores) - avg(b.scores)).slice(0, 3);
  const omitted = result.words.filter((w) => errType(w) === "Omission").map((w) => w.Word);
  const prosodyWords = result.words.filter((w) => prosodyIssues(w).length).map((w) => w.Word);
  const html = [];
  for (const e of worst) {
    const tip = tipFor(e.ipa);
    const heard = e.heard.size ? `(/${[...e.heard].join("/, /")}/ に聞こえました)` : "";
    html.push(`<div class="point"><b class="ipa">/${esc(e.ipa)}/</b>${esc(tip.name)} — ${esc([...e.words].join(", "))} ${esc(heard)}<br>${esc(tip.tip)}</div>`);
  }
  if (omitted.length) html.push(`<div class="point"><b class="ipa">抜け</b>${esc(omitted.join(", "))} が聞き取れませんでした。弱く読む単語も、短くはっきり発音しましょう。</div>`);
  if (prosodyWords.length) html.push(`<div class="point"><b class="ipa">⏸</b>区切り・抑揚の指摘: ${esc(prosodyWords.join(", "))}(単語をクリックすると内容が見られます)</div>`);
  if (!html.length) html.push('<div class="point"><b class="ipa">◎</b>大きな問題は見つかりませんでした。次は自然な速さで、赤字の語を少し強く読めているか意識してみましょう。</div>');
  $("points").innerHTML = `<h3>今回のポイント</h3>` + html.join("");
}

function renderDetail(w, el) {
  document.querySelectorAll(".word.selected").forEach((x) => x.classList.remove("selected"));
  el.classList.add("selected");
  const et = errType(w);
  const parts = [`<header><b>${esc(w.Word)}</b><button class="small" id="wordModel">▶ お手本</button>`];
  if (et === "Omission") parts.push('<span class="note">この単語は聞き取れませんでした(読み飛ばし・弱すぎ)。</span>');
  else if (et === "Insertion") parts.push('<span class="note">原稿にない単語として認識されました(言い直し・つなぎ言葉など)。</span>');
  else parts.push(`<span class="note">正確さ ${round(w.PronunciationAssessment.AccuracyScore)} 点${et === "Mispronunciation" ? "・発音ミス判定" : ""}</span>`);
  parts.push("</header>");

  const phs = phonemesOf(w);
  if (phs.length && et !== "Omission") {
    parts.push('<div class="phonemes">' + phs.map((p) =>
      `<div class="ph ${band(p.score)}"><b>${esc(p.ipa)}</b><span>${round(p.score)}</span>${p.heard && p.score < LOW ? `<em>→ ${esc(p.heard)}</em>` : ""}</div>`).join("") + "</div>");
  }
  const tips = [];
  const seen = new Set();
  for (const p of phs.filter((p) => p.score < LOW).sort((a, b) => a.score - b.score)) {
    if (seen.has(p.ipa)) continue;
    seen.add(p.ipa);
    const t = tipFor(p.ipa);
    tips.push(`<li><b>/${esc(p.ipa)}/ ${esc(t.name)}</b>${esc(t.tip)}${p.heard ? `(今回は /${esc(p.heard)}/ に近く聞こえました)` : ""}</li>`);
  }
  for (const issue of prosodyIssues(w)) tips.push(`<li><b>⏸</b>${esc(PROSODY_LABELS[issue])}</li>`);
  if (tips.length) parts.push(`<ul class="tips">${tips.join("")}</ul>`);
  $("detail").innerHTML = parts.join("");
  $("detail").hidden = false;
  $("wordModel").onclick = () => playModel(w.Word);
}

// ---------------------------------------------------------------- history & weak sounds

function recordStats(item, result) {
  if (DEMO) return; // dummy scores must not pollute the real history
  const stats = store.get("phonemes", {});
  for (const w of result.words) {
    if (["Omission", "Insertion"].includes(errType(w))) continue;
    for (const p of phonemesOf(w)) {
      const e = stats[p.ipa] || { n: 0, sum: 0, words: [] };
      e.n += 1;
      e.sum += p.score;
      if (p.score < LOW) {
        const word = w.Word.toLowerCase();
        e.words = [word, ...e.words.filter((x) => x !== word)].slice(0, 6);
      }
      stats[p.ipa] = e;
    }
  }
  store.set("phonemes", stats);
  store.set("attempts", store.get("attempts", 0) + 1);
  recordWeakWords(item, result);
  logAttempt(item, result);
  if (!item.custom) {
    const best = store.get("best", {});
    const pron = round(result.scores.pron);
    if (best[item.id] == null || pron > best[item.id]) best[item.id] = pron;
    store.set("best", best);
    const el = document.querySelector(`.item[data-i="${state.idx}"]`);
    if (el) {
      el.querySelector(".badge")?.remove();
      el.insertAdjacentHTML("beforeend", `<span class="badge ${band(best[item.id])}">${best[item.id]}</span>`);
    }
  }
  renderWeak();
}

/** Words scored below LOW, kept for the "苦手な単語ノート". */
function recordWeakWords(item, result) {
  const words = store.get("weakWords", {});
  const today = new Date().toISOString().slice(0, 10);
  for (const w of result.words) {
    const et = errType(w);
    if (et === "Insertion" || !w.PronunciationAssessment) continue;
    const score = et === "Omission" ? 0 : w.PronunciationAssessment.AccuracyScore;
    const key = w.Word.toLowerCase().replace(/[^a-z0-9'-]/g, "");
    if (!key) continue;
    const e = words[key];
    if (score >= LOW) {
      if (e) { e.lastScore = round(score); e.good = (e.good || 0) + 1; }  // got it right later: still listed, with the latest score
      continue;
    }
    const weak = phonemesOf(w).filter((p) => p.score < LOW).map((p) => p.heard && p.heard !== p.ipa ? `/${p.ipa}/→/${p.heard}/` : `/${p.ipa}/`);
    words[key] = {
      word: w.Word,
      n: (e ? e.n : 0) + 1,
      worst: Math.min(e ? e.worst : 100, round(score)),
      lastScore: round(score),
      good: e ? e.good || 0 : 0,
      omitted: et === "Omission" || (e && e.omitted) || false,
      sounds: [...new Set([...weak, ...(e ? e.sounds : [])])].slice(0, 6),
      sentence: item.custom ? current().text : item.text,
      deck: state.deck || state.data?.deck || "",
      date: today,
    };
  }
  store.set("weakWords", words);
}

function weakWordsMarkdown() {
  const words = Object.values(store.get("weakWords", {}));
  const now = new Date();
  const lines = [`# 苦手な単語ノート`, "", `作成: ${now.toLocaleString("ja-JP")}  /  ${LOW} 点未満だった単語 ${words.length} 語(低い点数が多い順)`, ""];
  if (!words.length) return lines.concat("まだありません。録音して採点すると、ここに単語がたまります。").join("\n");
  words.sort((a, b) => b.n - a.n || a.worst - b.worst);
  lines.push("| 単語 | 最低点 | 最新 | 低かった回数 | ずれた音 | 練習した文 |", "|---|---|---|---|---|---|");
  for (const w of words) {
    const sounds = w.omitted && !w.sounds.length ? "読み飛ばし" : w.sounds.join(" ");
    const cell = (t) => String(t).replace(/\|/g, "/");
    lines.push(`| **${cell(w.word)}** | ${w.worst} | ${w.lastScore} | ${w.n} | ${cell(sounds)} | ${cell(w.sentence)} |`);
  }
  const byIpa = {};
  for (const w of words) for (const s of w.sounds) {
    const ipa = s.match(/^\/([^/]+)\//)?.[1];
    if (ipa) (byIpa[ipa] = byIpa[ipa] || []).push(w.word);
  }
  const ipas = Object.keys(byIpa).sort((a, b) => byIpa[b].length - byIpa[a].length);
  if (ipas.length) {
    lines.push("", "## 音ごとのコツ", "");
    for (const ipa of ipas) {
      const t = tipFor(ipa);
      lines.push(`- **/${ipa}/ ${t.name}**(${byIpa[ipa].slice(0, 8).join(", ")}): ${t.tip}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** One line per recording in notes/練習ログ.csv (opens in Excel). Failures only show in the status line. */
function logAttempt(item, result) {
  const sc = result.scores;
  const low = result.words
    .filter((w) => errType(w) !== "Insertion" && w.PronunciationAssessment && (errType(w) === "Omission" || w.PronunciationAssessment.AccuracyScore < LOW))
    .map((w) => `${w.Word}(${errType(w) === "Omission" ? "読み飛ばし" : round(w.PronunciationAssessment.AccuracyScore)})`);
  const r = (v) => (v == null || Number.isNaN(v) ? "" : round(v));
  const row = {
    deck: state.deck || state.data?.deck || "", slide: item.slide ?? "", title: item.title || "",
    sentence: item.custom ? current().text : item.text, locale: $("locale").value,
    total: r(sc.pron), accuracy: r(sc.accuracy), fluency: r(sc.fluency), completeness: r(sc.completeness), prosody: r(sc.prosody),
    low_words: low.join(" "),
  };
  fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row) })
    .catch(() => setStatus("練習ログを保存できませんでした(採点結果はこの画面に出ています)。", true));
}

async function saveWeakNote() {
  const words = store.get("weakWords", {});
  if (!Object.keys(words).length) { setStatus("まだ苦手な単語がありません。録音して採点するとたまります。"); return; }
  try {
    const res = await fetch("/api/note", { method: "POST", headers: { "Content-Type": "text/markdown; charset=utf-8" }, body: weakWordsMarkdown() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setStatus(`ノートを保存しました: ${data.path}`);
  } catch (e) {
    setStatus(`ノートを保存できませんでした: ${e.message}`, true);
  }
}

function renderWeak() {
  const stats = store.get("phonemes", {});
  const rows = Object.entries(stats)
    .filter(([, e]) => e.n >= 3)
    .map(([ipa, e]) => ({ ipa, avg: e.sum / e.n, n: e.n, words: e.words }))
    .filter((e) => e.avg < 95)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 10);
  const attempts = store.get("attempts", 0);
  const counted = Object.keys(stats).length;
  const summary = attempts ? `<p class="empty">これまでに ${attempts} 回の録音を集計しました(苦手な単語 ${Object.keys(store.get("weakWords", {})).length} 語)。</p>` : "";
  if (!rows.length) {
    $("weak").innerHTML = !counted
      ? '<p class="empty">まだデータがありません。何文か録音すると、苦手な音がここに表示されます。</p>'
      : summary + '<p class="empty">今のところ、平均95点未満の音はありません(同じ音が3回以上出てから集計します)。</p>';
    return;
  }
  $("weak").innerHTML = summary + rows.map((e) => {
    const t = tipFor(e.ipa);
    return `<div class="weakRow"><div class="ipa">/${esc(e.ipa)}/</div><div class="avg"><b style="color:var(--${band(e.avg)})">${round(e.avg)}</b><span>${e.n} 回</span></div>` +
      `<div><b>${esc(t.name)}</b> ${esc(t.tip)}${e.words.length ? `<div class="ex">最近つまずいた単語: ${esc(e.words.join(", "))}</div>` : ""}</div></div>`;
  }).join("");
}

// ---------------------------------------------------------------- demo data (?demo=1, no Azure needed)

function demoResult(text) {
  const tokens = text.replace(/[^A-Za-z0-9' -]/g, " ").split(/\s+/).filter(Boolean);
  const letters = { th: "θ", sh: "ʃ", ch: "tʃ", ng: "ŋ", r: "ɹ", l: "l", v: "v", f: "f", a: "æ", e: "ɛ", i: "ɪ", o: "ɑ", u: "ʌ", y: "j", w: "w" };
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7);
  const words = tokens.map((tok, wi) => {
    const lower = tok.toLowerCase();
    const phonemes = [];
    for (let i = 0; i < lower.length; i++) {
      const two = lower.slice(i, i + 2);
      const ipa = letters[two] || letters[lower[i]] || lower[i];
      if (letters[two]) i++;
      const weak = { "ɹ": 45, "θ": 50, "l": 62, "v": 58, "æ": 66 }[ipa];
      const score = weak ? weak + (hash(lower + i) % 20) : 82 + (hash(lower + i) % 18);
      const heard = { "ɹ": "l", "θ": "s", "v": "b", "æ": "ɑ" }[ipa];
      phonemes.push({ Phoneme: ipa, PronunciationAssessment: { AccuracyScore: score, NBestPhonemes: [{ Phoneme: score < 70 && heard ? heard : ipa, Score: 90 }] } });
    }
    const acc = avg(phonemes.map((p) => p.PronunciationAssessment.AccuracyScore));
    const omitted = wi === 3 && tokens.length > 6;
    return {
      Word: lower,
      PronunciationAssessment: {
        AccuracyScore: omitted ? 0 : acc,
        ErrorType: omitted ? "Omission" : acc < 60 ? "Mispronunciation" : "None",
        Feedback: { Prosody: { Break: { ErrorTypes: wi === 5 ? ["UnexpectedBreak"] : ["None"] }, Intonation: { ErrorTypes: [] } } },
      },
      Phonemes: omitted ? [] : phonemes,
    };
  });
  words.splice(1, 0, { Word: "um", PronunciationAssessment: { ErrorType: "Insertion" }, Phonemes: [] });
  const graded = words.filter((w) => errType(w) !== "Insertion");
  const accuracy = avg(graded.map((w) => w.PronunciationAssessment.AccuracyScore));
  const completeness = (100 * graded.filter((w) => errType(w) !== "Omission").length) / graded.length;
  const scores = { accuracy, fluency: 78, completeness, prosody: $("locale").value === "en-US" ? 71 : undefined };
  const sorted = [scores.accuracy, scores.fluency, scores.completeness, scores.prosody].filter((x) => x != null).sort((a, b) => a - b);
  scores.pron = sorted.length === 4 ? sorted[0] * 0.4 + sorted[1] * 0.2 + sorted[2] * 0.2 + sorted[3] * 0.2 : sorted[0] * 0.6 + sorted[1] * 0.2 + sorted[2] * 0.2;
  return { scores, words, display: "(デモ)" + text };
}

// ---------------------------------------------------------------- wiring

$("rec").onclick = toggleRecording;
$("prev").onclick = () => select(state.idx - 1);
$("next").onclick = () => select(state.idx + 1);
$("model").onclick = () => playModel(current().text);
$("mine").onclick = () => { if (state.wavUrl) new Audio(state.wavUrl).play(); };
$("list").onclick = (e) => { const b = e.target.closest(".item"); if (b) select(b.dataset.i); };
$("words").onclick = (e) => {
  const b = e.target.closest(".word");
  const result = state.results[current().id];
  if (b && result) renderDetail(result.words[Number(b.dataset.w)], b);
};
$("custom").oninput = () => store.set("customText", $("custom").value);
$("locale").value = store.get("locale", "en-US");
$("locale").onchange = () => store.set("locale", $("locale").value);
$("rate").value = store.get("rate", "normal");
$("rate").onchange = () => store.set("rate", $("rate").value);
$("saveNote").onclick = saveWeakNote;
$("reset").onclick = () => {
  if (!confirm("苦手な音・苦手な単語・ベストスコアの記録をすべて消しますか?")) return;
  store.set("phonemes", {});
  store.set("best", {});
  store.set("weakWords", {});
  store.set("attempts", 0);
  document.querySelectorAll(".item .badge").forEach((b) => b.remove());
  renderWeak();
};
document.addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input, select")) return;
  if (e.code === "Space") { e.preventDefault(); toggleRecording(); }
  else if (e.key === "ArrowLeft") select(state.idx - 1);
  else if (e.key === "ArrowRight") select(state.idx + 1);
});

(async () => {
  if (typeof SpeechSDK === "undefined" && !DEMO) {
    showBanner("Azure Speech SDK を読み込めませんでした。インターネット接続を確認してください。");
  }
  try {
    await loadSentences();
  } catch (e) {
    setStatus(e.message, true);
  }
  renderWeak();
  if (!DEMO) {
    try {
      await getToken();
    } catch (e) {
      showBanner(`<b>Azure の設定が必要です。</b> ${esc(e.message)} 設定するまでは、お手本はブラウザの音声で再生されます。採点の画面だけ試すには <a href="/?demo=1">デモモード</a> を開いてください。`);
    }
  }
})();
