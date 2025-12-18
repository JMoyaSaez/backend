import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Battleship WS server running\n");
});

const wss = new WebSocketServer({ server });

/**
 * Rooms structure:
 * rooms[roomId] = {
 *   players: [ { ws, id, ready, grid, ships }, { ... } ],
 *   turn: 0|1,
 *   started: bool
 * }
 */
const rooms = new Map();

const SIZE = 10;
const SHIP_SIZES = [5, 4, 3, 3, 2];

function makeRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const p of room.players) safeSend(p.ws, obj);
}

function otherIndex(i) {
  return i === 0 ? 1 : 0;
}

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

/**
 * grid values:
 * 0 empty
 * 1 ship (hidden to opponent)
 * 2 miss
 * 3 hit
 */
function validatePlacement(placement) {
  // placement = { ships: [{cells:[{x,y}], size, dir}] } etc
  // For MVP: accept server-side checks: correct ship sizes, no overlap, in bounds, straight line
  if (!placement || !Array.isArray(placement.ships)) return { ok: false, err: "Bad placement format" };

  const ships = placement.ships;

  const sizes = ships.map(s => s.cells?.length).sort((a,b)=>a-b);
  const expected = [...SHIP_SIZES].sort((a,b)=>a-b);
  if (sizes.length !== expected.length) return { ok: false, err: "Wrong ship count" };
  for (let i=0;i<expected.length;i++) if (sizes[i] !== expected[i]) return { ok: false, err: "Wrong ship sizes" };

  const grid = emptyGrid();

  for (const ship of ships) {
    const cells = ship.cells;
    if (!Array.isArray(cells) || cells.length < 2) return { ok: false, err: "Invalid ship cells" };

    for (const c of cells) {
      if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) return { ok: false, err: "Invalid coords" };
      if (c.x < 0 || c.x >= SIZE || c.y < 0 || c.y >= SIZE) return { ok: false, err: "Out of bounds" };
      if (grid[c.y][c.x] === 1) return { ok: false, err: "Overlapping ships" };
    }

    // straight line check
    const allX = new Set(cells.map(c => c.x));
    const allY = new Set(cells.map(c => c.y));
    const isHoriz = allY.size === 1 && allX.size === cells.length;
    const isVert = allX.size === 1 && allY.size === cells.length;
    if (!isHoriz && !isVert) return { ok: false, err: "Ship must be straight" };

    // contiguous check
    if (isHoriz) {
      const y = cells[0].y;
      const xs = cells.map(c => c.x).sort((a,b)=>a-b);
      for (let i=1;i<xs.length;i++) if (xs[i] !== xs[i-1] + 1) return { ok: false, err: "Ship cells must be contiguous" };
      for (const x of xs) grid[y][x] = 1;
    } else {
      const x = cells[0].x;
      const ys = cells.map(c => c.y).sort((a,b)=>a-b);
      for (let i=1;i<ys.length;i++) if (ys[i] !== ys[i-1] + 1) return { ok: false, err: "Ship cells must be contiguous" };
      for (const y of ys) grid[y][x] = 1;
    }
  }

  return { ok: true, grid, ships };
}

function computeSunk(grid, shipCells) {
  // sunk if all ship cells are hit (3)
  return shipCells.every(c => grid[c.y][c.x] === 3);
}

function allShipsSunk(grid, ships) {
  return ships.every(s => computeSunk(grid, s.cells));
}

