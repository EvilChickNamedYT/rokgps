const DEFAULT_VIEW = {
  lat: 40.758,
  lon: -73.9855,
  zoom: 12,
};

const HOSTED_API_BASE = "https://rokgpsbackend.kyklos.online";
const API_BASE = resolveApiBase();
const CHAT_API_URL = `${API_BASE}/api/rok-chat`;
const PUBLIC_ROUTER_BASES = [
  "https://router.project-osrm.org/route/v1/driving",
  "https://routing.openstreetmap.de/routed-car/route/v1/driving",
];

const WAKE_REGEX = /\bhey\s+(?:rok|rock|r[\s.-]*o[\s.-]*k)\b/i;
const WAKE_WITH_TRAILING_TEXT_REGEX = /\bhey\s+(?:rok|rock|r[\s.-]*o[\s.-]*k)\b[\s,:-]*(.*)$/i;
const COMMAND_PATTERNS = [
  /give me destination for\s+(.+)/i,
  /destination for\s+(.+)/i,
  /directions?(?:\s+(?:for|to))\s+(.+)/i,
  /navigation(?:\s+(?:for|to))\s+(.+)/i,
  /navigate(?: me)? to\s+(.+)/i,
  /navigate to\s+(.+)/i,
  /take me to\s+(.+)/i,
  /route(?: me)? to\s+(.+)/i,
  /go to\s+(.+)/i,
  /get to\s+(.+)/i,
  /how do i get to\s+(.+)/i,
  /find\s+(.+)/i,
];
const LEADING_FILLER_REGEX = /^(?:(?:uh+|um+|umm+|er+|ah+|hmm+|mm+|like|okay|ok|alright|all right|well|so|please|just|actually|literally|basically)\b[\s,.-]*)+/i;
const TRAILING_FILLER_REGEX = /(?:[\s,.-]+(?:(?:please|thanks|thank you|for me|right now|real quick|if you can|you know|kind of|sort of)))+$/i;
const LEADING_HELPER_REGEXES = [
  /^(?:can you|could you|would you|will you)\s+/i,
  /^(?:i want to|i wanna|i need to|i need directions to|i need a route to)\s+/i,
  /^(?:show me|find me|give me|get me)\s+/i,
];
const CHATY_PREFIX_REGEX = /^(?:what|who|when|where|why|how|tell|explain|describe|do|does|did|can|could|would|will|should|is|are|am|was|were)\b/i;

const state = {
  map: null,
  routeLayer: null,
  userMarker: null,
  destinationMarker: null,
  currentPosition: null,
  originSource: "location",
  recognition: null,
  voiceSupported: false,
  voiceArmed: false,
  shouldRestartRecognition: false,
  recognitionRunning: false,
  waitingForCommand: false,
  waitingTimer: null,
  lastHandledText: "",
  lastHandledAt: 0,
  speechPulseTimer: null,
  speechStartTimer: null,
  micPermissionState: "unknown",
  chatHistory: [],
  chatInFlight: false,
  ttsSupported: false,
  ttsEnabled: true,
  ttsQueue: [],
  ttsSpeaking: false,
  ttsChunkBuffer: "",
  ttsVoice: null,
  ttsPausedRecognition: false,
};

const elements = {
  armVoiceBtn: document.querySelector("#armVoiceBtn"),
  locateBtn: document.querySelector("#locateBtn"),
  listenerBanner: document.querySelector("#listenerBanner"),
  listenerHeadline: document.querySelector("#listenerHeadline"),
  listenerSubtext: document.querySelector("#listenerSubtext"),
  listenerModeText: document.querySelector("#listenerModeText"),
  listenerHint: document.querySelector("#listenerHint"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatSendBtn: document.querySelector("#chatSendBtn"),
  chatMessages: document.querySelector("#chatMessages"),
  ttsToggleBtn: document.querySelector("#ttsToggleBtn"),
  ttsStopBtn: document.querySelector("#ttsStopBtn"),
  destinationForm: document.querySelector("#destinationForm"),
  destinationInput: document.querySelector("#destinationInput"),
  liveTranscript: document.querySelector("#liveTranscript"),
  assistantResponse: document.querySelector("#assistantResponse"),
  micStatus: document.querySelector("#micStatus"),
  wakeStatus: document.querySelector("#wakeStatus"),
  originStatus: document.querySelector("#originStatus"),
  destinationStatus: document.querySelector("#destinationStatus"),
  voiceModeBadge: document.querySelector("#voiceModeBadge"),
  tripTimeValue: document.querySelector("#tripTimeValue"),
  tripDistanceValue: document.querySelector("#tripDistanceValue"),
  etaValue: document.querySelector("#etaValue"),
  routeSteps: document.querySelector("#routeSteps"),
  presetButtons: Array.from(document.querySelectorAll(".preset-chip")),
};

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  wireEvents();
  setupVoiceRecognition();
  setupTts();
  syncVoicePresence();
  void refreshMicrophonePermissionState();
  requestUserLocation({ silent: true, recenter: false });
});

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
  }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);

  state.map.on("click", (event) => {
    setOrigin(
      {
        lat: event.latlng.lat,
        lon: event.latlng.lng,
      },
      {
        source: "map",
        recenter: false,
      }
    );
    setAssistantResponse("Origin pinned from the map. Ask for a destination whenever you are ready.");
  });
}

function wireEvents() {
  elements.armVoiceBtn.addEventListener("click", async () => {
    await toggleVoiceArming();
  });
  elements.locateBtn.addEventListener("click", () => requestUserLocation({ silent: false, recenter: true }));
  elements.ttsToggleBtn.addEventListener("click", toggleTts);
  elements.ttsStopBtn.addEventListener("click", stopTtsPlayback);

  elements.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = elements.chatInput.value.trim();
    if (!message) {
      return;
    }
    elements.chatInput.value = "";
    await sendRokMessage(message, { fromVoice: false });
  });

  elements.destinationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const rawDestination = elements.destinationInput.value.trim();
    const destination = extractDestinationFromCommand(rawDestination, { allowBare: true }) || sanitizeDestinationCandidate(rawDestination);
    if (!destination) {
      setAssistantResponse("Say or type a real place name, like Detroit or JFK Airport.");
      return;
    }
    await planRoute(destination);
  });

  elements.presetButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const destination = button.dataset.destination || "";
      elements.destinationInput.value = destination;
      await planRoute(destination);
    });
  });
}

