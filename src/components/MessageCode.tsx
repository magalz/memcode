import { Highlight, Prism, themes } from "prism-react-renderer";
export default function MessageCode({
  text,
  language,
}: {
  text: string;
  language: string;
}) {
  const mapped: Record<string, string> = {
    ts: "typescript",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    html: "markup",
    xml: "markup",
    svg: "markup",
    sh: "bash",
    py: "python",
    rs: "rust",
  };
  const lang = mapped[language] ?? language;
  return (
    <Highlight
      code={text}
      language={Prism.languages[lang] ? lang : "plain"}
      theme={themes.github}
    >
      {({ tokens, getTokenProps }) => (
        <pre>
          <code>
            {tokens.map((tokens, index) => (
              <div key={index}>
                {tokens.map((token, i) => (
                  <span {...getTokenProps({ token })} key={i} />
                ))}
              </div>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
