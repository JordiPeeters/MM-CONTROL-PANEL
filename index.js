// index.js
const osc = require("osc");
const WebSocket = require("ws");
const express = require("express");
const http = require("http");
const fs = require("fs");
const dgram = require("dgram");
const net = require("net");
const wol = require("wake_on_lan");
const DASLIGHT_FILE = "daslight.json";

const MADMAPPER_1 = { address: "192.168.3.101", port: 8000 };
const MADMAPPER_2 = { address: "192.168.3.102", port: 8000 };
const DASLIGHT     = { address: "10.0.0.120",   port: 8080 };
const XR16         = { address: "192.168.0.100", port: 10024 };

// ——— Daslight OSC port ———
const oscDaslight = new osc.UDPPort({
  localAddress:  "0.0.0.0",
  localPort:     0,                // pick any free port
  remoteAddress: DASLIGHT.address, // 10.0.0.120
  remotePort:    DASLIGHT.port,    // 8080
  metadata:      true              // must be true for enveloped OSC
});
oscDaslight
  .on("ready", () => {
    console.log(`OSC→Daslight ready → ${DASLIGHT.address}:${DASLIGHT.port}`);
  })
  .on("error", err => {
    console.error("OSC→Daslight error:", err.message);
  })
  .open();

// ——— XR16 OSC port ———
const oscXr16 = new osc.UDPPort({
  localAddress:  "0.0.0.0",
  localPort:     0,               // any free port
  remoteAddress: XR16.address,    // your XR16’s IP
  remotePort:    XR16.port,       // default XR16 OSC port (10024)
  metadata:      true
});
oscXr16
  .on("ready", () => {
    console.log(`OSC→XR16 ready → ${XR16.address}:${XR16.port}`);
  })
  .on("error", err => {
    console.error("OSC→XR16 error:", err.message);
  })
  .open();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let banks = [];
let hardware = { computers: [], projectors: [] };
let daslightScenes = [];
let daslightConnected = false;

if (fs.existsSync(DASLIGHT_FILE)) {
  try {
    daslightScenes = JSON.parse(fs.readFileSync(DASLIGHT_FILE, "utf8"));
    console.log(`Loaded ${daslightScenes.length} Daslight scenes from ${DASLIGHT_FILE}`);
  } catch (e) {
    console.error("Error parsing Daslight JSON:", e);
  }
}
if (fs.existsSync("banks.json")) {
  banks = JSON.parse(fs.readFileSync("banks.json", "utf8"));
}
if (fs.existsSync("hardware.json")) {
  hardware = JSON.parse(fs.readFileSync("hardware.json", "utf8"));
}

app.use(express.static("public"));
app.use(express.json());

const udpClient = dgram.createSocket("udp4");

// UDP Monitor Server
const udpMonitorServer = dgram.createSocket("udp4");
udpMonitorServer.on("message", (msg, rinfo) => {
  console.log(`UDP Monitor from ${rinfo.address}:${rinfo.port} - ${msg}`);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type:    "udpMonitor",
        message: msg.toString(),
        ip:      rinfo.address,
        port:    rinfo.port
      }));
    }
  });
});
udpMonitorServer.bind(9991); // Listening port for monitor

function broadcastLog(type, message, isError = false) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type,
        message,
        isError
      }));
    }
  });
}

function sendUDPCommand(ip, message) {
  const buf = Buffer.from(message);
  udpClient.send(buf, 9990, ip, (err) => {
    const time = new Date().toLocaleTimeString();
    if (err) {
      console.error("UDP Send error:", err);
    } else {
      const log = `[SEND] ${message} → ${ip}:9990`;
      console.log("", log);
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "udpLog", message: log }));
        }
      });
    }
  });
}

function wakeOnLan(mac) {
  wol.wake(mac, (err) => {
    const time = new Date().toLocaleTimeString();
    if (err) {
      console.error("WOL error:", err);
    } else {
      const log = `[WOL] Wake-on-LAN → ${mac}`;
      console.log("🔆", log);
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "udpLog", message: log }));
        }
      });
    }
  });
}

function sendTCPCommand(ip, port, message) {
  const client = new net.Socket();
  client.connect(port, ip, () => {
    console.log(`TCP Connected to ${ip}:${port}`);
    client.write(message);
    client.end();
  });
  client.on('error', (err) => {
    console.error(`TCP error to ${ip}:${port}:`, err.message);
  });
}