function setupTts() {
  state.ttsSupported = "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
  if (!state.ttsSupported) {
    state.ttsEnabled = false;
    syncTtsButtons();
    return;
  }

  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) {
      return;
    }
    state.ttsVoice =
      voices.find((voice) => /^en(-|_)/i.test(voice.lang) && /female|samantha|aria|jenny|zira|google us english/i.test(voice.name)) ||
      voices.find((voice) => /^en(-|_)/i.test(voice.lang)) ||
      voices[0] ||
      null;
  };

  pickVoice();
  if ("onvoiceschanged" in window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }
  syncTtsButtons();
}

function setupVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setMicStatus("Unsupported");
    setWakeStatus("Browser unsupported");
    setVoiceMode("Speech unavailable");
    setVoicePresence("unsupported", {
      headline: "Voice input is unavailable here",
      subtext: "This browser does not expose the speech recognition API. Use Chrome or Edge on localhost.",
      modeText: "UNAVAILABLE",
      hint: "SpeechRecognition is not supported",
    });
    setArmButtonState();
    setAssistantResponse("This browser does not expose the Web Speech API. Chrome or Edge on localhost is the safest bet.");
    return;
  }

  state.voiceSupported = true;
  state.recognition = new SpeechRecognition();
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.lang = "en-US";

  state.recognition.onstart = () => {
    clearSpeechStartWatch();
    state.recognitionRunning = true;
    setMicStatus("Listening");
    setWakeStatus(state.waitingForCommand ? "Heard wake word" : "Armed");
    setVoiceMode(state.waitingForCommand ? "Awaiting command" : "Wake listening");
    syncVoicePresence();
  };

  state.recognition.onend = () => {
    state.recognitionRunning = false;
    if (state.ttsPausedRecognition) {
      setMicStatus("Paused for voice reply");
      setWakeStatus("Armed");
      setVoiceMode("ROK speaking");
      syncVoicePresence();
      return;
    }
    if (state.shouldRestartRecognition) {
      setMicStatus("Restarting");
      setVoiceMode("Reconnecting");
      setVoicePresence("starting", {
        headline: "Reconnecting the microphone",
        subtext: "The browser stopped the speech engine for a moment. ROKGPS is trying again now.",
        modeText: "RETRYING",
        hint: "Hold on for a second",
      });
      scheduleSpeechStartWatch();
      window.setTimeout(() => {
        safeStartRecognition();
      }, 250);
      return;
    }
    clearSpeechStartWatch();
    setMicStatus("Idle");
    setWakeStatus("Disarmed");
    setVoiceMode("Standby");
    clearSpeechPulse();
    syncVoicePresence();
  };

  state.recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.voiceArmed = false;
      state.shouldRestartRecognition = false;
      clearSpeechStartWatch();
      setMicStatus("Permission blocked");
      setWakeStatus("Permission blocked");
      setVoiceMode("Mic blocked");
      clearSpeechPulse();
      setVoicePresence("blocked", {
        headline: "Microphone permission blocked",
        subtext: "ROKGPS cannot listen until microphone access is allowed for this page.",
        modeText: "BLOCKED",
        hint: "Allow mic access from the browser address bar",
      });
      setArmButtonState();
      setAssistantResponse("Microphone access was blocked. Allow mic access, then arm the wake word again.");
      return;
    }

    if (event.error === "no-speech") {
      setMicStatus("Listening");
      syncVoicePresence();
      return;
    }

    clearSpeechStartWatch();
    setMicStatus("Recovering");
    setVoicePresence("recovering", {
      headline: "Microphone is recovering",
      subtext: `The browser reported "${event.error}". ROKGPS will keep trying to reconnect the speech engine.`,
      modeText: "RECOVERING",
      hint: "If this keeps happening, refresh and allow the mic again",
    });
    setAssistantResponse(`Speech recognition hit "${event.error}". ROKGPS will keep trying to listen.`);
  };

  state.recognition.onresult = (event) => {
    let interim = "";
    let finalText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0].transcript.trim();
      if (result.isFinal) {
        finalText += `${transcript} `;
      } else {
        interim += `${transcript} `;
      }
    }

    const visibleTranscript = (finalText || interim).trim();
    if (visibleTranscript) {
      elements.liveTranscript.textContent = visibleTranscript;
      pulseSpeechPresence(visibleTranscript);
    }

    if (finalText.trim()) {
      handleRecognizedText(finalText.trim());
    }
  };

  setArmButtonState();
}

async function toggleVoiceArming() {
  if (!state.voiceSupported || !state.recognition) {
    setAssistantResponse("Voice arming is unavailable in this browser.");
    return;
  }

  if (state.voiceArmed) {
    disarmVoiceRecognition();
    return;
  }

  state.voiceArmed = true;
  state.shouldRestartRecognition = true;
  setMicStatus("Waiting for permission");
  setWakeStatus("Arming");
  setVoiceMode("Starting");
  setVoicePresence("starting", {
    headline: "Waiting for microphone permission",
    subtext: "Allow the browser microphone popup. When the orb turns red and pulses, ROKGPS is really listening.",
    modeText: "ARMING",
    hint: "Look for a mic permission popup",
  });
  setArmButtonState();
  setAssistantResponse('Allow microphone access in the browser prompt, then say "hey rok" and your destination command.');

  const micReady = await ensureMicrophoneAccess();
  if (!micReady) {
    state.voiceArmed = false;
    state.shouldRestartRecognition = false;
    setArmButtonState();
    return;
  }

  safeStartRecognition();
  scheduleSpeechStartWatch();
}

function safeStartRecognition() {
  if (!state.recognition || state.recognitionRunning) {
    return;
  }
  try {
    state.recognition.start();
  } catch (error) {
    if (!String(error.message || "").includes("start")) {
      setAssistantResponse("The speech engine did not start cleanly. Try the arm button again.");
    }
  }
}

