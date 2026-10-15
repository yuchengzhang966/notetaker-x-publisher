// X side: fill the Articles editor in a dedicated window of your real browser.
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";

import { URLS, SEL, LANG_ALIASES } from "./selectors.ts";
import type { Article, Log, Segment } from "./types.ts";

type SegmentOf<T extends Segment["type"]> = Extract<Segment, { type: T }>;

export interface Resume { draftUrl: string; fromPart: number }

export interface Check {
  counts: Record<string, number>;
  expected: Record<string, number>;
  missingBlocks: string[];
  missingText: string[];
  verified: boolean;
}

export interface FillResult extends Check {
  draftUrl: string;
  titleSaved: boolean;
  notes: string[];
}

export interface Tab {
  page: Page;
  real: boolean;
  close(): Promise<void>;
  onClosed(cb: () => void): void;
}

const ROOT = path.resolve(import.meta.dirname, "..");
const PROFILE = process.env.X_PROFILE_DIR || path.join(ROOT, ".chrome-profile");

export class StopError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const PORT_FILES = [
  path.join(os.homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort"),
  path.join(os.homedir(), "Library/Application Support/Google/Chrome/DevToolsActivePort"),
];

// Find the debug endpoint of your running Brave or Chrome. Stale port files are skipped.
const BRIDGE = `http://127.0.0.1:${process.env.BRIDGE_PORT || 9333}`;

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => { sock.end(); resolve(true); });
    sock.on("error", () => resolve(false));
  });
}

// Prefer the debug bridge (npm run bridge): it keeps one approved browser connection.
// A direct connection makes Brave ask for approval again.
async function realBrowserEndpoint(): Promise<string | null> {
  if (process.env.X_CDP) return process.env.X_CDP;
  if (await portOpen(Number(process.env.BRIDGE_PORT || 9333))) return BRIDGE;
  // (The bridge itself connects to Brave first, then Chrome.)
  for (const file of PORT_FILES) {
    const [port, wsPath] = (await readFile(file, "utf8").catch(() => "")).trim().split("\n");
    if (!port || !wsPath) continue;
    if (await portOpen(Number(port))) return `ws://127.0.0.1:${port}${wsPath}`;
  }
  return null;
}


// X only opens saved drafts in a tab that the browser treats as visible. A background tab
// is not, and neither is a window that is fully covered, minimized or on another desktop.
// So the work tab lives alone in its own window: keep any part of that window visible.
// Nothing is brought to the front.
const WINDOW_NAME = "siyuan-x-publisher-window";

async function findWorkTab(context: BrowserContext): Promise<Page | null> {
  for (const p of context.pages()) {
    if (!/^https:\/\/(x|twitter)\.com\//.test(p.url())) continue;
    const name = await Promise.race([p.evaluate(() => window.name).catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), 1500))]);
    if (name === WINDOW_NAME) return p;
  }
  return null;
}

async function newWorkWindow(browser: Browser, context: BrowserContext): Promise<Page> {
  const cdp = await browser.newBrowserCDPSession();
  const known = new Set(context.pages());
  const opened = context.waitForEvent("page", { predicate: (p: Page) => !known.has(p), timeout: 15000 });
  const { targetId } = await cdp.send("Target.createTarget", { url: URLS.articles, newWindow: true, background: true });
  const page = await opened;
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: 1000, height: 900, windowState: "normal" } }).catch(() => {});
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((n: string) => { window.name = n; }, WINDOW_NAME);
  return page;
}

export async function openBrowser(): Promise<Tab> {
  const endpoint = process.env.X_BROWSER === "profile" ? null : await realBrowserEndpoint();
  if (endpoint) {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 120000 }).catch((e) => { // waits its turn at the bridge
      if (e.name !== "TimeoutError") throw e;
      throw new StopError("browser", "The browser did not accept the debugging connection. If Brave shows \"allow remote debugging\" at the top of a window, click Allow, then try again.");
    });
    const context = browser.contexts()[0];
    const page = (await findWorkTab(context)) || (await newWorkWindow(browser, context));
    return {
      page,
      real: true,
      close: () => browser.close().catch(() => {}), // disconnects; the window stays open
      onClosed: (cb: () => void) => cb(),
    };
  }
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--window-size=1280,1000"],
  });
  const page = context.pages()[0] || (await context.newPage());
  return { page, real: false, close: () => context.close(), onClosed: (cb: () => void) => { context.on("close", cb); } };
}

async function first(page: Page, list: string[], { timeout = 10000, visible = true } = {}): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) && (!visible || (await loc.isVisible().catch(() => false)))) return loc;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function need(page: Page, name: "createArticle" | "challenge", opts?: { timeout?: number; visible?: boolean }): Promise<Locator> {
  const loc = await first(page, SEL[name], opts);
  if (!loc) throw new StopError("selector", `Could not find "${name}" on ${page.url()}. Run "npm run probe" and update service/selectors.ts.`);
  return loc;
}

