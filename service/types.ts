// Shared types. Type-only file: import it with `import type`.

export type Log = (message: string) => void;

export type RenderKind = "mermaid" | "math" | "table";

// One part of an article, in editor order (see convert.ts for how each is inserted).
export type Segment =
  | { type: "html"; html: string }
  | { type: "code"; lang: string; code: string }
  | { type: "latex"; tex: string }
  | { type: "table"; markdown: string }
  | { type: "divider" }
  | { type: "image"; src: string; alt: string; file: string | null }
  | { type: "video"; src: string; file: string }
  | { type: "render"; kind: RenderKind; source: string; file?: string; alt?: string }
  | { type: "post"; url: string };

export interface Asset {
  src: string;
  file: string | null;
}

// A note from any source, converted and ready for X.
export interface Article {
  id: string;
  source: string;
  title: string;
  markdown: string;
  segments: Segment[];
  report: string[];
  cover: Asset | null;
  missing: Asset[];
  status: string;
}

// What a sources.json command or module returns. Only markdown is required.
export interface Note {
  markdown: string;
  title?: string;
  baseDir?: string;
  cover?: string;
  status?: string;
  frontMatter?: boolean;
}

// Draft status written back to a source: status, draft-url, error, updated-at.
export type StatusFields = Record<string, string | null | undefined>;

export interface SourceAdapter {
  match(ref: string): boolean;
  load(ref: string, opts: { log: Log }): Promise<Article>;
  setStatus(ref: string, fields: StatusFields): Promise<void>;
}

// A sources.json "module": a .ts or .js file with these exports.
export interface NoteModule {
  load(ref: string, opts: { log: Log }): Promise<Note>;
  setStatus?(ref: string, fields: StatusFields): Promise<void>;
}