function disarmVoiceRecognition() {
  state.voiceArmed = false;
  state.shouldRestartRecognition = false;
  state.waitingForCommand = false;
  clearWaitingTimer();
  clearSpeechPulse();
  clearSpeechStartWatch();
  setWakeStatus("Disarmed");
  setVoiceMode("Standby");
  setArmButtonState();
  syncVoicePresence();
  setAssistantResponse('Wake word disarmed. Press Start Listening whenever you want the mic live again.');
  if (state.recognitionRunning) {
    state.recognition.stop();
  } else {
    setMicStatus("Idle");
  }
}

function handleRecognizedText(text) {
  const normalized = text.trim().toLowerCase();
  const now = Date.now();
  if (normalized && normalized === state.lastHandledText && now - state.lastHandledAt < 2500) {
    return;
  }
  state.lastHandledText = normalized;
  state.lastHandledAt = now;

  if (/\b(stop listening|disarm|cancel voice)\b/i.test(text)) {
    disarmVoiceRecognition();
    return;
  }

  const wakeRemainder = parseWakeText(text);
  if (wakeRemainder !== null) {
    if (wakeRemainder) {
      const embeddedDestination = extractDestinationFromCommand(wakeRemainder, { allowBare: true });
      if (embeddedDestination) {
        void planRoute(embeddedDestination);
        return;
      }

      const cleanedWakeRemainder = stripSpeechNoise(wakeRemainder);
      if (!cleanedWakeRemainder) {
        state.waitingForCommand = true;
        clearWaitingTimer();
        state.waitingTimer = window.setTimeout(() => {
          state.waitingForCommand = false;
          setWakeStatus("Armed");
          setVoiceMode("Wake listening");
          syncVoicePresence();
          setAssistantResponse('I heard "hey rok" but not the destination. Say it again like "navigate to Central Park".');
        }, 10000);
        setWakeStatus("Heard wake word");
        setVoiceMode("Awaiting command");
        syncVoicePresence();
        setAssistantResponse("I am listening. Say the place name whenever you're ready.");
        return;
      }

      state.waitingForCommand = false;
      clearWaitingTimer();
      setWakeStatus(state.voiceArmed ? "Armed" : "Disarmed");
      setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
      syncVoicePresence();
      setAssistantResponse("Sending your question to ROK.");
      void sendRokMessage(wakeRemainder, { fromVoice: true });
      return;
    }

    state.waitingForCommand = true;
    clearWaitingTimer();
    state.waitingTimer = window.setTimeout(() => {
      state.waitingForCommand = false;
      setWakeStatus("Armed");
      setVoiceMode("Wake listening");
      syncVoicePresence();
      setAssistantResponse('I heard "hey rok" but not the destination. Say it again like "navigate to Central Park".');
    }, 10000);
    setWakeStatus("Heard wake word");
    setVoiceMode("Awaiting command");
    syncVoicePresence();
    setAssistantResponse('Wake word detected. Now say something like "give me destination for Times Square".');
    return;
  }

  if (state.waitingForCommand) {
    const destination = extractDestinationFromCommand(text, { allowBare: true });
    if (!destination) {
      const cleanedText = stripSpeechNoise(text);
      if (!cleanedText) {
        setAssistantResponse("Still listening for the place name.");
        return;
      }
      state.waitingForCommand = false;
      clearWaitingTimer();
      setWakeStatus(state.voiceArmed ? "Armed" : "Disarmed");
      setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
      syncVoicePresence();
      setAssistantResponse("Sending that to ROK.");
      void sendRokMessage(text, { fromVoice: true });
      return;
    }
    void planRoute(destination);
  }
}

function parseWakeText(text) {
  const match = text.match(WAKE_WITH_TRAILING_TEXT_REGEX);
  if (!match) {
    return null;
  }
  return (match[1] || "").trim();
}

function extractDestinationFromCommand(text, options = {}) {
  const cleanText = simplifyRoutePrompt(text);
  for (const pattern of COMMAND_PATTERNS) {
    const match = cleanText.match(pattern);
    if (match && match[1]) {
      return sanitizeDestinationCandidate(match[1]);
    }
  }

  if (options.allowBare) {
    const bareCandidate = sanitizeDestinationCandidate(cleanText.replace(/^to\s+/i, ""));
    if (isLikelyBareDestination(bareCandidate)) {
      return bareCandidate;
    }
  }

  return "";
}

function tidyDestination(rawDestination) {
  return rawDestination
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSpeechNoise(rawText) {
  let text = String(rawText || "").replace(WAKE_REGEX, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text.replace(LEADING_FILLER_REGEX, "").replace(TRAILING_FILLER_REGEX, "").trim();
    for (const regex of LEADING_HELPER_REGEXES) {
      text = text.replace(regex, "").trim();
    }
  }

  return text.replace(/\s+/g, " ").trim();
}

function simplifyRoutePrompt(rawText) {
  let text = stripSpeechNoise(rawText)
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  text = text
    .replace(/^(?:can you|could you|would you|will you)\s+/i, "")
    .replace(/^(?:please\s+)?(?:show me|get me|give me|find me)\s+/i, "$&")
    .replace(/\b(?:please|thanks|thank you)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function sanitizeDestinationCandidate(rawText) {
  return tidyDestination(
    stripSpeechNoise(rawText)
      .replace(/^(?:destination|directions?|navigation|route)\s+(?:for|to)\s+/i, "")
      .replace(/^(?:route|navigate|map)(?:\s+me)?\s+to\s+/i, "")
      .replace(/^(?:take|bring|drive)\s+me\s+to\s+/i, "")
      .replace(/^(?:go|get)\s+to\s+/i, "")
      .replace(/^to\s+/i, "")
      .replace(/\b(?:please|thanks|thank you|for me|right now|real quick)\b/gi, " ")
      .replace(/\s+/g, " ")
  );
}

function isLikelyBareDestination(text) {
  const candidate = sanitizeDestinationCandidate(text);
  if (!candidate) {
    return false;
  }

  if (CHATY_PREFIX_REGEX.test(candidate) || /[?]$/.test(candidate)) {
    return false;
  }

  const words = candidate.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 7) {
    return false;
  }

  if (!/[a-z0-9]/i.test(candidate)) {
    return false;
  }

  return true;
}

async function requestUserLocation({ silent = false, recenter = true } = {}) {
  if (!navigator.geolocation) {
    setOriginStatus("Geolocation unsupported");
    if (!silent) {
      setAssistantResponse("This browser does not support geolocation. Click the map to choose an origin manually.");
    }
    return null;
  }

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 45000,
      });
    });

    const coords = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
    };

    setOrigin(coords, {
      source: "location",
      recenter,
    });

    if (!silent) {
      setAssistantResponse("Current location locked in. Ask for a destination and I will map the route.");
    }
    return coords;
  } catch (error) {
    setOriginStatus("Location blocked");
    if (!silent) {
      setAssistantResponse("Location access was denied or timed out. Click the map to pick an origin manually.");
    }
    return null;
  }
}

