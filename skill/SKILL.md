---
name: x-articles
description: Make an X (Twitter) Article draft from a note or document in any note-taking app (SiYuan, Notion pages, Obsidian, Markdown files, Word .docx/.doc/.rtf/.odt files, Joplin, Bear, Logseq, or any custom app), through the local Notetaker X Publisher. The tool only makes drafts; the user publishes in X. Use when the user asks to post, publish, draft, or send a note/doc/article to X or Twitter as an Article, preview how a note will look on X, resume a stopped X draft, connect a new note app to the X publisher, or fix the X publisher. Trigger phrases include "publish to X", "post this to X", "X article", "Twitter article", "draft on X", "send note to X", "publish my siyuan doc", "publish this markdown to X", "publish my note to X", "publish this Word doc to X", "docx to X", "publish this Notion page to X", "notion.so link to X".
---

# Notetaker X Publisher

Repo: https://github.com/yuchengzhang966/notetaker-x-publisher (its `README.md` has the full format table).
The tool converts a note or document and fills the X Articles editor in the user's logged-in Brave,
in a dedicated background window, and saves it as a draft. X Articles need X Premium.

**Find the local clone.** This skill is the `skill/` folder of the repo, linked into
`~/.claude/skills/x-articles`, so the clone is the parent folder of this skill's real path:

```sh
REPO=$(cd "$(dirname "$(readlink -f ~/.claude/skills/x-articles/SKILL.md)")/.." && pwd)
```

If there is no clone (the skill was copied alone), ask the user before you install it:

```sh
git clone https://github.com/yuchengzhang966/notetaker-x-publisher.git && cd notetaker-x-publisher && npm install
```

Run every command from `$REPO`, through npm (npm loads `.env`, which holds tokens such as `NOTION_TOKEN`):

```sh
cd "$REPO"
npm run -s cli -- <command> <ref>      # same as node --env-file-if-exists=.env service/cli.ts
```

npm runs the CLI in the repo folder, so give files as **absolute paths**.

## Rules

- **Never publish on behalf of the user.** The tool has no publish command or route; do not add one,
  and do not click Publish in the browser by any other means.
- When the user asks to "publish" or "post", make a draft and tell them to review it in X and click
  **Publish** there themselves.
- Run one job at a time. A second job fails with `busy`.
- Do not close, focus, or move the Brave work window (`notetaker-x-publisher-window`).
- Never ask the user to paste a token or secret into the chat. Never print `.env`.

## Step 1: Identify the content type

Find the type from what the user gives, then use the ref in the "Ref" column. If the type is not
clear (for example "post my launch notes" and the notes could be in SiYuan or a file), search the
likely places (SiYuan with the `siyuan` skill, then files with `mdfind`/`find`). If you find more
than one candidate, ask the user which one.

