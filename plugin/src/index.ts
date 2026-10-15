// Adds "Create X draft" to SiYuan. The plugin never publishes: the user publishes the draft in X.
import { Plugin, showMessage } from "siyuan";

const SERVICE = "http://127.0.0.1:6830";

interface DraftResult {
  draftUrl: string;
  verified: boolean;
}

async function call(path: string, body: object): Promise<DraftResult> {
  const res = await fetch(SERVICE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Publisher": "1" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

class XPublisher extends Plugin {
  private onTitleMenu = ({ detail }: CustomEvent) => {
    const id: string | undefined = detail.protyle?.block?.rootID;
    if (!id) return;
    detail.menu.addItem({ icon: "iconUpload", label: "Create X draft", click: () => this.run(id) });
  };

  onload() {
    this.eventBus.on("click-editortitleicon", this.onTitleMenu);

    this.addCommand({
      langKey: "xDraft",
      langText: "Create X draft",
      hotkey: "",
      editorCallback: (protyle) => protyle.block.rootID && this.run(protyle.block.rootID),
    });
  }

  onunload() {
    this.eventBus.off("click-editortitleicon", this.onTitleMenu);
  }

  async run(id: string) {
    try {
      await fetch(SERVICE + "/health");
    } catch {
      showMessage("Publisher service is not running. Start it with npm start in your notetaker-x-publisher folder.", 8000, "error");
      return;
    }
    showMessage("Creating X draft…", 4000);
    try {
      const r = await call("/draft", { id });
      const note = r.verified ? "Review it in the browser window, then publish it in X yourself." : "Some content did not arrive. Check the draft before you publish it in X.";
      showMessage(`X draft created. ${note}`, 10000, r.verified ? "info" : "error");
    } catch (e) {
      showMessage(`X draft failed: ${(e as Error).message}`, 12000, "error");
    }
  }
}

export = XPublisher;
