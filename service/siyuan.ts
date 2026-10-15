// SiYuan side: read a document as clean HTML segments and store draft status on it.
import { convert } from "./convert.ts";
import type { Article, StatusFields } from "./types.ts";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const API = process.env.SIYUAN_API || "http://127.0.0.1:6806/api";
const WORKSPACE = process.env.SIYUAN_WORKSPACE || path.join(os.homedir(), "SiYuan");
const TOKEN = process.env.SIYUAN_TOKEN || "";

export async function api<T = any>(endpoint: string, body: object = {}): Promise<T> {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN && { Authorization: `Token ${TOKEN}` }) },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { code: number; msg: string; data: T };
  if (data.code !== 0) throw new Error(`SiYuan ${endpoint}: ${data.msg}`);
  return data.data;
}

// Remove the leading H1 when it repeats the document title (the title becomes the article title).
export function stripTitle(md: string, title: string): string {
  const h1 = md.match(/^\s*#\s+(.+)\n/);
  return h1 && h1[1].trim() === title.trim() ? md.slice(h1[0].length) : md;
}

export function assetPath(src: string): string | null {
  const rel = decodeURIComponent(src.split("?")[0]);
  if (!rel.startsWith("assets/")) return null;
  const file = path.join(WORKSPACE, "data", rel);
  return existsSync(file) ? file : null;
}

export async function loadArticle(id: string): Promise<Article> {
  const [row] = await api<{ id: string; content: string; type: string }[]>("query/sql", { stmt: `select id, content, type from blocks where id='${id.replace(/[^\w-]/g, "")}'` });
  if (!row) throw new Error(`No SiYuan block with id ${id}`);
  if (row.type !== "d") throw new Error(`Block ${id} is not a document`);
  const attrs = await api<Record<string, string>>("attr/getBlockAttrs", { id });
  // refMode 3: a block reference becomes its anchor text. embedMode 0: embeds show the original content.
  const { content } = await api<{ content: string }>("export/exportMdContent", { id, refMode: 3, embedMode: 0, yfm: false });
  const title = row.content;
  const markdown = stripTitle(content, title);
  const { segments, report } = convert(markdown, { resolveAsset: assetPath });
  const coverSrc = attrs["custom-x-cover"] || null;
  const cover = coverSrc ? { src: coverSrc, file: assetPath(coverSrc) } : null;
  const missing = [...segments.filter((s) => s.type === "image"), ...(cover ? [cover] : [])].filter((s) => !s.file);
  return { id, source: "siyuan", title, markdown, segments, report, cover, missing, status: attrs["custom-x-status"] || "" };
}

export async function setStatus(id: string, fields: StatusFields): Promise<void> {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) attrs[`custom-x-${k}`] = v == null ? "" : String(v);
  attrs["custom-x-updated-at"] = new Date().toISOString();
  await api("attr/setBlockAttrs", { id, attrs });
}
