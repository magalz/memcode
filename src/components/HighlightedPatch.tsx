import { Highlight, themes, Prism } from "prism-react-renderer";
import type { ChangeHunk, ChangeLine } from "../changes";
const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  html: "markup",
  htm: "markup",
  svg: "markup",
  xml: "markup",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  sh: "bash",
  ps1: "powershell",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  toml: "toml",
};
/** Tokenize each side independently so deleted syntax cannot corrupt added syntax. */
export default function HighlightedPatch({
  hunk,
  path,
  onLine,
}: {
  hunk: ChangeHunk;
  path: string;
  onLine?: (line: ChangeLine) => void;
}) {
  const language =
    languages[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plain";
  const supported = Prism.languages[language] ? language : "plain";
  const oldCode = hunk.lines
    .filter((l) => l.kind !== "add")
    .map((l) => l.text)
    .join("\n");
  const newCode = hunk.lines
    .filter((l) => l.kind !== "delete")
    .map((l) => l.text)
    .join("\n");
  return (
    <Highlight code={oldCode} language={supported} theme={themes.github}>
      {(old) => (
        <Highlight code={newCode} language={supported} theme={themes.github}>
          {(next) => {
            let before = 0,
              after = 0;
            return (
              <div className="change-lines">
                {hunk.lines.map((line, i) => {
                  const tokens =
                    line.kind === "delete"
                      ? old.tokens[before++]
                      : (line.kind === "context" && before++,
                        next.tokens[after++]);
                  const props = line.kind === "delete" ? old : next;
                  return (
                    <div
                      className={"change-line " + line.kind}
                      key={i}
                      data-kind={line.kind}
                      data-old-line={line.oldLine}
                      data-new-line={line.newLine}
                    >
                      <div
                        className="change-gutter"
                        role={onLine ? "button" : undefined}
                        tabIndex={onLine ? 0 : undefined}
                        aria-label={
                          onLine
                            ? `Select ${line.kind === "delete" ? "deleted" : "changed"} line ${line.newLine ?? line.oldLine}`
                            : undefined
                        }
                        onClick={() => onLine?.(line)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onLine?.(line);
                          }
                        }}
                      >
                        <span>{line.oldLine ?? ""}</span>
                        <span>{line.newLine ?? ""}</span>
                        <i
                          aria-label={
                            line.kind === "add"
                              ? "Added"
                              : line.kind === "delete"
                                ? "Deleted"
                                : undefined
                          }
                        >
                          {line.kind === "add"
                            ? "+"
                            : line.kind === "delete"
                              ? "−"
                              : " "}
                        </i>
                      </div>
                      <code>
                        {tokens?.map((token, index) => (
                          <span
                            {...props.getTokenProps({ token })}
                            key={index}
                          />
                        )) ??
                          line.text ??
                          " "}
                      </code>
                    </div>
                  );
                })}
              </div>
            );
          }}
        </Highlight>
      )}
    </Highlight>
  );
}
