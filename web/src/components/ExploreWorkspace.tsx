import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { AnswerEvidence, McpMessageRecord, ProjectGraphRecord, ProjectGraphSuggestionRecord, QuestionAnchor } from "../types";
import { api } from "../lib/api";
import { composeExplorationScope, projectGraphForExploration, readAnswerEvidence } from "../lib/exploration-evidence";
import { ProjectGraphFlow } from "./ProjectGraphFlow";
import { Button } from "./ui/button";

type Scope = ReturnType<typeof composeExplorationScope>;
type GraphFocus = Scope & { key: string; query: string; entityName?: string; primaryEntityId?: string };
type Target = QuestionAnchor & { label: string };
type Props = {
  projectId: string;
  sessionId?: string;
  messages: McpMessageRecord[];
  liveEvidence?: AnswerEvidence;
  citationChunkId?: string;
  citationRequest?: number;
  onPickNode: (node: Target) => void;
  onOpenChunk: (id: string) => void;
  onOpenEvent: (id: string) => void;
  onOpenEntity: (id: string) => void;
  children: ReactNode;
};

function clamp(value: number) {
  return Math.min(70, Math.max(30, value));
}

const paneWidthKey = "sag:explore.graph-width";
const emptyScope: Scope = { chunkIds: [], eventIds: [], entityIds: [] };

function scopeFor(suggestion: ProjectGraphSuggestionRecord): Scope {
  return suggestion.kind === "chunk" ? { ...emptyScope, chunkIds: [suggestion.id] }
    : suggestion.kind === "event" ? { ...emptyScope, eventIds: [suggestion.id] }
      : { ...emptyScope, entityIds: suggestion.entityIds?.length ? suggestion.entityIds : [suggestion.id] };
}

export function ExploreWorkspace(props: Props) {
  const { t, language } = useI18n();
  const { projectId, sessionId, messages, liveEvidence, citationChunkId, citationRequest } = props;
  const area = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(() => {
    const stored = Number(localStorage.getItem(paneWidthKey));
    return stored > 0 ? clamp(stored) : 54;
  });
  const [focus, setFocus] = useState<GraphFocus | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<string | undefined>();
  const [loaded, setLoaded] = useState<{ graph: ProjectGraphRecord; focus: GraphFocus | null } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const evidence = useMemo(() => {
    const rounds = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => {
        const snapshot = readAnswerEvidence(message.metadata.evidence, projectId);
        return snapshot ? [snapshot] : [];
      });
    if (liveEvidence?.projectId === projectId) rounds.push(liveEvidence);
    return rounds;
  }, [messages, liveEvidence, projectId]);

  const evidenceFocus = useMemo<GraphFocus | null>(() => {
    if (!evidence.length) return null;
    const scope = composeExplorationScope(evidence);
    if (!scope.chunkIds.length && !scope.eventIds.length && !scope.entityIds.length) return null;
    return { ...scope, key: `evidence:${JSON.stringify(scope)}`, query: "" };
  }, [evidence]);

  // A new evidence snapshot takes priority over an earlier manual graph search.
  const evidenceKey = evidenceFocus?.key ?? "";
  useEffect(() => { setFocus(null); }, [evidenceKey]);

  useEffect(() => {
    if (!citationChunkId) return;
    const match = [...evidence].reverse().flatMap((item) => item.citations).find((item) => item.chunkId === citationChunkId);
    setSelectedCitation(match?.eventIds[0] ?? citationChunkId);
    setFocus({
      ...evidenceFocus,
      key: `citation:${citationChunkId}:${citationRequest}`,
      query: "",
      chunkIds: [...new Set([citationChunkId, ...(evidenceFocus?.chunkIds ?? [])])],
      eventIds: [...new Set([...(match?.eventIds ?? []), ...(evidenceFocus?.eventIds ?? [])])],
      entityIds: evidenceFocus?.entityIds ?? []
    });
    // A citation action is an explicit selection; subsequent evidence updates do not replay it.
  }, [citationChunkId, citationRequest]);

  const requested = focus ?? evidenceFocus;
  const requestKey = requested?.key ?? "";
  const requestSuggestions = useCallback(async (query: string, signal: AbortSignal) =>
    (await api.getProjectGraphSuggestions(projectId, { query, limit: 10 }, signal)).suggestions,
  [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    void api.getProjectGraph(projectId, {
      ...(requested ? {
        chunkIds: requested.chunkIds,
        eventIds: requested.eventIds,
        entityIds: requested.entityIds,
        query: requested.chunkIds.length || requested.eventIds.length || requested.entityIds.length || requested.entityName
          ? undefined : requested.query || undefined,
        entityName: requested.entityName
      } : {}),
      limit: 120
    }, controller.signal).then(({ graph }) => {
      if (controller.signal.aborted) return;
      setLoaded({ graph: projectGraphForExploration(graph, projectId), focus: requested });
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError(true);
    });
    return () => controller.abort();
  }, [projectId, requestKey, refresh]);

  useEffect(() => { localStorage.setItem(paneWidthKey, String(leftWidth)); }, [leftWidth]);

  function resize(clientX: number) {
    const bounds = area.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    setLeftWidth(clamp((clientX - bounds.left) / bounds.width * 100));
  }

  return (
    <div ref={area} className="chem-explore" style={{ "--explore-left": `${leftWidth}%` } as CSSProperties} data-explore-workspace="">
      <section aria-label={t("探索图谱", "Exploration graph")} className="atlas-universe-panel relative min-h-0 min-w-0 overflow-hidden">
        {loadError && <p className="absolute bottom-3 left-3 z-30 flex items-center gap-2 rounded-lg border border-border bg-background p-2 text-sm" role="status">
          {t("图谱加载失败", "Could not load graph")}
          <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>{t("重试", "Retry")}</Button>
        </p>}
        {loaded ? (
          <ProjectGraphFlow
            graph={loaded.graph}
            focus={loaded.focus}
            language={language}
            compact
            universe2D
            preferenceKey={`sag:explore.view:${projectId}:${sessionId ?? "new"}`}
            selectedExternalId={selectedCitation}
            onPickNode={(node) => {
              setSelectedCitation(undefined);
              props.onPickNode(node);
            }}
            onSearch={(query) => {
              setSelectedCitation(undefined);
              setFocus(query ? { ...emptyScope, key: `search:${query}`, query } : null);
            }}
            onRequestSuggestions={requestSuggestions}
            onSelectSuggestion={(suggestion) => {
              setSelectedCitation(suggestion.id);
              setFocus({ ...scopeFor(suggestion), key: `node:${suggestion.id}`, query: suggestion.label,
                entityName: suggestion.normalizedEntityName, primaryEntityId: suggestion.kind === "entity" ? suggestion.id : undefined });
            }}
            onOpenChunk={props.onOpenChunk}
            onOpenEvent={props.onOpenEvent}
            onOpenEntity={props.onOpenEntity}
          />
        ) : !loadError && <div className="grid h-full place-items-center text-sm text-muted-foreground" role="status">
          {t("正在加载项目图谱", "Loading project graph")}
        </div>}
      </section>
      <div className="chem-explore-handle" tabIndex={0} role="separator" aria-orientation="vertical"
        aria-label={t("调整图谱与问答宽度", "Resize graph and conversation")}
        aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(leftWidth)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setLeftWidth((value) => event.key === "Home" ? 30 : event.key === "End" ? 70 :
            clamp(value + (event.key === "ArrowLeft" ? -3 : 3)));
        }}
      />
      <div className="atlas-explore-conversation flex min-h-0 min-w-0 flex-col overflow-hidden">{props.children}</div>
    </div>
  );
}
