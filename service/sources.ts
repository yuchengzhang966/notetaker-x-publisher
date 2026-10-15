// Where articles come from. A ref names a note in some app:
//   20251015151430-ukqxya2        SiYuan document ID
//   notes/My Article.md           Markdown file (Obsidian, Logseq, Typora, ...)
//   reports/Q3.docx               Word document; also .doc, .rtf, .rtfd, .odt, .html
//   https://www.notion.so/...     Notion page URL (or notion:<page id>); needs NOTION_TOKEN
//   -                             Markdown on stdin (command line only)
//   <source>:<ref>                any source by name, built-in or from sources.json
//
// Other apps are added in sources.json (see sources.example.json). Each entry is either
//   { "load": "<shell command>", "status": "<shell command>" }   or   { "module": "./adapter.ts" }
// A load command gets the ref as $1 and prints Markdown, or JSON
//   { "markdown": "...", "title", "baseDir", "cover", "status", "frontMatter" }  (only markdown is required).
// A status command gets the ref as $1 and the status fields as JSON on stdin.
// A module (.ts or .js) exports load(ref, { log }) returning the same object, and optionally setStatus(ref, fields).
// The shapes are Note and NoteModule in types.ts.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadArticle, setStatus } from "./siyuan.ts";
import { isMarkdownFile, loadFile, loadMarkdown, setFileStatus } from "./markdown-file.ts";
import { isDocFile, loadDoc, setDocStatus } from "./doc-file.ts";
import { isNotionUrl, loadNotion, setNotionStatus } from "./notion.ts";
import type { Article, Log, Note, NoteModule, SourceAdapter, StatusFields } from "./types.ts";

// One entry of sources.json.
interface SourceSpec {
  load?: string;
  status?: string;
  module?: string;
  match?: string;
}

// A resolved ref, ready to use.
export interface Source {
  name: string;
  ref: string;
  load(log?: Log): Promise<Article>;
  setStatus(fields: StatusFields): Promise<void>;
}

const CONFIG = path.resolve(process.env.X_SOURCES || path.join(import.meta.dirname, "..", "sources.json"));
const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;

const builtins: Record<string, SourceAdapter> = {
  siyuan: {
    match: (ref) => SIYUAN_ID.test(ref),
    load: (ref) => loadArticle(ref),
    setStatus: (ref, f) => setStatus(ref, f),
  },
  file: {
    match: isMarkdownFile,
    load: (ref, { log }) => loadFile(ref, { log }),
    setStatus: (ref, f) => setFileStatus(ref, f),
  },
  doc: {
    match: isDocFile,
    load: (ref, { log }) => loadDoc(ref, { log }),
    setStatus: (ref, f) => setDocStatus(ref, f),
  },
  notion: {
    match: isNotionUrl,
    load: (ref, { log }) => loadNotion(ref, { log }),
    setStatus: (ref, f) => setNotionStatus(ref, f),
  },
};

let stdinText: string | undefined;
const stdin: SourceAdapter = {
  match: () => false,
  async load(_ref, { log }) {
    stdinText ??= await new Promise<string>((resolve, reject) => {
      let text = "";
      process.stdin.setEncoding("utf8").on("data", (c: string) => (text += c)).on("end", () => resolve(text)).on("error", reject);
    });
    log("stdin: status is not saved anywhere");
    return { ...(await loadMarkdown(stdinText, { log })), id: "-", source: "stdin" };
  },
  setStatus: async () => {},
};

// Run a sources.json command with the ref as $1 (never pasted into the command text).
function run(cmd: string, ref: string, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd, "sh", ref], { cwd: path.dirname(CONFIG), env: { ...process.env, X_REF: ref } });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`"${cmd}" exited with ${code}: ${err.trim()}`)));
    child.stdin.end(input);
  });
}

function parseOutput(out: string): Note {
  const text = out.trim();
  if (text.startsWith("{")) {
    try {
      const note = JSON.parse(text);
      if (typeof note.markdown === "string") return note;
    } catch {}
  }
  return { markdown: out };
}

function configured(name: string, spec: SourceSpec): SourceAdapter {
  const base = path.dirname(CONFIG);
  let mod: NoteModule | undefined;
  const loadModule = async (file: string): Promise<NoteModule> =>
    (mod ??= (await import(pathToFileURL(path.resolve(base, file)).href)) as NoteModule);
  const { module, load, status, match } = spec;
  const fetchNote = module
    ? async (ref: string, opts: { log: Log }) => (await loadModule(module)).load(ref, opts)
    : async (ref: string) => parseOutput(await run(load!, ref));

  return {
    match: match ? (ref) => new RegExp(match).test(ref) : () => false,
    async load(ref, { log }) {
      const note = await fetchNote(ref, { log });
      if (typeof note?.markdown !== "string") throw new Error(`Source "${name}" returned no markdown for ${ref}`);
      const hasStatus = module ? !!mod?.setStatus : !!status;
      if (!hasStatus) log(`${name}: no status command; status is not saved back`);
      const article = await loadMarkdown(note.markdown, {
        dir: note.baseDir ? path.resolve(base, note.baseDir) : base,
        title: note.title, cover: note.cover, status: note.status,
        frontMatter: note.frontMatter !== false, fallbackTitle: ref || name, log,
      });
      return { ...article, id: ref, source: name };
    },
    async setStatus(ref, fields) {
      const values = { ...fields, "updated-at": new Date().toISOString() };
      if (module) await (await loadModule(module)).setStatus?.(ref, values);
      else if (status) await run(status, ref, JSON.stringify(values));
    },
  };
}

export function sources(): Record<string, SourceAdapter> {
  const all = { ...builtins };
  if (existsSync(CONFIG)) {
    const config = JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, SourceSpec>;
    for (const [name, spec] of Object.entries(config)) {
      if (name.startsWith("_")) continue; // comments
      if (all[name] || name === "stdin") throw new Error(`${CONFIG}: "${name}" is a built-in source name`);
      if (!spec.load && !spec.module) throw new Error(`${CONFIG}: source "${name}" needs "load" or "module"`);
      all[name] = configured(name, spec);
    }
  }
  return all;
}

export function sourceFor(ref: string): Source {
  if (!ref) throw new Error("No document given");
  const all = sources();
  let name: string | undefined, inner = ref;
  const prefixed = ref.match(/^([a-z][\w-]*):(.*)$/is);
  if (ref === "-") name = "stdin";
  else if (prefixed && all[prefixed[1]]) [, name, inner] = prefixed as unknown as [string, string, string];
  else name = Object.keys(all).find((n) => all[n].match(ref));
  if (!name) throw new Error(`No source for "${ref}". Use a SiYuan ID, a .md or .docx file, a Notion URL, "-", or <source>:<ref> with one of: ${Object.keys(all).join(", ")}`);
  const src = name === "stdin" ? stdin : all[name];
  return {
    name, ref: inner,
    load: (log = () => {}) => src.load(inner, { log }),
    setStatus: (fields: StatusFields) => src.setStatus(inner, fields),
  };
}
