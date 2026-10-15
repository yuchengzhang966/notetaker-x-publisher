// A stand-in for the Notion API, for testing the Notion source without a real workspace.
// node test/notion/mock-api.ts [port]   then   NOTION_API=http://127.0.0.1:<port>/v1 NOTION_TOKEN=test ...
// Serves one page (ID below) with sample-page.md as its Markdown. PATCH requests are printed.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] || 8790);
const ID = "0123abcd-0123-4567-89ab-0123456789ab";
const BOOKMARK = "11112222-3333-4444-5555-666677778888";
const HERE = import.meta.dirname;
const BASE = `http://127.0.0.1:${PORT}`;
const png = readFileSync(path.join(HERE, "..", "vault", "cover.png"));

const page = {
  object: "page", id: ID, url: `https://www.notion.so/Launch-Notes-${ID.replace(/-/g, "")}`,
  cover: { type: "file", file: { url: `${BASE}/files/cover.png?X-Amz-Signature=1`, expiry_time: "2026-10-15T10:00:00Z" } },
  properties: {
    Name: { id: "title", type: "title", title: [{ plain_text: "Launch Notes" }] },
    "X Status": { id: "a", type: "select", select: null },
    "X Draft URL": { id: "b", type: "url", url: null },
  },
};

http.createServer((req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const url = req.url || "";
  if (url.startsWith("/files/")) { res.writeHead(200, { "Content-Type": "image/png" }); res.end(png); return; }
  if (req.headers.authorization !== "Bearer test") return send(401, { code: "unauthorized", message: "API token is invalid." });
  if (!req.headers["notion-version"]) return send(400, { code: "missing_version", message: "Notion-Version header missing" });
  if (req.method === "PATCH") {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => { console.log("PATCH", url, body); send(200, page); });
    return;
  }
  if (url === `/v1/pages/${ID}`) return send(200, page);
  if (url === `/v1/pages/${ID}/markdown`) {
    const markdown = readFileSync(path.join(HERE, "sample-page.md"), "utf8")
      .replace(/https:\/\/prod-files-secure[^)\s]+/, `${BASE}/files/image.png?X-Amz-Signature=2`);
    return send(200, { object: "page_markdown", id: ID, markdown, truncated: false, unknown_block_ids: [BOOKMARK] });
  }
  if (url === `/v1/blocks/${BOOKMARK}`) return send(200, { object: "block", id: BOOKMARK, type: "bookmark", bookmark: { url: "https://x.com/jack/status/21", caption: [] } });
  send(404, { code: "object_not_found", message: `Could not find ${url}` });
}).listen(PORT, "127.0.0.1", () => console.log(`mock Notion API on ${BASE}/v1`));