// Broadcast Daslight status to all clients
function updateDaslightStatus(isUp) {
  if (daslightConnected === isUp) return;
  daslightConnected = isUp;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type:      "daslightFeedback",
        connected: isUp
      }));
    }
  });
}

// Try TCP connect to Daslight’s OSC port every 5s
function checkDaslight() {
  const sock = new net.Socket();
  let done = false;
  const timeout = setTimeout(() => {
    if (done) return;
    done = true;
    sock.destroy();
    updateDaslightStatus(false);
  }, 2000);

  sock.connect(DASLIGHT.port, DASLIGHT.address, () => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    sock.destroy();
    updateDaslightStatus(true);
  });

  sock.on("error", () => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    updateDaslightStatus(false);
  });
}
setInterval(checkDaslight, 5000);
checkDaslight();

wss.on("connection", (ws) => {
  console.log("Web client connected");
  ws.send(JSON.stringify({ type: "updateBanks", banks }));
  ws.send(JSON.stringify({ type: "updateHardware", hardware }));
  ws.send(JSON.stringify({ type: "updateDaslightScenes", daslightScenes }));
  ws.send(JSON.stringify({ type: "daslightFeedback", connected: daslightConnected }));

  ws.on("message", (message) => {
    const msg = JSON.parse(message);

    if (msg.type === "selectBank") {
      [MADMAPPER_1, MADMAPPER_2].forEach(target => {
        oscUDP.send(
          { address: `/bank/select/${msg.bank+1}`, args: [] },
          target.address,
          target.port
        );
      });
    }

    if (msg.type === "selectScene") {
      const cmd = msg.oscCommand || `/scene/select/${msg.scene+1}`;
      [MADMAPPER_1, MADMAPPER_2].forEach(target => {
        oscUDP.send(
          { address: cmd, args: [] },
          target.address,
          target.port
        );
      });
    }

    if (msg.type === "playVideo") {
      [MADMAPPER_1, MADMAPPER_2].forEach(target => {
        oscUDP.send({ address: "/play", args: [] }, target.address, target.port);
      });
    }

    if (msg.type === "pauseVideo") {
      [MADMAPPER_1, MADMAPPER_2].forEach(target => {
        oscUDP.send({ address: "/pause", args: [] }, target.address, target.port);
      });
    }

    if (msg.type === "executeComputer") {
      const comp = hardware.computers[msg.index];
      if (!comp) return;
      if (msg.action === "wake") {
        if (comp.wol && comp.wol.trim()) {
          wakeOnLan(comp.wol);
        } else {
          const warn = `Cannot wake "${comp.name}": no MAC address configured.`;
          console.warn(warn);
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type:    "udpLog",
                message: warn,
                level:   "log-udp-error"
              }));
            }
          });
        }
      } else if (msg.action === "shutdown") {
        sendUDPCommand(comp.ip, comp.shutdown || "SHUTDOWN");
      } else if (msg.action === "reboot") {
        sendUDPCommand(comp.ip, comp.reboot || "REBOOT");
      }
    }

    if (msg.type === "executeProjector") {
      const proj = hardware.projectors[msg.index];
      if (!proj) return;
      const cmd = msg.action === "on" ? proj.onCmd : proj.offCmd;
      const port = proj.port || 4352;
      if (cmd && proj.ip) {
        const client = new net.Socket();
        client.connect(port, proj.ip, () => {
          client.write(cmd);
          client.end();
        });
        client.on("error", (e) => {
          console.error("TCP Error:", e.message);
          broadcastLog("udpLog", `TCP ERROR: ${e.message}`, true);
        });
      }
    }

    // —— Daslight scene trigger ——
    if (msg.type === "daslightScene") {
      const s = daslightScenes[msg.index];
      if (!s || !s.oscCommand) {
        console.warn("Invalid Daslight scene at index", msg.index);
        return;
      }
      // send a dummy int (1) so Daslight sees a valid OSC payload
      oscDaslight.send({
        address: s.oscCommand,
        args: [
          {
            type:  "i",   // integer tag
            value: 1      // dummy value = 1
          }
        ]
      });
      console.log("OSC→Daslight:", s.oscCommand, "→ 1");
    }

    // —— XR16 “fadeChannel” handler (loop through multiple channels) ——
    if (msg.type === "fadeChannel") {
      const inList  = Array.isArray(msg.fadeInChannels)  ? msg.fadeInChannels  : [];
      const outList = Array.isArray(msg.fadeOutChannels) ? msg.fadeOutChannels : [];
      const dur     = parseFloat(msg.duration);

      // If no channels or bad duration, skip
      if ((inList.length === 0 && outList.length === 0) || isNaN(dur) || dur <= 0) {
        console.warn("fadeChannel: missing/invalid data:", msg);
        return;
      }

      // Helper: zero-pad a number to two digits
      const pad2 = n => String(n).padStart(2,"0");

      // Fade‐IN each channel in inList
      inList.forEach(chStr => {
        const idx = parseInt(chStr, 10);
        if (!isNaN(idx)) {
          const channel   = pad2(idx);
          const address   = `/ch/${channel}/mix/fader_seek`;
          const fadeTimeMs = Math.round(dur * 1000);

          oscXr16.send({
            address: address,
            args: [
              { type: "f", value: 1.0 },      // fade up to 1.0
              { type: "i", value: fadeTimeMs } // over fadeTimeMs ms
            ]
          });
          console.log(`XR16 Fade IN → ${address} → (1.0 over ${fadeTimeMs}ms)`);
        }
      });

      // Fade‐OUT each channel in outList
      outList.forEach(chStr => {
        const idx = parseInt(chStr, 10);
        if (!isNaN(idx)) {
          const channel   = pad2(idx);
          const address   = `/ch/${channel}/mix/fader_seek`;
          const fadeTimeMs = Math.round(dur * 1000);

          oscXr16.send({
            address: address,
            args: [
              { type: "f", value: 0.0 },      // fade down to 0.0
              { type: "i", value: fadeTimeMs } // over fadeTimeMs ms
            ]
          });
          console.log(`XR16 Fade OUT → ${address} → (0.0 over ${fadeTimeMs}ms)`);
        }
      });
    }

  });
});

