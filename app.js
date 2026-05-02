const HOSTED_API_BASE = "https://rokgpsbackend.kyklos.online";
const CHAT_API_URL = `${resolveApiBase()}/api/rok-chat`;
const DEFAULT_MODEL = "gpt-oss:20b-cloud";
const WAKE_WITH_TRAILING_TEXT_REGEX = /\bhey\s+(?:rok|rock|r[\s.-]*o[\s.-]*k)\b[\s,:-]*(.*)$/i;
const WAKE_ONLY_REGEX = /\bhey\s+(?:rok|rock|r[\s.-]*o[\s.-]*k)\b/i;
const STOP_LISTENING_REGEX = /\b(?:stop listening|stand down|go quiet|disarm|mute yourself)\b/i;
const LEADING_FILLER_REGEX = /^(?:(?:uh+|um+|umm+|okay|ok|alright|please|well|so|like)\b[\s,.-]*)+/i;
const TRAILING_FILLER_REGEX = /(?:[\s,.-]+(?:please|thanks|thank you))+$/i;
const PROMPT_TIMEOUT_MS = 9000;

const state = {
  recognition: null,
  voiceSupported: false,
  voiceArmed: false,
  recognitionRunning: false,
  shouldRestartRecognition: false,
  waitingForPrompt: false,
  waitingTimer: null,
  micPermissionState: "unknown",
  apiBusy: false,
  ttsSupported: false,
  ttsEnabled: true,
  ttsSpeaking: false,
  ttsPausedRecognition: false,
  chatHistory: [],
  lastRecognizedText: "",
  lastRecognizedAt: 0,
};

const elements = {
  armVoiceBtn: document.querySelector("#armVoiceBtn"),
  armButtonText: document.querySelector("#armButtonText"),
  assistantSummary: document.querySelector("#assistantSummary"),
  voiceStatusPill: document.querySelector("#voiceStatusPill"),
  apiStatusPill: document.querySelector("#apiStatusPill"),
  modeMetric: document.querySelector("#modeMetric"),
  micMetric: document.querySelector("#micMetric"),
  speechMetric: document.querySelector("#speechMetric"),
  liveTranscript: document.querySelector("#liveTranscript"),
  queuedPrompt: document.querySelector("#queuedPrompt"),
  speakReplyBtn: document.querySelector("#speakReplyBtn"),
  stopSpeechBtn: document.querySelector("#stopSpeechBtn"),
  clearChatBtn: document.querySelector("#clearChatBtn"),
  composerForm: document.querySelector("#composerForm"),
  messageInput: document.querySelector("#messageInput"),
  chatLog: document.querySelector("#chatLog"),
};

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  setupSpeechSynthesis();
  setupVoiceRecognition();
  void refreshMicrophonePermissionState();
  syncUi();
});

function wireEvents() {
  elements.armVoiceBtn.addEventListener("click", async () => {
    await toggleVoiceArming();
  });

  elements.speakReplyBtn.addEventListener("click", () => {
    if (!state.ttsSupported) {
      return;
    }
    state.ttsEnabled = !state.ttsEnabled;
    if (!state.ttsEnabled) {
      stopSpeechPlayback();
      setAssistantSummary("Voice replies are off. ROK will still answer in text.");
    } else {
      setAssistantSummary("Voice replies are back on.");
    }
    syncUi();
  });

  elements.stopSpeechBtn.addEventListener("click", () => {
    stopSpeechPlayback();
    setAssistantSummary("Voice playback stopped.");
  });

  elements.clearChatBtn.addEventListener("click", () => {
    resetConversation();
  });

  elements.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = String(elements.messageInput.value || "").trim();
    if (!message) {
      setAssistantSummary("Type something before sending it to ROK.");
      return;
    }
    elements.messageInput.value = "";
    await sendRokMessage(message, { fromVoice: false });
  });
}

function setupSpeechSynthesis() {
  state.ttsSupported = "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
  if (!state.ttsSupported) {
    state.ttsEnabled = false;
  }
}

function setupVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    state.voiceSupported = false;
    setAssistantSummary("Speech-to-text is not available in this browser. Use Chrome or Edge for the Jarvis flow.");
    syncUi();
    return;
  }

  state.voiceSupported = true;
  state.recognition = new SpeechRecognition();
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.lang = "en-US";

  state.recognition.onstart = () => {
    state.recognitionRunning = true;
    syncUi();
  };

  state.recognition.onend = () => {
    state.recognitionRunning = false;
    if (state.ttsPausedRecognition) {
      syncUi();
      return;
    }
    if (state.shouldRestartRecognition && state.voiceArmed) {
      window.setTimeout(() => {
        safeStartRecognition();
      }, 250);
    }
    syncUi();
  };

  state.recognition.onerror = (event) => {
    const errorCode = String(event.error || "").toLowerCase();

    if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
      state.voiceArmed = false;
      state.shouldRestartRecognition = false;
      state.waitingForPrompt = false;
      clearWaitingTimer();
      state.micPermissionState = "denied";
      setAssistantSummary("Microphone permission was blocked. Allow it in the browser and arm voice again.");
      syncUi();
      return;
    }

    if (errorCode === "no-speech" || errorCode === "aborted") {
      syncUi();
      return;
    }

    setAssistantSummary(`Speech recognition hit "${event.error}". ROKGPS will try to recover.`);
    syncUi();
  };

  state.recognition.onresult = (event) => {
    let interimText = "";
    let finalText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = String(result[0].transcript || "").trim();
      if (result.isFinal) {
        finalText += `${transcript} `;
      } else {
        interimText += `${transcript} `;
      }
    }

    const visibleText = (finalText || interimText).trim();
    if (visibleText) {
      elements.liveTranscript.textContent = visibleText;
    }

    const finalized = finalText.trim();
    if (finalized) {
      handleRecognizedText(finalized);
    }
  };
}

async function toggleVoiceArming() {
  if (!state.voiceSupported || !state.recognition) {
    setAssistantSummary("Voice mode is unavailable in this browser.");
    return;
  }

  if (state.voiceArmed) {
    disarmVoiceRecognition();
    return;
  }

  state.voiceArmed = true;
  state.shouldRestartRecognition = true;
  setAssistantSummary('Allow microphone access, then say "hey rok" and your prompt.');
  elements.liveTranscript.textContent = 'Waiting for "hey rok"...';
  elements.queuedPrompt.textContent = 'Wake phrase not heard yet.';
  syncUi();

  const micReady = await ensureMicrophoneAccess();
  if (!micReady) {
    state.voiceArmed = false;
    state.shouldRestartRecognition = false;
    syncUi();
    return;
  }

  safeStartRecognition();
}

function disarmVoiceRecognition() {
  state.voiceArmed = false;
  state.shouldRestartRecognition = false;
  state.waitingForPrompt = false;
  clearWaitingTimer();
  if (state.recognitionRunning && state.recognition) {
    state.recognition.stop();
  }
  elements.liveTranscript.textContent = "The microphone is idle. Arm it to start speech-to-text.";
  elements.queuedPrompt.textContent = 'Waiting for "hey rok" before sending anything to the API.';
  setAssistantSummary('Voice mode is off. Arm it whenever you want ROK listening for "hey rok".');
  syncUi();
}

function safeStartRecognition() {
  if (!state.recognition || state.recognitionRunning) {
    return;
  }

  try {
    state.recognition.start();
  } catch (error) {
    const message = String(error && error.message ? error.message : "");
    if (!message.toLowerCase().includes("start")) {
      setAssistantSummary("The speech engine did not start cleanly. Try arming voice again.");
    }
  }
}

function handleRecognizedText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  const now = Date.now();
  if (!normalized) {
    return;
  }
  if (normalized === state.lastRecognizedText && now - state.lastRecognizedAt < 2500) {
    return;
  }

  state.lastRecognizedText = normalized;
  state.lastRecognizedAt = now;

  if (STOP_LISTENING_REGEX.test(text)) {
    disarmVoiceRecognition();
    return;
  }

  const wakeRemainder = parseWakeRemainder(text);
  if (wakeRemainder !== null) {
    if (wakeRemainder) {
      const prompt = sanitizePrompt(wakeRemainder);
      if (prompt) {
        state.waitingForPrompt = false;
        clearWaitingTimer();
        elements.queuedPrompt.textContent = prompt;
        setAssistantSummary("Wake phrase heard. Sending your voice prompt to ROK now.");
        void sendRokMessage(prompt, { fromVoice: true });
        syncUi();
        return;
      }
    }

    startPromptWindow();
    setAssistantSummary('Wake phrase heard. Now say the prompt you want sent to ROK.');
    syncUi();
    return;
  }

  if (state.waitingForPrompt) {
    const prompt = sanitizePrompt(text);
    if (!prompt) {
      elements.queuedPrompt.textContent = "Still waiting for a clear prompt after the wake phrase.";
      return;
    }

    state.waitingForPrompt = false;
    clearWaitingTimer();
    elements.queuedPrompt.textContent = prompt;
    setAssistantSummary("Prompt captured. Sending it to ROK.");
    syncUi();
    void sendRokMessage(prompt, { fromVoice: true });
  }
}

