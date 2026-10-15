// A long-running debug bridge. It holds ONE connection to your Brave/Chrome
// (so the browser asks "allow remote debugging?" once) and offers a local CDP
// endpoint that the publisher, tests and tools connect to instead.
// One client at a time; others wait. When a client leaves, its state is cleaned up.
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";

// A connected tool. Its messages wait in buffer until it is the active client.
type Client = WebSocket & { label: string; buffer: string[] | null };
interface CdpMessage { id?: number; method?: string; params?: { sessionId?: string } }

const PORT = Number(process.env.BRIDGE_PORT || 9333);
const PORT_FILES = [
  path.join(os.homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort"),
  path.join(os.homedir(), "Library/Application Support/Google/Chrome/DevToolsActivePort"),
];
const OWN_ID = 1_000_000_000; // ids above this are the bridge's own commands

async function browserEndpoint(): Promise<string> {
  if (process.env.UPSTREAM_CDP) return process.env.UPSTREAM_CDP;
  for (const file of PORT_FILES) {
    const [port, wsPath] = (await readFile(file, "utf8").catch(() => "")).trim().split("\n");
    if (!port || !wsPath) continue;
    const alive = await new Promise<boolean>((r) => {
      const s = net.connect(Number(port), "127.0.0.1", () => { s.end(); r(true); });
      s.on("error", () => r(false));
    });
    if (alive) return `ws://127.0.0.1:${port}${wsPath}`;
  }
  throw new Error("No running Brave or Chrome with remote debugging found.");
}

let upstream: WebSocket | null = null;
let upstreamReady: Promise<WebSocket> | null = null;
let nextOwnId = OWN_ID;
const ownPending = new Map<number, (msg: CdpMessage | null) => void>();

function connectUpstream(): Promise<WebSocket> {
  if (upstreamReady) return upstreamReady;
  upstreamReady = (async () => {
    const url = await browserEndpoint();
    log(`connecting to ${url} (approve the prompt in the browser if it asks)`);
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    log("connected to browser");
    ws.on("message", onUpstream);
    ws.on("close", () => {
      log("browser connection closed");
      upstream = null; upstreamReady = null;
      active?.close(1011, "browser disconnected");
    });
    upstream = ws;
    return ws;
  })().catch((e) => { upstreamReady = null; throw e; });
  return upstreamReady;
}

function own(method: string, params: object = {}, sessionId?: string): Promise<CdpMessage | null> {
  const id = nextOwnId++;
  upstream!.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  return new Promise((resolve) => {
    ownPending.set(id, resolve);
    setTimeout(() => { ownPending.delete(id); resolve(null); }, 5000);
  });
}

let active: Client | null = null; // current client socket
const queue: Client[] = [];         // waiting clients
const sessions = new Set<string>();

function onUpstream(data: RawData) {
  const text = data.toString();
  const msg = JSON.parse(text) as CdpMessage;
  if (msg.id !== undefined && msg.id >= OWN_ID) { ownPending.get(msg.id)?.(msg); ownPending.delete(msg.id); return; }
  const sessionId = msg.params?.sessionId;
  if (msg.method === "Target.attachedToTarget" && sessionId) sessions.add(sessionId);
  if (msg.method === "Target.detachedFromTarget" && sessionId) sessions.delete(sessionId);
  if (active?.readyState === WebSocket.OPEN) active.send(text);
}

// Undo what the client set up, so the browser is left as it was.
async function cleanup() {
  if (!upstream) return;
  await own("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  await own("Target.setDiscoverTargets", { discover: false });
  for (const sessionId of [...sessions]) {
    await own("Runtime.runIfWaitingForDebugger", {}, sessionId);
    await own("Target.detachFromTarget", { sessionId });
  }
  sessions.clear();
}

async function activate(client: Client) {
  active = client;
  try { await connectUpstream(); }
  catch (e) { log(`cannot reach browser: ${(e as Error).message}`); client.close(1011, "browser not reachable"); return; }
  for (const m of client.buffer ?? []) upstream!.send(m);
  client.buffer = null;
  log(`client ${client.label} active`);
}

async function release(client: Client) {
  if (active !== client) { queue.splice(queue.indexOf(client), 1); return; }
  log(`client ${client.label} left`);
  await cleanup();
  active = null;
  const next = queue.shift();
  if (next) await activate(next);
}

let counter = 0;
function log(m: string) { console.log(new Date().toISOString().slice(11, 19), m); }

const server = http.createServer((req, res) => {
  // Playwright and other tools discover the endpoint here.
  if (req.url?.startsWith("/json/version")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ Browser: "siyuan-x-publisher bridge", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/bridge` }));
    return;
  }
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ browserConnected: !!upstream, active: active?.label || null, waiting: queue.length }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 * 1024 });
wss.on("connection", (socket, req) => {
  const client = socket as Client;
  if (req.headers.origin) { client.close(1008, "browser pages may not connect"); return; } // block web pages
  client.label = `#${++counter}`;
  client.buffer = [];
  client.on("message", (data) => {
    const text = data.toString();
    if (client.buffer) client.buffer.push(text);
    else if (active === client && upstream) upstream.send(text);
  });
  client.on("close", () => release(client));
  if (active) { queue.push(client); log(`client ${client.label} waiting`); }
  else activate(client);
});

server.listen(PORT, "127.0.0.1", async () => {
  log(`bridge on http://127.0.0.1:${PORT}`);
  try { await connectUpstream(); } catch (e) { log(`browser not connected yet: ${(e as Error).message}`); }
});
