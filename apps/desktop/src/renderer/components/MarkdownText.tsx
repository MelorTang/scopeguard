import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownText(props: { text: string }): JSX.Element {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <span className="message-link" title={href}>
              {children}
              {href && (
                <span className="message-link__target"> ({href})</span>
              )}
            </span>
          ),
          img: ({ alt }) => (
            <span className="message-image-placeholder">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