function startPromptWindow() {
  state.waitingForPrompt = true;
  clearWaitingTimer();
  elements.queuedPrompt.textContent = 'Wake word detected. Listening for the prompt that comes next.';
  state.waitingTimer = window.setTimeout(() => {
    state.waitingForPrompt = false;
    elements.queuedPrompt.textContent = 'No prompt followed the wake phrase. Say "hey rok" again.';
    setAssistantSummary('I heard "hey rok" but no follow-up prompt came through.');
    syncUi();
  }, PROMPT_TIMEOUT_MS);
}

function clearWaitingTimer() {
  if (state.waitingTimer) {
    window.clearTimeout(state.waitingTimer);
    state.waitingTimer = null;
  }
}

function parseWakeRemainder(text) {
  const match = String(text || "").match(WAKE_WITH_TRAILING_TEXT_REGEX);
  if (match) {
    return String(match[1] || "").trim();
  }
  return WAKE_ONLY_REGEX.test(text) ? "" : null;
}

function sanitizePrompt(text) {
  return String(text || "")
    .replace(WAKE_ONLY_REGEX, " ")
    .replace(LEADING_FILLER_REGEX, "")
    .replace(TRAILING_FILLER_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function sendRokMessage(message, { fromVoice = false } = {}) {
  const trimmed = sanitizePrompt(message);
  if (!trimmed) {
    return;
  }
  if (state.apiBusy) {
    setAssistantSummary("ROK is still finishing the last reply.");
    return;
  }

  state.apiBusy = true;
  stopSpeechPlayback();
  appendChatMessage("user", trimmed);
  const assistantBubble = appendChatMessage("assistant", "", { streaming: true });
  setAssistantSummary(fromVoice ? "Voice prompt sent to the ROK API." : "Text prompt sent to the ROK API.");
  syncUi();

  let assistantText = "";
  const priorHistory = state.chatHistory.slice(-12);

  try {
    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: trimmed,
        history: priorHistory,
        model: DEFAULT_MODEL,
      }),
    });

    if (!response.ok) {
      let errorMessage = `ROK request failed (${response.status}).`;
      try {
        const errorPayload = await response.json();
        if (errorPayload && typeof errorPayload.error === "string" && errorPayload.error.trim()) {
          errorMessage = errorPayload.error.trim();
        }
      } catch (error) {
        // Ignore body parse errors and keep the generic message.
      }
      updateChatMessage(assistantBubble, errorMessage, { streaming: false });
      setAssistantSummary(errorMessage);
      return;
    }

    if (!response.body) {
      const fallback = "ROK returned an empty response.";
      updateChatMessage(assistantBubble, fallback, { streaming: false });
      setAssistantSummary(fallback);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let streamDone = false;

    const applyPayload = (rawPayload) => {
      const parsed = extractTokenFromStreamPayload(rawPayload);
      if (parsed.token) {
        assistantText += parsed.token;
        updateChatMessage(assistantBubble, assistantText, { streaming: !parsed.done });
      }
      if (!assistantText && parsed.assistantContent) {
        assistantText = parsed.assistantContent;
        updateChatMessage(assistantBubble, assistantText, { streaming: !parsed.done });
      }
      return parsed.done;
    };

    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });
      const blocks = pending.split("\n\n");
      pending = blocks.pop() || "";

      for (const block of blocks) {
        const lines = block.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const rawPayload = line.slice(5).trim();
          if (!rawPayload) {
            continue;
          }
          if (applyPayload(rawPayload)) {
            streamDone = true;
            break;
          }
        }
        if (streamDone) {
          break;
        }
      }
    }

    if (pending.trim()) {
      for (const line of pending.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const rawPayload = line.slice(5).trim();
        if (!rawPayload) {
          continue;
        }
        applyPayload(rawPayload);
      }
    }

    assistantText = assistantText.trim() || "ROK did not return any text this time.";
    updateChatMessage(assistantBubble, assistantText, { streaming: false });
    state.chatHistory.push(
      { role: "user", content: trimmed },
      { role: "assistant", content: assistantText }
    );
    state.chatHistory = state.chatHistory.slice(-24);

    if (state.ttsEnabled) {
      setAssistantSummary("ROK answered. Speaking the reply with the browser default voice.");
      speakAssistantReply(assistantText);
    } else {
      setAssistantSummary("ROK answered in text. Voice replies are currently off.");
    }
  } catch (error) {
    const errorMessage = error && error.message ? error.message : "ROK could not be reached right now.";
    updateChatMessage(assistantBubble, errorMessage, { streaming: false });
    setAssistantSummary(errorMessage);
  } finally {
    state.apiBusy = false;
    syncUi();
  }
}