wss.on("connection", (ws) => {
  const clientId = crypto.randomUUID();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return safeSend(ws, { type: "error", message: "Invalid JSON" }); }

    if (!msg.type) return;

    // Find room/player if already joined
    let room = null, pIndex = -1;
    for (const [rid, r] of rooms.entries()) {
      const idx = r.players.findIndex(p => p.ws === ws);
      if (idx !== -1) { room = r; pIndex = idx; break; }
    }

    switch (msg.type) {
      case "create_room": {
        const roomId = makeRoomId();
        rooms.set(roomId, {
          players: [{ ws, id: clientId, ready: false, grid: null, ships: null }],
          turn: 0,
          started: false
        });
        safeSend(ws, { type: "room_created", roomId, player: 1 });
        break;
      }

      case "join_room": {
        const roomId = String(msg.roomId || "").trim().toUpperCase();
        const r = rooms.get(roomId);
        if (!r) return safeSend(ws, { type: "error", message: "Room not found" });
        if (r.players.length >= 2) return safeSend(ws, { type: "error", message: "Room full" });

        r.players.push({ ws, id: clientId, ready: false, grid: null, ships: null });

        // notify both
        safeSend(r.players[0].ws, { type: "player_joined", player: 2 });
        safeSend(r.players[1].ws, { type: "room_joined", roomId, player: 2 });

        // tell both waiting for placement
        broadcast(r, { type: "status", message: "Both players connected. Place ships and press READY." });
        break;
      }

      case "place_ready": {
        if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
        if (room.players.length < 2) return safeSend(ws, { type: "error", message: "Waiting for opponent" });

        const v = validatePlacement(msg.placement);
        if (!v.ok) return safeSend(ws, { type: "error", message: `Placement invalid: ${v.err}` });

        room.players[pIndex].ready = true;
        room.players[pIndex].grid = v.grid;
        room.players[pIndex].ships = v.ships;

        safeSend(ws, { type: "ready_ok" });
        broadcast(room, { type: "status", message: `Player ${pIndex + 1} is READY.` });

        // start if both ready
        if (room.players[0].ready && room.players[1].ready && !room.started) {
          room.started = true;
          room.turn = 0; // player 1 starts
          broadcast(room, { type: "game_start", turnPlayer: room.turn + 1 });
        }
        break;
      }

      case "shot": {
        if (!room || !room.started) return safeSend(ws, { type: "error", message: "Game not started" });
        if (pIndex !== room.turn) return safeSend(ws, { type: "error", message: "Not your turn" });

        const x = msg.x, y = msg.y;
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
          return safeSend(ws, { type: "error", message: "Invalid shot coords" });
        }

        const defender = room.players[otherIndex(pIndex)];
        const attacker = room.players[pIndex];

        const cell = defender.grid[y][x];
        if (cell === 2 || cell === 3) {
          return safeSend(ws, { type: "error", message: "Already shot there" });
        }

        let hit = false;
        if (cell === 1) {
          hit = true;
          defender.grid[y][x] = 3;
        } else {
          defender.grid[y][x] = 2;
        }

        // find if sunk
        let sunk = false;
        let sunkSize = null;

        if (hit) {
          for (const ship of defender.ships) {
            const hasCell = ship.cells.some(c => c.x === x && c.y === y);
            if (hasCell) {
              sunk = computeSunk(defender.grid, ship.cells);
              if (sunk) sunkSize = ship.cells.length;
              break;
            }
          }
        }

        // win?
        const win = allShipsSunk(defender.grid, defender.ships);

        // Inform attacker: result at (x,y)
        safeSend(attacker.ws, { type: "shot_result", x, y, hit, sunk, sunkSize, win });

        // Inform defender: got shot
        safeSend(defender.ws, { type: "got_shot", x, y, hit, sunk, sunkSize, lose: win });

        if (win) {
          broadcast(room, { type: "game_over", winner: pIndex + 1 });
          break;
        }

        // Switch turn on miss only (classic rules). If you prefer switch always, change here.
        if (!hit) room.turn = otherIndex(room.turn);

        broadcast(room, { type: "turn", turnPlayer: room.turn + 1 });
        break;
      }

      default:
        safeSend(ws, { type: "error", message: "Unknown message type" });
    }
  });

  ws.on("close", () => {
    // Remove player from room; if empty, delete room
    for (const [rid, r] of rooms.entries()) {
      const idx = r.players.findIndex(p => p.ws === ws);
      if (idx !== -1) {
        r.players.splice(idx, 1);
        if (r.players.length === 0) rooms.delete(rid);
        else broadcast(r, { type: "status", message: "Opponent disconnected." });
        break;
      }
    }
  });

  safeSend(ws, { type: "hello", message: "Connected to Battleship server." });
});

server.listen(PORT, () => {
  console.log(`WS server listening on :${PORT}`);
});
