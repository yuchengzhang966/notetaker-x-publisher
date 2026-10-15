// Command line: login, probe, sources, preview, draft, resume. There is no publish command:
// the user publishes the draft in X.
import path from "node:path";
import { openBrowser, loginStatus, probe } from "./x.ts";
import { createDraft, sourceFor } from "./draft.ts";
import { sources } from "./sources.ts";
import { URLS } from "./selectors.ts";

const [cmd, id = "", ...flags] = process.argv.slice(2);

switch (cmd) {
  case "login": {
    const { page, onClosed } = await openBrowser();
    if (await loginStatus(page)) console.log("Already logged in to X in the publisher profile.");
    else {
      await page.goto(URLS.login);
      console.log("Sign in to X in the opened tab. Close the tab when you are done.");
    }
    await new Promise<void>((r) => onClosed(r));
    break;
  }
  case "probe": {
    const { page, close } = await openBrowser();
    const out = path.resolve(import.meta.dirname, "..", "probe.json");
    console.log(await probe(page, out));
    await close();
    break;
  }
  case "sources":
    console.log(Object.keys(sources()).concat("stdin").join("\n"));
    break;
  case "preview": {
    const a = await sourceFor(id).load(console.error);
    console.log(JSON.stringify({ title: a.title, cover: a.cover, missing: a.missing, report: a.report, segments: a.segments }, null, 2));
    break;
  }
  case "resume": {
    // resume <ref> <draftUrl> <fromPart>: continue a draft that stopped halfway
    const [draftUrl, fromPart] = flags;
    const result = await createDraft(id, { resume: { draftUrl: draftUrl ?? "", fromPart: Number(fromPart) } });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  case "draft": {
    const result = await createDraft(id);
    console.log(JSON.stringify(result, null, 2));
    console.log("Review the draft in the opened tab and publish it in X yourself. This tool does not publish.");
    process.exit(0);
  }
  default:
    console.log(`Usage: node service/cli.ts <command>
  login | probe | sources
  preview <ref>
  draft   <ref>
  resume  <ref> <draftUrl> <fromPart>

This tool only makes drafts. Publish them in X yourself.

<ref>: SiYuan document ID, path to a .md or Word file (.docx .doc .rtf .odt .html),
       Notion page URL (or notion:<page id>), - (Markdown on stdin),
       or <source>:<ref> for a source in sources.json`);
}
