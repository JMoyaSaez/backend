import http from "http";
import { WebSocketServer } from "ws";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hundir WS backend OK\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", message: "WS conectado" }));

  ws.on("message", (raw) => {
    // aquí irá tu lógica (rooms, turnos, disparos, etc.)
    ws.send(JSON.stringify({ type: "echo", raw: raw.toString() }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("WS listening on", PORT);
});
