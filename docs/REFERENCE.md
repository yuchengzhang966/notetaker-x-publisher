# Notetaker X Publisher: reference

Manual use and details. To use it through an agent, see the [README](../README.md).

## Quick start

```sh
git clone https://github.com/yuchengzhang966/notetaker-x-publisher.git
cd notetaker-x-publisher
npm install
npm run bridge                              # keep one DevTools connection to Brave (click "Allow" once)
npm run cli -- preview "$HOME/Notes/My Article.md"   # see the parts and the format changes, no browser
npm run cli -- draft   "$HOME/Notes/My Article.md"   # fill a new X Article draft
```

Open the draft in the browser window, read it, and click **Publish** in X when it is correct.

## Supported formats

Every command takes a **ref**: what to read. npm runs the command in this folder, so give file paths
as absolute paths (or relative to this folder).

| Your article | Ref | Notes |
|---|---|---|
| Markdown, Obsidian, Logseq, Typora | `path/to/note.md` | [Markdown files](#markdown-files) |
| Plain text with Markdown in it | `file:path/to/note.txt` | Same rules as Markdown |
| Word | `path/to/post.docx` | Full structure and images. [Word and rich text](#word-and-rich-text) |
| Older Word, RTF, OpenDocument | `.doc`, `.rtf`, `.rtfd`, `.odt`, `.wordml`, `.webarchive` | Headings from font size; few images |
| HTML | `path/to/page.html` | Read as is |
| Notion | a page URL, or `notion:<page id>` | [Notion pages](#notion-pages) |
| SiYuan | a document ID, or the plugin menu | [SiYuan](#siyuan) |
| Clipboard or any text | `-` (stdin): `pbpaste \| npm run cli -- draft -` | |
| Another note app | `<source>:<ref>` | [Connect any note app](#connect-any-note-app) |
| Apple Pages, Google Docs | export to `.docx` or `.md` first | |
| PDF | not supported | Use the original document |

`npm run cli -- sources` lists the sources you can use.

## Commands

```sh
npm run cli -- preview <ref>     # the parts, the cover, missing images and format changes; no browser
npm run cli -- draft <ref>       # make an X Article draft
npm run cli -- resume <ref> <draftUrl> <n>   # continue a draft that stopped at part n
npm run cli -- sources           # list sources
npm run probe                    # write the X editor controls to probe.json (when X changes its page)
```

The draft result is JSON: `draftUrl`, `verified`, and the `report` of format changes. When `verified` is
false, it also gives `titleSaved`, `missingBlocks` and `missingText`. Check those parts before you publish.

Tokens such as `NOTION_TOKEN` go in `.env` in this folder (git-ignored). The npm scripts read it.

## How it works

```
your article ──▶ source (sources.ts) ──▶ Markdown
                   │ convert.ts   Markdown → X-safe parts, plus a report of changes
                   │ render.ts    Mermaid → PNG
                   └ x.ts         fill the X Articles editor in Brave over CDP, then check the draft
                                  via bridge.ts (127.0.0.1:9333)
```

Each source writes a small status back (for example `draft`, the draft URL, or an error), so you can see
which articles have drafts. The sections below say where each source keeps it.

## Format mapping

| In your article | In the X Article |
|---|---|
| Highest heading level / all others | Heading / subheading |
| Bold, italic, strikethrough, links, nested lists, quotes | Kept |
| Code blocks | X code block with language |
| Block math | X LaTeX block |
| Tables | X table (column alignment is lost) |
| Horizontal rule | X divider |
| Images | Uploaded media |
| Mermaid | Drawn as a PNG image |
| Footnotes | `[n]` markers and a Notes section |
| Task lists | ☐ / ☑ bullets |
| Callouts | Quote with a bold label |
| Highlight | Bold |
| Underline, keyboard keys | Plain text |
| Superscript, subscript | Unicode, else `^()` / `_()` |
| Tags `#tag#` | `#tag` |
| Inline math, inline code | Plain text |
| Images in a paragraph | Own line |
| Local video | Uploaded |
| YouTube, remote audio/video | Links |
| X post URL on its own line | Embedded post |

Every change is listed in `report` (preview and draft results).

## Markdown files

```sh
npm run cli -- draft "$HOME/Notes/My Article.md"
```

- Title: front matter `title`, else the first `# ` heading (removed from the body), else the file name.
- Cover: front matter `cover` (or `x_cover`, `image`), relative to the file, or a URL.
- Images: paths relative to the file. Remote images are downloaded to `.cache/remote` and uploaded.
- Obsidian: `![[image.png]]` is found in the note's folder or anywhere in the vault (the folder with
  `.obsidian`). `[[Note|text]]` becomes plain text.
- Status: written to the front matter as `x_status`, `x_draft_url`, `x_error`, `x_updated_at`.
  Other lines are not changed. A front matter block is added if the file has none.

## Word and rich text

```sh
npm run cli -- draft "$HOME/Documents/Launch post.docx"
```

- `.docx`: read with mammoth. Headings, bold, italic, strikethrough, links, lists, tables, images and
  footnotes are kept. The Word "Title" style (else the first heading 1) becomes the article title,
  else the file name. Word styles "Quote" and "Code" become a quote and a code block.
- `.doc`, `.rtf`, `.rtfd`, `.odt`, `.wordml`, `.webarchive`: read with macOS `textutil`. These formats
  give no heading styles, so larger fonts become headings (the largest is heading 1) and bullet lines
  become lists. Images are read only from `.rtfd` and `.webarchive`; save as `.docx` to keep images.
- `.html`: read as is; relative images resolve against the file's folder.
- Cover: an image named `<document name>.cover.png` (or `.jpg`, `.jpeg`, `.webp`) next to the document.
- Text is literal: `$5`, `==` and `#word#` are not read as math, highlight or tags.
- Colors, fonts, comments and tracked changes are dropped. Table cells hold one line.
- Status: the document is not changed. The status goes to `.status/<hash>.json` in this folder
  (git-ignored). Deleting `.status/` only removes that history.
- The converted Markdown and images are in `.cache/docs/<hash>/` (`document.md`) for checks.

## Notion pages

```sh
npm run cli -- draft "https://www.notion.so/myteam/Launch-Notes-0123abcd0123456789ab0123456789ab"
npm run cli -- draft notion:0123abcd0123456789ab0123456789ab
```

Set-up, once:

1. Create an internal connection at <https://www.notion.so/profile/integrations> with **Read content**
   (add **Update content** to save the status on the page).
2. Put its secret in `.env` in this folder: `NOTION_TOKEN=ntn_...`
3. Share each page with the connection: page `•••` menu → **Connections** → your connection.
   Sharing a parent page shares the pages under it.

The page is read with Notion's Markdown endpoint (`GET /v1/pages/:id/markdown`). Notion's own tags are
changed to standard Markdown, and the result goes through the usual steps.

- Title: the page title. Cover: the page cover (Notion's own covers and uploaded ones).
- Images and the cover are downloaded (Notion file links expire after a short time) and uploaded to X.
- Callouts become quotes with their emoji. Toggles and toggle headings are expanded (the toggle title
  becomes bold). Columns become one column. Mentions become links or text. Tables become X tables.
- Bookmarks, embeds and link previews become their URL; an X post URL becomes an embedded post.
- Files, PDFs, audio, child pages and databases become links. The table of contents and text colors are dropped.
- Status: in `.status/` always, and on the page when it has properties named `X Status` (select, status
  or text), `X Draft URL` (URL or text) or `X Error`. A Notion database with these properties gives a
  drafts board.
- `test/notion/mock-api.ts` is a stand-in Notion API for tests:
  `node test/notion/mock-api.ts` then `NOTION_API=http://127.0.0.1:8790/v1 NOTION_TOKEN=test npm run cli -- preview notion:0123abcd-0123-4567-89ab-0123456789ab`.

## SiYuan

Use the document ID as the ref, or use the plugin:

```sh
npm start                    # HTTP service on 127.0.0.1:6830 (SiYuan itself uses 6806 and 6810)
npm run install-plugin       # build the plugin and copy it into ~/SiYuan/data/plugins, then reload SiYuan
```

In SiYuan, click the document icon next to the title, then **Create X draft**. The plugin only makes
drafts.

- Title: the document title. A first `# heading` that is the same as the title is removed.
- Cover: set the document attribute `custom-x-cover` to an asset path such as `assets/cover.png`.
- Block references become their anchor text. Embeds become the embedded content.
- Status: document attributes `custom-x-status` (drafting, draft, failed), `custom-x-draft-url`,
  `custom-x-error`, `custom-x-updated-at`.

## Connect any note app

Any app that can give its note as Markdown works. Without set-up: export the note to a `.md` file, or
pipe it in (`pbpaste | npm run cli -- draft -`). To use the app's own note IDs and save the status back
in the app, add a source to `sources.json` (copy `sources.example.json`; set `X_SOURCES` for another path).

```json
{
  "joplin": {
    "load": "curl -sf \"http://127.0.0.1:41184/notes/$1?fields=title,body&token=$JOPLIN_TOKEN\" | jq '{title, markdown: .body}'",
    "status": "my-joplin-tag \"$1\"",
    "match": "^[0-9a-f]{32}$"
  },
  "web": { "module": "./examples/url-source.ts" }
}
```

Then `npm run cli -- draft joplin:<noteId>` (or only the ID when `match` fits it).

- `load`: a shell command. It gets the ref as `$1` (and `$X_REF`) and runs in the folder of `sources.json`.
  It prints Markdown, or JSON `{ "markdown", "title", "baseDir", "cover", "status", "frontMatter" }`
  (only `markdown` is required). Markdown gets the same title, cover, front matter, Obsidian and remote
  image rules as a `.md` file. Relative images resolve against `baseDir` (default: the config folder).
- `status`: optional. It gets the ref as `$1` and JSON on stdin: `status`, `draft-url`, `error`,
  `updated-at`. Without it the status is not saved.
- `module`: a `.ts` (or `.js`) file instead of commands. It exports `load(ref, { log })` that returns the
  same object, and optionally `setStatus(ref, fields)`. The types are `Note` and `NoteModule` in
  `service/types.ts`; see `examples/url-source.ts`.
- `match`: optional regex, so plain refs that fit it go to this source without the `name:` prefix.

**HTTP service.** `npm start` serves `POST /preview` and `POST /draft` with `{ "ref": "..." }` for any
source (`{ "id" }` also works), with the header `X-Publisher: 1`. A plugin in another app can call it as
the SiYuan plugin does. Apps other than SiYuan need their origin in `PUBLISHER_ORIGINS`
(comma-separated, for example `app://obsidian.md`).

## Browser

Start Brave with remote debugging. `bridge.ts` holds ONE DevTools connection to Brave and serves it
at `ws://127.0.0.1:9333`, so Brave asks "allow debugging?" only when the bridge starts, not for each job.
Jobs run one at a time.

The tool works in one dedicated Brave window (`window.name = notetaker-x-publisher-window`).
It creates the window in the background if it is missing, uses it again after that, and never brings it
to the front. Keep this window at least partly visible: a fully covered or minimized window can stop
rendering. Do not close it between jobs.

Without the bridge, the tool reads `DevToolsActivePort` directly (one prompt for each job).
Set `X_CDP=ws://...` to choose an endpoint, or `X_BROWSER=profile` to use a separate Chrome profile
in `.chrome-profile/` (`npm run login` once). If X shows a login or verification screen, the job
stops and leaves the page open. Set `X_DEBUG=1` for a step log.

## Start at login

`launchd/` has two LaunchAgent templates (bridge and service). Install or reload them with:

```sh
npm run install-agents       # fills in this clone's paths, loads local.notetaker-x-publisher.{bridge,server}
```

Logs: `~/Library/Logs/notetaker-x-publisher/`. Restarting the service makes no Brave prompt;
restarting the bridge (or Brave) makes one.

## Development

All code is TypeScript. Node (24 or later) runs the `.ts` files directly, so the service has no build step.
Only Node-erasable syntax is used (no enums, namespaces or parameter properties), and type-only imports use
`import type`. The SiYuan plugin (`plugin/src/`) is compiled to `plugin/dist/index.js`, because SiYuan loads JavaScript.

```sh
npm run typecheck            # strict tsc over service/, examples/ and plugin/
npm run build-plugin         # plugin/src -> plugin/dist/index.js (install-plugin does this)
```

All X page assumptions are in `service/selectors.ts`. When X changes its editor, run `npm run probe`
and update that file.
