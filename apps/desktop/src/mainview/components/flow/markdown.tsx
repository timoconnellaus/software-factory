// A model's reply as Markdown (Chat): headings, lists, code, links, tables (GitHub's flavour, through
// remark-gfm), styled with the app's own tokens rather than a typography plugin. Links open in the
// default browser through the main process (https only); raw HTML in the text is never rendered.
import { cn } from "@software-factory/ui/lib/utils";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "../../lib/external.tsx";

const components: Components = {
  h1: ({ node: _, ...p }) => <h3 className="mt-4 mb-1.5 font-semibold text-[16px]" {...p} />,
  h2: ({ node: _, ...p }) => <h3 className="mt-4 mb-1.5 font-semibold text-[15px]" {...p} />,
  h3: ({ node: _, ...p }) => <h4 className="mt-3.5 mb-1 font-semibold text-[14px]" {...p} />,
  h4: ({ node: _, ...p }) => <h5 className="mt-3 mb-1 font-semibold" {...p} />,
  p: ({ node: _, ...p }) => <p className="my-2 leading-relaxed" {...p} />,
  ul: ({ node: _, ...p }) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: ({ node: _, ...p }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  li: ({ node: _, ...p }) => <li className="leading-relaxed" {...p} />,
  a: ({ node: _, href, ...p }) => (
    <a
      className="text-link underline underline-offset-2"
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternal(href);
      }}
      {...p}
    />
  ),
  blockquote: ({ node: _, ...p }) => (
    <blockquote className="my-2 border-line border-l-2 pl-3 text-ink-muted" {...p} />
  ),
  hr: () => <hr className="my-3 border-line" />,
  code: ({ node: _, className, ...p }) => (
    <code
      className={cn(
        "rounded-[4px] bg-window px-1 py-px font-mono text-[12.5px]",
        // Inside a fenced block the <pre> carries the box.
        "[pre_&]:bg-transparent [pre_&]:p-0",
        className,
      )}
      {...p}
    />
  ),
  pre: ({ node: _, ...p }) => (
    <pre
      className="my-2.5 overflow-x-auto rounded-[8px] border border-line bg-window px-3 py-2.5 font-mono text-[12.5px] leading-normal"
      {...p}
    />
  ),
  table: ({ node: _, ...p }) => (
    <div className="my-2.5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" {...p} />
    </div>
  ),
  th: ({ node: _, ...p }) => (
    <th className="border-line border-b px-2.5 py-1.5 text-left font-semibold" {...p} />
  ),
  td: ({ node: _, ...p }) => <td className="border-line-soft border-b px-2.5 py-1.5" {...p} />,
};

export function ChatMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
