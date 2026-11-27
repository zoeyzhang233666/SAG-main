import { Children, createElement, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { renderRichTextChildren } from "./RichText";

export type MarkdownCitation = {
  index: number;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank?: number;
  score?: number;
  query?: string;
};

type MarkdownMessageProps = {
  content: string;
  citations?: MarkdownCitation[];
  onOpenCitation?: (citation: MarkdownCitation) => void;
};

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  citations = [],
  onOpenCitation
}: MarkdownMessageProps) {
  const citationIndexes = useMemo(() => citations.map((citation) => citation.index), [citations]);
  const citationByIndex = useMemo(
    () => new Map(citations.map((citation) => [citation.index, citation])),
    [citations]
  );
  const sanitizeSchema = useMemo(() => ({
    ...defaultSchema,
    tagNames: [...new Set([...(defaultSchema.tagNames ?? []), "u"])],
    attributes: {
      ...defaultSchema.attributes,
      input: ["type", "checked", "disabled"],
      span: [...(defaultSchema.attributes?.span ?? []), "className", "class"]
    },
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), "citation"]
    }
  }), []);

  return (
    <div className="chem-markdown break-words">
      <ReactMarkdown
        urlTransform={(url) => url.startsWith("citation:") ? url : defaultUrlTransform(url)}
        remarkPlugins={[
          remarkGfm,
          [remarkCitationLinks, { indexes: citationIndexes }]
        ]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema]
        ]}
        components={{
          h1: ({ children }) => <CollapsibleHeading level={1}>{renderRichTextChildren(children)}</CollapsibleHeading>,
          h2: ({ children }) => <CollapsibleHeading level={2}>{renderRichTextChildren(children)}</CollapsibleHeading>,
          h3: ({ children }) => <CollapsibleHeading level={3}>{renderRichTextChildren(children)}</CollapsibleHeading>,
          h4: ({ children }) => <CollapsibleHeading level={4}>{renderRichTextChildren(children)}</CollapsibleHeading>,
          h5: ({ children }) => <CollapsibleHeading level={5}>{renderRichTextChildren(children)}</CollapsibleHeading>,
          h6: ({ children }) => <CollapsibleHeading level={6}>{renderRichTextChildren(children)}</CollapsibleHeading>,
          ul: ({ children }) => <ul className="chem-outline-list chem-outline-ul">{children}</ul>,
          ol: ({ children }) => <ol className="chem-outline-list chem-outline-ol">{children}</ol>,
          li: ({ children }) => <CollapsibleListItem>{renderRichTextChildren(children)}</CollapsibleListItem>,
          p: ({ children }) => <p>{renderRichTextChildren(children)}</p>,
          th: ({ children }) => <th>{renderRichTextChildren(children)}</th>,
          td: ({ children }) => <td>{renderRichTextChildren(children)}</td>,
          table: ({ children }) => (
            <div className="chem-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => {
            if (href?.startsWith("citation:")) {
              const citation = citationByIndex.get(Number(href.slice("citation:".length)));
              if (citation && onOpenCitation) {
                return (
                  <button
                    type="button"
                    className="chem-citation-link"
                    title={citation.heading || citation.chunkId}
                    onClick={() => onOpenCitation(citation)}
                  >
                    {citation.index}
                  </button>
                );
              }
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {renderRichTextChildren(children)}
              </a>
            );
          },
          pre: ({ children }) => {
            const child = Children.only(children);
            if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
              const language = child.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
              const source = String(child.props.children ?? "").replace(/\n$/, "");
              return <CodeBlock source={source} language={language} />;
            }
            return <pre>{children}</pre>;
          },
          code: ({ className, children }) => (
            <code className={className}>{children}</code>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}, areMarkdownMessagePropsEqual);

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