// UDP Server
const udpServer = dgram.createSocket("udp4");
udpServer.on("message", (msg, rinfo) => {
  const text = msg.toString();
  console.log(`UDP: ${text} from ${rinfo.address}:${rinfo.port}`);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type:    "udpLog",
        time:    new Date().toLocaleTimeString(),
        message: `${text} from ${rinfo.address}`
      }));
    }
  });
});
udpServer.bind(9990);

// OSC MadMapper & Feedback
const oscUDP = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort:    9000,
  metadata:     true
});
oscUDP.open();
oscUDP.on("error", err => {
  console.error("OSC→MadMapper error:", err.message);
});

const oscFeedback = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort:    9001,
  metadata:     true
});
oscFeedback.open();
oscFeedback.on("error", err => {
  console.error("OSC‐Feedback error:", err.message);
});
oscFeedback.on("message", (oscMsg) => {
  console.log("OSC Feedback:", oscMsg.address);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (oscMsg.address.startsWith("/bank/select/")) {
        client.send(JSON.stringify({
          type:     "bankFeedback",
          selected: parseInt(oscMsg.address.split("/")[3])
        }));
      }
      if (oscMsg.address.startsWith("/scene/select/")) {
        client.send(JSON.stringify({
          type:     "sceneFeedback",
          selected: parseInt(oscMsg.address.split("/")[3])
        }));
      }
    }
  });
});

// HTTP Endpoints
app.post("/api/banks", (req, res) => {
  banks = req.body;
  fs.writeFileSync("banks.json", JSON.stringify(banks, null, 2), "utf8");
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "updateBanks", banks }));
    }
  });
  res.json({ success: true });
});

app.post("/api/hardware", (req, res) => {
  hardware = req.body;
  fs.writeFileSync("hardware.json", JSON.stringify(hardware, null, 2), "utf8");
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "updateHardware", hardware }));
    }
  });
  res.json({ success: true });
});

app.post("/api/daslight", (req, res) => {
  daslightScenes = req.body;
  fs.writeFileSync(DASLIGHT_FILE, JSON.stringify(daslightScenes, null, 2), "utf8");
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type:           "updateDaslightScenes",
        daslightScenes
      }));
    }
  });
  res.json({ success: true });
});

server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
