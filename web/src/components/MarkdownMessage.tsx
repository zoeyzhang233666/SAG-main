import { Children, createElement, isValidElement, memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Download, Maximize2, Minimize2, Minus, Plus, RotateCcw, Sparkles } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Button } from "./ui/button";

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
  mermaidPendingText?: string;
  isStreaming?: boolean;
  onOpenCitation?: (citation: MarkdownCitation) => void;
  onRequestMermaidRedraw?: (input: { source: string; error?: string }) => void;
};

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  citations = [],
  mermaidPendingText = "ChemClaw正在绘制产业链关系图",
  isStreaming = false,
  onOpenCitation,
  onRequestMermaidRedraw
}: MarkdownMessageProps) {
  const citationIndexes = useMemo(() => citations.map((citation) => citation.index), [citations]);
  const citationByIndex = useMemo(
    () => new Map(citations.map((citation) => [citation.index, citation])),
    [citations]
  );
  const displayContent = useMemo(() => stripMermaidTitleSourceQualifiers(content), [content]);
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
          h1: ({ children }) => <CollapsibleHeading level={1}>{children}</CollapsibleHeading>,
          h2: ({ children }) => <CollapsibleHeading level={2}>{children}</CollapsibleHeading>,
          h3: ({ children }) => <CollapsibleHeading level={3}>{children}</CollapsibleHeading>,
          h4: ({ children }) => <CollapsibleHeading level={4}>{children}</CollapsibleHeading>,
          h5: ({ children }) => <CollapsibleHeading level={5}>{children}</CollapsibleHeading>,
          h6: ({ children }) => <CollapsibleHeading level={6}>{children}</CollapsibleHeading>,
          ul: ({ children }) => <ul className="chem-outline-list chem-outline-ul">{children}</ul>,
          ol: ({ children }) => <ol className="chem-outline-list chem-outline-ol">{children}</ol>,
          li: ({ children }) => <CollapsibleListItem>{children}</CollapsibleListItem>,
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
                {children}
              </a>
            );
          },
          pre: ({ children }) => {
            const child = Children.only(children);
            if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
              const language = child.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
              const source = String(child.props.children ?? "").replace(/\n$/, "");
              if (language === "mermaid") {
                return (
                  <MermaidDiagram
                    source={source}
                    pendingText={mermaidPendingText}
                    isStreaming={isStreaming}
                    onRequestRedraw={onRequestMermaidRedraw}
                  />
                );
              }
              return <CodeBlock source={source} language={language} />;
            }
            return <pre>{children}</pre>;
          },
          code: ({ className, children }) => (
            <code className={className}>{children}</code>
          )
        }}
      >
        {displayContent}
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

