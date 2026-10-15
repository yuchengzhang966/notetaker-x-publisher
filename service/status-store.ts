// Draft status for sources that cannot hold it themselves (Word documents, Notion pages without
// X properties). One JSON file per source in .status/, keyed by a stable name such as a file path.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StatusFields } from "./types.ts";

const STATUS = path.resolve(import.meta.dirname, "..", ".status");
const fileFor = (name: string) => path.join(STATUS, `${createHash("sha1").update(name).digest("hex").slice(0, 16)}.json`);

export async function readStatus(name: string): Promise<Record<string, string>> {
  const f = fileFor(name);
  return existsSync(f) ? JSON.parse(await readFile(f, "utf8")) : {};
}

export async function writeStatus(name: string, fields: StatusFields): Promise<void> {
  const old = await readStatus(name);
  await mkdir(STATUS, { recursive: true });
  await writeFile(fileFor(name), JSON.stringify({ ...old, source: name, ...fields, "updated-at": new Date().toISOString() }, null, 2) + "\n");
}
