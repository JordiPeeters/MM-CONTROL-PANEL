const socket = new WebSocket(`ws://${location.hostname}:3000`);

let banks = [];
let hardware = { computers: [], projectors: [] };
let selectedBankIndex = 0;
let lastTriggeredScene = -1;
let sceneCooldown = false;
let isPlaying = true;
let daslightScenes = [];
let activeDaslightIndex = null;

// Turn off ALL computers
function computersUit() {
  if (!confirm("Weet je zeker dat je alle computers wilt uitschakelen?")) return;
  hardware.computers.forEach((_, idx) => {
    socket.send(JSON.stringify({
      type: "executeComputer",
      index: idx,
      action: "shutdown"
    }));
  });
}

// Turn off ALL projectors
function projectorsUit() {
  if (!confirm("Weet je zeker dat je alle projectoren wilt uitschakelen?")) return;
  hardware.projectors.forEach((_, idx) => {
    socket.send(JSON.stringify({
      type: "executeProjector",
      index: idx,
      action: "off"
    }));
  });
}

// Turn off everything
function allesUit() {
  if (!confirm("Weet je zeker dat je alles wilt uitschakelen?")) return;
  hardware.computers.forEach((_, idx) => {
    socket.send(JSON.stringify({
      type: "executeComputer",
      index: idx,
      action: "shutdown"
    }));
  });
  hardware.projectors.forEach((_, idx) => {
    socket.send(JSON.stringify({
      type: "executeProjector",
      index: idx,
      action: "off"
    }));
  });
}

// Turn on ALL computers
function computersAan() {
  hardware.computers.forEach((_, idx) => {
    socket.send(JSON.stringify({
      type: "executeComputer",
      index: idx,
      action: "wake"
    }));
  });
}

// Turn on ALL projectors
function projectorsAan() {
  hardware.projectors.forEach((_, idx) => {
    socket.send(JSON.stringify({
      type: "executeProjector",
      index: idx,
      action: "on"
    }));
  });
}

// Turn on everything
function allesAan() {
  computersAan();
  projectorsAan();
}


// Track feedback for MM1 & MM2
let lastFeedbackTimes = { MM1: 0, MM2: 0 };

// === Logging helpers ===
let userLogs = [];

function logUser(msg) {
  const time = new Date().toLocaleTimeString();
  userLogs.push({ time, msg });
  if (userLogs.length > 50) userLogs.shift();

  const box = document.getElementById("logOutput");
  box.innerHTML = userLogs.map(log => 
    `<p class="log-action">${log.time} – ${log.msg}</p>`
  ).join("");
  box.scrollTop = box.scrollHeight;
}
let oscLogs = [];

function logOSC(msg, type="normal") {
  const box = document.getElementById("oscMonitor");
  const p = document.createElement("p");
  p.className = "osc-" + type;
  p.textContent = `${new Date().toLocaleTimeString()} – ${msg}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

function clearUserLog() {
  userLogs = [];
  document.getElementById("logOutput").innerHTML = "";
}
function clearOSCMonitor() {
  oscLogs = [];
  document.getElementById("oscMonitor").innerHTML = "";
}

// Click tracking for user log
document.addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (btn && btn.id !== "openAdminBtn") logUser(`"${btn.textContent.trim()}" clicked`);
});

// WebSocket incoming
socket.addEventListener("message", ev => {
  const d = JSON.parse(ev.data);

  if (d.type === "udpLog") {
    logUdpMessage(d.message, d.isError);
  }
  if (d.type === "updateBanks") {
    banks = d.banks;
    updateBankDropdown();
    selectBank();
  }
  if (d.type === "bankFeedback") {
    selectedBankIndex = d.selected - 1;
    document.getElementById("bankDropdown").selectedIndex = selectedBankIndex;
    updateBackground();
    updateScenes();
  }
  if (d.type === "sceneFeedback") {
    lastFeedbackTimes.MM1 = lastFeedbackTimes.MM2 = Date.now();
    const sceneName = banks[selectedBankIndex]?.scenes[d.selected - 1]?.name || "";
    document.getElementById("activeSceneLabel").textContent = "Active: " + sceneName;
  }
  if (d.type === "updateHardware") {
    hardware = d.hardware;
    renderHardware();
  }
  if (d.type === "updateDaslightScenes") {
    daslightScenes = d.daslightScenes;
    renderDaslightScenes();
  }  
  if (d.type === "daslightFeedback") {
    const dot = document.querySelector("#status-Daslight .status-dot");
    const lbl = document.querySelector("#status-Daslight .status-label");
    if (d.connected) {
      dot.className = "status-dot green";
      lbl.textContent = "Daslight: Connected";
    } else {
      dot.className = "status-dot red";
      lbl.textContent = "Daslight: Disconnected";
    }
  }
});

socket.addEventListener("message", ev => {
  lastFeedbackTimes.MM1 = Date.now();
  lastFeedbackTimes.MM2 = Date.now();
});

// Status Refresh
setInterval(() => {
  const now = Date.now();
  ["MM1", "MM2"].forEach(key => {
    const dot = document.querySelector(`#status-${key} .status-dot`);
    const lbl = document.querySelector(`#status-${key} .status-label`);
    if (now - lastFeedbackTimes[key] < 6000) {
      dot.className = "status-dot green";
      lbl.textContent = `${key}: Connected`;
    } else {
      dot.className = "status-dot red";
      lbl.textContent = `${key}: Disconnected`;
    }
  });
}, 3000);

