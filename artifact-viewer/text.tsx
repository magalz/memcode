import { useEffect, useRef } from "react";
import { Highlight, Prism, themes } from "prism-react-renderer";
import { selectForComment } from "./selection";
export default function TextFile({
  bytes,
  name,
  line,
}: {
  bytes: ArrayBuffer;
  name: string;
  line?: number;
}) {
  const host = useRef<HTMLDivElement>(null),
    text = new TextDecoder().decode(bytes),
    ext = name.split(".").at(-1)?.toLowerCase() ?? "",
    map: Record<string, string> = {
      ts: "typescript",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      html: "markup",
      svg: "markup",
      xml: "markup",
      py: "python",
      rs: "rust",
      sh: "bash",
      yml: "yaml",
    },
    language = map[ext] ?? ext;
  useEffect(() => {
    if (line)
      host.current
        ?.querySelector(`[data-code-line="${line}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [line]);
  if (text.includes("\0"))
    return (
      <div className="viewer-error">
        This binary file has no readable text preview.
      </div>
    );
  return (
    <div ref={host} className="source-viewer">
      <Highlight
        code={text}
        language={Prism.languages[language] ? language : "plain"}
        theme={themes.github}
      >
        {({ tokens, getTokenProps }) => (
          <div className="source-code">
            {tokens.map((tokens, index) => (
              <div
                key={index}
                data-code-line={index + 1}
                className={
                  line === index + 1 ? "source-line active" : "source-line"
                }
              >
                <button
                  className="source-line-number"
                  aria-label={`Comment on line ${index + 1}`}
                  onClick={() =>
                    selectForComment({
                      quote:
                        tokens.map((t) => t.content).join("") || "(empty line)",
                      lineStart: index + 1,
                      lineEnd: index + 1,
                    })
                  }
                >
                  {index + 1}
                </button>
                <code>
                  {tokens.map((token, i) => (
                    <span {...getTokenProps({ token })} key={i} />
                  ))}
                </code>
              </div>
            ))}
          </div>
        )}
      </Highlight>
    </div>
  );
}