| The user gives | Type | Ref | Section |
|---|---|---|---|
| SiYuan ID (`20251015151430-ukqxya2`), "my SiYuan note ...", or the current SiYuan doc | SiYuan document | the ID | [A](#a-siyuan-document) |
| Path ending `.md` / `.markdown`, an Obsidian or Logseq note | Markdown file | `/abs/path/note.md` | [B](#b-markdown-file-obsidian-logseq-typora) |
| Path ending `.txt` or other plain text with Markdown in it | Markdown file | `file:/abs/path/note.txt` | [B](#b-markdown-file-obsidian-logseq-typora) |
| Path ending `.docx` | Word document | `/abs/path/post.docx` | [C](#c-word-and-rich-text-documents) |
| Path ending `.doc`, `.rtf`, `.rtfd`, `.odt`, `.wordml`, `.webarchive`, `.html` | Rich-text document | `/abs/path/file.ext` | [C](#c-word-and-rich-text-documents) |
| `notion.so` / `notion.site` URL, or a Notion page ID | Notion page | the URL, or `notion:<id>` | [D](#d-notion-page) |
| Text pasted in the chat, or the clipboard | Markdown text | `-` (stdin) or a temporary `.md` | [E](#e-pasted-text-and-the-clipboard) |
| A note in another app (Joplin, Bear, Apple Notes, Craft, ...) | Other app | `<source>:<ref>` or a temporary `.md` | [F](#f-other-note-apps) |
| `.pages` file, Google Doc | Not read directly | export first | [G](#g-formats-that-must-be-exported-first) |

`npm run -s cli -- sources` lists the source names (built-in: `siyuan`, `file`, `doc`, `notion`, `stdin`,
plus entries from `sources.json`). Any built-in also takes a `name:` prefix, for example `siyuan:<id>`.

## Step 2: Process by type

### A. SiYuan document

- Needs: SiYuan running (API on 127.0.0.1:6806).
- Find the ID from a title with the `siyuan` skill: `search.mjs "<title>"`, or
  `query.mjs "SELECT id, content FROM blocks WHERE type='d' AND content LIKE '%<title>%'"`.
  The ID must be a document (`type='d'`), not a block inside it.
- Title: the document title. A first `# heading` equal to the title is removed.
- Cover: the document attribute `custom-x-cover` set to an asset path (`assets/cover.png`).
- Block references become their anchor text; embeds become the embedded content.
- Status: document attributes `custom-x-status`, `custom-x-draft-url`, `custom-x-error`, `custom-x-updated-at`.
- The user can also use the SiYuan plugin (document title icon → "Create X draft"); that goes through
  the service on port 6830.

### B. Markdown file (Obsidian, Logseq, Typora, ...)

- Title: front matter `title`, else the first `# ` heading (removed from the body), else the file name.
- Cover: front matter `cover` (or `x_cover`, `image`), relative to the file, or a URL.
- Images: relative to the file. Remote images are downloaded. Obsidian `![[image.png]]` is found in the
  note folder or anywhere in the vault (the folder with `.obsidian`); `[[Note|text]]` becomes `text`.
- Status: written to the front matter (`x_status`, `x_draft_url`, `x_error`, `x_updated_at`).
  Other lines of the file are not changed. Tell the user the file was changed.
- The same Markdown rules apply to every type below that produces Markdown.

### C. Word and rich-text documents

- `.docx` (mammoth): headings, bold, italic, strikethrough, links, lists, tables, images and footnotes are
  kept. Title: the Word "Title" style, else the first heading 1, else the file name. Word styles "Quote"
  and "Code" become a quote and a code block.
- `.doc`, `.rtf`, `.rtfd`, `.odt`, `.wordml`, `.webarchive` (macOS `textutil`): there are no heading styles,
  so larger fonts become headings (largest = heading 1) and bullet lines become lists. **Images are lost**
  except in `.rtfd` and `.webarchive`; links can be lost in `.doc`. If the document has images or the
  preview shows no headings, ask the user to save it as `.docx` and use that.
- `.html`: read as is; relative images resolve against the file's folder.
- Cover: put `<document name>.cover.png` (or `.jpg`, `.jpeg`, `.webp`) next to the document.
- Text is literal: `$5`, `==` and `#word#` stay as typed. Colors, fonts, comments and tracked changes are
  dropped. A table cell keeps one line.
- Status: the document is not changed; status goes to the repo's `.status/`.
- To check a conversion, read the newest `.cache/docs/<hash>/document.md`.

### D. Notion page

- Needs `NOTION_TOKEN` (in `.env` or the environment). Check without printing it:
  `grep -q '^NOTION_TOKEN=' .env 2>/dev/null || [ -n "$NOTION_TOKEN" ]`.
- No token: tell the user the one-time set-up (README "Notion pages"): create a connection at
  https://www.notion.so/profile/integrations with Read content (and Update content to save status), put the
  secret in `.env` as `NOTION_TOKEN=...` themselves, and share the page with the connection (page `•••`
  menu → Connections). Without set-up, a one-off is possible if a Notion MCP connector is authorized:
  fetch the page as Markdown and use [E](#e-pasted-text-and-the-clipboard); tell the user that callouts,
  toggles and images may need a check.
- Ref: the page URL (`https://www.notion.so/...-<32 hex>`, `notion.site` too) or `notion:<page id>`.
- Title: the page title. Cover: the page cover. Images and the cover are downloaded (Notion links expire).
- Changes: callouts become quotes with their emoji; toggles and toggle headings are expanded (title in
  bold); columns become one column; mentions become links or text; Notion tables become X tables;
  bookmarks and embeds become their URL (an X post URL becomes an embedded post); files, PDFs, audio,
  child pages and databases become links; the table of contents and colors are dropped.
- Status: `.status/`, plus the page properties `X Status` (select/status/text), `X Draft URL`,
  `X Error` when the page has them (for example a "drafts" database).
- Errors: "Is the page shared with your Notion connection" = share the page; "API token is invalid" =
  the user replaces the token in `.env`.

### E. Pasted text and the clipboard

- Text in the chat: write it to a new empty folder in `$TMPDIR` as `note.md` (with images next to it under
  relative paths, if any), then use [B](#b-markdown-file-obsidian-logseq-typora) on that file.
  Tell the user that the status is saved in that temporary file only.
- Markdown on stdin: `pbpaste | npm run -s cli -- preview -`. Status is not saved anywhere.
- If `sources.json` has a `clipboard` source: `clipboard:` (nothing after the colon).

### F. Other note apps

1. If `npm run -s cli -- sources` lists a source for the app, use `<source>:<ref>` (or a plain ref that
   matches its `match` pattern). Its status goes where its `status` command or `setStatus` puts it; with
   neither, the status is not saved (the log says so), so give the user the URLs to keep.
2. **One-off** (no source): get the note as Markdown (the app's Markdown export, its API, an MCP tool, or
   the clipboard), then use [E](#e-pasted-text-and-the-clipboard). For an app that exports Word, use [C](#c-word-and-rich-text-documents).
3. **Connect the app** (only when the user asks for repeated use): add an entry to `sources.json` in the repo
   (start from `sources.example.json`; the file is git-ignored). See README "Other note apps". In short:
   - `load`: shell command; the ref is `$1` (never paste the ref into the command text). It prints Markdown
     or JSON `{markdown, title, baseDir, cover, status, frontMatter}`.
   - `status` (optional): shell command; the ref is `$1`, the status fields are JSON on stdin.
   - `module` (instead of commands): `.ts` file exporting `load(ref, {log})` and optionally `setStatus(ref, fields)`
     (types `Note`, `NoteModule` in `service/types.ts`; example `examples/url-source.ts`).
   - `match` (optional): regex for refs that go to this source without the `name:` prefix.
   Test with `preview <name>:<ref>` before any draft. Credentials go in `.env`, never in `sources.json`.

### G. Formats that must be exported first

- Apple Pages (`.pages`): ask the user to export (File → Export To → Word), then [C](#c-word-and-rich-text-documents).
- Google Docs: File → Download → Microsoft Word (`.docx`), then [C](#c-word-and-rich-text-documents);
  or Markdown (`.md`), then [B](#b-markdown-file-obsidian-logseq-typora).
- PDF: not supported as a source. Ask for the original document.

## Step 3: Preview, draft, report

1. **Check the services** (both are LaunchAgents and normally run):
   ```sh
   curl -s -m 3 127.0.0.1:6830/health            # service → {"ok":true}
   curl -s -m 3 127.0.0.1:9333/json/version      # bridge → "notetaker-x-publisher bridge"
   ```
   The CLI does not need the service (port 6830); only app plugins use it (POST `/preview` or
   `/draft` with `{ref}`). The CLI needs the bridge, or Brave asks "allow debugging?" for each job.
   If the bridge is down: `launchctl kickstart -k gui/$(id -u)/local.notetaker-x-publisher.bridge`,
   then tell the user to click **Allow** in Brave.

2. **Preview** (no browser, safe):
   ```sh
   npm run -s cli -- preview <ref>
   ```
   Output JSON: `title`, `cover`, `missing` (image files not found), `report` (format changes for this
   type), `segments` (the parts to insert). Tell the user the title, the cover, the number of parts,
   and the `report` items. If `missing` is not empty, stop and report the files; the job would fail
   with `assets`. If the title or structure looks wrong, fix it at the source (see Step 2) first.

3. **Draft**:
   ```sh
   npm run -s cli -- draft <ref>
   ```
   Allow up to 10 minutes (images and Mermaid take time). Run in the background for long documents.
   The result JSON has `draftUrl`, `verified`, and when not verified `titleSaved`, `missingBlocks`,
   `missingText`. If not verified, tell the user what is missing before they publish.

4. **Report** the draft URL, `verified`, the `report` items, and where the status was saved (the
   "Status" line of the type in Step 2). The draft stays open in the work tab. Tell the user to review
   it and click **Publish** in X themselves.

## Errors

The CLI does not catch errors: Node prints a stack trace with the message and a `code` field.

| Code | Meaning | Action |
|---|---|---|
| `busy` | Another job runs | Wait, then try again |
| `assets` | Image files not found | Fix the paths in the source |
| `browser` | Brave did not accept the debugging connection | User clicks **Allow** in Brave, try again |
| `login` | X is not logged in | User logs in to X in Brave |
| `challenge` | X asks for verification | User finishes it in the open tab |
| `selector`, `insert`, `dialog`, `paste` | X page changed or was slow | Try once again; if it fails again, see Repair |
| `draft` | Draft URL did not open (deleted?) | Make a new draft |
| (none) `No source for "..."` | Ref matches no type | Go back to Step 1; use a `name:` prefix from `sources` |
| (none) `NotionError` | Notion token or sharing problem | See [D](#d-notion-page) |
| (none) `"<cmd>" exited with n` | A `sources.json` command failed | Run the command by hand with the ref, fix it |

**Stopped halfway:** the log shows `part n/N`. Continue the same draft from part n:
```sh
npm run -s cli -- resume <ref> <draftUrl> <n>
```

## Repair

- Step log: prefix the command with `X_DEBUG=1`.
- The code is TypeScript that Node runs directly. After a code change run `npm run typecheck`
  (strict `tsc`); keep to Node-erasable syntax (no enums, namespaces, parameter properties) and `import type`.
- Notion conversion: test with the mock API in `test/notion/mock-api.ts` (see README "Notion pages").
- X changed its editor: run `npm run probe` (writes `probe.json` with the editor controls), then
  update `service/selectors.ts`. All X page assumptions are in that file.
- Service logs: `~/Library/Logs/notetaker-x-publisher/`. If the LaunchAgents are missing or point to an
  old path, run `npm run install-agents` (one Brave prompt).
- Restart the service with `launchctl kickstart -k gui/$(id -u)/local.notetaker-x-publisher.server`
  (no Brave prompt). Restarting the bridge makes one Brave prompt.
