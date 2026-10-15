// The part of SiYuan's plugin API that this plugin uses. SiYuan provides the module at runtime.
declare module "siyuan" {
  interface Protyle { block: { rootID?: string } }

  export class Plugin {
    eventBus: {
      on(type: string, listener: (event: CustomEvent) => void): void;
      off(type: string, listener: (event: CustomEvent) => void): void;
    };
    addCommand(command: { langKey: string; langText: string; hotkey: string; editorCallback?: (protyle: Protyle) => void }): void;
    onload(): void;
    onunload(): void;
  }

  export function showMessage(text: string, timeout?: number, type?: "info" | "error"): void;
}