function appendChatMessage(role, text, options = {}) {
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;
  if (options.streaming) {
    article.classList.add("streaming");
  }

  const roleLabel = document.createElement("span");
  roleLabel.className = "chat-role";
  roleLabel.textContent = role === "user" ? "You" : "ROK";

  const body = document.createElement("p");
  body.className = "chat-text";
  body.textContent = text;

  article.appendChild(roleLabel);
  article.appendChild(body);
  elements.chatLog.appendChild(article);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  return article;
}

function updateChatMessage(node, text, options = {}) {
  if (!node) {
    return;
  }

  const body = node.querySelector(".chat-text");
  if (body) {
    body.textContent = text;
  }

  node.classList.toggle("streaming", Boolean(options.streaming));
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function resetConversation() {
  stopSpeechPlayback();
  state.chatHistory = [];
  state.apiBusy = false;
  elements.chatLog.innerHTML = `
    <article class="chat-message assistant">
      <span class="chat-role">ROK</span>
      <p class="chat-text">Jarvis mode is online. Say "hey rok" and then your prompt, or type below to send a message directly.</p>
    </article>
  `;
  elements.queuedPrompt.textContent = state.voiceArmed
    ? 'Listening for "hey rok" again.'
    : 'Waiting for "hey rok" before sending anything to the API.';
  setAssistantSummary("Conversation cleared.");
  syncUi();
}

function extractTokenFromStreamPayload(payload) {
  const raw = String(payload || "").trim();
  if (!raw) {
    return { token: "", done: false, assistantContent: "" };
  }
  if (raw === "[DONE]") {
    return { token: "", done: true, assistantContent: "" };
  }
  if (raw[0] !== "{") {
    return { token: raw, done: false, assistantContent: "" };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { token: raw, done: false, assistantContent: "" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { token: "", done: false, assistantContent: "" };
  }

  const done = Boolean(parsed.done);
  const assistantContent = typeof parsed.assistant_content === "string" ? parsed.assistant_content : "";

  for (const key of ["token", "response", "reply", "text", "message", "content"]) {
    if (typeof parsed[key] === "string") {
      return { token: parsed[key], done, assistantContent };
    }
  }

  if (Array.isArray(parsed.choices)) {
    let joined = "";
    let choiceDone = false;
    for (const choice of parsed.choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      if (choice.finish_reason) {
        choiceDone = true;
      }
      if (typeof choice.text === "string") {
        joined += choice.text;
      } else if (choice.delta && typeof choice.delta.content === "string") {
        joined += choice.delta.content;
      } else if (choice.message && typeof choice.message.content === "string") {
        joined += choice.message.content;
      }
    }
    return { token: joined, done: done || choiceDone, assistantContent };
  }

  return { token: "", done, assistantContent };
}

function speakAssistantReply(text) {
  if (!state.ttsSupported || !state.ttsEnabled) {
    return;
  }

  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return;
  }

  stopSpeechPlayback();
  pauseRecognitionForSpeech();

  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.onstart = () => {
    state.ttsSpeaking = true;
    syncUi();
  };
  utterance.onend = () => {
    state.ttsSpeaking = false;
    resumeRecognitionAfterSpeech();
    syncUi();
  };
  utterance.onerror = () => {
    state.ttsSpeaking = false;
    resumeRecognitionAfterSpeech();
    syncUi();
  };

  window.speechSynthesis.speak(utterance);
}

function stopSpeechPlayback() {
  if (!state.ttsSupported) {
    return;
  }

  state.ttsSpeaking = false;
  window.speechSynthesis.cancel();
  resumeRecognitionAfterSpeech();
  syncUi();
}

function pauseRecognitionForSpeech() {
  if (!state.voiceArmed || !state.recognitionRunning || state.ttsPausedRecognition) {
    return;
  }

  state.ttsPausedRecognition = true;
  state.shouldRestartRecognition = false;
  if (state.recognition) {
    state.recognition.stop();
  }
}

function resumeRecognitionAfterSpeech() {
  if (!state.ttsPausedRecognition) {
    return;
  }

  state.ttsPausedRecognition = false;
  if (!state.voiceArmed) {
    return;
  }

  state.shouldRestartRecognition = true;
  safeStartRecognition();
}

async function ensureMicrophoneAccess() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.micPermissionState = "unknown";
    setAssistantSummary("This browser cannot request microphone access for speech-to-text.");
    return false;
  }

  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      createMicTimeout(15000),
    ]);
    stream.getTracks().forEach((track) => track.stop());
    state.micPermissionState = "granted";
    return true;
  } catch (error) {
    state.micPermissionState = isPermissionDeniedError(error) ? "denied" : "unknown";
    setAssistantSummary("Microphone access was not granted. Allow it in the browser and try again.");
    return false;
  } finally {
    syncUi();
  }
}

