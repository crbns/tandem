import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Absolute ("https:", "data:") or protocol-relative ("//host") image sources.
const EXTERNAL_SRC = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Renders file content. Content is untrusted (agents and humans both write it):
 * no rehype-raw, so raw HTML is never rendered, and react-markdown's default
 * URL transform strips `javascript:` and similar links. Remote images aren't
 * fetched automatically, since a doc could use one as a read-receipt beacon;
 * they render as links the reader can choose to open.
 */
export function MarkdownPreview({ content, className }: { content: string; className?: string }) {
  if (!content.trim()) {
    return <p className="text-sm text-muted-foreground italic">Nothing to preview.</p>;
  }
  return (
    <div className={cn("prose prose-sm prose-neutral max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
          img: ({ node: _node, src, alt }) => {
            if (typeof src !== "string" || !src) return null;
            if (!EXTERNAL_SRC.test(src)) return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" />;
            return (
              <a href={src} target="_blank" rel="noopener noreferrer nofollow" title={src}>
                <ImageIcon className="inline size-3.5 align-[-2px]" aria-hidden /> {alt || "External image"}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
