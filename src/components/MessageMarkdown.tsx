import { lazy, memo, Suspense, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import "../styles-message-markdown.css";
import { localFileURL } from "../file-reference";
const Code = lazy(() => import("./MessageCode"));
function CodeBlock({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false),
    text = String(children ?? "").replace(/\n$/, ""),
    language = className?.match(/language-([^ ]+)/)?.[1] ?? "text";
  const reference = language.match(/^\d+:\d+:(.+)$/),
    title = reference?.[1] ?? language;
  const syntax = reference?.[1].split(".").at(-1) ?? language;
  return (
    <div className="message-code-block">
      <header>
        <span>{title}</span>
        <button
          aria-label="Copy code"
          title="Copy code"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
          }
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </header>
      <Suspense
        fallback={
          <pre>
            <code>{text}</code>
          </pre>
        }
      >
        <Code text={text} language={syntax} />
      </Suspense>
    </div>
  );
}
export default memo(function MessageMarkdown({
  text,
  onOpenLink,
}: {
  text: string;
  onOpenLink?: (href: string) => void;
}) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          localFileURL(url) ? url : defaultUrlTransform(url)
        }
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ children, className, node, ...props }) => {
            const block =
              !!className ||
              node?.position?.start.line !== node?.position?.end.line ||
              String(children).endsWith("\n");
            return block ? (
              <CodeBlock className={className}>{children}</CodeBlock>
            ) : (
              <code {...props}>{children}</code>
            );
          },
          table: ({ children }) => (
            <div className="message-table-scroll">
              <table>{children}</table>
            </div>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target={onOpenLink ? undefined : "_blank"}
              rel="noopener noreferrer"
              onClick={(event) => {
                if (onOpenLink && href) {
                  event.preventDefault();
                  onOpenLink(href);
                }
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
