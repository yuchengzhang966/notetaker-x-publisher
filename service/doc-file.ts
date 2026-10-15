// Word and other rich-text documents: .docx through mammoth; .doc, .rtf, .rtfd, .odt through macOS textutil; .html as is.
// The document becomes HTML, then Markdown, then goes through the same steps as a .md file.
// A document has no front matter, so the draft status is kept in .status/ (one JSON file per document).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { loadMarkdown } from "./markdown-file.ts";
import { readStatus, writeStatus } from "./status-store.ts";
import type { Article, Log, StatusFields } from "./types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".cache", "docs");
const TEXTUTIL = /\.(doc|rtf|rtfd|odt|wordml|webarchive|html?)$/i;

export function isDocFile(ref: string): boolean {
  return /\.docx$/i.test(ref) || TEXTUTIL.test(ref);
}

const key = (file: string) => createHash("sha1").update(file).digest("hex").slice(0, 16);

// Word styles that mammoth does not map by default.
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
  "r[style-name='Code Char'] => code",
  "r[style-name='HTML Code'] => code",
];

async function docxToHtml(file: string, dir: string, log: Log): Promise<string> {
  let n = 0;
  const { value, messages } = await mammoth.convertToHtml({ path: file }, {
    styleMap: STYLE_MAP,
    convertImage: mammoth.images.imgElement(async (image) => {
      const ext = (image.contentType.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, "");
      const name = `image-${++n}.${ext}`;
      await writeFile(path.join(dir, name), await image.readAsBuffer());
      return { src: name };
    }),
  });
  for (const m of messages) if (m.type === "warning") log(`docx: ${m.message}`);
  return value;
}

// textutil writes images of .rtfd/.webarchive next to the HTML; others keep text only.
async function textutilToHtml(file: string, dir: string): Promise<string> {
  const out = path.join(dir, "document.html");
  await promisify(execFile)("/usr/bin/textutil", ["-convert", "html", "-output", out, file]);
  return restoreStructure(await readFile(out, "utf8"));
}

// textutil gives only styled <p class="pN"> paragraphs. Rebuild structure from the styles:
// larger fonts become headings (largest = h1), "•"/"1" + tab paragraphs become lists, line-through becomes <del>.
function restoreStructure(html: string): string {
  const css: Record<string, string> = {};
  for (const [, sel, body] of html.matchAll(/((?:p|span)\.\w+)\s*\{([^}]*)\}/g)) css[sel] = body;
  const size = (cls: string) => Number(css[`p.${cls}`]?.match(/font:[^;]*?([\d.]+)px/)?.[1] || 0);
  const indent = (cls: string) => Number(css[`p.${cls}`]?.match(/margin:\s*[\d.]+px [\d.]+px [\d.]+px ([\d.]+)px/)?.[1] || 0);
  const text = (s: string) => s.replace(/<[^>]+>/g, "").trim();
  const PARA = /<p class="(\w+)">([\s\S]*?)<\/p>/g;

  // Body size: the font size that holds the most text.
  const amount: Record<number, number> = {};
  for (const [, cls, inner] of html.matchAll(PARA)) amount[size(cls)] = (amount[size(cls)] || 0) + text(inner).length;
  const body = Number(Object.entries(amount).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
  const isHeading = (cls: string, inner: string) => size(cls) > body * 1.1 && text(inner).length > 0 && text(inner).length < 200;
  const levels = [...new Set([...html.matchAll(PARA)].filter(([, c, i]) => isHeading(c, i)).map(([, c]) => size(c)))].sort((a, b) => b - a);

  const TAB = '<span class="Apple-tab-span">\\s*</span>';
  const ITEM = new RegExp(`^\\s*${TAB}\\s*([•◦▪●○■\\-–]|\\d+[.)]?|[a-zA-Z][.)])\\s*${TAB}([\\s\\S]*)$`);
  let out = "";
  const stack: { tag: "ul" | "ol"; level: number }[] = []; // open lists
  const closeTo = (level: number) => { while (stack.length && stack.at(-1)!.level > level) out += `</li></${stack.pop()!.tag}>`; };

  let last = 0;
  for (const m of html.matchAll(PARA)) {
    const [all, cls, inner] = m;
    const between = html.slice(last, m.index);
    last = m.index + all.length;
    const item = inner.match(ITEM);
    if (!/^\s*$/.test(between)) closeTo(-1); // a table or other block ends open lists
    out += between;
    if (item) {
      const tag = /^[•◦▪●○■\-–]$/.test(item[1]) ? "ul" : "ol";
      const level = Math.max(0, Math.round(indent(cls) / 36) - 1);
      closeTo(level);
      const top = stack.at(-1);
      if (top?.level === level && top.tag === tag) out += `</li><li>${item[2]}`;
      else {
        if (top?.level === level) out += `</li></${stack.pop()!.tag}>`;
        out += `<${tag}><li>${item[2]}`;
        stack.push({ tag, level });
      }
      continue;
    }
    closeTo(-1);
    if (isHeading(cls, inner)) {
      const h = Math.min(levels.indexOf(size(cls)) + 1, 6);
      out += `<h${h}>${text(inner)}</h${h}>`;
    } else out += `<p>${inner}</p>`;
  }
  closeTo(-1);
  out += html.slice(last);
  // Spans: line-through -> <del>; other spans keep only their text.
  return out
    // textutil puts a nested list after its <li>, not inside it: move it in.
    .replace(/<\/li>(\s*<(?:ul|ol)\b)/g, "$1")
    .replace(/(<\/(?:ul|ol)>)(?=\s*(?:<li\b|<\/(?:ul|ol)>))/g, "$1</li>")
    .replace(/<span class="(s\d+)">([\s\S]*?)<\/span>/g, (_, cls: string, t: string) =>
    /line-through/.test(css[`span.${cls}`] || "") ? `<del>${t}</del>` : t);
}