function setOrigin(coords, { source = "location", recenter = true } = {}) {
  state.currentPosition = coords;
  state.originSource = source;

  const label =
    source === "map"
      ? `Manual pin ${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`
      : `Live location ${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`;

  setOriginStatus(label);

  if (!state.userMarker) {
    state.userMarker = L.circleMarker([coords.lat, coords.lon], {
      radius: 9,
      weight: 3,
      color: "#230507",
      fillColor: "#ff5a66",
      fillOpacity: 1,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng([coords.lat, coords.lon]);
  }

  state.userMarker
    .bindPopup(source === "map" ? "Manual origin" : "Current location")
    .closePopup();

  if (recenter) {
    state.map.setView([coords.lat, coords.lon], 13);
  }
}

async function planRoute(destinationText) {
  const destination =
    extractDestinationFromCommand(destinationText, { allowBare: true }) ||
    sanitizeDestinationCandidate(destinationText);
  if (!destination) {
    setAssistantResponse("I still need a place name before I can route anywhere.");
    return;
  }

  elements.destinationInput.value = destination;
  setDestinationStatus("Finding destination...");
  setVoiceMode("Routing");
  setAssistantResponse(`Routing to ${destination}.`);

  const origin = state.currentPosition || (await requestUserLocation({ silent: true, recenter: true }));
  if (!origin) {
    setDestinationStatus("Need origin");
    setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
    setAssistantResponse("I need an origin before I can map the route. Use your location or click the map.");
    return;
  }

  try {
    const params = new URLSearchParams({
      destination,
      origin_lat: String(origin.lat),
      origin_lon: String(origin.lon),
    });

    const response = await fetch(`${API_BASE}/api/route?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      const message = payload.error || "Route request failed.";
      if (response.status >= 500 || /routing service could not be reached/i.test(message)) {
        const fallbackPayload = await fetchRouteWithBrowserFallback(destination, origin);
        renderRoute(fallbackPayload);
        state.waitingForCommand = false;
        clearWaitingTimer();
        setWakeStatus(state.voiceArmed ? "Armed" : "Disarmed");
        setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
        syncVoicePresence();
        setAssistantResponse(`Fastest route ready for ${fallbackPayload.destination.name}.`);
        return;
      }
      throw new Error(message);
    }

    renderRoute(payload);
    state.waitingForCommand = false;
    clearWaitingTimer();
    setWakeStatus(state.voiceArmed ? "Armed" : "Disarmed");
    setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
    syncVoicePresence();
    setAssistantResponse(`Fastest route ready for ${payload.destination.name}.`);
  } catch (error) {
    try {
      const fallbackPayload = await fetchRouteWithBrowserFallback(destination, origin);
      renderRoute(fallbackPayload);
      state.waitingForCommand = false;
      clearWaitingTimer();
      setWakeStatus(state.voiceArmed ? "Armed" : "Disarmed");
      setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
      syncVoicePresence();
      setAssistantResponse(`Fastest route ready for ${fallbackPayload.destination.name}.`);
    } catch (fallbackError) {
      setDestinationStatus("Route failed");
      setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
      syncVoicePresence();
      setAssistantResponse(fallbackError.message || error.message || "Routing failed. Try another destination.");
    }
  }
}

function renderRoute(payload) {
  const destination = payload.destination;
  const route = payload.route;
  const steps = route.steps || [];
  const coordinates = route.geometry && route.geometry.coordinates ? route.geometry.coordinates : [];

  setDestinationStatus(destination.name);
  elements.tripTimeValue.textContent = formatDuration(route.duration_seconds);
  elements.tripDistanceValue.textContent = formatDistance(route.distance_meters);
  elements.etaValue.textContent = calculateEta(route.duration_seconds);

  if (state.routeLayer) {
    state.map.removeLayer(state.routeLayer);
  }

  state.routeLayer = L.geoJSON(route.geometry, {
    style: {
      color: "#ff5f63",
      weight: 7,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
    },
  }).addTo(state.map);

  if (!state.destinationMarker) {
    state.destinationMarker = L.marker([destination.lat, destination.lon]).addTo(state.map);
  } else {
    state.destinationMarker.setLatLng([destination.lat, destination.lon]);
  }

  state.destinationMarker.bindPopup(destination.name);

  const bounds = L.latLngBounds([
    [payload.origin.lat, payload.origin.lon],
    [destination.lat, destination.lon],
  ]);

  coordinates.forEach((pair) => {
    bounds.extend([pair[1], pair[0]]);
  });

  state.map.fitBounds(bounds.pad(0.15));
  renderRouteSteps(steps);
}

async function fetchRouteWithBrowserFallback(destinationText, origin) {
  const destination = await fetchDestinationViaBackendGeocode(destinationText);
  let lastError = null;

  for (const routerBase of PUBLIC_ROUTER_BASES) {
    try {
      const params = new URLSearchParams({
        overview: "full",
        geometries: "geojson",
        steps: "true",
      });
      const response = await fetch(
        `${routerBase}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?${params.toString()}`,
        {
          headers: {
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        let message = `Public router failed (${response.status}).`;
        try {
          const payload = await response.json();
          if (payload && typeof payload.message === "string" && payload.message.trim()) {
            message = payload.message.trim();
          } else if (payload && typeof payload.code === "string" && payload.code.trim()) {
            message = payload.code.trim();
          }
        } catch (error) {
          // Ignore JSON parse failures and keep the generic message.
        }
        throw new Error(message);
      }

      const payload = await response.json();
      return mapOsrmRoutePayload(origin, destination, payload);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    (lastError && lastError.message) || "The routing service could not be reached right now."
  );
}

async function fetchDestinationViaBackendGeocode(destinationText) {
  const params = new URLSearchParams({
    q: destinationText,
  });
  const response = await fetch(`${API_BASE}/api/geocode?${params.toString()}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Destination lookup failed.");
  }
  return payload;
}

function mapOsrmRoutePayload(origin, destination, payload) {
  const routes = payload && Array.isArray(payload.routes) ? payload.routes : [];
  if (!routes.length) {
    throw new Error("No drivable route was found.");
  }

  const route = routes[0];
  const leg = Array.isArray(route.legs) && route.legs.length ? route.legs[0] : { steps: [] };
  const steps = Array.isArray(leg.steps)
    ? leg.steps.map((step) => ({
        instruction: buildInstructionFromOsrmStep(step),
        distance_meters: Number(step.distance || 0),
        duration_seconds: Number(step.duration || 0),
        name: pickRoadNameFromOsrmStep(step),
      }))
    : [];

  return {
    origin: {
      lat: origin.lat,
      lon: origin.lon,
    },
    destination: {
      name: destination.name,
      lat: destination.lat,
      lon: destination.lon,
    },
    route: {
      distance_meters: Number(route.distance || 0),
      duration_seconds: Number(route.duration || 0),
      geometry: route.geometry || { type: "LineString", coordinates: [] },
      steps,
    },
  };
}

function pickRoadNameFromOsrmStep(step) {
  const name = String(step && step.name ? step.name : "").trim();
  if (name) {
    return name;
  }
  const ref = String(step && step.ref ? step.ref : "").trim();
  if (ref) {
    return ref;
  }
  const destinations = String(step && step.destinations ? step.destinations : "").trim();
  if (destinations) {
    return destinations;
  }
  const rotaryName = String(step && step.rotary_name ? step.rotary_name : "").trim();
  if (rotaryName) {
    return rotaryName;
  }
  return "the road ahead";
}

function buildInstructionFromOsrmStep(step) {
  const maneuver = (step && step.maneuver) || {};
  const stepType = String(maneuver.type || "continue").trim().toLowerCase();
  const modifier = String(maneuver.modifier || "").trim().toLowerCase();
  const road = pickRoadNameFromOsrmStep(step);

  if (stepType === "depart") {
    return modifier ? `Head ${modifier} on ${road}` : `Start on ${road}`;
  }
  if (stepType === "arrive") {
    return modifier === "left" || modifier === "right"
      ? `Arrive at your destination on the ${modifier}`
      : "Arrive at your destination";
  }
  if (stepType === "turn") {
    return `Turn ${modifier || "ahead"} onto ${road}`;
  }
  if (stepType === "continue") {
    return modifier ? `Continue ${modifier} on ${road}` : `Continue on ${road}`;
  }
  if (stepType === "new name") {
    return `Continue onto ${road}`;
  }
  if (stepType === "merge") {
    return `Merge ${modifier} onto ${road}`.replace("  ", " ").trim();
  }
  if (stepType === "on ramp") {
    return `Take the ramp ${modifier} onto ${road}`.replace("  ", " ").trim();
  }
  if (stepType === "off ramp") {
    return `Take the exit ${modifier} toward ${road}`.replace("  ", " ").trim();
  }
  if (stepType === "fork") {
    return `Keep ${modifier || "straight"} to stay on ${road}`;
  }
  if (stepType === "roundabout") {
    const exitNumber = maneuver.exit;
    return exitNumber
      ? `Enter the roundabout and take exit ${exitNumber} onto ${road}`
      : `Enter the roundabout toward ${road}`;
  }
  if (stepType === "rotary") {
    return `Go through the rotary toward ${road}`;
  }
  if (stepType === "notification") {
    return `Continue on ${road}`;
  }
  if (stepType === "end of road") {
    return `At the end of the road, turn ${modifier || "as needed"}`;
  }
  return `${stepType.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())} on ${road}`;
}

function renderRouteSteps(steps) {
  elements.routeSteps.innerHTML = "";

  if (!steps.length) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "empty-step";
    emptyItem.textContent = "The router returned a route without step details.";
    elements.routeSteps.appendChild(emptyItem);
    return;
  }

  steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = "step-item";

    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${step.instruction}`;

    const meta = document.createElement("div");
    meta.className = "step-meta";
    meta.textContent = `${formatDistance(step.distance_meters)} | ${formatDuration(step.duration_seconds)}`;

    item.appendChild(title);
    item.appendChild(meta);
    elements.routeSteps.appendChild(item);
  });
}

function clearWaitingTimer() {
  if (state.waitingTimer) {
    window.clearTimeout(state.waitingTimer);
    state.waitingTimer = null;
  }
}

function clearSpeechPulse() {
  if (state.speechPulseTimer) {
    window.clearTimeout(state.speechPulseTimer);
    state.speechPulseTimer = null;
  }
}

function clearSpeechStartWatch() {
  if (state.speechStartTimer) {
    window.clearTimeout(state.speechStartTimer);
    state.speechStartTimer = null;
  }
}

function scheduleSpeechStartWatch() {
  clearSpeechStartWatch();
  state.speechStartTimer = window.setTimeout(() => {
    if (!state.voiceArmed || state.recognitionRunning) {
      return;
    }

    setMicStatus("No speech engine response");
    setVoiceMode("No response");
    setVoicePresence("recovering", {
      headline: "The browser still is not listening",
      subtext: "Microphone permission may be allowed, but the speech engine itself has not started. Try refreshing the page or using Chrome or Edge.",
      modeText: "NO RESPONSE",
      hint: "Permission alone is not the same as a live mic",
    });
    setAssistantResponse("The browser did not start speech recognition after the permission step, so the mic is still not actually live.");
  }, 5000);
}

function pulseSpeechPresence(transcript) {
  if (!state.voiceArmed || !state.recognitionRunning) {
    return;
  }

  clearSpeechPulse();
  setMicStatus("Hearing speech");
  setVoicePresence("hearing", {
    headline: "I can hear you",
    subtext: `Live audio detected: "${truncateText(transcript, 100)}"`,
    modeText: "HEARING",
    hint: "Your voice is reaching the microphone",
  });

  state.speechPulseTimer = window.setTimeout(() => {
    setMicStatus("Listening");
    syncVoicePresence();
  }, 1600);
}

async function ensureMicrophoneAccess() {
  const permissionState = await refreshMicrophonePermissionState();
  if (permissionState === "denied") {
    setMicStatus("Permission blocked");
    setWakeStatus("Permission blocked");
    setVoiceMode("Mic blocked");
    setVoicePresence("blocked", {
      headline: "Microphone permission blocked",
      subtext: "ROKGPS cannot listen until microphone access is allowed for this page.",
      modeText: "BLOCKED",
      hint: "Use the address-bar lock icon to allow the mic, then try again",
    });
    setAssistantResponse("Microphone access is blocked for this page. Allow it in the browser, then press Start Listening again.");
    return false;
  }

  if (permissionState === "granted") {
    return true;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return true;
  }

  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      createMicTimeout(4500),
    ]);
    stream.getTracks().forEach((track) => track.stop());
    await refreshMicrophonePermissionState();
    return true;
  } catch (error) {
    if (error && error.name === "ROKMicTimeoutError") {
      setMicStatus("Waiting on browser speech engine");
      setVoiceMode("Trying speech engine");
      setVoicePresence("starting", {
        headline: "Still waiting on the browser",
        subtext: "Permission did not resolve quickly, so ROKGPS is trying to start the speech engine anyway.",
        modeText: "WAITING",
        hint: "If this stays here, the browser is not exposing live speech input",
      });
      setAssistantResponse("Mic permission did not finish cleanly, so I am trying the browser speech engine anyway.");
      return true;
    }

    await refreshMicrophonePermissionState();
    if (!isPermissionDeniedError(error)) {
      const errorName = error && error.name ? error.name : "unknown error";
      setMicStatus("Trying speech engine");
      setVoiceMode("Fallback start");
      setVoicePresence("starting", {
        headline: "Trying speech recognition anyway",
        subtext: `The direct mic check returned "${errorName}", but ROKGPS is still asking the browser speech engine to start.`,
        modeText: "FALLBACK",
        hint: "The browser may support speech even if getUserMedia is flaky",
      });
      setAssistantResponse(`Direct mic access returned "${errorName}", but I am still trying to start speech recognition.`);
      return true;
    }

    setMicStatus("Permission blocked");
    setWakeStatus("Permission blocked");
    setVoiceMode("Mic blocked");
    setVoicePresence("blocked", {
      headline: "Microphone permission blocked",
      subtext: "ROKGPS cannot listen until microphone access is allowed for this page.",
      modeText: "BLOCKED",
      hint: "Use the address-bar lock icon to allow the mic, then try again",
    });
    setAssistantResponse("Microphone access was blocked. Allow it in the browser, then press Start Listening again.");
    return false;
  }
}

async function refreshMicrophonePermissionState() {
  if (!navigator.permissions || !navigator.permissions.query) {
    state.micPermissionState = "unknown";
    return state.micPermissionState;
  }

  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    state.micPermissionState = status.state;
    status.onchange = () => {
      state.micPermissionState = status.state;
      if (!state.voiceArmed) {
        syncVoicePresence();
      }
    };
  } catch (error) {
    state.micPermissionState = "unknown";
  }

  return state.micPermissionState;
}

function createMicTimeout(delayMs) {
  return new Promise((_, reject) => {
    window.setTimeout(() => {
      const error = new Error("Microphone check timed out.");
      error.name = "ROKMicTimeoutError";
      reject(error);
    }, delayMs);
  });
}

function isPermissionDeniedError(error) {
  const errorName = String(error && error.name ? error.name : "").toLowerCase();
  return errorName === "notallowederror" || errorName === "securityerror" || errorName === "permissiondismissederror";
}

function setVoicePresence(stateName, { headline, subtext, modeText, hint } = {}) {
  elements.listenerBanner.dataset.state = stateName;
  if (headline) {
    elements.listenerHeadline.textContent = headline;
  }
  if (subtext) {
    elements.listenerSubtext.textContent = subtext;
  }
  if (modeText) {
    elements.listenerModeText.textContent = modeText;
  }
  if (hint) {
    elements.listenerHint.textContent = hint;
  }
}

function syncVoicePresence() {
  if (!state.voiceSupported) {
    setVoicePresence("unsupported", {
      headline: "Voice input is unavailable here",
      subtext: "This browser does not expose the speech recognition API. Use Chrome or Edge on localhost.",
      modeText: "UNAVAILABLE",
      hint: "SpeechRecognition is not supported",
    });
    setArmButtonState();
    return;
  }

  if (!state.voiceArmed) {
    if (state.micPermissionState === "granted") {
      setVoicePresence("off", {
        headline: "Microphone permission is ready",
        subtext: "The browser says the microphone is allowed. Press Start Listening to actually start the speech engine.",
        modeText: "READY",
        hint: "Permission granted, but not listening yet",
      });
      setArmButtonState();
      return;
    }

    if (state.micPermissionState === "denied") {
      setVoicePresence("blocked", {
        headline: "Microphone permission is blocked",
        subtext: "This page does not have microphone access right now. Allow it in the browser and then try again.",
        modeText: "BLOCKED",
        hint: "Use the address-bar lock icon",
      });
      setArmButtonState();
      return;
    }

    setVoicePresence("off", {
      headline: "Microphone is off",
      subtext: "Press Start Listening, allow the browser microphone prompt, and wait for the orb to pulse before speaking.",
      modeText: "OFF",
      hint: "Wake word inactive",
    });
    setArmButtonState();
    return;
  }

  if (state.ttsPausedRecognition) {
    setVoicePresence("recovering", {
      headline: "ROK is speaking",
      subtext: "The microphone is briefly paused so ROK does not hear its own voice reply.",
      modeText: "SPEAKING",
      hint: "Listening will resume right after the reply",
    });
    setArmButtonState();
    return;
  }

  if (!state.recognitionRunning) {
    setVoicePresence("starting", {
      headline: "Starting microphone",
      subtext: "ROKGPS is trying to start the speech engine. If you do not see a red pulse, the mic is not live yet.",
      modeText: "ARMING",
      hint: "Waiting for the browser speech engine",
    });
    setArmButtonState();
    return;
  }

  if (state.waitingForCommand) {
    setVoicePresence("awaiting", {
      headline: "Wake word heard",
      subtext: 'ROKGPS heard "hey rok". Say the destination now, like "navigate to Newark Airport".',
      modeText: "READY",
      hint: "Listening for the next phrase",
    });
    setArmButtonState();
    return;
  }

  setVoicePresence("listening", {
    headline: "Microphone is live",
    subtext: 'ROKGPS is actively listening now. Say "hey rok" and then your destination command.',
    modeText: "LIVE",
    hint: "Pulsing red means the mic is active",
  });
  setArmButtonState();
}

function setArmButtonState() {
  if (!state.voiceSupported) {
    elements.armVoiceBtn.textContent = "Voice Unsupported";
    elements.armVoiceBtn.disabled = true;
    elements.armVoiceBtn.classList.remove("is-live");
    return;
  }

  elements.armVoiceBtn.disabled = false;

  if (state.voiceArmed && state.recognitionRunning) {
    elements.armVoiceBtn.textContent = "Stop Listening";
    elements.armVoiceBtn.classList.add("is-live");
    return;
  }

  if (state.voiceArmed) {
    elements.armVoiceBtn.textContent = "Starting Mic...";
    elements.armVoiceBtn.classList.add("is-live");
    return;
  }

  elements.armVoiceBtn.textContent = "Start Listening";
  elements.armVoiceBtn.classList.remove("is-live");
}

function truncateText(text, maxLength) {
  const clean = String(text || "").trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 3)}...`;
}

function toggleTts() {
  if (!state.ttsSupported) {
    return;
  }
  state.ttsEnabled = !state.ttsEnabled;
  if (!state.ttsEnabled) {
    stopTtsPlayback();
  }
  syncTtsButtons();
}

function syncTtsButtons() {
  if (!elements.ttsToggleBtn || !elements.ttsStopBtn) {
    return;
  }

  if (!state.ttsSupported) {
    elements.ttsToggleBtn.textContent = "Voice Replies Unsupported";
    elements.ttsToggleBtn.disabled = true;
    elements.ttsToggleBtn.classList.remove("is-active");
    elements.ttsStopBtn.disabled = true;
    return;
  }

  elements.ttsToggleBtn.disabled = false;
  elements.ttsToggleBtn.textContent = state.ttsEnabled ? "Voice Replies On" : "Voice Replies Off";
  elements.ttsToggleBtn.classList.toggle("is-active", state.ttsEnabled);
  elements.ttsStopBtn.disabled = !state.ttsSpeaking && !state.ttsQueue.length && !state.ttsChunkBuffer;
}

function stopTtsPlayback() {
  state.ttsQueue = [];
  state.ttsChunkBuffer = "";
  state.ttsSpeaking = false;
  if (state.ttsSupported) {
    window.speechSynthesis.cancel();
  }
  resumeRecognitionAfterTts();
  syncTtsButtons();
}

function maybeQueueTtsChunk(token) {
  if (!state.ttsSupported || !state.ttsEnabled) {
    return;
  }

  state.ttsChunkBuffer += token;
  const readyByPunctuation = /[.!?]\s*$/.test(state.ttsChunkBuffer);
  const readyByLength = state.ttsChunkBuffer.length >= 110 && /\s/.test(state.ttsChunkBuffer.slice(-1));
  if (!readyByPunctuation && !readyByLength) {
    return;
  }

  queueTtsText(state.ttsChunkBuffer);
  state.ttsChunkBuffer = "";
}

function flushTtsChunkBuffer() {
  if (!state.ttsSupported || !state.ttsEnabled) {
    state.ttsChunkBuffer = "";
    return;
  }
  if (state.ttsChunkBuffer.trim()) {
    queueTtsText(state.ttsChunkBuffer);
    state.ttsChunkBuffer = "";
  }
}

function queueTtsText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return;
  }
  state.ttsQueue.push(clean);
  pumpTtsQueue();
}

