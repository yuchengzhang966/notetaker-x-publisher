// Plain Markdown file side: read a .md file as segments and store draft status in its front matter.
// Works with any Markdown folder, including Obsidian vaults (![[embeds]], [[links]]).
import { convert } from "./convert.ts";
import type { Article, Log, StatusFields } from "./types.ts";

// Article fields that a source sets itself (id, source).
export type LoadedMarkdown = Omit<Article, "id" | "source">;

export interface MarkdownOptions {
  dir?: string;
  title?: string;
  cover?: string;
  status?: string;
  fallbackTitle?: string;
  frontMatter?: boolean;
  log?: Log;
}
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE = path.resolve(import.meta.dirname, "..", ".cache", "remote");
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function isMarkdownFile(ref: string): boolean {
  return /\.(md|markdown)$/i.test(ref);
}

// Simple "key: value" front matter. Nested YAML is kept in the file but not read.
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.match(FM);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { data, body: text.slice(m[0].length) };
}

// Find a file by name under the vault root (the folder with .obsidian), else under the note's folder.
function vaultRoot(dir: string): string {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, ".obsidian"))) return d;
  return dir;
}

function findByName(root: string, name: string, depth = 0): string | null {
  if (depth > 8) return null;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(root, e.name);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const hit = findByName(path.join(root, e.name), name, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Obsidian syntax to standard Markdown: ![[img.png|alt]] -> ![alt](<path>), [[Note|text]] -> text.
function obsidianToMarkdown(md: string, dir: string, note: (key: string, text: string) => void): string {
  const root = vaultRoot(dir);
  let out = md.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (all, name: string, alt: string | undefined) => {
    const file = existsSync(path.resolve(dir, name)) ? path.resolve(dir, name) : findByName(root, path.basename(name));
    if (!file) return all; // left as text; reported as missing below if it looks like an image
    note("obsidian-embed", "Obsidian embeds ![[...]] became images");
    const rel = path.relative(dir, file).split(path.sep).map(encodeURIComponent).join("/");
    return `![${/^\d+(x\d+)?$/.test(alt || "") ? "" : alt || ""}](${rel})`;
  });
  out = out.replace(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target: string, text: string | undefined) => {
    note("wikilink", "Wiki links [[...]] became plain text");
    return text || target.split("#")[0];
  });
  return out;
}

// Remote images are downloaded once into .cache/remote so X can upload them.
async function fetchRemoteImages(md: string, log: Log): Promise<Map<string, string>> {
  const urls = [...md.matchAll(/!\[[^\]]*\]\(<?(https?:\/\/[^)\s>]+)>?/g)].map((m) => m[1]);
  const map = new Map<string, string>();
  for (const url of new Set(urls)) {
    const ext = (path.extname(new URL(url).pathname).match(/^\.(png|jpe?g|gif|webp|mp4|mov)$/i) || [".png"])[0];
    const file = path.join(CACHE, createHash("sha1").update(url).digest("hex").slice(0, 16) + ext);
    if (!existsSync(file)) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await mkdir(CACHE, { recursive: true });
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
        log(`downloaded ${url}`);
      } catch (e) { log(`cannot download ${url}: ${(e as Error).message}`); continue; }
    }
    map.set(url, file);
  }
  return map;
}

export async function loadFile(ref: string, { log = () => {} }: { log?: Log } = {}): Promise<Article> {
  const file = path.resolve(ref);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`File not found: ${file}`);
  const article = await loadMarkdown(await readFile(file, "utf8"), {
    dir: path.dirname(file),
    fallbackTitle: path.basename(file).replace(/\.(md|markdown|txt)$/i, ""),
    log,
  });
  return { ...article, id: file, source: "file" };
}

// Markdown text from any source -> article. Explicit options win over front matter.
// dir: folder for relative images (and the Obsidian vault search).
export async function loadMarkdown(text: string, { dir = process.cwd(), title, cover, status, fallbackTitle = "Untitled", frontMatter = true, log = () => {} }: MarkdownOptions = {}): Promise<LoadedMarkdown> {
  const { data, body }: { data: Record<string, string>; body: string } = frontMatter ? parseFrontMatter(text) : { data: {}, body: text };

  // Title: given title, else front matter "title", else the first "# " heading (removed from the body), else fallbackTitle.
  let markdown = body;
  title ||= data.title;
  if (!title) {
    const h1 = body.match(/^\s*#\s+(.+)\r?\n/);
    if (h1) { title = h1[1].trim(); markdown = body.slice(h1[0].length); }
  }
  title ||= fallbackTitle;

  const extra = new Set<string>();
  markdown = obsidianToMarkdown(markdown, dir, (_, text) => extra.add(text));
  const coverSrc = cover || data.x_cover || data.cover || data.image || null;
  const remote = await fetchRemoteImages(markdown + (coverSrc ? `\n![](${coverSrc})` : ""), log);
  const resolve = (src: string): string | null => {
    const downloaded = remote.get(src);
    if (downloaded) return downloaded;
    if (/^[a-z]+:/i.test(src)) return null;
    let rel;
    try { rel = decodeURIComponent(src.split(/[?#]/)[0]); } catch { rel = src; }
    const f = path.resolve(dir, rel);
    return existsSync(f) ? f : null;
  };

  const { segments, report } = convert(markdown, { resolveAsset: resolve });
  report.push(...extra);
  const coverPart = coverSrc ? { src: coverSrc, file: resolve(coverSrc) } : null;
  const media = segments.filter((s) => s.type === "image" || s.type === "video");
  const missing = [...media, ...(coverPart ? [coverPart] : [])].filter((s) => !s.file);
  return { title, markdown, segments, report, cover: coverPart, missing, status: status ?? data.x_status ?? "" };
}

// Status is written as x_* keys in the front matter. Other lines are left exactly as they are.
export async function setFileStatus(ref: string, fields: StatusFields): Promise<void> {
  const file = path.resolve(ref);
  const text = await readFile(file, "utf8");
  const values = { ...fields, "updated-at": new Date().toISOString() };
  const lines = Object.entries(values).map(([k, v]) => [`x_${k.replace(/-/g, "_")}`, v == null ? "" : String(v)]);
  const m = text.match(FM);
  let fm = m ? m[1].split(/\r?\n/) : [];
  for (const [key, val] of lines) {
    const line = `${key}: ${JSON.stringify(val)}`;
    const i = fm.findIndex((l) => l.startsWith(`${key}:`));
    if (i >= 0) fm[i] = line; else fm.push(line);
  }
  const out = `---\n${fm.join("\n")}\n---\n` + (m ? text.slice(m[0].length) : text);
  await writeFile(file, out);
}
