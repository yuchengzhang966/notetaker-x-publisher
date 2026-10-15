// Draw tables, formulas and Mermaid diagrams as PNG images, since X Articles cannot show them.
import { chromium, type Browser } from "playwright-core";
import katex from "katex";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Log, RenderKind, Segment } from "./types.ts";

// Mermaid as loaded into the render page by its <script> tag.
declare global {
  interface Window { mermaid: { initialize(config: object): void; render(id: string, src: string): Promise<{ svg: string }> } }
}

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".cache", "renders");
const KATEX_CSS = pathToFileURL(path.join(ROOT, "node_modules/katex/dist/katex.min.css")).href;
const MERMAID_JS = path.join(ROOT, "node_modules/mermaid/dist/mermaid.min.js");

const STYLE = `
  body { margin: 0; background: #fff; font: 16px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #0f1419; }
  #out { display: inline-block; padding: 24px; background: #fff; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #cfd9de; padding: 8px 14px; }
  th { background: #f7f9f9; font-weight: 600; }
  code { font: 14px Menlo, monospace; background: #f1f3f4; padding: 1px 4px; border-radius: 4px; }
  .katex-display { margin: 0; font-size: 1.4em; }
`;

function bodyFor(kind: RenderKind, source: string): string {
  if (kind === "table") return source;
  if (kind === "math") return katex.renderToString(source, { displayMode: true, throwOnError: false, output: "html" });
  if (kind === "mermaid") return `<pre class="mermaid"></pre>`;
  throw new Error(`Unknown render kind ${kind}`);
}

export async function renderSegments(segments: Segment[], log: Log = () => {}): Promise<Segment[]> {
  const todo = segments.filter((s): s is Extract<Segment, { type: "render" }> => s.type === "render" && !s.file);
  if (!todo.length) return segments;
  await mkdir(CACHE, { recursive: true });
  let browser: Browser | undefined;
  try {
    for (const seg of todo) {
      const hash = createHash("sha256").update(seg.kind + "\0" + seg.source).digest("hex").slice(0, 16);
      const file = path.join(CACHE, `${seg.kind}-${hash}.png`);
      if (!existsSync(file)) {
        log(`render ${seg.kind}`);
        browser ??= await chromium.launch({ channel: "chrome", headless: true });
        const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1200, height: 800 } });
        const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${KATEX_CSS}"><style>${STYLE}</style></head><body><div id="out">${bodyFor(seg.kind, seg.source)}</div></body></html>`;
        const htmlFile = path.join(CACHE, `${hash}.html`);
        await writeFile(htmlFile, html);
        await page.goto(pathToFileURL(htmlFile).href);
        if (seg.kind === "mermaid") {
          await page.addScriptTag({ path: MERMAID_JS });
          const err = await page.evaluate(async (src) => {
            try {
              window.mermaid.initialize({ startOnLoad: false, theme: "default" });
              const { svg } = await window.mermaid.render("m", src);
              document.querySelector(".mermaid")!.innerHTML = svg;
              return null;
            } catch (e) { return String((e as Error).message || e); }
          }, seg.source);
          if (err) throw new Error(`Mermaid diagram failed to render: ${err}`);
        }
        await page.evaluate(() => document.fonts.ready);
        await page.locator("#out").screenshot({ path: file });
        await page.close();
      }
      seg.file = file;
      seg.alt = seg.kind === "table" ? "Table" : seg.kind === "math" ? seg.source : "Diagram";
    }
  } finally {
    await browser?.close();
  }
  return segments;
}