function pumpTtsQueue() {
  if (!state.ttsSupported || !state.ttsEnabled) {
    syncTtsButtons();
    return;
  }
  if (state.ttsSpeaking || !state.ttsQueue.length) {
    syncTtsButtons();
    return;
  }

  const nextChunk = state.ttsQueue.shift();
  pauseRecognitionForTts();
  const utterance = new SpeechSynthesisUtterance(nextChunk);
  if (state.ttsVoice) {
    utterance.voice = state.ttsVoice;
  }
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.onstart = () => {
    state.ttsSpeaking = true;
    syncTtsButtons();
  };
  utterance.onend = () => {
    state.ttsSpeaking = false;
    syncTtsButtons();
    if (!state.ttsQueue.length) {
      resumeRecognitionAfterTts();
    }
    pumpTtsQueue();
  };
  utterance.onerror = () => {
    state.ttsSpeaking = false;
    syncTtsButtons();
    if (!state.ttsQueue.length) {
      resumeRecognitionAfterTts();
    }
    pumpTtsQueue();
  };
  window.speechSynthesis.speak(utterance);
}

function pauseRecognitionForTts() {
  if (!state.voiceArmed || !state.recognitionRunning || state.ttsPausedRecognition) {
    return;
  }
  state.ttsPausedRecognition = true;
  state.shouldRestartRecognition = false;
  setMicStatus("Paused for voice reply");
  setVoiceMode("ROK speaking");
  if (state.recognition) {
    state.recognition.stop();
  }
}