export async function checkChallenge(page: Page) {
  if (/\/i\/flow\/login|\/login|\/account\/access/.test(page.url())) {
    throw new StopError("login", "X is not logged in. Log in to X in your browser, then try again.");
  }
  if (await first(page, SEL.challenge, { timeout: 500, visible: false })) {
    throw new StopError("challenge", "X asked for manual verification. Finish it in the open tab, then try again.");
  }
}

export async function loginStatus(page: Page) {
  await page.goto(URLS.home, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  return !/login|\/i\/flow|^https:\/\/x\.com\/?$/.test(page.url());
}

// X does not draw its editor in a background tab. Focus emulation makes the tab act as
// focused without bringing it to the front.
async function keepRendering(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
}

const composer = (page: Page) => page.locator(SEL.composer).first();
const blockCount = (page: Page) => page.locator(`${SEL.composer} section`).count();
const dialog = (page: Page) => page.locator(SEL.dialog).last();

async function caretToEnd(page: Page) {
  await composer(page).focus();
  await page.keyboard.press("Meta+ArrowDown");
}

async function waitDialogClosed(page: Page, what: string) {
  await dialog(page).waitFor({ state: "detached", timeout: 30000 })
    .catch(() => { throw new StopError("dialog", `The ${what} dialog did not close.`); });
}

// Insert → <item>. Returns once the item's dialog is open (Divider has none).
// The menu sometimes swallows a click while it is still opening, so check and retry.
const NO_DIALOG = new Set(["Divider"]);

async function closeStray(page: Page) {
  const close = page.locator(`${SEL.dialog} [data-testid='app-bar-close']`);
  if (await close.count()) await close.first().click().catch(() => {});
  if (await page.locator("[role=menu]").count()) await page.keyboard.press("Escape");
}

async function openInsert(page: Page, item: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await closeStray(page);
    await caretToEnd(page);
    await page.locator(SEL.insertButton).click();
    const entry = page.getByRole("menuitem", { name: item, exact: true });
    await entry.waitFor({ state: "visible", timeout: 5000 });
    await page.waitForTimeout(300); // let the menu finish opening
    await entry.click();
    if (NO_DIALOG.has(item)) return;
    if (await dialog(page).waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) return;
    if (process.env.X_DEBUG) console.error(`[debug] Insert → ${item} attempt ${attempt}:`, await page.evaluate(() => ({
      dialogs: [...document.querySelectorAll<HTMLElement>("[role=dialog]")].map((d) => `${d.offsetParent ? "shown" : "hidden"}:${d.innerText.slice(0, 60).replace(/\n/g, " ")}`),
      menus: document.querySelectorAll("[role=menu]").length,
      active: document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName,
    })));
  }
  throw new StopError("insert", `Insert → ${item} did not open its dialog.`);
}

async function expectNewBlock(page: Page, before: number, what: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await blockCount(page)) > before) return;
    await page.waitForTimeout(250);
  }
  throw new StopError("insert", `The ${what} block did not appear in the editor.`);
}

// React-controlled fields: Playwright's fill() dispatches the input events React needs.
async function insertCode(page: Page, { lang, code }: SegmentOf<"code">, note: (text: string) => void) {
  const before = await blockCount(page);
  await openInsert(page, "Code");
  const d = dialog(page);
  if (lang) {
    const name = LANG_ALIASES[lang.toLowerCase()] ?? lang;
    await d.locator(SEL.codeLanguage).fill(name);
    const option = page.locator(SEL.typeahead).filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).first();
    if (await option.waitFor({ timeout: 4000 }).then(() => true, () => false)) await option.click();
    else { await d.locator(SEL.codeLanguage).fill(""); note(`X has no code language "${lang}"; inserted without a language`); }
  }
  await d.locator("textarea").fill(code);
  await d.getByRole("button", { name: "Insert", exact: true }).click();
  await waitDialogClosed(page, "Code");
  await expectNewBlock(page, before, "code");
}

async function insertLatex(page: Page, { tex }: SegmentOf<"latex">) {
  const before = await blockCount(page);
  await openInsert(page, "LaTeX");
  const d = dialog(page);
  await d.locator("textarea").fill(tex);
  await d.getByRole("button", { name: "Insert", exact: true }).click();
  await waitDialogClosed(page, "LaTeX");
  await expectNewBlock(page, before, "LaTeX");
}

// Insert a 1×1 table, then replace it with the Markdown table through "Edit block".
async function insertTable(page: Page, { markdown }: SegmentOf<"table">) {
  const before = await blockCount(page);
  await openInsert(page, "Table");
  await page.locator(SEL.tableSize1x1).click();
  await expectNewBlock(page, before, "table");
  const section = page.locator(`${SEL.composer} section:has(table)`).last();
  await section.locator(SEL.editBlock).click();
  const d = dialog(page);
  await d.locator("textarea").fill(markdown);
  await d.getByRole("button", { name: "Update", exact: true }).click();
  await waitDialogClosed(page, "Table");
}

