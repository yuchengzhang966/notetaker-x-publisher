// Local HTTP service for note-app plugins (SiYuan, or any app). Loopback only; browser origins must be allowed.
// POST /preview and POST /draft with body { ref } (any source ref, see sources.ts; { id } is the same).
// There is no publish route: the user publishes the draft in X.
import http, { type ServerResponse } from "node:http";
import { createDraft } from "./draft.ts";
import { sourceFor, type Source } from "./sources.ts";
import type { StopError } from "./x.ts";

const PORT = Number(process.env.PUBLISHER_PORT || 6830);
// SiYuan by default. Add other apps' origins (for example app://obsidian.md) in PUBLISHER_ORIGINS, comma-separated.
const ALLOWED = new Set(["http://127.0.0.1:6806", "http://localhost:6806", "app://.",
  ...(process.env.PUBLISHER_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)]);

function send(res: ServerResponse, origin: string, code: number, body: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    ...(ALLOWED.has(origin) && {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, X-Publisher",
      "Access-Control-Allow-Methods": "GET, POST",
    }),
  });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  // Block other web pages in your browser from starting a job.
  if (origin && !ALLOWED.has(origin)) return send(res, origin, 403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") return send(res, origin, 204, {});
  if (req.method === "GET" && req.url === "/health") return send(res, origin, 200, { ok: true });
  if (req.method !== "POST" || req.headers["x-publisher"] !== "1" || !["/preview", "/draft"].includes(req.url || "")) {
    return send(res, origin, 404, { error: "not found" });
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let input: { ref?: string; id?: string };
  try { input = JSON.parse(body || "{}"); } catch { return send(res, origin, 400, { error: "invalid JSON" }); }
  const ref = String(input.ref ?? input.id ?? "");
  let source: Source;
  try {
    if (ref === "-") throw new Error("stdin is for the command line only");
    source = sourceFor(ref);
  } catch (err) { return send(res, origin, 400, { error: (err as Error).message }); }

  try {
    if (req.url === "/preview") {
      const a = await source.load((m: string) => console.log(`[${ref}] ${m}`));
      return send(res, origin, 200, { title: a.title, report: a.report, segments: a.segments, cover: a.cover, missing: a.missing });
    }
    if (req.url === "/draft") {
      const result = await createDraft(ref, { log: (m: string) => console.log(`[${ref}] ${m}`) });
      return send(res, origin, 200, result);
    }
  } catch (e) {
    const err = e as StopError;
    console.error(`[${ref}]`, err.code || "", err.message);
    send(res, origin, err.code === "busy" ? 409 : 500, { error: err.message, code: err.code || "error" });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`notetaker-x-publisher on http://127.0.0.1:${PORT}`));
