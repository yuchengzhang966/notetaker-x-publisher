// One draft job: a note from any source (see sources.ts) -> a draft in the X Articles editor -> status back
// on the source. The tool never publishes: the user reviews the draft and publishes it in X.
import { sourceFor } from "./sources.ts";
import { openBrowser, fillArticle, StopError, type FillResult, type Resume } from "./x.ts";
import { renderSegments } from "./render.ts";
import type { Log } from "./types.ts";

export interface DraftOptions {
  resume?: Resume | null;
  log?: Log;
}

let busy = false;

export { sourceFor };

export async function createDraft(ref: string, { resume = null, log = console.log }: DraftOptions = {}): Promise<FillResult & { title: string; report: string[] }> {
  if (busy) throw new StopError("busy", "Another draft is being made. Wait for it to finish.");
  const source = sourceFor(ref);
  const article = await source.load(log);
  if (article.missing.length) {
    throw new StopError("assets", `Image files not found: ${article.missing.map((m) => m.src).join(", ")}`);
  }

  busy = true;
  let tab;
  try {
    await source.setStatus({ status: "drafting", error: "" });
    await renderSegments(article.segments, log);
    tab = await openBrowser();
    const result = await fillArticle(tab.page, article, { log, resume });
    await source.setStatus({ status: "draft", "draft-url": result.draftUrl, error: result.verified ? "" : `Check the draft: ${JSON.stringify({ titleSaved: result.titleSaved, missingBlocks: result.missingBlocks, missingText: result.missingText })}` });
    // The draft stays open in the work tab for the user to review and publish.
    return { title: article.title, report: article.report, ...result };
  } catch (err) {
    await source.setStatus({ status: "failed", error: (err as Error).message }).catch(() => {});
    throw err; // the work tab stays as it was, so you can see what happened
  } finally {
    await tab?.close(); // disconnect only
    busy = false;
  }
}
