import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Renders file content. Content is untrusted (agents and humans both write it):
 * no rehype-raw, so raw HTML is never rendered, and react-markdown's default
 * URL transform strips `javascript:` and similar links.
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
