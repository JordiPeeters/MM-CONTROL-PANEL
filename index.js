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
      console.error("❌ UDP Send error:", err);
    } else {
      const log = `[SEND] ${message} → ${ip}:9990`;
      console.log("📤", log);
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
      console.error("❌ WOL error:", err);
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
        const net = require("net");
        const client = new net.Socket();
        client.connect(port, proj.ip, () => {
          client.write(cmd);
          client.end();
        });
    
        client.on("error", (e) => {
          console.error("❌ TCP Error:", e.message);
          broadcastLog("udpLog", `TCP ERROR: ${e.message}`, true);
        });
      }
    }
     
    
  });
});

//UDP Server
const udpServer = dgram.createSocket("udp4");
udpServer.on("message", (msg, rinfo) => {
  const text = msg.toString();
  console.log(`📨 UDP: ${text} from ${rinfo.address}:${rinfo.port}`);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "udpLog",
        time: new Date().toLocaleTimeString(),
        message: `${text} from ${rinfo.address}`
      }));
    }
  });
});
udpServer.bind(9990);



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
