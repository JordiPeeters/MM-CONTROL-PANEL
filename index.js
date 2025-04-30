const osc = require("osc");
const WebSocket = require("ws");
const express = require("express");
const http = require("http");
const fs = require("fs");
const dgram = require("dgram");
const net = require("net");
const wol = require("wake_on_lan");

const MADMAPPER_1 = { address: "192.168.1.101", port: 8000 };
const MADMAPPER_2 = { address: "192.168.1.102", port: 8000 };

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let banks = [];
let hardware = { computers: [], projectors: [] };

if (fs.existsSync("banks.json")) {
  banks = JSON.parse(fs.readFileSync("banks.json", "utf8"));
}
if (fs.existsSync("hardware.json")) {
  hardware = JSON.parse(fs.readFileSync("hardware.json", "utf8"));
}

app.use(express.static("public"));
app.use(express.json());

const udpClient = dgram.createSocket("udp4");

// UDP Monitor Server (incoming monitoring)
const udpMonitorServer = dgram.createSocket("udp4");
udpMonitorServer.on("message", (msg, rinfo) => {
  console.log(`📥 UDP Monitor from ${rinfo.address}:${rinfo.port} - ${msg}`);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "udpMonitor",
        message: msg.toString(),
        ip: rinfo.address,
        port: rinfo.port
      }));
    }
  });
});
udpMonitorServer.bind(9991); // Listening port for monitor

function sendUDPCommand(ip, message) {
  const buf = Buffer.from(message);
  udpClient.send(buf, 9990, ip, (err) => {
    if (err) console.error("❌ UDP Send error:", err);
    else console.log(`✅ UDP "${message}" sent to ${ip}:9990`);
  });
}

function wakeOnLan(mac) {
  wol.wake(mac, (err) => {
    if (err) console.error("❌ WOL error:", err);
    else console.log(`✅ WOL sent to MAC: ${mac}`);
  });
}

function sendTCPCommand(ip, port, message) {
  const client = new net.Socket();
  client.connect(port, ip, () => {
    console.log(`🔵 TCP Connected to ${ip}:${port}`);
    client.write(message);
    client.end();
  });
  client.on('error', (err) => {
    console.error(`❌ TCP error to ${ip}:${port}:`, err.message);
  });
}

wss.on("connection", (ws) => {
  console.log("🔌 Web client connected");
  ws.send(JSON.stringify({ type: "updateBanks", banks }));
  ws.send(JSON.stringify({ type: "updateHardware", hardware }));

  ws.on("message", (message) => {
    const msg = JSON.parse(message);

    if (msg.type === "selectBank") {
      [MADMAPPER_1, MADMAPPER_2].forEach(target => {
        oscUDP.send({ address: `/bank/select/${msg.bank+1}`, args: [] }, target.address, target.port);
      });
    }

    if (msg.type === "selectScene") {
      [MADMAPPER_1, MADMAPPER_2].forEach(target => {
        oscUDP.send({ address: `/scene/select/${msg.scene+1}`, args: [] }, target.address, target.port);
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
        wakeOnLan(comp.wol);
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
        sendTCPCommand(proj.ip, port, cmd);
      }
    }
  });
});

// OSC
const oscUDP = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 9000,
  metadata: true
});
oscUDP.open();

const oscFeedback = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 9001,
  metadata: true
});
oscFeedback.open();

oscFeedback.on("message", (oscMsg) => {
  console.log("📥 OSC Feedback:", oscMsg.address);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (oscMsg.address.startsWith("/bank/select/")) {
        client.send(JSON.stringify({ type: "bankFeedback", selected: parseInt(oscMsg.address.split("/")[3]) }));
      }
      if (oscMsg.address.startsWith("/scene/select/")) {
        client.send(JSON.stringify({ type: "sceneFeedback", selected: parseInt(oscMsg.address.split("/")[3]) }));
      }
    }
  });
});

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

server.listen(3000, () => {
  console.log("🌐 Server running at http://localhost:3000");
});