function resumeRecognitionAfterTts() {
  if (!state.ttsPausedRecognition) {
    return;
  }
  state.ttsPausedRecognition = false;
  if (!state.voiceArmed) {
    return;
  }
  state.shouldRestartRecognition = true;
  setMicStatus("Restarting");
  setVoiceMode("Wake listening");
  syncVoicePresence();
  safeStartRecognition();
}

async function sendRokMessage(message, { fromVoice = false } = {}) {
  const trimmed = String(message || "").trim();
  if (!trimmed || state.chatInFlight) {
    return;
  }

  state.chatInFlight = true;
  if (elements.chatSendBtn) {
    elements.chatSendBtn.disabled = true;
    elements.chatSendBtn.textContent = "Thinking...";
  }

  stopTtsPlayback();
  appendChatMessage("user", trimmed);
  const assistantBubble = appendChatMessage("assistant", "", { streaming: true });
  setAssistantResponse(fromVoice ? "ROK is answering out loud." : "ROK is answering.");

  const priorHistory = state.chatHistory.slice(-12);
  let assistantText = "";

  try {
    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: trimmed,
        history: priorHistory,
      }),
    });

    if (!response.ok) {
      let errorMessage = `ROK chat failed (${response.status}).`;
      try {
        const err = await response.json();
        if (err && typeof err.error === "string" && err.error.trim()) {
          errorMessage = err.error.trim();
        }
      } catch (error) {
        // Ignore JSON parse failures and fall back to the generic error.
      }
      updateChatMessage(assistantBubble, errorMessage, { streaming: false });
      setAssistantResponse(errorMessage);
      return;
    }

    if (!response.body) {
      const fallback = "ROK returned an empty response body.";
      updateChatMessage(assistantBubble, fallback, { streaming: false });
      setAssistantResponse(fallback);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    const applyPayload = (rawPayload) => {
      const parsed = extractTokenFromStreamPayload(rawPayload);
      if (parsed.token) {
        assistantText += parsed.token;
        updateChatMessage(assistantBubble, assistantText, { streaming: !parsed.done });
        maybeQueueTtsChunk(parsed.token);
      }
      if (!assistantText && parsed.assistant_content) {
        assistantText = parsed.assistant_content;
        updateChatMessage(assistantBubble, assistantText, { streaming: !parsed.done });
      }
      return parsed.done;
    };

    let streamDone = false;
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
      const lines = pending.split("\n");
      for (const line of lines) {
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

    flushTtsChunkBuffer();
    if (!assistantText.trim()) {
      assistantText = "ROK did not return any text this time.";
    }

    updateChatMessage(assistantBubble, assistantText, { streaming: false });
    setAssistantResponse(fromVoice ? "ROK finished speaking." : "ROK replied.");
    state.chatHistory.push(
      { role: "user", content: trimmed },
      { role: "assistant", content: assistantText }
    );
    state.chatHistory = state.chatHistory.slice(-24);
  } catch (error) {
    const errorMessage = error && error.message ? error.message : "ROK chat failed right now.";
    updateChatMessage(assistantBubble, errorMessage, { streaming: false });
    setAssistantResponse(errorMessage);
  } finally {
    state.chatInFlight = false;
    if (elements.chatSendBtn) {
      elements.chatSendBtn.disabled = false;
      elements.chatSendBtn.textContent = "Send";
    }
    syncTtsButtons();
  }
}