// Play/Pause Button
const playPauseBtn = document.getElementById("playPauseBtn");
function updatePlayPauseButton() {
  if (isPlaying) {
    playPauseBtn.innerHTML = `<span class="icon">⏸</span>Pause`;
  } else {
    playPauseBtn.innerHTML = `<span class="icon">▶</span>Play`;
  }
}
updatePlayPauseButton();
playPauseBtn.addEventListener("click", () => {
  if (isPlaying) {
    socket.send(JSON.stringify({ type: "pauseVideo" }));
    logOSC("Sent: /pause", "playpause");
  } else {
    socket.send(JSON.stringify({ type: "playVideo" }));
    logOSC("Sent: /play", "playpause");
  }
  isPlaying = !isPlaying;
  updatePlayPauseButton();
});

// Tabs
function switchTab(id, ev) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  ev.currentTarget.classList.add("active");
}

// Bank & Scene UI
function updateBankDropdown() {
  const dd = document.getElementById("bankDropdown");
  dd.innerHTML = "";
  banks.forEach((b, i) => {
    const option = document.createElement("option");
    option.value = i;
    option.textContent = b.name;
    dd.appendChild(option);
  });
}
function selectBank() {
  selectedBankIndex = +document.getElementById("bankDropdown").value;
  socket.send(JSON.stringify({ type: "selectBank", bank: selectedBankIndex }));
  logOSC(`Sent: /bank/select/${selectedBankIndex + 1}`, "bank");
  updateBackground();
  updateScenes();
}
function updateBackground() {
  let url = banks[selectedBankIndex]?.background || "";
  if (url && !/^https?:\/\//.test(url) && !url.startsWith("/")) {
    url = "/images/" + url;
  }
  document.body.style.background =
    `linear-gradient(rgba(0,0,0,0.5),rgba(0,0,0,0.5)),url(${url})no-repeat center/cover`;
}
function updateScenes() {
  const cont    = document.getElementById("scenesContainer");
  const preview = document.getElementById("previewVideo");
  cont.innerHTML = "";

  (banks[selectedBankIndex]?.scenes || []).forEach((scene, idx) => {
    const btn = document.createElement("button");
    btn.className = "scene-btn";
    btn.textContent = scene.name;

    // Highlight the last triggered scene & handle preview
    if (idx === lastTriggeredScene) {
      btn.classList.add("scene-active");

      if (scene.preview) {
        let src = scene.preview;
        if (!src.startsWith("http") && !src.startsWith("/")) {
          src = "/videos/" + src;
        }
        preview.src = src;
        preview.load();
        preview.play();
      } else {
        preview.removeAttribute("src");
        preview.load();
      }
    }

    btn.addEventListener("click", () => {
      if (sceneCooldown) return;

      lastTriggeredScene = idx;

      // 1) MadMapper OSC — use editable scene.oscCommand
      socket.send(JSON.stringify({
        type:       "selectScene",
        scene:      idx,
        oscCommand: scene.oscCommand
      }));
      logOSC(`Sent: ${scene.oscCommand}`, "scene");

      // 2) Optional Daslight OSC (if linked)
      if (scene.daslightIndex != null) {
        const dlIdx = scene.daslightIndex;
        socket.send(JSON.stringify({
          type:  "daslightScene",
          index: dlIdx
        }));
        const cmd = (daslightScenes[dlIdx] || {}).oscCommand || "<none>";
        logOSC(`Sent Daslight: ${cmd}`, "scene");
      }

      // 3) Optional XR16 Fade over multiple channels
      const dur = parseFloat(scene.fadeDuration);
      if (!isNaN(dur) && dur > 0) {
        // parse comma-separated lists, e.g. "01,02,05"
        const inList  = (scene.fadeInChannels  || "")
                         .split(",")
                         .map(s => s.trim())
                         .filter(s => s);
        const outList = (scene.fadeOutChannels || "")
                         .split(",")
                         .map(s => s.trim())
                         .filter(s => s);
        if (inList.length || outList.length) {
          socket.send(JSON.stringify({
            type:            "fadeChannel",
            fadeInChannels:  inList,
            fadeOutChannels: outList,
            duration:        dur
          }));
          logOSC(
            `Sent XR16 Fade → in=[${inList.join(",")}], out=[${outList.join(",")}], dur=${dur}s`,
            "fade"
          );
        }
      }

      // 4) Flash effect & cooldown
      btn.classList.add("flash");
      setTimeout(() => btn.classList.remove("flash"), 300);

      sceneCooldown = true;
      setTimeout(() => {
        sceneCooldown = false;
        updateScenes();
      }, 2000);
    });

    cont.appendChild(btn);
  });
}


