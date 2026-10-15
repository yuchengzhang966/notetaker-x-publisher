// Convert Markdown (from any source) into the parts the X Articles editor takes:
//   {type:"html"}     rich text, pasted (paragraphs, 2 heading levels, lists, quotes, links)
//   {type:"code"}     Insert → Code       {lang, code}
//   {type:"latex"}    Insert → LaTeX      {tex}
//   {type:"table"}    Insert → Table, filled with Markdown {markdown}
//   {type:"divider"}  Insert → Divider
//   {type:"image"}    Insert → Media      {file}
//   {type:"video"}    Insert → Media      {file}
//   {type:"render"}   drawn as an image, then Insert → Media (Mermaid)
//   {type:"post"}     Insert → Posts      {url}
// Every change of format is written to `report`, so nothing is lost silently.
// The block behavior was checked against the live editor on 2026-10-14.
import { Marked, type MarkedToken, type Parser, type Token, type Tokens, type TokensList } from "marked";
import type { Segment } from "./types.ts";

type Note = (key: string, text: string) => void;

const X_POST = /^https?:\/\/(x|twitter)\.com\/\w+\/status\/\d+\S*$/;
const SUP: Record<string, string> = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUB: Record<string, string> = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
// X keeps these on paste. h1 = Heading, h2 = Subheading; h3+ and <pre> become plain text.
const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "del", "a", "ul", "ol", "li", "blockquote", "h1", "h2"]);

function mapChars(text: string, table: Record<string, string>, fallback: string): string {
  const chars = [...text];
  return chars.every((c) => table[c]) ? chars.map((c) => table[c]).join("") : fallback;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
      name = name.toLowerCase();
      if (name === "b") name = "strong";
      if (name === "i") name = "em";
      if (name === "s") name = "del";
      if (/^h[1-6]$/.test(name)) name = name === "h1" ? "h1" : "h2";
      if (!ALLOWED_TAGS.has(name)) return "";
      if (tag.startsWith("</")) return `</${name}>`;
      const href = name === "a" && attrs.match(/href="([^"]+)"/);
      return href ? `<a href="${href[1]}">` : `<${name}>`;
    });
}

// Text-level rewrites, applied outside code.
function rewriteText(md: string, note: Note): string {
  const parts = md.split(/(^```[\s\S]*?^```\s*$|`[^`\n]+`)/m);
  return parts.map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/==([^=\n]+)==/g, (_, t) => (note("highlight", "Highlight became bold"), `**${t}**`))
      .replace(/<u>([\s\S]*?)<\/u>/g, (_, t) => (note("underline", "Underline became plain text"), t))
      .replace(/<kbd>([\s\S]*?)<\/kbd>/g, (_, t) => (note("kbd", "Keyboard keys became plain text"), t))
      .replace(/<sup>([\s\S]*?)<\/sup>/g, (_, t) => (note("sup", "Superscript became Unicode or ^()"), mapChars(t, SUP, `^(${t})`)))
      .replace(/<sub>([\s\S]*?)<\/sub>/g, (_, t) => (note("sub", "Subscript became Unicode or _()"), mapChars(t, SUB, `_(${t})`)))
      .replace(/(^|[\s(])#([^#\s][^#\n]*?)#(?=$|[\s.,;:!?)])/gm, (_, pre, t) => (note("tag", "Tags became hashtags"), `${pre}#${t.replace(/\s+/g, "_")}`))
      .replace(/(^|[^$\\])\$([^$\n]+?)\$(?!\$)/g, (_, pre, t) => (note("inline-math", "Inline math became plain TeX text (X has LaTeX blocks only)"), `${pre}${t}`));
  }).join("");
}

function extractFootnotes(md: string, note: Note): string {
  const defs = new Map<string, string>();
  md = md.replace(/^\[\^([^\]]+)\]:[ \t]*(.*(?:\n(?: {4}|\t).*|\n[ \t]*(?=\n(?: {4}|\t)))*)/gm, (_, key: string, body: string) => {
    if (!defs.has(key)) defs.set(key, body.replace(/^(?: {4}|\t)/gm, "").trim());
    return "";
  });
  if (!defs.size) return md;
  const order: string[] = [];
  md = md.replace(/\[\^([^\]]+)\](?!:)/g, (m, key: string) => {
    if (!defs.has(key)) return m;
    if (!order.includes(key)) order.push(key);
    return `[${order.indexOf(key) + 1}]`;
  });
  note("footnote", "Footnotes became numbered [n] markers with a Notes section at the end");
  const list = order.map((k, i) => `${i + 1}. ${defs.get(k)!.replace(/\n/g, " ")}`).join("\n");
  return `${md.trimEnd()}\n\n## Notes\n\n${list}\n`;
}