function appendChatMessage(role, text, options = {}) {
  const article = document.createElement("article");
  article.className = `chat-bubble ${role}`;
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
  elements.chatMessages.appendChild(article);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  return article;
}

function updateChatMessage(messageNode, text, options = {}) {
  if (!messageNode) {
    return;
  }
  const body = messageNode.querySelector(".chat-text");
  if (body) {
    body.textContent = text;
  }
  messageNode.classList.toggle("streaming", Boolean(options.streaming));
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function extractTokenFromStreamPayload(payload) {
  const raw = String(payload || "").trim();
  if (!raw) {
    return { token: "", done: false, assistant_content: "" };
  }
  if (raw === "[DONE]") {
    return { token: "", done: true, assistant_content: "" };
  }
  if (raw[0] !== "{") {
    return { token: raw, done: false, assistant_content: "" };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { token: raw, done: false, assistant_content: "" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { token: "", done: false, assistant_content: "" };
  }

  const done = Boolean(parsed.done);
  const assistantContent = typeof parsed.assistant_content === "string" ? parsed.assistant_content : "";

  for (const key of ["token", "response", "reply", "text", "message", "content"]) {
    const value = parsed[key];
    if (typeof value === "string") {
      return { token: value, done, assistant_content: assistantContent };
    }
  }

  if (parsed.message && typeof parsed.message === "object" && typeof parsed.message.content === "string") {
    return { token: parsed.message.content, done, assistant_content: assistantContent };
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
        continue;
      }
      if (choice.delta && typeof choice.delta === "object" && typeof choice.delta.content === "string") {
        joined += choice.delta.content;
        continue;
      }
      if (choice.message && typeof choice.message === "object" && typeof choice.message.content === "string") {
        joined += choice.message.content;
      }
    }
    return { token: joined, done: done || choiceDone, assistant_content: assistantContent };
  }

  return { token: "", done, assistant_content: assistantContent };
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

function formatDistance(meters) {
  const miles = Number(meters) / 1609.344;
  if (miles >= 10) {
    return `${miles.toFixed(0)} mi`;
  }
  if (miles >= 1) {
    return `${miles.toFixed(1)} mi`;
  }
  const feet = Number(meters) * 3.28084;
  return `${Math.round(feet)} ft`;
}

function formatDuration(seconds) {
  const totalMinutes = Math.max(1, Math.round(Number(seconds) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (!hours) {
    return `${totalMinutes} min`;
  }
  if (!minutes) {
    return `${hours} hr`;
  }
  return `${hours} hr ${minutes} min`;
}

function calculateEta(seconds) {
  const arrival = new Date(Date.now() + Number(seconds) * 1000);
  return arrival.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function setAssistantResponse(text) {
  if (elements.assistantResponse) {
    elements.assistantResponse.textContent = text;
  }
}

function setMicStatus(text) {
  if (elements.micStatus) {
    elements.micStatus.textContent = text;
  }
}

function setWakeStatus(text) {
  if (elements.wakeStatus) {
    elements.wakeStatus.textContent = text;
  }
}

function setOriginStatus(text) {
  if (elements.originStatus) {
    elements.originStatus.textContent = text;
  }
}

function setDestinationStatus(text) {
  if (elements.destinationStatus) {
    elements.destinationStatus.textContent = text;
  }
}

function setVoiceMode(text) {
  if (elements.voiceModeBadge) {
    elements.voiceModeBadge.textContent = text;
  }
}