// Word footnotes (mammoth) -> Markdown footnotes, which convert.ts turns into [n] markers and a Notes section.
function footnotes(html: string): string {
  const defs: string[] = [];
  html = html.replace(/<li id="(?:foot|end)note-(\d+)">([\s\S]*?)<\/li>/g, (_, id: string, body: string) => {
    defs.push(`<p>[^${id}]: ${body.replace(/\s*<a href="#(?:foot|end)note-ref-\d+">↑<\/a>/, "").replace(/<\/?p>/g, " ").trim()}</p>`);
    return "";
  });
  html = html.replace(/<sup><a href="#(?:foot|end)note-\d+" id="(?:foot|end)note-ref-(\d+)">\[\d+\]<\/a><\/sup>/g, "[^$1]");
  return html.replace(/<ol>\s*<\/ol>/g, "") + defs.join("");
}

// Word tables have no header row; Markdown tables need one. Paragraphs inside a cell are joined with a space
// (an X table cell holds one line).
function tables(html: string): string {
  return html
    .replace(/(<table[^>]*>)\s*(<tbody[^>]*>)?\s*<tr[^>]*>([\s\S]*?)<\/tr>/g, (_, table: string, tbody: string | undefined, row: string) =>
      `${table}<thead><tr>${row.replace(/<(\/?)td/g, "<$1th")}</tr></thead>${tbody || ""}`)
    .replace(/<(t[dh])([^>]*)>([\s\S]*?)<\/\1>/g, (_, tag: string, attrs: string, cell: string) =>
      `<${tag}${attrs}>${cell.replace(/^\s*<p>|<\/p>\s*$/g, "").replace(/<\/p>\s*<p>/g, " ")}</${tag}>`);
}

function toMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  td.use(gfm);
  td.remove(["style", "script", "head", "title"]);
  // Document text is literal: keep "$5 and $10", "==", "#tag#" from being read as math, highlight or tags.
  const escape = td.escape.bind(td);
  td.escape = (s) => escape(s).replace(/\$/g, "\\$").replace(/==/g, "\\=\\=").replace(/#(?=\S)/g, "\\#");
  return td.turndown(html).replace(/\\\[\^(\d+)\\\]/g, "[^$1]"); // footnote markers survive escaping
}

export async function loadDoc(ref: string, { log = () => {} }: { log?: Log } = {}): Promise<Article> {
  const file = path.resolve(ref);
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  // One folder per document version, so images from an older version are never reused.
  const dir = path.join(CACHE, key(`${file}:${statSync(file).mtimeMs}`));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const isDocx = /\.docx$/i.test(file);
  const isHtml = /\.html?$/i.test(file);
  const html = isDocx ? await docxToHtml(file, dir, log) : isHtml ? await readFile(file, "utf8") : await textutilToHtml(file, dir);
  const markdown = toMarkdown(tables(footnotes(html)));
  await writeFile(path.join(dir, "document.md"), markdown); // for debugging

  // Cover: "<document name>.cover.png" (or .jpg/.jpeg/.webp) next to the document.
  const stem = file.replace(/\.[^.]+$/, "");
  const cover = ["png", "jpg", "jpeg", "webp"].map((e) => `${stem}.cover.${e}`).find(existsSync);

  const saved = await readStatus(file);
  const article = await loadMarkdown(markdown, {
    dir: isHtml ? path.dirname(file) : dir, frontMatter: false, log,
    fallbackTitle: path.basename(file).replace(/\.[^.]+$/, ""),
    status: saved.status || "", cover,
  });
  article.report.push(`Converted from ${path.extname(file).slice(1).toLowerCase()} to Markdown; Word-only formatting (colors, fonts, comments) was dropped`);
  if (!isDocx && !isHtml && !readdirSync(dir).some((f) => /\.(png|jpe?g|gif|tiff?)$/i.test(f))) {
    article.report.push("Images are not read from this format; save as .docx to keep images");
  }
  return { ...article, id: file, source: "doc" };
}

export async function setDocStatus(ref: string, fields: StatusFields): Promise<void> {
  await writeStatus(path.resolve(ref), fields);
}