export function normalizeMarkdown(md: string, note: Note): string {
  let out = md.replace(/[​‍﻿]/g, "");
  out = out.replace(/\{:\s[^}]*\}/g, "");
  out = out.replace(/^>\s*\[!(\w+)\][^\n]*\n(?:>\s?)?/gm, (_, kind: string) => (note("callout", "Callouts became quotes with a bold label"), `> **${kind[0]}${kind.slice(1).toLowerCase()}:** `));
  out = out.replace(/^\$\$\s*\n([\s\S]*?)\n\$\$\s*$/gm, (_, tex: string) => "```math\n" + tex + "\n```");
  out = extractFootnotes(out, note);
  out = rewriteText(out, note);
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// X has two heading levels. The highest level used becomes Heading; all deeper levels become Subheading.
function headingMap(tokens: Token[], note: Note): (depth: number) => 1 | 2 {
  const levels = [...new Set(tokens.filter((t): t is Tokens.Heading => t.type === "heading").map((t) => t.depth))].sort();
  if (levels.length > 2) note("heading", `Heading levels ${levels.join(", ")} were mapped to X's two levels (Heading, Subheading)`);
  return (depth) => (depth === levels[0] ? 1 : 2);
}

// Rebuild a GFM table from tokens; X's table editor takes Markdown.
function tableMarkdown(tok: Tokens.Table): string {
  const cell = (c: Tokens.TableCell) => c.text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  const sep = tok.align.map((a) => (a === "left" ? ":--" : a === "center" ? ":-:" : a === "right" ? "--:" : "---"));
  return [
    `| ${tok.header.map(cell).join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...tok.rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

function makeMarked(note: Note, level: (depth: number) => 1 | 2): Marked {
  const marked = new Marked({ gfm: true });
  const inlineOf = (parser: Parser, item: Tokens.ListItem) =>
    item.tokens
      .filter((t) => t.type !== "list" && t.type !== "checkbox")
      .map((t) => { const g = t as Tokens.Generic; return g.tokens ? parser.parseInline(g.tokens) : escapeHtml(g.text || ""); })
      .join(" ");

  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const h = level(depth);
        return `<h${h}>${this.parser.parseInline(tokens)}</h${h}>\n`;
      },
      // X keeps nesting only when the inner list is a sibling of the <li>, not inside it.
      list(token) {
        const render = (list: Tokens.List): string => {
          const tag = list.ordered ? "ol" : "ul";
          let out = `<${tag}>`;
          for (const item of list.items) {
            const box = item.task ? (note("task", "Task items became ☐/☑ bullets"), item.checked ? "☑ " : "☐ ") : "";
            out += `<li>${box}${inlineOf(this.parser, item)}</li>`;
            for (const sub of item.tokens.filter((t): t is Tokens.List => t.type === "list")) out += render(sub);
          }
          return out + `</${tag}>\n`;
        };
        return render(token);
      },
      // X merges paragraphs inside one quote, so each paragraph gets its own quote.
      blockquote({ tokens }) {
        return tokens.map((tok) => {
          const t = tok as MarkedToken;
          if (t.type === "paragraph" || t.type === "heading" || t.type === "text") return `<blockquote>${this.parser.parseInline(t.tokens ?? [])}</blockquote>\n`;
          if (t.type === "list") return t.items.map((it) => `<blockquote>• ${inlineOf(this.parser, it)}</blockquote>\n`).join("");
          if (t.type === "space") return "";
          if (t.type === "code") note("quote-code", "Code inside quotes became quoted text");
          return `<blockquote>${escapeHtml((t as Tokens.Generic).text || t.raw || "")}</blockquote>\n`;
        }).join("");
      },
      codespan({ text }) {
        note("inline-code", "Inline code became plain text (X has no inline code)");
        return text;
      },
      image({ href, text }) {
        note("nested-image", "Images inside lists, quotes or tables became links");
        return `<a href="${escapeHtml(href)}">${escapeHtml(text || "image")}</a>`;
      },
      html({ text }) {
        return sanitizeHtml(text);
      },
    },
  });
  return marked;
}

function mediaFromHtml(html: string): { tag: string; src: string } | null {
  const src = html.match(/src="([^"]+)"/)?.[1];
  const tag = html.match(/<(iframe|video|audio)/i)?.[1]?.toLowerCase();
  if (!src || !tag) return null;
  const yt = src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/);
  return { tag, src: yt ? `https://www.youtube.com/watch?v=${yt[1]}` : src };
}

export function convert(markdown: string, { resolveAsset }: { resolveAsset: (src: string) => string | null }): { segments: Segment[]; report: string[] } {
  const report = new Map<string, string>();
  const note: Note = (key, text) => { report.set(key, text); };
  const md = normalizeMarkdown(markdown, note);
  const tokens = new Marked({ gfm: true }).lexer(md);
  const marked = makeMarked(note, headingMap(tokens, note));
  const segments: Segment[] = [];
  let pending = [] as unknown as TokensList;

  const flush = () => {
    if (!pending.length) return;
    pending.links = tokens.links;
    const html = marked.parser(pending).trim();
    if (html) {
      const last = segments.at(-1);
      if (last?.type === "html") last.html += "\n" + html;
      else segments.push({ type: "html", html });
    }
    pending = [] as unknown as TokensList;
  };
  const block = (seg: Segment) => { flush(); segments.push(seg); };

  for (const token of tokens) {
    const tok = token as MarkedToken;
    switch (tok.type) {
      case "paragraph": {
        const text = tok.text.trim();
        if (X_POST.test(text)) { block({ type: "post", url: text }); continue; }
        if (/^<(iframe|video|audio)/i.test(text)) break; // handled as html below
        if (tok.tokens.some((t) => t.type === "image")) {
          let run: Token[] = [];
          const pushRun = () => {
            const raw = run.map((t) => t.raw).join("").trim();
            if (raw) pending.push(...marked.lexer(raw));
            run = [];
          };
          for (const t of tok.tokens) {
            if (t.type !== "image") { run.push(t); continue; }
            const img = t as Tokens.Image;
            pushRun();
            if (tok.tokens.length > 1) note("inline-image", "Images inside paragraphs were placed on their own line");
            if (img.title) note("caption", "Image titles were not set as captions");
            block({ type: "image", src: img.href, alt: img.text, file: resolveAsset(img.href) });
          }
          pushRun();
          continue;
        }
        break;
      }
      case "code":
        if (tok.lang === "math") { block({ type: "latex", tex: tok.text }); continue; }
        if (tok.lang === "mermaid") {
          note("mermaid", "Mermaid diagrams were drawn as images");
          block({ type: "render", kind: "mermaid", source: tok.text });
          continue;
        }
        block({ type: "code", lang: tok.lang || "", code: tok.text });
        continue;
      case "table":
        if (tok.header.some((c) => /!\[/.test(c.text)) || tok.rows.some((r) => r.some((c) => /!\[/.test(c.text)))) {
          note("nested-image", "Images inside lists, quotes or tables became links");
        }
        block({ type: "table", markdown: tableMarkdown(tok) });
        continue;
      case "hr":
        block({ type: "divider" });
        continue;
    }
    if (tok.type === "html" || tok.type === "paragraph") {
      const media = mediaFromHtml(tok.text);
      if (media) {
        const file = resolveAsset(media.src);
        if (file && media.tag === "video") { block({ type: "video", src: media.src, file }); continue; }
        note(`media-${media.tag}`, `${media.tag === "iframe" ? "Embedded frames" : media.tag === "audio" ? "Audio" : "Remote videos"} became links`);
        flush();
        pending.push(...marked.lexer(`<${media.src}>`));
        continue;
      }
      if (tok.type === "html") note("html", "Raw HTML was reduced to the formats X supports");
    }
    pending.push(tok);
  }
  flush();
  return { segments, report: [...report.values()] };
}
