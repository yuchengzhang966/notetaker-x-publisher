// Every X page assumption lives here; checked against the live editor on 2026-10-14.
// When X changes its UI and a step fails, run `npm run probe` and adjust these.
export const URLS = {
  home: "https://x.com/home",
  login: "https://x.com/i/flow/login",
  articles: "https://x.com/compose/articles",
};

export const SEL = {
  // Signs that X wants a person, not a script.
  challenge: [
    "iframe[src*='arkoselabs']",
    "iframe[src*='captcha']",
    "text=/verify your identity|unusual login activity|confirm your identity/i",
  ],
  createArticle: ["button[aria-label='create']", "[data-testid='empty_state_button_text']"],
  title: "textarea[placeholder='Add a title']",
  composer: "[data-testid='composer']",
  coverInput: "input[data-testid='fileInput']:not([role=dialog] *)",
  applyButton: "[data-testid='applyButton']",
  insertButton: "button[aria-label='Add Media']",
  // The [role=dialog] element is a zero-size wrapper; the visible box is the sheet inside it.
  dialog: "[data-testid='sheetDialog']",
  codeLanguage: "[data-testid='programming-language-input']",
  typeahead: "[data-testid='typeaheadResult']",
  tableSize1x1: "[aria-label='Insert a 1 by 1 table']",
  editBlock: "[aria-label='Edit block']",
  postCard: "[role=button]:has([data-testid='User-Name'])",
} satisfies Record<string, string | string[]>;

// SiYuan code-block languages → names in X's language list.
export const LANG_ALIASES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JSX", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
  py: "Python", python: "Python", sh: "Bash", shell: "Bash", bash: "Bash", zsh: "Bash",
  yml: "YAML", yaml: "YAML", md: "Markdown", markdown: "Markdown", json: "JSON", html: "HTML", css: "CSS",
  sql: "SQL", go: "Go", golang: "Go", rs: "Rust", rust: "Rust", rb: "Ruby", ruby: "Ruby", java: "Java",
  kt: "Kotlin", kotlin: "Kotlin", swift: "Swift", c: "C", cpp: "C++", "c++": "C++", cs: "C#", csharp: "C#",
  php: "PHP", lua: "Lua", r: "R", dart: "Dart", scala: "Scala", toml: "TOML", xml: "XML", dockerfile: "Dockerfile",
  plaintext: "", text: "", txt: "",
};
