"use strict";

const SETTINGS = {
  questionCount: 10,
  playSeconds: 2.5,
  bellGainDb: 9,
  bellQ: 2.0,
  notchGainDb: -12,
  notchQ: 3.0,
  mode: "normal", // "easy" | "normal"
  outputLevel: 0.18
};

const FREQUENCY_POOL = [
  80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000
];

const TYPE_BELL = "bell";
const TYPE_CUT = "cut";
const FADE_SECONDS = 0.02;
const LOOP_ORIGINAL = "eqOff";
const LOOP_EQ = "eq";

const state = {
  audioContext: null,
  limiter: null,
  masterGain: null,
  currentPlayback: null,
  phaseTimer: null,
  loopPhase: LOOP_ORIGINAL,
  playbackToken: 0,
  questions: [],
  currentIndex: 0,
  score: 0,
  answered: false,
  moveNextTimer: null
};

const dom = {
  startScreen: document.getElementById("start-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),
  startButton: document.getElementById("start-button"),
  restartButton: document.getElementById("restart-button"),
  progress: document.getElementById("progress"),
  liveScore: document.getElementById("live-score"),
  loopStatus: document.getElementById("loop-status"),
  eqOffIndicator: document.getElementById("eq-off-indicator"),
  eqOnIndicator: document.getElementById("eq-on-indicator"),
  prompt: document.getElementById("prompt"),
  options: document.getElementById("options"),
  feedback: document.getElementById("feedback"),
  score: document.getElementById("score"),
  review: document.getElementById("review")
};

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatFrequency(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2)} kHz` : `${hz} Hz`;
}

function frequencyIndex(hz) {
  return FREQUENCY_POOL.indexOf(hz);
}

function getMinDistractorSteps() {
  return SETTINGS.mode === "easy" ? 2 : 1;
}

function initAudio() {
  if (state.audioContext) {
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioCtx();

  // Mild limiting to keep level consistent when boost/notch questions alternate.
  state.limiter = state.audioContext.createDynamicsCompressor();
  state.limiter.threshold.value = -8;
  state.limiter.knee.value = 8;
  state.limiter.ratio.value = 4;
  state.limiter.attack.value = 0.003;
  state.limiter.release.value = 0.1;

  state.masterGain = state.audioContext.createGain();
  state.masterGain.gain.value = SETTINGS.outputLevel;

  state.limiter.connect(state.masterGain);
  state.masterGain.connect(state.audioContext.destination);
}

function createPinkNoiseData(totalSamples) {
  const output = new Float32Array(totalSamples);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;

  // Paul Kellet style filter coefficients for perceptual pink noise.
  for (let i = 0; i < totalSamples; i += 1) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    output[i] = pink * 0.11;
  }

  return output;
}

function cloneAudioData(data) {
  const copy = new Float32Array(data.length);
  copy.set(data);
  return copy;
}

function applyEdgeFade(data, fadeSamples) {
  const safeFade = Math.min(fadeSamples, Math.floor(data.length / 2));

  if (safeFade < 2) {
    return;
  }

  for (let i = 0; i < safeFade; i += 1) {
    const gain = i / (safeFade - 1);
    data[i] *= gain;
    data[data.length - 1 - i] *= gain;
  }
}

function applyBoundaryFade(data, boundarySample, fadeSamples) {
  const maxSafe = Math.min(fadeSamples, boundarySample, data.length - boundarySample);
  if (maxSafe < 2) {
    return;
  }

  for (let i = 0; i < maxSafe; i += 1) {
    const outGain = 1 - i / (maxSafe - 1);
    const inGain = i / (maxSafe - 1);
    data[boundarySample - maxSafe + i] *= outGain;
    data[boundarySample + i] *= inGain;
  }
}

function setLoopIndicators(phase) {
  const isEqOn = phase === LOOP_EQ;
  state.loopPhase = phase;
  if (!dom.loopStatus || !dom.eqOffIndicator || !dom.eqOnIndicator) {
    return;
  }
  dom.loopStatus.textContent = isEqOn ? "EQ On" : "EQ Off";
  dom.eqOffIndicator.classList.toggle("active", !isEqOn);
  dom.eqOnIndicator.classList.toggle("active", isEqOn);
}

function getQuestionFilterValues(question) {
  if (question.type === TYPE_BELL) {
    return { gain: SETTINGS.bellGainDb, q: SETTINGS.bellQ };
  }
  return { gain: SETTINGS.notchGainDb, q: SETTINGS.notchQ };
}

async function renderProcessedData(rawData, sampleRate, question) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    return cloneAudioData(rawData);
  }

  const offline = new OfflineCtx(1, rawData.length, sampleRate);
  const sourceBuffer = offline.createBuffer(1, rawData.length, sampleRate);
  if (typeof sourceBuffer.copyToChannel === "function") {
    sourceBuffer.copyToChannel(rawData, 0);
  } else {
    sourceBuffer.getChannelData(0).set(rawData);
  }

  const source = offline.createBufferSource();
  source.buffer = sourceBuffer;

  const filter = offline.createBiquadFilter();
  filter.type = "peaking";
  filter.frequency.value = question.targetHz;
  const filterValues = getQuestionFilterValues(question);
  filter.gain.value = filterValues.gain;
  filter.Q.value = filterValues.q;

  source.connect(filter);
  filter.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  return cloneAudioData(rendered.getChannelData(0));
}

async function buildComparisonBuffer(question) {
  const ctx = state.audioContext;
  const phaseSamples = Math.floor(ctx.sampleRate * SETTINGS.playSeconds);
  const rawData = createPinkNoiseData(phaseSamples);
  const processedData = await renderProcessedData(rawData, ctx.sampleRate, question);

  const combinedData = new Float32Array(phaseSamples * 2);
  combinedData.set(rawData, 0);
  combinedData.set(processedData, phaseSamples);

  const fadeSamples = Math.max(2, Math.floor(ctx.sampleRate * FADE_SECONDS));
  applyBoundaryFade(combinedData, phaseSamples, fadeSamples);
  applyEdgeFade(combinedData, fadeSamples);

  const buffer = ctx.createBuffer(1, combinedData.length, ctx.sampleRate);
  if (typeof buffer.copyToChannel === "function") {
    buffer.copyToChannel(combinedData, 0);
  } else {
    buffer.getChannelData(0).set(combinedData);
  }
  return buffer;
}

function stopQuestionAudio() {
  if (state.phaseTimer) {
    window.clearInterval(state.phaseTimer);
    state.phaseTimer = null;
  }
  setLoopIndicators(LOOP_ORIGINAL);

  if (!state.currentPlayback) {
    return;
  }

  const playback = state.currentPlayback;
  state.currentPlayback = null;

  try {
    playback.source.stop();
  } catch (_error) {
    // Safe to ignore if the source already stopped.
  }

  playback.source.disconnect();
}

function cancelQuestionAudio() {
  state.playbackToken += 1;
  stopQuestionAudio();
}

async function startQuestionAudioLoop(question) {
  if (!state.audioContext || !state.limiter) {
    return;
  }

  cancelQuestionAudio();
  const token = state.playbackToken;
  const buffer = await buildComparisonBuffer(question);

  if (token !== state.playbackToken || state.answered) {
    return;
  }

  setLoopIndicators(LOOP_ORIGINAL);
  const ctx = state.audioContext;
  const startAt = ctx.currentTime + 0.01;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = source.buffer.duration;
  source.connect(state.limiter);
  source.start(startAt);

  state.phaseTimer = window.setInterval(() => {
    const nextPhase = state.loopPhase === LOOP_ORIGINAL ? LOOP_EQ : LOOP_ORIGINAL;
    setLoopIndicators(nextPhase);
  }, SETTINGS.playSeconds * 1000);

  state.currentPlayback = { source };
}

function makeTypeSequence() {
  const minEachType = 4;
  // In a 10-question run this yields 4-6 per type, preserving roughly 50/50.
  const bellCount = randomInt(minEachType, SETTINGS.questionCount - minEachType);
  const notchCount = SETTINGS.questionCount - bellCount;
  return shuffle([
    ...Array.from({ length: bellCount }, () => TYPE_BELL),
    ...Array.from({ length: notchCount }, () => TYPE_CUT)
  ]);
}

function pickTargets() {
  return shuffle(FREQUENCY_POOL).slice(0, SETTINGS.questionCount);
}

function createOptions(targetHz) {
  const minSteps = getMinDistractorSteps();
  const targetPos = frequencyIndex(targetHz);

  const distractorCandidates = FREQUENCY_POOL.filter((hz) => {
    const stepDistance = Math.abs(frequencyIndex(hz) - targetPos);
    return stepDistance >= minSteps;
  });

  const distractors = shuffle(distractorCandidates).slice(0, 2);
  const options = shuffle([targetHz, ...distractors]);
  const correctIndex = options.indexOf(targetHz);

  return { options, correctIndex };
}

function generateQuiz() {
  const types = makeTypeSequence();
  const targets = pickTargets();

  return targets.map((targetHz, index) => {
    const { options, correctIndex } = createOptions(targetHz);
    return {
      id: index + 1,
      type: types[index],
      targetHz,
      options,
      correctIndex
    };
  });
}

function questionPrompt(question) {
  if (question.type === TYPE_BELL) {
    return "Listen to the loop (EQ Off \u2192 Bell Boost). Which center frequency is boosted?";
  }
  return "Listen to the loop (EQ Off \u2192 Bell Cut). Which center frequency is cut?";
}

function resetRun() {
  if (state.moveNextTimer) {
    window.clearTimeout(state.moveNextTimer);
    state.moveNextTimer = null;
  }
  cancelQuestionAudio();

  state.questions = generateQuiz();
  state.currentIndex = 0;
  state.score = 0;
  state.answered = false;
}

function showScreen(screenName) {
  dom.startScreen.classList.toggle("hidden", screenName !== "start");
  dom.quizScreen.classList.toggle("hidden", screenName !== "quiz");
  dom.resultScreen.classList.toggle("hidden", screenName !== "result");
}

function renderQuestion() {
  const question = state.questions[state.currentIndex];
  state.answered = false;

  dom.progress.textContent = `${state.currentIndex + 1}/${SETTINGS.questionCount}`;
  dom.liveScore.textContent = String(state.score);
  dom.prompt.textContent = questionPrompt(question);
  dom.feedback.textContent = "";
  dom.feedback.className = "feedback";

  dom.options.innerHTML = "";
  question.options.forEach((hz, idx) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-button";
    button.dataset.index = String(idx);
    button.textContent = `${String.fromCharCode(65 + idx)}. ${formatFrequency(hz)}`;
    button.addEventListener("click", () => selectAnswer(idx));
    dom.options.appendChild(button);
  });

  startQuestionAudioLoop(question).catch((error) => {
    console.error("Audio loop failed:", error);
  });
}

function lockOptions() {
  Array.from(dom.options.querySelectorAll("button")).forEach((button) => {
    button.disabled = true;
  });
}

function selectAnswer(optionIndex) {
  if (state.answered) {
    return;
  }

  state.answered = true;
  cancelQuestionAudio();
  const question = state.questions[state.currentIndex];
  const isCorrect = optionIndex === question.correctIndex;
  if (isCorrect) {
    state.score += 1;
  }
  dom.liveScore.textContent = String(state.score);

  lockOptions();

  const buttons = Array.from(dom.options.querySelectorAll("button"));
  buttons.forEach((button) => {
    const idx = Number(button.dataset.index);
    if (idx === question.correctIndex) {
      button.classList.add("correct");
    } else if (idx === optionIndex && !isCorrect) {
      button.classList.add("wrong");
    }
  });

  dom.feedback.textContent = isCorrect
    ? `Correct. ${formatFrequency(question.targetHz)}`
    : `Incorrect. Correct answer: ${formatFrequency(question.targetHz)}`;
  dom.feedback.classList.add(isCorrect ? "ok" : "bad");

  state.moveNextTimer = window.setTimeout(() => {
    state.moveNextTimer = null;
    state.currentIndex += 1;
    if (state.currentIndex >= SETTINGS.questionCount) {
      renderResult();
      return;
    }
    renderQuestion();
  }, 1000);
}

function renderResult() {
  cancelQuestionAudio();
  dom.score.textContent = `Score: ${state.score}/${SETTINGS.questionCount}`;
  dom.review.innerHTML = "";

  state.questions.forEach((question, index) => {
    const row = document.createElement("li");
    const label = question.type === TYPE_BELL ? "Bell boost" : "Bell cut";
    row.textContent = `Q${index + 1} ${label}: ${formatFrequency(question.targetHz)}`;
    dom.review.appendChild(row);
  });

  showScreen("result");
}

async function startQuiz() {
  initAudio();
  await state.audioContext.resume();
  resetRun();
  showScreen("quiz");
  renderQuestion();
}

function setupKeyboard() {
  // Optional quick-answer shortcuts.
  document.addEventListener("keydown", (event) => {
    if (dom.quizScreen.classList.contains("hidden") || state.answered) {
      return;
    }

    if (event.key === "1" || event.key === "2" || event.key === "3") {
      const idx = Number(event.key) - 1;
      const targetButton = dom.options.querySelector(`button[data-index="${idx}"]`);
      if (targetButton) {
        targetButton.click();
      }
    }
  });
}

function verifyNoRepeats(questions) {
  const targets = questions.map((q) => q.targetHz);
  return new Set(targets).size === targets.length;
}

function verifySpacing(questions) {
  const minSteps = getMinDistractorSteps();
  return questions.every((question) => {
    const targetPos = frequencyIndex(question.targetHz);
    const distractors = question.options.filter((hz) => hz !== question.targetHz);
    return distractors.every((hz) => {
      const steps = Math.abs(frequencyIndex(hz) - targetPos);
      return steps >= minSteps;
    });
  });
}

function typeDistribution(questions) {
  return questions.reduce(
    (acc, q) => {
      acc[q.type] += 1;
      return acc;
    },
    { [TYPE_BELL]: 0, [TYPE_CUT]: 0 }
  );
}

// Console helper: runSelfTest() validates generation rules for one or more runs.
window.runSelfTest = function runSelfTest(runs = 1) {
  let allValid = true;
  let sampleQuiz = null;

  for (let i = 0; i < runs; i += 1) {
    const quiz = generateQuiz();
    if (i === 0) {
      sampleQuiz = quiz;
    }

    const spacingOk = verifySpacing(quiz);
    const repeatsOk = verifyNoRepeats(quiz);
    const distribution = typeDistribution(quiz);
    const minEachOk = distribution[TYPE_BELL] >= 4 && distribution[TYPE_CUT] >= 4;
    const totalOk = quiz.length === SETTINGS.questionCount;

    if (!(spacingOk && repeatsOk && minEachOk && totalOk)) {
      allValid = false;
    }
  }

  if (!sampleQuiz) {
    console.log("Self test skipped: no quiz generated.");
    return;
  }

  const sampleDistribution = typeDistribution(sampleQuiz);
  console.log("Type distribution:", sampleDistribution);
  console.log("Target frequencies:", sampleQuiz.map((q) => q.targetHz));
  console.log("No repeats:", verifyNoRepeats(sampleQuiz));
  console.log(
    `Distractor spacing valid (${SETTINGS.mode} mode, min ${getMinDistractorSteps()} step):`,
    verifySpacing(sampleQuiz)
  );
  console.log(`Runs checked: ${runs}; all runs valid: ${allValid}`);
};

function init() {
  dom.startButton.addEventListener("click", () => {
    startQuiz().catch((error) => {
      console.error("Audio start failed:", error);
    });
  });
  dom.restartButton.addEventListener("click", () => {
    startQuiz().catch((error) => {
      console.error("Restart failed:", error);
    });
  });
  setupKeyboard();
  dom.liveScore.textContent = "0";
  setLoopIndicators(LOOP_ORIGINAL);
  showScreen("start");
}

init();