async function insertDivider(page: Page) {
  const before = await blockCount(page);
  await openInsert(page, "Divider");
  await expectNewBlock(page, before, "divider");
}

// X ignores a new media insert while another upload is still running, without an error.
// So wait for uploads to settle, and try again if the block does not appear.
async function uploadsSettled(page: Page, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Uploaded images keep blob: addresses, so only a progress bar shows a running upload.
    const busy = await page.locator(`${SEL.composer} section [role=progressbar]`).count();
    if (!busy) return;
    await page.waitForTimeout(500);
  }
}

async function insertMedia(page: Page, file: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await uploadsSettled(page);
    const before = await blockCount(page);
    await openInsert(page, "Media");
    await page.locator("[role=dialog] input[type=file]").first().setInputFiles(file);
    await waitDialogClosed(page, "Media");
    try {
      await expectNewBlock(page, before, `media (${path.basename(file)})`, 20000);
      await page.waitForTimeout(3000); // let the upload settle before the next media insert
      return;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
}

async function insertPost(page: Page, { url }: SegmentOf<"post">): Promise<boolean> {
  const before = await blockCount(page);
  await openInsert(page, "Posts");
  const d = dialog(page);
  await d.locator("input[type=text]").fill(url);
  const card = d.locator(SEL.postCard).first();
  if (!(await card.waitFor({ timeout: 15000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape");
    return false;
  }
  await card.click();
  await waitDialogClosed(page, "Posts");
  await expectNewBlock(page, before, "post");
  return true;
}

async function setCover(page: Page, file: string) {
  await page.locator(SEL.coverInput).first().setInputFiles(file);
  await page.locator(SEL.applyButton).click({ timeout: 20000 });
  await waitDialogClosed(page, "cover");
}

// Paste HTML as a paste event; X's Draft.js editor converts it to its own blocks.
async function pasteHtml(page: Page, html: string) {
  await caretToEnd(page);
  const lines = html.split(/<\/(?:p|h1|h2|li|blockquote)>/).map(textOf).filter((t) => t.length > 3);
  const probe = (lines.at(-1) || textOf(html)).slice(0, 40);
  const count = async () => squash(await composer(page).innerText()).split(squash(probe)).length - 1;
  const before = await count();
  await composer(page).evaluate((el: HTMLElement, html: string) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    dt.setData("text/plain", tmp.innerText);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
  for (let i = 0; i < 20 && (await count()) <= before; i++) await page.waitForTimeout(250);
  if ((await count()) <= before) throw new StopError("paste", `The editor did not accept pasted content ("${probe}").`);
}

// Compare text without whitespace: tags become spaces in textOf, but not in the editor.
const squash = (t: string) => t.replace(/\s+/g, "");

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

// Count what the editor holds now, read from the page.
async function inspect(page: Page): Promise<{ counts: Record<string, number>; text: string }> {
  return page.locator(SEL.composer).evaluate((el: HTMLElement) => {
    const sections = [...el.querySelectorAll("section")];
    const kind = (s: Element) => s.querySelector("[data-testid=markdown-code-block]") ? "code"
      : s.querySelector("[data-testid=tex-block]") ? "latex"
      : s.querySelector("table") ? "table"
      : s.querySelector("[role=separator]") ? "divider"
      : s.querySelector("[data-testid=simpleTweet]") ? "post"
      : s.querySelector("img, video") ? "media" : "other";
    const counts: Record<string, number> = {};
    for (const s of sections) counts[kind(s)] = (counts[kind(s)] || 0) + 1;
    return { counts, text: el.innerText.replace(/\s+/g, "") };
  });
}

const EXPECT_KIND: Partial<Record<Segment["type"], string>> = { code: "code", latex: "latex", table: "table", divider: "divider", post: "post", image: "media", video: "media", render: "media" };

async function verify(page: Page, article: Article, postsAsLinks: Set<string>): Promise<Check> {
  const { counts, text } = await inspect(page);
  const expected: Record<string, number> = {};
  for (const s of article.segments) {
    const k = s.type === "post" && postsAsLinks.has(s.url) ? null : EXPECT_KIND[s.type];
    if (k) expected[k] = (expected[k] || 0) + 1;
  }
  const missingBlocks = Object.entries(expected).filter(([k, n]) => (counts[k] || 0) < n).map(([k, n]) => `${k}: ${counts[k] || 0}/${n}`);
  const missingText = article.segments
    .filter((s): s is SegmentOf<"html"> => s.type === "html")
    .flatMap((s) => s.html.split(/<\/(?:p|h1|h2|li|blockquote)>/).map(textOf))
    .filter((t) => t.length > 3)
    .map((t) => t.slice(0, 40))
    .filter((t) => !text.includes(squash(t)));
  return { counts, expected, missingBlocks, missingText, verified: !missingBlocks.length && !missingText.length };
}

// Fill a new article and save it as a draft. Nothing here publishes: the user does that in X.
// resume: {draftUrl, fromPart} continues an existing draft from part fromPart (1-based),
// for example after a run stopped halfway.
export async function fillArticle(page: Page, article: Article,
  { log = () => {}, resume = null }: { log?: Log; resume?: Resume | null } = {}): Promise<FillResult> {
  await keepRendering(page);
  let draftUrl: string;
  if (resume) {
    draftUrl = resume.draftUrl;
    await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
    await checkChallenge(page);
    // A deleted draft shows a spinner forever instead of an error.
    await composer(page).waitFor({ timeout: 45000 })
      .catch(() => { throw new StopError("draft", `The draft did not open. Was it deleted? ${draftUrl}`); });
  } else {
    await page.goto(URLS.articles, { waitUntil: "domcontentloaded" });
    await checkChallenge(page);

    log("create article");
    const before = page.url();
    await (await need(page, "createArticle", { timeout: 20000 })).click();
    await page.waitForURL((u) => /\/compose\/articles\/edit\/\d+/.test(u.href) && u.href !== before, { timeout: 20000 })
      .catch(() => { throw new StopError("selector", "X did not open a new article editor."); });
    draftUrl = page.url().replace(/\/(preview|focus)$/, "");
    await composer(page).waitFor({ timeout: 20000 });

    log("title");
    await page.locator(SEL.title).fill(article.title);

    if (article.cover?.file) {
      log("cover image");
      await setCover(page, article.cover.file);
    }
  }

  const notes: string[] = [];
  const postsAsLinks = new Set<string>();
  const start = resume ? resume.fromPart - 1 : 0;
  for (const [i, seg] of article.segments.entries()) {
    if (i < start) continue;
    log(`part ${i + 1}/${article.segments.length}: ${seg.type}`);
    switch (seg.type) {
      case "html": await pasteHtml(page, seg.html); break;
      case "code": await insertCode(page, seg, (n) => notes.push(n)); break;
      case "latex": await insertLatex(page, seg); break;
      case "table": await insertTable(page, seg); break;
      case "divider": await insertDivider(page); break;
      case "image": case "video": case "render":
        if (!seg.file) throw new StopError("assets", `No file for ${seg.type} part ${i + 1}`);
        await insertMedia(page, seg.file);
        break;
      case "post":
        if (!(await insertPost(page, seg))) {
          notes.push(`Post could not be embedded and was added as a link: ${seg.url}`);
          postsAsLinks.add(seg.url);
          await pasteHtml(page, `<p><a href="${seg.url}">${seg.url}</a></p>`);
        }
        break;
    }
  }

  // Check what X saved: reload the draft and read it again.
  log("verify saved draft");
  await page.waitForTimeout(3000);
  await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
  await composer(page).waitFor({ timeout: 45000 })
    .catch(() => { throw new StopError("draft", `The saved draft did not reopen for the check. Was it deleted? ${draftUrl}`); });
  await page.waitForTimeout(2000);
  const check = await verify(page, article, postsAsLinks);
  const titleSaved = (await page.locator(SEL.title).inputValue()) === article.title;
  const result = { draftUrl, titleSaved, ...check, verified: check.verified && titleSaved, notes };

  return result;
}

// Dump the editor's controls so selectors.ts can be fixed against the live page.
export async function probe(page: Page, out: string) {
  await page.goto(URLS.articles, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const dump = async (label: string) => ({
    label,
    url: page.url(),
    controls: await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button,a,[role=button],[role=menuitem],input,textarea,[contenteditable=true],[data-testid]")]
        .filter((el) => el.offsetParent || (el as HTMLInputElement).type === "file")
        .slice(0, 400)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          testid: el.getAttribute("data-testid"),
          aria: el.getAttribute("aria-label"),
          placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder"),
          type: el.getAttribute("type"),
          href: el.getAttribute("href"),
          cls: String((el.className as unknown as SVGAnimatedString)?.baseVal ?? el.className ?? "").slice(0, 80),
          text: (el.innerText || "").trim().slice(0, 60),
        }))),
  });
  const pages = [await dump("articles list")];
  const create = await first(page, SEL.createArticle, { timeout: 5000 });
  if (create) {
    await create.click();
    await page.waitForTimeout(4000);
    pages.push(await dump("editor"));
  }
  await writeFile(out, JSON.stringify(pages, null, 2));
  return { file: out, pages: pages.map((p) => ({ label: p.label, url: p.url, controls: p.controls.length })) };
}
