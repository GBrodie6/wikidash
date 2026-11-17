// Socket plumbing: join, reconnect with backoff, keepalive, and a small outbox
// so tab-leave reports sent while the socket is down still arrive.

const PING = "__ping";
const PONG = "__pong";

export function playerId() {
  const k = "wd:pid";
  let id = localStorage.getItem(k);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    id = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
    localStorage.setItem(k, id);
  }
  return id;
}

let socket = null;
let retry = 0;
let handlers = null;
let room = "";
let outbox = [];
let getName = () => "";

export function connect(code, nameFn, h) {
  room = code;
  handlers = h;
  getName = nameFn;
  open();
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(PING);
  }, 25000);
}

function open() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(room)}`);
  socket.addEventListener("open", () => {
    retry = 0;
    handlers.onConn("online");
    raw({ type: "join", playerId: playerId() });
    const name = getName();
    if (name) raw({ type: "action", action: { kind: "hello", name } });
    const queued = outbox;
    outbox = [];
    for (const a of queued) raw({ type: "action", action: a });
  });
  socket.addEventListener("message", (e) => {
    if (e.data === PONG) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "state") handlers.onState(msg);
    else if (msg.type === "say") handlers.onSay?.(msg);
    else if (msg.type === "error") handlers.onError(msg.error);
  });
  socket.addEventListener("close", () => {
    retry = Math.min(retry + 1, 5);
    handlers.onConn("offline");
    setTimeout(open, 400 * 2 ** (retry - 1));
  });
}

function raw(msg) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/** Send a game action. Leave reports are queued if the socket is down. */
export function act(action) {
  if (raw({ type: "action", action })) return true;
  if (action.kind === "left") outbox.push(action);
  return false;
}

export function isOnline() {
  return socket?.readyState === WebSocket.OPEN;
}