function MermaidDiagram({
  source,
  pendingText,
  isStreaming,
  onRequestRedraw
}: {
  source: string;
  pendingText: string;
  isStreaming: boolean;
  onRequestRedraw?: (input: { source: string; error?: string }) => void;
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const normalizedSource = useMemo(() => normalizeMermaidSource(source), [source]);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [renderedSource, setRenderedSource] = useState(normalizedSource);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (isStreaming) {
      setError("");
      setSvg("");
      setRenderedSource(normalizedSource);
      return;
    }
    let active = true;
    setError("");
    setSvg("");
    setRenderedSource(normalizedSource);
    const renderId = `mermaid-${reactId}-${Date.now().toString(36)}`;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
          flowchart: {
            curve: "basis",
            htmlLabels: true,
            nodeSpacing: 42,
            rankSpacing: 54,
            padding: 14,
            useMaxWidth: false
          },
          themeVariables: {
            primaryColor: "#fff4ed",
            primaryTextColor: "#18243a",
            primaryBorderColor: "#df5b25",
            lineColor: "#8ca0b8",
            secondaryColor: "#eef6ff",
            tertiaryColor: "#f8fafc",
            clusterBkg: "#f8fafc",
            clusterBorder: "#cbd6e4",
            fontSize: "14px"
          }
        });
        const result = await mermaid.render(renderId, normalizedSource);
        if (active) setSvg(result.svg);
      })
      .catch(async (renderError: unknown) => {
        cleanupMermaidArtifacts(renderId);
        try {
          const { default: mermaid } = await import("mermaid");
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "loose",
            theme: "base",
            fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
            flowchart: {
              curve: "basis",
              htmlLabels: false,
              nodeSpacing: 42,
              rankSpacing: 54,
              padding: 14,
              useMaxWidth: false
            }
          });
          const retryId = `${renderId}-retry`;
          const result = await mermaid.render(retryId, normalizedSource);
          cleanupMermaidArtifacts(retryId);
          if (active) {
            setSvg(result.svg);
            setError("");
          }
        } catch (retryError: unknown) {
          cleanupMermaidArtifacts(`${renderId}-retry`);
          if (active) {
            setError(retryError instanceof Error ? retryError.message : String(retryError || renderError));
          }
        }
      })
      .finally(() => {
        cleanupMermaidArtifacts(renderId);
      });
    return () => {
      active = false;
      cleanupMermaidArtifacts(renderId);
    };
  }, [isStreaming, normalizedSource, reactId]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("chem-mermaid-fullscreen-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("chem-mermaid-fullscreen-open");
    };
  }, [fullscreen]);

  async function copySource() {
    await navigator.clipboard.writeText(renderedSource);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function downloadSvg() {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `industry-chain-${Date.now()}.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function requestRedraw() {
    onRequestRedraw?.({
      source: renderedSource || normalizedSource,
      error: error || undefined
    });
  }

  return (
    <div className={`chem-mermaid${fullscreen ? " chem-mermaid-fullscreen" : ""}`}>
      <div className="chem-mermaid-toolbar">
        <div>
          <div className="font-semibold text-foreground">产业链关系图</div>
          <div className="text-[11px] text-muted-foreground">Mermaid · {Math.round(zoom * 100)}%</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button type="button" variant="outline" size="icon" title="缩小" onClick={() => setZoom((value) => Math.max(0.5, value - 0.15))}>
            <Minus className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" size="icon" title="放大" onClick={() => setZoom((value) => Math.min(3, value + 0.15))}>
            <Plus className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" size="icon" title="恢复 100%" onClick={() => setZoom(1)}>
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            title={fullscreen ? "退出全屏" : "全屏查看"}
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={error ? "把 Mermaid 语法错误发送给 AI 重新生成" : "让 AI 重新生成更好的 Mermaid 图"}
            disabled={isStreaming || !onRequestRedraw}
            onClick={requestRedraw}
          >
            <Sparkles className="h-4 w-4" />
            重绘
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void copySource()}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "已复制" : "复制源代码"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!svg} onClick={downloadSvg}>
            <Download className="h-4 w-4" />
            下载 SVG
          </Button>
        </div>
      </div>
      {error ? (
        <div className="chem-mermaid-error">
          <div className="font-semibold text-foreground">Mermaid 语法暂时无法渲染</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{compactMermaidError(error)}</div>
          <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">
            <code>{renderedSource}</code>
          </pre>
        </div>
      ) : svg ? (
        <div className="chem-mermaid-viewport">
          <div
            className="chem-mermaid-canvas"
            style={{ transform: `scale(${zoom})` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : (
        <div className="chem-mermaid-pending">{pendingText}</div>
      )}
    </div>
  );
}

function normalizeMermaidSource(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/^\uFEFF/, "")
    .replace(/```(?:mermaid)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function compactMermaidError(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 360);
}

function stripMermaidTitleSourceQualifiers(value: string) {
  return value.replace(
    /(^|\n)(#{1,6}\s*[^\n]*?(?:产业链(?:关系图|示意图)?|Mermaid|关系图)[^\n]*?)（(?:基于现有证据|基于项目证据|并补充公开知识|补充公开知识|模型知识补充|基于现有证据并补充公开知识)[^）]*）/g,
    "$1$2"
  );
}

function cleanupMermaidArtifacts(renderId: string) {
  document.getElementById(`d${renderId}`)?.remove();
  document.querySelectorAll(`[id="d${renderId}"]`).forEach((element) => element.remove());
}

function areMarkdownMessagePropsEqual(prev: MarkdownMessageProps, next: MarkdownMessageProps) {
  return prev.content === next.content &&
    (prev.isStreaming ?? false) === (next.isStreaming ?? false) &&
    (prev.mermaidPendingText ?? "") === (next.mermaidPendingText ?? "") &&
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
    const regex = /\[(\d{1,2})\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(child.value)) !== null) {
      const citationIndex = Number(match[1]);
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