function createMicTimeout(delayMs) {
  return new Promise((_, reject) => {
    window.setTimeout(() => {
      const timeoutError = new Error("Microphone check timed out.");
      timeoutError.name = "ROKMicTimeoutError";
      reject(timeoutError);
    }, delayMs);
  });
}

function isPermissionDeniedError(error) {
  const name = String(error && error.name ? error.name : "").toLowerCase();
  return name === "notallowederror" || name === "securityerror" || name === "permissiondismissederror";
}

async function refreshMicrophonePermissionState() {
  if (!navigator.permissions || !navigator.permissions.query) {
    state.micPermissionState = "unknown";
    syncUi();
    return state.micPermissionState;
  }

  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    state.micPermissionState = status.state;
    status.onchange = () => {
      state.micPermissionState = status.state;
      syncUi();
    };
  } catch (error) {
    state.micPermissionState = "unknown";
  }

  syncUi();
  return state.micPermissionState;
}

function syncUi() {
  elements.armVoiceBtn.disabled = !state.voiceSupported;
  elements.speakReplyBtn.disabled = !state.ttsSupported;
  elements.stopSpeechBtn.disabled = !state.ttsSupported || !state.ttsSpeaking;

  elements.speakReplyBtn.classList.toggle("is-off", !state.ttsEnabled);
  elements.speakReplyBtn.textContent = state.ttsEnabled ? "Voice replies on" : "Voice replies off";

  let reactorState = "idle";
  let voicePill = "Voice offline";
  let mode = "Standby";

  if (!state.voiceSupported) {
    reactorState = "unsupported";
    voicePill = "Voice unsupported";
    mode = "Browser unsupported";
    elements.armButtonText.textContent = "Unavailable";
  } else if (!state.voiceArmed) {
    reactorState = state.micPermissionState === "denied" ? "blocked" : "idle";
    voicePill = state.micPermissionState === "denied" ? "Voice blocked" : "Voice standby";
    mode = "Standby";
    elements.armButtonText.textContent = "Arm Voice";
  } else if (state.ttsSpeaking || state.ttsPausedRecognition) {
    reactorState = "speaking";
    voicePill = "Voice speaking";
    mode = "Replying";
    elements.armButtonText.textContent = "Speaking";
  } else if (state.waitingForPrompt) {
    reactorState = "awaiting";
    voicePill = "Wake heard";
    mode = "Awaiting prompt";
    elements.armButtonText.textContent = "Listening";
  } else if (state.recognitionRunning) {
    reactorState = "listening";
    voicePill = "Voice live";
    mode = 'Listening for "hey rok"';
    elements.armButtonText.textContent = "Disarm";
  } else {
    reactorState = "armed";
    voicePill = "Voice armed";
    mode = "Starting mic";
    elements.armButtonText.textContent = "Starting";
  }

  elements.armVoiceBtn.dataset.state = reactorState;
  elements.voiceStatusPill.textContent = voicePill;
  elements.modeMetric.textContent = mode;
  elements.micMetric.textContent = formatMicPermission(state.micPermissionState);
  elements.speechMetric.textContent = state.ttsSpeaking
    ? "Speaking"
    : state.apiBusy
      ? "Thinking"
      : state.recognitionRunning
        ? "Listening"
        : "Idle";

  elements.apiStatusPill.textContent = state.apiBusy ? "ROK thinking" : "ROK idle";
}

function formatMicPermission(permissionState) {
  if (permissionState === "granted") {
    return "Granted";
  }
  if (permissionState === "denied") {
    return "Blocked";
  }
  if (permissionState === "prompt") {
    return "Prompt";
  }
  return "Unknown";
}

function setAssistantSummary(text) {
  elements.assistantSummary.textContent = text;
}

function resolveApiBase() {
  const override = typeof window !== "undefined" ? window.ROKGPS_API_BASE : "";
  if (override && String(override).trim()) {
    return String(override).trim().replace(/\/+$/, "");
  }

  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return "";
  }

  return HOSTED_API_BASE;
}
