// Notion pages through the Notion API: GET /v1/pages/:id/markdown gives Notion's "enhanced Markdown",
// which is rewritten here into standard Markdown and then goes through the same steps as a .md file.
//
// Set-up: create an internal connection at https://www.notion.so/profile/integrations (read content;
// add update content to save the status), put its secret in NOTION_TOKEN (.env works), and share
// each page with the connection (page ••• menu → Connections).
//
// Ref: a Notion page URL, or notion:<page id or URL>.
// Title: the page title. Cover: the page cover. Status: the page properties "X Status",
// "X Draft URL", "X Error" when the page has them (for example in a database),
// and always the local .status/ store, so the status is kept for any page.
import os from "node:os";
import path from "node:path";
import { loadMarkdown } from "./markdown-file.ts";
import { stripTitle } from "./siyuan.ts";
import { readStatus, writeStatus } from "./status-store.ts";
import type { Article, Log, StatusFields } from "./types.ts";

const API = process.env.NOTION_API || "https://api.notion.com/v1";
const VERSION = "2026-03-11";
const MAX_UNKNOWN = 50; // extra block fetches per page (bookmarks, embeds, truncated parts)

// Status field -> page property name.
const PROPS: Record<string, string> = {
  status: "X Status", "draft-url": "X Draft URL", error: "X Error",
};

interface RichText { plain_text: string }
interface Property { id: string; type: string; title?: RichText[]; select?: { name: string } | null; status?: { name: string } | null; rich_text?: RichText[]; url?: string | null }
interface Page {
  id: string;
  url: string;
  properties: Record<string, Property>;
  cover: { type: "external"; external: { url: string } } | { type: "file"; file: { url: string } } | null;
}
interface PageMarkdown { markdown: string; truncated: boolean; unknown_block_ids: string[] }
interface Block { id: string; type: string; [type: string]: unknown }

export class NotionError extends Error {}

export function isNotionUrl(ref: string): boolean {
  return /^https?:\/\/([\w-]+\.)?notion\.(so|site)\//i.test(ref);
}

