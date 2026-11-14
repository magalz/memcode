import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { localFileURL } from "../src/file-reference";
export default function Markdown({ bytes }: { bytes: ArrayBuffer }) {
  return (
    <main className="markdown-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => {
          if (key === "href" && localFileURL(url)) return url;
          if (key === "src" && !/^(https?:|data:|blob:|\/\/)/i.test(url))
            return (
              "./__asset/" + url.split("/").map(encodeURIComponent).join("/")
            );
          return defaultUrlTransform(url);
        }}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          img: (props) => <img {...props} loading="lazy" />,
        }}
      >
        {new TextDecoder().decode(bytes)}
      </ReactMarkdown>
    </main>
  );
}