function CollapsibleHeading({ level, children }: { level: HeadingLevel; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const Tag = `h${level}` as const;

  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    const changed: HTMLElement[] = [];
    let sibling = heading.nextElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName) && Number(sibling.tagName.slice(1)) <= level) {
        break;
      }
      if (sibling instanceof HTMLElement) {
        sibling.style.display = open ? "" : "none";
        changed.push(sibling);
      }
      sibling = sibling.nextElementSibling;
    }
    return () => {
      changed.forEach((element) => {
        element.style.display = "";
      });
    };
  }, [children, level, open]);

  return createElement(
    Tag,
    { ref: headingRef, className: open ? "chem-md-heading" : "chem-md-heading chem-md-heading-collapsed" },
    <button
      type="button"
      className="chem-md-heading-toggle"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      <span>{children}</span>
    </button>
  );
}

function CollapsibleListItem({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const childItems = Children.toArray(children);
  const nestedLists = childItems.filter(isOutlineListElement);
  const contentItems = childItems.filter((child) => !isOutlineListElement(child));
  const hasNestedList = nestedLists.length > 0;

  return (
    <li className={`chem-outline-item${hasNestedList ? " chem-outline-item-branch" : ""}`}>
      <div className="chem-outline-row">
        {hasNestedList ? (
          <button
            type="button"
            className="chem-outline-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="chem-outline-toggle-placeholder" aria-hidden="true" />
        )}
        <div className="chem-outline-content">{contentItems}</div>
      </div>
      {hasNestedList && open ? <div className="chem-outline-children">{nestedLists}</div> : null}
    </li>
  );
}

function isOutlineListElement(child: ReactNode) {
  if (!isValidElement<{ className?: string; node?: { tagName?: string } }>(child)) return false;
  const className = child.props.className ?? "";
  const nodeTagName = child.props.node?.tagName;
  return nodeTagName === "ul" ||
    nodeTagName === "ol" ||
    (typeof child.type === "string" && (child.type === "ul" || child.type === "ol")) ||
    className.includes("chem-outline-list");
}

function CodeBlock({ source, language }: { source: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  async function copySource() {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="chem-code-block">
      <div className="chem-code-toolbar">
        <span>{language || "code"}</span>
        <button type="button" onClick={() => void copySource()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code className={language ? `language-${language}` : undefined}>{source}</code>
      </pre>
    </div>
  );
}

function areMarkdownMessagePropsEqual(prev: MarkdownMessageProps, next: MarkdownMessageProps) {
  return prev.content === next.content &&
    prev.onOpenCitation === next.onOpenCitation &&
    citationSignature(prev.citations ?? []) === citationSignature(next.citations ?? []);
}

function citationSignature(citations: MarkdownCitation[]) {
  return citations
    .map((citation) => `${citation.index}:${citation.chunkId}:${citation.sourceId}`)
    .join("|");
}

type MarkdownAstNode = {
  type?: string;
  value?: string;
  children?: MarkdownAstNode[];
  url?: string;
};

function remarkCitationLinks(options?: { indexes?: number[] }) {
  const validIndexes = new Set(options?.indexes ?? []);
  return (tree: MarkdownAstNode) => {
    transformCitationNodes(tree, validIndexes);
  };
}

function transformCitationNodes(node: MarkdownAstNode, validIndexes: Set<number>) {
  if (!Array.isArray(node.children) || node.type === "code" || node.type === "inlineCode" || node.type === "link") {
    return;
  }
  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type !== "text" || typeof child.value !== "string") {
      transformCitationNodes(child, validIndexes);
      nextChildren.push(child);
      continue;
    }
    const regex = /\[(\d{1,2})\]|【(\d{1,2})】/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(child.value)) !== null) {
      const citationIndex = Number(match[1] ?? match[2]);
      if (!validIndexes.has(citationIndex)) continue;
      if (match.index > lastIndex) {
        nextChildren.push({ type: "text", value: child.value.slice(lastIndex, match.index) });
      }
      nextChildren.push({
        type: "link",
        url: `citation:${citationIndex}`,
        children: [{ type: "text", value: String(citationIndex) }]
      });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex === 0) {
      nextChildren.push(child);
    } else if (lastIndex < child.value.length) {
      nextChildren.push({ type: "text", value: child.value.slice(lastIndex) });
    }
  }
  node.children = nextChildren;
}