// Hardware UI
function renderHardware() {
  // Computers
  const cc = document.getElementById("computersContainer");
  cc.innerHTML = "<h3>Computers</h3>";
  hardware.computers.forEach((comp, i) => {
    const div = document.createElement("div");
    div.innerHTML = `
      <strong>${comp.name}</strong><br/>
      <button onclick="confirmComputer(${i},'wake')">On</button>
      <button onclick="confirmComputer(${i},'shutdown')">Off</button>
      <button onclick="confirmComputer(${i},'reboot')">Restart</button>
    `;
    cc.appendChild(div);
  });

  // Projectors
  const pc = document.getElementById("projectorsContainer");
  pc.innerHTML = "<h3>Projectors</h3>";
  hardware.projectors.forEach((proj, i) => {
    const div = document.createElement("div");
    div.innerHTML = `
      <strong>${proj.name}</strong><br/>
      <button onclick="confirmProjector(${i},'on')">On</button>
      <button onclick="confirmProjector(${i},'off')">Off</button>
    `;
    pc.appendChild(div);
  });
}

// Individual device actions
function confirmComputer(idx, action) {
  const comp = hardware.computers[idx];
  const verb = action === "wake"
    ? "turn on"
    : action === "shutdown"
      ? "turn off"
      : "reboot";
  if (action !== "wake" &&
      !confirm(`Are you sure you want to ${verb} "${comp.name}"?`)) return;
  socket.send(JSON.stringify({ type: "executeComputer", index: idx, action }));
}

function confirmProjector(idx, action) {
  const proj = hardware.projectors[idx];
  const verb = action === "on" ? "turn on" : "turn off";
  if (action !== "on" &&
      !confirm(`Are you sure you want to ${verb} "${proj.name}"?`)) return;
  socket.send(JSON.stringify({ type: "executeProjector", index: idx, action }));
}

// Open Admin
document.getElementById("openAdminBtn")
  .addEventListener("click", () => window.open("/admin.html", "_blank"));

//UDP Logging
let udpLogs = [];

function logUdpMessage(msg, isError = false) {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = isError ? "log-udp-error" : "log-udp";
  div.textContent = `[${time}] ${msg}`;
  const out = document.getElementById("udpMonitor");
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;

  // Limit to 50 lines
  while (out.children.length > 50) {
    out.removeChild(out.firstChild);
  }
}

function updateUdpMonitor() {
  const out = document.getElementById("udpMonitor");
  out.innerHTML = udpLogs.map(log =>
    `<div class="log-udp">[${log.time}] ${log.message}</div>`
  ).join("");
}

function clearUdpLog() {
  udpLogs = [];
  document.getElementById("udpMonitor").innerHTML = "";
}

function renderDaslightScenes() {
  const container = document.getElementById("daslightScenesContainer");
  const label     = document.getElementById("activeDaslightLabel");
  container.innerHTML = "";

  daslightScenes.forEach((scene, index) => {
    const btn = document.createElement("button");
    btn.className = "scene-btn";
    btn.textContent = scene.name;

    // highlight if active
    if (index === activeDaslightIndex) {
      btn.classList.add("scene-active");
    }

    btn.addEventListener("click", () => {
      // 1) send to server
      socket.send(JSON.stringify({
        type:  "daslightScene",  
        index: index
      }));
      // 2) log it
      logOSC(`Sent Daslight: ${scene.oscCommand}`, "daslight");
      // 3) update local state & UI
      activeDaslightIndex = index;
      renderDaslightScenes();
      label.textContent = "Active: " + scene.name;
    });

    container.appendChild(btn);
  });

  // if nothing selected yet
  if (activeDaslightIndex === null) {
    label.textContent = "Active: None";
  }
}