// Page ID from a URL or ID: the last 32 hex digits, with or without dashes.
export function pageId(ref: string): string {
  const hex = ref.split(/[?#]/)[0]!.replace(/-/g, "").match(/[0-9a-f]{32}(?=\/?$)/i)?.[0];
  if (!hex) throw new NotionError(`Not a Notion page ID or URL: ${ref}`);
  return hex.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function token(): string {
  const t = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (!t) throw new NotionError("NOTION_TOKEN is not set. Create a connection at https://www.notion.so/profile/integrations, put its secret in NOTION_TOKEN (or in .env), and share the page with it.");
  return t;
}

async function notion<T>(method: string, endpoint: string, body?: object): Promise<T> {
  const res = await fetch(`${API}/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Notion-Version": VERSION, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string };
  if (!res.ok) {
    const hint = res.status === 404 ? " Is the page shared with your Notion connection (page ••• menu → Connections)?" : "";
    throw new NotionError(`Notion ${endpoint}: ${(data.message || `HTTP ${res.status}`).replace(/\.?$/, ".")}${hint}`);
  }
  return data;
}

const plain = (rt: RichText[] = []) => rt.map((t) => t.plain_text).join("");

// ---- Notion enhanced Markdown -> standard Markdown ----

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const tabs = (line: string) => line.match(/^\t*/)![0].length;
const isListLine = (line: string) => /^\s*([-*+]|\d+[.)])\s/.test(line);

// <table> with <tr>/<td> rich-text cells -> GFM table (first row is the header row).
function tableToMarkdown(html: string): string {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell]) => cell!.replace(/<br\s*\/?>/g, " ").replace(/\|/g, "\\|").trim()));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]!), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

// Inline tags: mentions, colors, underline.
function inline(text: string, note: (key: string, text: string) => void): string {
  return text
    .replace(/<mention-(page|database)\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/mention-\1>/g, (_, _k, url: string, t: string) => `[${t}](${unescapeAttr(url)})`)
    .replace(/<mention-user\b[^>]*>([\s\S]*?)<\/mention-user>/g, (_, t: string) => `@${t}`)
    .replace(/<mention-date\b([^>]*)\/>/g, (_, a: string) => [attr(a, "start"), attr(a, "end")].filter(Boolean).join(" – "))
    .replace(/<mention-[\w-]+\b[^>]*>([\s\S]*?)<\/mention-[\w-]+>/g, "$1")
    .replace(/<span underline="true">([\s\S]*?)<\/span>/g, (_, t: string) => (note("underline", "Underline became plain text"), t))
    .replace(/<span color="[^"]*">([\s\S]*?)<\/span>/g, (_, t: string) => (note("color", "Notion text colors were dropped"), t));
}

export function notionToMarkdown(md: string, note: (key: string, text: string) => void = () => {}): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  // Children are indented one tab deeper than their parent. Containers (callout, toggle, columns,
  // synced block) and toggle headings are dropped, so their children lose one tab per container.
  const open: ("quote" | "plain")[] = [];
  let toggleHeading: number | null = null; // tab level of an open toggle heading (it has no closing tag)
  let icon = ""; // a callout icon goes in front of the callout's first line
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(new RegExp(`^\\t{0,${open.length}}`), "");
    if (toggleHeading !== null && !fence) {
      if (line.trim() && tabs(line) <= toggleHeading) toggleHeading = null;
      else line = line.replace(/^\t/, "");
    }
    const quoted = open.includes("quote");
    const emit = (l: string) => {
      if (!quoted || l === "") return out.push(l);
      out.push(`> ${icon ? icon + " " : ""}${l.replace(/^\t+/, "")}`);
      icon = "";
    };
    const t = line.trim();
    let m: RegExpMatchArray | null;

    if (!fence && (m = t.match(/^\$\$\s*(.+?)\s*\$\$$/))) { emit("$$"); emit(m[1]!); emit("$$"); continue; }
    const fenceMark = t.match(/^(```+|~~~+|\$\$)/)?.[1];
    if (fence) { emit(line); if (fenceMark?.startsWith(fence)) fence = null; continue; }
    if (fenceMark) { fence = fenceMark; emit(line); continue; }

    if ((m = t.match(/^<callout\b([^>]*)>$/))) {
      note("callout", "Callouts became quotes");
      const i_ = attr(m[1]!, "icon");
      icon = i_ && !/^(https?:|\/)/.test(i_) ? i_ : "";
      open.push("quote");
      continue;
    }
    if (/^<details\b[^>]*>$/.test(t)) {
      note("toggle", "Toggles were expanded; the toggle title became bold text");
      open.push("plain");
      const summary = lines[i + 1]?.trim().match(/^<summary>([\s\S]*)<\/summary>$/);
      if (summary) { emit(`**${inline(summary[1]!, note)}**`); i++; }
      continue;
    }
    if (/^<(columns|column|synced_block|synced_block_reference)\b[^>]*>$/.test(t)) {
      if (t.startsWith("<column")) note("columns", "Columns became one column");
      open.push("plain");
      continue;
    }
    if (/^<\/(callout|details|columns|column|synced_block|synced_block_reference)>$/.test(t)) { open.pop(); icon = ""; continue; }

    if (/^<table[\s>]/.test(t)) {
      let html = line;
      while (!html.includes("</table>") && i + 1 < lines.length) html += "\n" + lines[++i];
      emit(""); for (const row of tableToMarkdown(inline(html, note)).split("\n")) emit(row); emit("");
      continue;
    }
    if ((m = t.match(/^<(page|database)\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/\1>$/))) {
      note("child-page", "Child pages and databases became links");
      emit(`[${m[3]}](${unescapeAttr(m[2]!)})`);
      continue;
    }
    if ((m = t.match(/^<(file|pdf|audio)\s+src="([^"]*)"[^>]*>([\s\S]*?)<\/\1>$/))) {
      note("file", "Files, PDFs and audio became links");
      const src = unescapeAttr(m[2]!);
      emit(`[${m[3] || path.basename(new URL(src).pathname)}](${src})`);
      continue;
    }
    if (/^<(table_of_contents|empty-block|custom-block|breadcrumb)\b[^>]*\/>$/.test(t)) {
      if (t.startsWith("<table_of_contents")) note("toc", "The table of contents was left out");
      continue;
    }
    if (/^<unknown\b[^>]*\/>$/.test(t)) {
      note("unknown", "Some Notion blocks cannot be exported by the API and were left out");
      continue;
    }

    // Block attributes such as {color="gray_bg"} or {toggle="true"} end the first line of a block.
    const attrs = line.match(/\s*\{((?:color|toggle)="[^"]*"(?:\s+\w+="[^"]*")*)\}\s*$/);
    if (attrs) {
      line = line.slice(0, attrs.index);
      if (/toggle="true"/.test(attrs[1]!) && /^\t*#{1,6}\s/.test(line)) {
        note("toggle", "Toggles were expanded; the toggle title became bold text");
        toggleHeading = tabs(line);
      }
    }
    emit(inline(line, note));
  }

  // Notion separates blocks with one newline; Markdown needs a blank line, except within a list,
  // a table or a code/math block. Remaining tabs are list nesting (4 spaces in Markdown); the
  // children of anything but a list item are moved out to the top level.
  const result: string[] = [];
  const isTable = (l: string) => /^(> )?\|/.test(l);
  let inList = false;
  fence = null;
  for (let i = 0; i < out.length; i++) {
    let line = out[i]!;
    const next = out[i + 1];
    const fenceMark = line.match(/^(?:> )?\s*(```+|~~~+|\$\$)/)?.[1];
    if (fence || fenceMark) {
      result.push(line);
      if (fence) { if (fenceMark?.startsWith(fence)) fence = null; }
      else fence = fenceMark!;
      if (!fence && next) result.push("");
      continue;
    }
    if (!line) { result.push(line); continue; }
    const indent = tabs(line);
    inList = isListLine(line) ? true : indent > 0 && inList;
    line = inList ? line.replace(/^\t+/, (t) => "    ".repeat(t.length)) : line.replace(/^\t+/, "");
    result.push(line);
    if (!next) continue;
    const nextInList = isListLine(next) || (tabs(next) > 0 && inList);
    if ((inList && nextInList) || (isTable(line) && isTable(next))) continue;
    result.push("");
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---- unknown blocks: bookmarks, embeds, link previews, truncated parts ----

async function resolveUnknown(md: string, ids: string[], log: Log): Promise<string> {
  for (const id of ids.slice(0, MAX_UNKNOWN)) {
    const hex = id.replace(/-/g, "");
    const tag = new RegExp(`^(\\t*)<unknown\\b[^>]*url="[^"]*${hex}[^"]*"[^>]*/>$`, "m");
    const found = md.match(tag);
    if (!found) continue;
    let text = "";
    try {
      const block = await notion<Block>("GET", `blocks/${id}`);
      const data = block[block.type] as { url?: string } | undefined;
      if (data?.url) text = data.url; // a bare URL line: X post URLs become embedded posts, others links
      else text = (await notion<PageMarkdown>("GET", `pages/${id}/markdown`)).markdown; // a truncated part
    } catch (e) { log(`notion: block ${id} not exported: ${(e as Error).message}`); continue; }
    md = md.replace(tag, text.split("\n").map((l) => found[1] + l).join("\n"));
  }
  if (ids.length > MAX_UNKNOWN) log(`notion: ${ids.length - MAX_UNKNOWN} more unexported blocks were left out`);
  return md;
}

// ---- source ----

function titleOf(page: Page): string {
  const prop = Object.values(page.properties).find((p) => p.type === "title");
  return plain(prop?.title);
}

function propValue(p: Property | undefined): string {
  if (!p) return "";
  if (p.type === "select") return p.select?.name ?? "";
  if (p.type === "status") return p.status?.name ?? "";
  if (p.type === "url") return p.url ?? "";
  if (p.type === "rich_text") return plain(p.rich_text);
  return "";
}

export async function loadNotion(ref: string, { log = () => {} }: { log?: Log } = {}): Promise<Article> {
  const id = pageId(ref);
  const page = await notion<Page>("GET", `pages/${id}`);
  const doc = await notion<PageMarkdown>("GET", `pages/${id}/markdown`);
  let md = doc.markdown;
  if (doc.unknown_block_ids.length) md = await resolveUnknown(md, doc.unknown_block_ids, log);
  if (doc.truncated) log("notion: the page is very large; Notion truncated it");

  const title = titleOf(page) || "Untitled";
  const extra = new Map<string, string>();
  const markdown = stripTitle(notionToMarkdown(md, (k, t) => extra.set(k, t)), title);
  const saved = await readStatus(`notion:${id}`);
  const cover = page.cover?.type === "external" ? page.cover.external.url : page.cover?.file.url;
  const article = await loadMarkdown(markdown, {
    dir: os.tmpdir(), frontMatter: false, log, title, cover,
    status: propValue(page.properties[PROPS.status!]) || saved.status || "",
  });
  article.report.push(...extra.values());
  return { ...article, id, source: "notion" };
}

// Local store always; page properties when the page has them (needs the "update content" capability).
export async function setNotionStatus(ref: string, fields: StatusFields): Promise<void> {
  const id = pageId(ref);
  await writeStatus(`notion:${id}`, fields);
  try {
    const page = await notion<Page>("GET", `pages/${id}`);
    const properties: Record<string, object> = {};
    for (const [field, value] of Object.entries(fields)) {
      const name = PROPS[field];
      const prop = name && page.properties[name];
      if (!prop) continue;
      const v = value ?? "";
      if (prop.type === "select") properties[name] = { select: v ? { name: v } : null };
      else if (prop.type === "status") { if (v) properties[name] = { status: { name: v } }; }
      else if (prop.type === "url") properties[name] = { url: v || null };
      else if (prop.type === "rich_text") properties[name] = { rich_text: v ? [{ text: { content: v.slice(0, 2000) } }] : [] };
    }
    if (Object.keys(properties).length) await notion("PATCH", `pages/${id}`, { properties });
  } catch (e) {
    console.error(`notion: status saved locally only: ${(e as Error).message}`);
  }
}
