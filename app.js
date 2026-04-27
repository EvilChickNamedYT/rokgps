const DEFAULT_VIEW = {
  lat: 40.758,
  lon: -73.9855,
  zoom: 12,
};

const WAKE_REGEX = /\bhey\s+(?:rok|rock|r[\s.-]*o[\s.-]*k)\b/i;
const WAKE_WITH_TRAILING_TEXT_REGEX = /\bhey\s+(?:rok|rock|r[\s.-]*o[\s.-]*k)\b[\s,:-]*(.*)$/i;
const COMMAND_PATTERNS = [
  /give me destination for\s+(.+)/i,
  /destination for\s+(.+)/i,
  /navigate to\s+(.+)/i,
  /take me to\s+(.+)/i,
  /route(?: me)? to\s+(.+)/i,
  /go to\s+(.+)/i,
  /find\s+(.+)/i,
];

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
};

const elements = {
  armVoiceBtn: document.querySelector("#armVoiceBtn"),
  locateBtn: document.querySelector("#locateBtn"),
  listenerBanner: document.querySelector("#listenerBanner"),
  listenerHeadline: document.querySelector("#listenerHeadline"),
  listenerSubtext: document.querySelector("#listenerSubtext"),
  listenerModeText: document.querySelector("#listenerModeText"),
  listenerHint: document.querySelector("#listenerHint"),
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

  elements.destinationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const destination = elements.destinationInput.value.trim();
    if (!destination) {
      setAssistantResponse("Type a destination first, then I can map the route.");
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
      setAssistantResponse('I am listening, but I still need the destination name. Try "take me to JFK Airport".');
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
  const cleanText = text.replace(WAKE_REGEX, "").trim();
  for (const pattern of COMMAND_PATTERNS) {
    const match = cleanText.match(pattern);
    if (match && match[1]) {
      return tidyDestination(match[1]);
    }
  }

  if (options.allowBare && cleanText.length > 2) {
    return tidyDestination(cleanText.replace(/^to\s+/i, ""));
  }

  return "";
}

function tidyDestination(rawDestination) {
  return rawDestination
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  const destination = destinationText.trim();
  if (!destination) {
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

    const response = await fetch(`/api/route?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Route request failed.");
    }

    renderRoute(payload);
    state.waitingForCommand = false;
    clearWaitingTimer();
    setWakeStatus(state.voiceArmed ? "Armed" : "Disarmed");
    setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
    syncVoicePresence();
    setAssistantResponse(`Fastest route ready for ${payload.destination.name}.`);
  } catch (error) {
    setDestinationStatus("Route failed");
    setVoiceMode(state.voiceArmed ? "Wake listening" : "Standby");
    syncVoicePresence();
    setAssistantResponse(error.message || "Routing failed. Try another destination.");
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
  elements.assistantResponse.textContent = text;
}

function setMicStatus(text) {
  elements.micStatus.textContent = text;
}

function setWakeStatus(text) {
  elements.wakeStatus.textContent = text;
}

function setOriginStatus(text) {
  elements.originStatus.textContent = text;
}

function setDestinationStatus(text) {
  elements.destinationStatus.textContent = text;
}

function setVoiceMode(text) {
  elements.voiceModeBadge.textContent = text;
}
