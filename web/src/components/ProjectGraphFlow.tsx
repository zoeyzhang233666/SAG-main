import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { RefreshCw, Search } from "lucide-react";
import type {
  ProjectGraphChunkRecord,
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord,
} from "../types";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { SupportedLanguage } from "../i18n";
import { RichTextFragment } from "./RichText";

type GraphNodeData = {
  label: string;
  kind: "chunk" | "entity" | "event" | "question";
  expanded: boolean;
  entityType?: string;
  entityTypeColor?: string;
} & Record<string, unknown>;

type GraphNode = Node<GraphNodeData>;
type GraphEdge = Edge;

const ROOT_ENTITY_LIMIT = 8;
const CHUNK_NODE_WIDTH = 190;
const ENTITY_NODE_WIDTH = 170;
const EVENT_NODE_WIDTH = 180;
const NODE_HEIGHT = 44;
const ENTITY_RING_START_RADIUS = 220;
const ENTITY_RING_GAP = 190;
const ENTITY_SLOT_SPACING = 210;
const EVENT_RING_START_RADIUS = 520;
const EVENT_RING_GAP = 185;
const EVENT_SLOT_SPACING = 240;
const EVENT_ANGLE_OFFSET = -Math.PI / 2 + Math.PI / 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const FOCUS_ENTITY_LIMIT = 30;
const FOCUS_EVENT_LIMIT = 24;
const SHOWCASE_ENTITY_LIMIT = 34;
const SHOWCASE_EVENT_LIMIT = 12;
const SHOWCASE_TOP_CANDIDATE_LIMIT = 18;
const QUESTION_NODE_ID = "__sag_question__";
const QUESTION_NODE_WIDTH = 310;
const EDGE_DASH_PATTERN = "8 8";
const EDGE_DASH_ANIMATION = "sag-edge-dash-slow 4.5s linear infinite";

type GraphPosition = {
  x: number;
  y: number;
  angle: number;
  radius: number;
  root?: boolean;
};

type GraphShowcaseMode = "overview" | "frequency" | "relations" | "events";
type ActiveGraphMode = GraphShowcaseMode | "manual";

type GraphShowcase = {
  mode: GraphShowcaseMode;
  title: string;
  entityIds: string[];
  eventIds: string[];
  linkedNodeIds: string[];
};

const GRAPH_SHOWCASE_BUTTONS: Array<{
  mode: GraphShowcaseMode;
  zh: string;
  en: string;
}> = [
  { mode: "frequency", zh: "高频化工品", en: "Core chemicals" },
  { mode: "relations", zh: "产业链关系", en: "Co-event pairs" },
  { mode: "events", zh: "高关联事件", en: "Key events" },
];

export type GraphLayoutStyle = "search_layers" | "entity_inner" | "columns";

export function ProjectGraphFlow(props: {
  graph: ProjectGraphRecord;
  focus?: {
    key: string;
    query: string;
    chunkIds: string[];
    eventIds: string[];
    entityIds: string[];
    primaryEntityId?: string;
  } | null;
  defaultLayoutStyle?: string;
  language: SupportedLanguage;
  onOpenChunk: (chunkId: string) => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <ProjectGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ProjectGraphCanvas(props: {
  graph: ProjectGraphRecord;
  focus?: {
    key: string;
    query: string;
    chunkIds: string[];
    eventIds: string[];
    entityIds: string[];
    primaryEntityId?: string;
  } | null;
  defaultLayoutStyle?: string;
  language: SupportedLanguage;
  onOpenChunk: (chunkId: string) => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const initialEntityIds = useMemo(
    () =>
      new Set(
        props.graph.entities
          .slice(0, ROOT_ENTITY_LIMIT)
          .map((entity) => entity.id),
      ),
    [props.graph.entities],
  );
  const [expandedEntityIds, setExpandedEntityIds] = useState<Set<string>>(
    () => new Set(props.graph.entities[0] ? [props.graph.entities[0].id] : []),
  );
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(
    new Set(),
  );
  const [focusedChunkIds, setFocusedChunkIds] = useState<Set<string>>(
    new Set(),
  );
  const [focusedEntityIds, setFocusedEntityIds] = useState<Set<string>>(
    new Set(),
  );
  const [focusedEventIds, setFocusedEventIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphQuery, setGraphQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeQueryLabel, setActiveQueryLabel] = useState("");
  const [queryLinkedNodeIds, setQueryLinkedNodeIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<Set<string>>(
    new Set(),
  );
  const [entityTypeQuery, setEntityTypeQuery] = useState("");
  const [entityTypeFilterCollapsed, setEntityTypeFilterCollapsed] =
    useState(false);
  const [activeGraphMode, setActiveGraphMode] =
    useState<ActiveGraphMode>("overview");
  const [showcaseSeed, setShowcaseSeed] = useState(() =>
    Math.floor(Math.random() * 1_000_000),
  );
  const [showcaseRevision, setShowcaseRevision] = useState(0);
  const [layoutStyle, setLayoutStyle] = useState<GraphLayoutStyle>(() =>
    normalizeGraphLayoutStyle(props.defaultLayoutStyle),
  );
  const [layoutRevision, setLayoutRevision] = useState(0);
  const expandedEventIdsRef = useRef(expandedEventIds);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const { fitView } = useReactFlow<GraphNode, GraphEdge>();
  const graphEdgeTypes = useMemo(() => ({ bus: BusEdge }), []);
  const graphNodeTypes = useMemo(() => ({ rich: RichGraphNode }), []);
  const clickTimerRef = useRef<number | null>(null);
  const shouldFitViewRef = useRef(true);

  const entityById = useMemo(
    () => new Map(props.graph.entities.map((entity) => [entity.id, entity])),
    [props.graph.entities],
  );
  const chunkById = useMemo(
    () => new Map((props.graph.chunks ?? []).map((chunk) => [chunk.id, chunk])),
    [props.graph.chunks],
  );
  const eventById = useMemo(
    () => new Map(props.graph.events.map((event) => [event.id, event])),
    [props.graph.events],
  );
  const eventIdsByChunkId = useMemo(() => {
    const map = new Map<string, string[]>();
    const edges = props.graph.chunkEventEdges ?? [];
    for (const edge of edges) {
      const eventIds = map.get(edge.chunkId) ?? [];
      eventIds.push(edge.eventId);
      map.set(edge.chunkId, eventIds);
    }
    for (const [chunkId, eventIds] of map.entries()) {
      eventIds.sort((a, b) =>
        compareEvents(eventById.get(a), eventById.get(b)),
      );
      map.set(chunkId, eventIds);
    }
    return map;
  }, [eventById, props.graph.chunkEventEdges]);
  const chunkIdByEventId = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of props.graph.events) {
      if (event.chunkId) map.set(event.id, event.chunkId);
    }
    for (const edge of props.graph.chunkEventEdges ?? []) {
      map.set(edge.eventId, edge.chunkId);
    }
    return map;
  }, [props.graph.chunkEventEdges, props.graph.events]);
  const eventIdsByEntityId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of props.graph.edges) {
      const eventIds = map.get(edge.entityId) ?? [];
      eventIds.push(edge.eventId);
      map.set(edge.entityId, eventIds);
    }
    for (const [entityId, eventIds] of map.entries()) {
      eventIds.sort((a, b) =>
        compareEvents(eventById.get(a), eventById.get(b)),
      );
      map.set(entityId, eventIds);
    }
    return map;
  }, [eventById, props.graph.edges]);
  const entityIdsByEventId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of props.graph.edges) {
      const entityIds = map.get(edge.eventId) ?? [];
      entityIds.push(edge.entityId);
      map.set(edge.eventId, entityIds);
    }
    for (const [eventId, entityIds] of map.entries()) {
      entityIds.sort((a, b) =>
        compareEntities(entityById.get(a), entityById.get(b)),
      );
      map.set(eventId, entityIds);
    }
    return map;
  }, [entityById, props.graph.edges]);
  const activeShowcase = useMemo(
    () =>
      activeGraphMode === "manual"
        ? null
        : buildGraphShowcase({
            graph: props.graph,
            mode: activeGraphMode,
            seed: showcaseSeed + showcaseRevision * 9973,
            language: props.language,
          }),
    [
      activeGraphMode,
      props.graph,
      props.language,
      showcaseRevision,
      showcaseSeed,
    ],
  );

  const positionByNodeId = useMemo(
    () => buildCircularPositionMap(props.graph),
    [props.graph],
  );
  const suggestions = useMemo(
    () => rankGraphSuggestions(props.graph, graphQuery).slice(0, 8),
    [graphQuery, props.graph],
  );
  const graphIdentity = useMemo(
    () =>
      [
        (props.graph.chunks ?? []).map((chunk) => chunk.id).join(","),
        props.graph.entities.map((entity) => entity.id).join(","),
        props.graph.events.map((event) => event.id).join(","),
        (props.graph.chunkEventEdges ?? [])
          .map((edge) => `${edge.chunkId}:${edge.eventId}`)
          .join(","),
        props.graph.edges
          .map((edge) => `${edge.entityId}:${edge.eventId}`)
          .join(","),
      ].join("|"),
    [props.graph],
  );

  const visibleGraphScope = useMemo(
    () =>
      buildVisibleGraphScope({
        initialEntityIds,
        expandedEntityIds,
        expandedEventIds,
        focusedChunkIds,
        focusedEntityIds,
        focusedEventIds,
        eventIdsByChunkId,
        chunkIdByEventId,
        eventIdsByEntityId,
        entityIdsByEventId,
      }),
    [
      chunkIdByEventId,
      entityIdsByEventId,
      eventIdsByChunkId,
      eventIdsByEntityId,
      expandedEntityIds,
      expandedEventIds,
      focusedChunkIds,
      focusedEntityIds,
      focusedEventIds,
      initialEntityIds,
    ],
  );

  const visibleGraphScopeAfterEntityFilter = useMemo(() => {
    const nextScope = cloneVisibleGraphScope(visibleGraphScope);
    applyEntityVisibilityRules({
      visibleEntityIds: nextScope.visibleEntityIds,
      visibleEventIds: nextScope.visibleEventIds,
      selectedEntityTypes,
      expandedEventIds,
      entityById,
      entityIdsByEventId,
    });
    return nextScope;
  }, [
    entityById,
    entityIdsByEventId,
    expandedEventIds,
    selectedEntityTypes,
    visibleGraphScope,
  ]);

  const entityTypeOptions = useMemo(
    () =>
      buildEntityTypeOptionsFromScope({
        scopeEntityIds: visibleGraphScope.visibleEntityIds,
        visibleEntityIds: visibleGraphScopeAfterEntityFilter.visibleEntityIds,
        entityById,
        language: props.language,
      }),
    [
      entityById,
      props.language,
      visibleGraphScope.visibleEntityIds,
      visibleGraphScopeAfterEntityFilter.visibleEntityIds,
    ],
  );

  const filteredEntityTypeOptions = useMemo(() => {
    const normalizedQuery = normalizeGraphText(entityTypeQuery);
    if (!normalizedQuery) return entityTypeOptions;
    return entityTypeOptions.filter(
      (option) =>
        normalizeGraphText(option.label).includes(normalizedQuery) ||
        normalizeGraphText(option.type).includes(normalizedQuery),
    );
  }, [entityTypeOptions, entityTypeQuery]);

  const graphModel = useMemo(
    () =>
      buildVisibleGraph({
        initialEntityIds,
        expandedEntityIds,
        expandedEventIds,
        focusedChunkIds,
        focusedEntityIds,
        focusedEventIds,
        chunkById,
        entityById,
        eventById,
        eventIdsByChunkId,
        chunkIdByEventId,
        eventIdsByEntityId,
        entityIdsByEventId,
        edges: props.graph.edges,
        chunkEventEdges: props.graph.chunkEventEdges ?? [],
        positionByNodeId,
        selectedNodeId,
        activeQueryLabel,
        queryLinkedNodeIds,
        selectedEntityTypes,
        layoutStyle,
        layoutRevision,
      }),
    [
      activeQueryLabel,
      chunkById,
      chunkIdByEventId,
      entityById,
      entityIdsByEventId,
      eventById,
      eventIdsByChunkId,
      eventIdsByEntityId,
      expandedEntityIds,
      expandedEventIds,
      focusedChunkIds,
      focusedEntityIds,
      focusedEventIds,
      initialEntityIds,
      positionByNodeId,
      props.graph.chunkEventEdges,
      props.graph.edges,
      queryLinkedNodeIds,
      selectedEntityTypes,
      layoutStyle,
      layoutRevision,
      selectedNodeId,
    ],
  );

  function applyShowcase(showcase: GraphShowcase | null) {
    if (!showcase) return;
    shouldFitViewRef.current = true;
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setFocusedChunkIds(new Set());
    setFocusedEntityIds(new Set(showcase.entityIds));
    setFocusedEventIds(new Set(showcase.eventIds));
    setSelectedNodeId(null);
    setActiveQueryLabel(showcase.title);
    setQueryLinkedNodeIds(
      new Set(
        showcase.linkedNodeIds.length > 0
          ? showcase.linkedNodeIds
          : [...showcase.eventIds, ...showcase.entityIds].slice(0, 6),
      ),
    );
    setSelectedEntityTypes(
      buildSelectedEntityTypes(showcase.entityIds, entityById),
    );
    setEntityTypeQuery("");
    setSuggestionsOpen(false);
    setLayoutRevision((current) => current + 1);
  }

  useEffect(() => {
    setNodes(graphModel.nodes);
    setEdges(graphModel.edges);
    if (shouldFitViewRef.current) {
      shouldFitViewRef.current = false;
      window.requestAnimationFrame(() => {
        fitView({ padding: 0.2, maxZoom: 1, duration: 320 });
      });
    }
  }, [fitView, graphModel.edges, graphModel.nodes, setEdges, setNodes]);

  useEffect(() => {
    if (props.focus) return;
    if (!activeShowcase) return;
    applyShowcase(activeShowcase);
  }, [activeShowcase, graphIdentity, props.focus?.key]);

  useEffect(() => {
    const availableTypes = new Set(
      entityTypeOptions.map((option) => option.type),
    );
    setSelectedEntityTypes((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set<string>();
      for (const type of current) {
        if (availableTypes.has(type)) {
          next.add(type);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [entityTypeOptions]);

  useEffect(() => {
    const nextLayoutStyle = normalizeGraphLayoutStyle(props.defaultLayoutStyle);
    setLayoutStyle((current) => {
      if (current === nextLayoutStyle) return current;
      shouldFitViewRef.current = true;
      setLayoutRevision((revision) => revision + 1);
      return nextLayoutStyle;
    });
  }, [props.defaultLayoutStyle]);

  useEffect(() => {
    if (!props.focus) return;
    const chunkIds = props.focus.chunkIds
      .filter((id) => chunkById.has(id))
      .slice(0, 12);
    const eventIdsFromChunks = uniqueGraphIds(
      chunkIds.flatMap((chunkId) => eventIdsByChunkId.get(chunkId) ?? []),
    );
    const directEventIds = props.focus.eventIds
      .filter((id) => eventById.has(id))
      .slice(0, FOCUS_EVENT_LIMIT);
    const eventIds = uniqueGraphIds([
      ...eventIdsFromChunks,
      ...directEventIds,
    ]).slice(0, FOCUS_EVENT_LIMIT);
    const directEntityIds = props.focus.entityIds
      .filter((id) => entityById.has(id))
      .slice(0, FOCUS_ENTITY_LIMIT);
    const entityIds = new Set(directEntityIds);
    for (const eventId of eventIds) {
      for (const entityId of entityIdsByEventId.get(eventId) ?? []) {
        entityIds.add(entityId);
        if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
      }
      if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
    }
    setActiveGraphMode("manual");
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setFocusedChunkIds(new Set(chunkIds));
    setFocusedEntityIds(entityIds);
    setFocusedEventIds(new Set(eventIds));
    setSelectedNodeId(null);
    setSelectedEntityTypes(buildSelectedEntityTypes([...entityIds], entityById));
    setGraphQuery(props.focus.query);
    setActiveQueryLabel(
      `${graphText(props.language, "当前搜索", "Search")} · ${props.focus.query}`,
    );
    setQueryLinkedNodeIds(
      new Set(
        chunkIds.length > 0
          ? chunkIds
          : eventIds.length > 0
            ? eventIds
            : directEntityIds,
      ),
    );
    setSuggestionsOpen(false);
    setLayoutRevision((current) => current + 1);
    shouldFitViewRef.current = true;
  }, [
    chunkById,
    entityById,
    entityIdsByEventId,
    eventById,
    eventIdsByChunkId,
    props.focus?.key,
  ]);


  useEffect(() => {
    expandedEventIdsRef.current = expandedEventIds;
  }, [expandedEventIds]);

  useEffect(() => () => clearClickTimer(), []);

  const onNodeClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    clearClickTimer();
    const data = node.data as GraphNodeData;
    if (data.kind === "question") {
      setSelectedNodeId(null);
      return;
    }

    setSelectedNodeId(node.id);
    if (data.kind === "chunk") {
      props.onOpenChunk(node.id);
      return;
    }
    if (data.kind === "entity") {
      props.onOpenEntity(node.id);
      clickTimerRef.current = window.setTimeout(() => {
        expandEntityNode(node.id);
        clickTimerRef.current = null;
      }, 220);
      return;
    }

    props.onOpenEvent(node.id);
    clickTimerRef.current = window.setTimeout(() => {
      expandEventNode(node.id);
      clickTimerRef.current = null;
    }, 220);
  };

  const onNodeDoubleClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    clearClickTimer();
    setSelectedNodeId(node.id);
    const data = node.data as GraphNodeData;
    if (data.kind === "question") {
      return;
    }
    if (data.kind === "entity") {
      props.onOpenEntity(node.id);
      return;
    }
    if (data.kind === "chunk") {
      props.onOpenChunk(node.id);
      return;
    }
    props.onOpenEvent(node.id);
    collapseEventNode(node.id);
  };

  function expandEntityNode(entityId: string) {
    setExpandedEntityIds((current) => {
      if (current.has(entityId)) {
        return current;
      }
      const next = new Set(current);
      next.add(entityId);
      return next;
    });
  }

  function expandEventNode(eventId: string) {
    setExpandedEventIds((current) => {
      if (current.has(eventId)) {
        return current;
      }
      const next = new Set(current);
      next.add(eventId);
      return next;
    });
  }

  function collapseEventNode(eventId: string) {
    setExpandedEventIds((current) => {
      if (!current.has(eventId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(eventId);
      return next;
    });
  }

  function clearClickTimer() {
    if (clickTimerRef.current == null) {
      return;
    }
    window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
  }

  function resetGraph() {
    shouldFitViewRef.current = true;
    setGraphQuery("");
    setActiveGraphMode("overview");
    setShowcaseSeed(Math.floor(Math.random() * 1_000_000));
    setShowcaseRevision((current) => current + 1);
  }

  function showGraphPreset(mode: GraphShowcaseMode) {
    shouldFitViewRef.current = true;
    setGraphQuery("");
    setActiveGraphMode(mode);
    setShowcaseSeed(Math.floor(Math.random() * 1_000_000));
    setShowcaseRevision((current) => current + 1);
  }

  function rotateGraphShowcase() {
    shouldFitViewRef.current = true;
    setGraphQuery("");
    setActiveGraphMode((current) => (current === "manual" ? "overview" : current));
    setShowcaseSeed(Math.floor(Math.random() * 1_000_000));
    setShowcaseRevision((current) => current + 1);
  }

  function autoLayoutCurrentGraph() {
    shouldFitViewRef.current = true;
    setSelectedNodeId(null);
    setLayoutRevision((current) => current + 1);
  }

  function changeLayoutStyle(value: GraphLayoutStyle) {
    shouldFitViewRef.current = true;
    setSelectedNodeId(null);
    setLayoutStyle(value);
    setLayoutRevision((current) => current + 1);
  }

  function revealSuggestion(suggestion: GraphSuggestion) {
    const chunkIds = new Set<string>();
    const entityIds = new Set<string>();
    const eventIds = new Set<string>();
    if (suggestion.kind === "chunk") {
      chunkIds.add(suggestion.id);
      for (const eventId of eventIdsByChunkId.get(suggestion.id) ?? []) {
        eventIds.add(eventId);
        const chunkId = chunkIdByEventId.get(eventId);
        if (chunkId) chunkIds.add(chunkId);
        for (const entityId of entityIdsByEventId.get(eventId) ?? []) {
          entityIds.add(entityId);
          if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
        }
        if (eventIds.size >= FOCUS_EVENT_LIMIT) break;
      }
    } else if (suggestion.kind === "entity") {
      entityIds.add(suggestion.id);
      for (const eventId of (eventIdsByEntityId.get(suggestion.id) ?? []).slice(
        0,
        FOCUS_EVENT_LIMIT,
      )) {
        eventIds.add(eventId);
        const chunkId = chunkIdByEventId.get(eventId);
        if (chunkId) chunkIds.add(chunkId);
        for (const entityId of entityIdsByEventId.get(eventId) ?? []) {
          entityIds.add(entityId);
          if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
        }
        if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
      }
    } else {
      eventIds.add(suggestion.id);
      const chunkId = chunkIdByEventId.get(suggestion.id);
      if (chunkId) chunkIds.add(chunkId);
      for (const entityId of entityIdsByEventId.get(suggestion.id) ?? []) {
        entityIds.add(entityId);
      }
    }
    setActiveGraphMode("manual");
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setFocusedChunkIds(chunkIds);
    setFocusedEntityIds(entityIds);
    setFocusedEventIds(eventIds);
    setSelectedNodeId(null);
    setSelectedEntityTypes(buildSelectedEntityTypes([...entityIds], entityById));
    setGraphQuery(suggestion.label);
    setActiveQueryLabel(
      `${graphText(props.language, "当前搜索", "Search")} · ${suggestion.label}`,
    );
    setQueryLinkedNodeIds(new Set(chunkIds.size > 0 ? [...chunkIds] : [suggestion.id]));
    setSuggestionsOpen(false);
    setLayoutRevision((current) => current + 1);
    shouldFitViewRef.current = true;
  }

  function toggleEntityType(type: string) {
    shouldFitViewRef.current = true;
    setSelectedNodeId(null);
    setSelectedEntityTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  function selectAllEntityTypes() {
    shouldFitViewRef.current = true;
    setSelectedNodeId(null);
    setSelectedEntityTypes(
      new Set(entityTypeOptions.map((option) => option.type)),
    );
  }

  function clearEntityTypeFilter() {
    shouldFitViewRef.current = true;
    setSelectedNodeId(null);
    setSelectedEntityTypes(new Set());
    setEntityTypeQuery("");
    setExpandedEventIds(new Set());
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-xl bg-background">
      <style>{`
        @keyframes sag-edge-dash-slow {
          from { stroke-dashoffset: 0; }
          to { stroke-dashoffset: -32; }
        }
        .sag-graph-flow .react-flow__edges {
          z-index: 0 !important;
        }
        .sag-graph-flow .react-flow__nodes {
          z-index: 2 !important;
        }
        .sag-graph-flow .react-flow__node {
          z-index: 2 !important;
        }
        .sag-graph-flow .react-flow__node {
          background-clip: padding-box;
        }
        .sag-rich-graph-node {
          min-width: 0;
        }
        .sag-rich-graph-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sag-rich-graph-label-inline {
          white-space: nowrap;
        }
        .sag-rich-graph-label-question {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          white-space: normal;
        }
        .sag-rich-graph-handle {
          opacity: 0;
          pointer-events: none;
        }
      `}</style>
      <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-2 rounded-xl border border-border bg-background/90 p-2 shadow-[0_10px_30px_rgba(24,36,58,0.08)] backdrop-blur">
        <MetricChip
          label={graphText(props.language, "切片", "Chunks")}
          value={(props.graph.chunks ?? []).length}
        />
        <MetricChip
          label={graphText(props.language, "实体", "Entities")}
          value={props.graph.entities.length}
        />
        <MetricChip
          label={graphText(props.language, "事件", "Events")}
          value={props.graph.events.length}
        />
        <MetricChip
          label={graphText(props.language, "关系", "Relations")}
          value={props.graph.edges.length}
        />
        <Button type="button" variant="outline" size="sm" onClick={resetGraph}>
          {graphText(props.language, "重置", "Reset")}
        </Button>
        {GRAPH_SHOWCASE_BUTTONS.map((item) => (
          <Button
            key={item.mode}
            type="button"
            variant={activeGraphMode === item.mode ? "default" : "outline"}
            size="sm"
            onClick={() => showGraphPreset(item.mode)}
            title={graphText(
              props.language,
              "不依赖问答上下文，按数据库真实关系生成精选子图",
              "Build a curated subgraph from real project graph relations without a chat context",
            )}
          >
            {graphText(props.language, item.zh, item.en)}
          </Button>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={rotateGraphShowcase}>
          {graphText(props.language, "换一批", "Shuffle")}
        </Button>
        <select
          value={layoutStyle}
          title={graphText(props.language, "重排风格", "Layout style")}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) =>
            changeLayoutStyle(event.target.value as GraphLayoutStyle)
          }
        >
          <option value="search_layers">
            {graphText(props.language, "搜索居中", "Search-centered")}
          </option>
          <option value="entity_inner">
            {graphText(props.language, "实体内圈", "Entity inner ring")}
          </option>
          <option value="columns">
            {graphText(props.language, "分栏", "Columns")}
          </option>
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={autoLayoutCurrentGraph}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {graphText(props.language, "自动重排", "Auto layout")}
        </Button>
      </div>
      <div className="absolute left-3 top-[68px] z-20 w-[min(520px,calc(100%-24px))]">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          value={graphQuery}
          onChange={(event) => {
            setGraphQuery(event.target.value);
            setSuggestionsOpen(true);
          }}
          onFocus={() => setSuggestionsOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && suggestions[0]) {
              event.preventDefault();
              revealSuggestion(suggestions[0]);
            }
            if (event.key === "Escape") {
              setSuggestionsOpen(false);
            }
          }}
          placeholder={graphText(
            props.language,
            "搜索切片、实体或事件，支持模糊匹配",
            "Search chunks, entities or events with fuzzy matching",
          )}
          className="h-9 w-full rounded-lg border border-input bg-background/95 pl-9 pr-3 text-sm shadow-lg outline-none backdrop-blur focus-visible:ring-2 focus-visible:ring-ring"
        />
        {suggestionsOpen && graphQuery.trim() ? (
          <div className="mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-xl">
            {suggestions.length > 0 ? (
              suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}-${suggestion.id}`}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => revealSuggestion(suggestion)}
                >
                  <span className="min-w-0 truncate text-sm">
                    <RichTextFragment text={suggestion.label} />
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {suggestion.kind === "chunk"
                      ? graphText(props.language, "切片", "Chunk")
                      : suggestion.kind === "entity"
                        ? graphText(props.language, "实体", "Entity")
                        : graphText(props.language, "事件", "Event")}
                  </span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {graphText(
                  props.language,
                  "没有找到相似实体或事件",
                  "No similar entity or event found",
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <EntityTypeFilterPanel
        language={props.language}
        options={filteredEntityTypeOptions}
        totalCount={entityTypeOptions.length}
        selectedTypes={selectedEntityTypes}
        query={entityTypeQuery}
        collapsed={entityTypeFilterCollapsed}
        onToggleCollapsed={() =>
          setEntityTypeFilterCollapsed((collapsed) => !collapsed)
        }
        onQueryChange={setEntityTypeQuery}
        onToggleType={toggleEntityType}
        onSelectAll={selectAllEntityTypes}
        onClear={clearEntityTypeFilter}
      />
      <ReactFlow<GraphNode, GraphEdge>
        className="sag-graph-flow"
        nodes={nodes}
        edges={edges}
        edgeTypes={graphEdgeTypes}
        nodeTypes={graphNodeTypes}
        defaultEdgeOptions={{ zIndex: 0 }}
        elevateEdgesOnSelect={false}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setSelectedNodeId(null)}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.12}
        maxZoom={2.5}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as GraphNodeData;
            return data.kind === "question"
              ? "#22a06b"
              : data.kind === "chunk"
                ? "#1b6fcc"
                : data.kind === "entity"
                  ? data.entityTypeColor ?? "#df5b25"
                  : "#4f46e5";
          }}
          maskColor="rgba(238,242,247,0.72)"
        />
      </ReactFlow>
    </div>
  );
}

function RichGraphNode({ data }: NodeProps<GraphNode>) {
  const nodeData = data as GraphNodeData;
  const isQuestion = nodeData.kind === "question";
  return (
    <div className="sag-rich-graph-node" title={nodeData.label}>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="sag-rich-graph-handle"
      />
      <div
        className={cn(
          "sag-rich-graph-label",
          isQuestion ? "sag-rich-graph-label-question" : "sag-rich-graph-label-inline",
        )}
      >
        <RichTextFragment text={nodeData.label} />
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="sag-rich-graph-handle"
      />
    </div>
  );
}

function graphText(language: SupportedLanguage, zh: string, en: string) {
  return language === "en" ? en : zh;
}

function BusEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  data,
  interactionWidth,
}: EdgeProps) {
  const edgeData = (data ?? {}) as {
    preferredAxis?: "auto" | "horizontal" | "vertical";
    busOffset?: number;
  };
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const preferredAxis = edgeData.preferredAxis ?? "auto";
  const shouldUseHorizontalBus =
    preferredAxis === "horizontal" ||
    (preferredAxis === "auto" && absDy >= absDx * 0.58);
  const offset = Math.max(
    38,
    Math.min(
      96,
      edgeData.busOffset ??
        Math.max(
          52,
          Math.min(88, (shouldUseHorizontalBus ? absDy : absDx) * 0.38),
        ),
    ),
  );
  const direction = shouldUseHorizontalBus
    ? dy >= 0
      ? 1
      : -1
    : dx >= 0
      ? 1
      : -1;

  const edgePath = shouldUseHorizontalBus
    ? buildOrthogonalPath([
        [sourceX, sourceY],
        [sourceX, sourceY + direction * offset],
        [targetX, sourceY + direction * offset],
        [targetX, targetY],
      ])
    : buildOrthogonalPath([
        [sourceX, sourceY],
        [sourceX + direction * offset, sourceY],
        [sourceX + direction * offset, targetY],
        [targetX, targetY],
      ]);

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth ?? 14}
    />
  );
}

function buildOrthogonalPath(points: Array<[number, number]>) {
  const [start, ...rest] = points;
  return [
    `M ${roundPathNumber(start[0])} ${roundPathNumber(start[1])}`,
    ...rest.map(([x, y]) => `L ${roundPathNumber(x)} ${roundPathNumber(y)}`),
  ].join(" ");
}

function roundPathNumber(value: number) {
  return Math.round(value * 10) / 10;
}

function normalizeGraphLayoutStyle(value: unknown): GraphLayoutStyle {
  return value === "entity_inner" || value === "columns" || value === "search_layers"
    ? value
    : "search_layers";
}

type EntityTypeOption = {
  type: string;
  label: string;
  visibleCount: number;
  totalCount: number;
};

type VisibleGraphScope = {
  hasFocusedGraph: boolean;
  visibleChunkIds: Set<string>;
  visibleEntityIds: Set<string>;
  visibleEventIds: Set<string>;
};

function normalizeEntityType(value: unknown) {
  const type = String(value ?? "").trim();
  return type || "__sag_uncategorized_entity__";
}

function formatEntityTypeLabel(type: string, language: SupportedLanguage) {
  return type === "__sag_uncategorized_entity__"
    ? graphText(language, "未分类", "Uncategorized")
    : type;
}

function buildEntityTypeOptionsFromScope(input: {
  scopeEntityIds: Iterable<string>;
  visibleEntityIds: Set<string>;
  entityById: Map<string, ProjectGraphEntityRecord>;
  language: SupportedLanguage;
}): EntityTypeOption[] {
  const counts = new Map<
    string,
    { visibleCount: number; totalCount: number; firstIndex: number }
  >();
  let index = 0;
  for (const entityId of input.scopeEntityIds) {
    const entity = input.entityById.get(entityId);
    if (!entity) {
      index += 1;
      continue;
    }
    const type = normalizeEntityType(entity.type);
    const current = counts.get(type) ?? {
      visibleCount: 0,
      totalCount: 0,
      firstIndex: index,
    };
    current.totalCount += 1;
    if (input.visibleEntityIds.has(entityId)) {
      current.visibleCount += 1;
    }
    counts.set(type, current);
    index += 1;
  }

  // Keep the order stable while users check/uncheck types: sort by the
  // current canvas scope's total count, not by visibleCount. visibleCount changes
  // as filters are applied, but totalCount represents how many entities of this
  // type are available in the current canvas context.
  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      label: formatEntityTypeLabel(type, input.language),
      visibleCount: count.visibleCount,
      totalCount: count.totalCount,
      firstIndex: count.firstIndex,
    }))
    .sort(
      (left, right) =>
        right.totalCount - left.totalCount ||
        left.label.localeCompare(right.label) ||
        left.firstIndex - right.firstIndex,
    )
    .map(({ firstIndex: _firstIndex, ...option }) => option);
}

function buildVisibleGraphScope(input: {
  initialEntityIds: Set<string>;
  expandedEntityIds: Set<string>;
  expandedEventIds: Set<string>;
  focusedChunkIds: Set<string>;
  focusedEntityIds: Set<string>;
  focusedEventIds: Set<string>;
  eventIdsByChunkId: Map<string, string[]>;
  chunkIdByEventId: Map<string, string>;
  eventIdsByEntityId: Map<string, string[]>;
  entityIdsByEventId: Map<string, string[]>;
}): VisibleGraphScope {
  const hasFocusedGraph =
    input.focusedChunkIds.size > 0 ||
    input.focusedEntityIds.size > 0 ||
    input.focusedEventIds.size > 0;
  const visibleChunkIds = new Set(hasFocusedGraph ? input.focusedChunkIds : []);
  const visibleEntityIds = new Set(
    hasFocusedGraph ? input.focusedEntityIds : input.initialEntityIds,
  );
  const visibleEventIds = new Set(hasFocusedGraph ? input.focusedEventIds : []);

  for (const chunkId of visibleChunkIds) {
    for (const eventId of input.eventIdsByChunkId.get(chunkId) ?? []) {
      visibleEventIds.add(eventId);
    }
  }

  for (const eventId of visibleEventIds) {
    const chunkId = input.chunkIdByEventId.get(eventId);
    if (chunkId && hasFocusedGraph) {
      visibleChunkIds.add(chunkId);
    }
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      visibleEntityIds.add(entityId);
    }
  }

  for (const entityId of input.expandedEntityIds) {
    visibleEntityIds.add(entityId);
    for (const eventId of input.eventIdsByEntityId.get(entityId) ?? []) {
      visibleEventIds.add(eventId);
      const chunkId = input.chunkIdByEventId.get(eventId);
      if (chunkId && hasFocusedGraph) {
        visibleChunkIds.add(chunkId);
      }
    }
  }

  for (const eventId of input.expandedEventIds) {
    visibleEventIds.add(eventId);
    const chunkId = input.chunkIdByEventId.get(eventId);
    if (chunkId && hasFocusedGraph) {
      visibleChunkIds.add(chunkId);
    }
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      visibleEntityIds.add(entityId);
    }
  }

  for (const eventId of visibleEventIds) {
    const chunkId = input.chunkIdByEventId.get(eventId);
    if (chunkId && hasFocusedGraph) {
      visibleChunkIds.add(chunkId);
    }
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      visibleEntityIds.add(entityId);
    }
  }

  return {
    hasFocusedGraph,
    visibleChunkIds,
    visibleEntityIds,
    visibleEventIds,
  };
}

function cloneVisibleGraphScope(scope: VisibleGraphScope): VisibleGraphScope {
  return {
    hasFocusedGraph: scope.hasFocusedGraph,
    visibleChunkIds: new Set(scope.visibleChunkIds),
    visibleEntityIds: new Set(scope.visibleEntityIds),
    visibleEventIds: new Set(scope.visibleEventIds),
  };
}

function collectExpandedEventEntityIds(input: {
  expandedEventIds: Set<string>;
  entityIdsByEventId: Map<string, string[]>;
}) {
  const entityIds = new Set<string>();
  for (const eventId of input.expandedEventIds) {
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      entityIds.add(entityId);
    }
  }
  return entityIds;
}

function applyEntityVisibilityRules(input: {
  visibleEntityIds: Set<string>;
  visibleEventIds: Set<string>;
  selectedEntityTypes: Set<string>;
  expandedEventIds: Set<string>;
  entityById: Map<string, ProjectGraphEntityRecord>;
  entityIdsByEventId: Map<string, string[]>;
}) {
  const eventRevealedEntityIds = collectExpandedEventEntityIds({
    expandedEventIds: input.expandedEventIds,
    entityIdsByEventId: input.entityIdsByEventId,
  });

  for (const entityId of [...input.visibleEntityIds]) {
    const entity = input.entityById.get(entityId);
    const type = normalizeEntityType(entity?.type);
    const visibleByType = input.selectedEntityTypes.has(type);
    const visibleByExpandedEvent = eventRevealedEntityIds.has(entityId);
    if (!entity || (!visibleByType && !visibleByExpandedEvent)) {
      input.visibleEntityIds.delete(entityId);
    }
  }

  // Entity type filtering is intentionally entity-only.
  // Events represent the current canvas context (search results, expanded nodes,
  // or the default/global view), so checking or unchecking entity types must not
  // remove event nodes from the canvas. Related edges are still filtered later by
  // visibleNodeIds, because hidden entities simply won't have visible edges.
}

function resolveQuestionLinkedNodeIds(input: {
  layoutStyle: GraphLayoutStyle;
  queryLinkedNodeIds: Set<string>;
  visibleNodeIds: Set<string>;
  visibleChunkIds: string[];
  visibleEntityIds: string[];
}) {
  if (input.layoutStyle === "entity_inner") {
    const entityIds = input.visibleEntityIds.filter((entityId) =>
      input.visibleNodeIds.has(entityId),
    );
    if (entityIds.length > 0) return entityIds;
  }

  const chunkIds = input.visibleChunkIds.filter((chunkId) =>
    input.visibleNodeIds.has(chunkId),
  );
  if (chunkIds.length > 0) return chunkIds;

  return [...input.queryLinkedNodeIds].filter((nodeId) =>
    input.visibleNodeIds.has(nodeId),
  );
}

function buildVisibleGraph(input: {
  initialEntityIds: Set<string>;
  expandedEntityIds: Set<string>;
  expandedEventIds: Set<string>;
  focusedChunkIds: Set<string>;
  focusedEntityIds: Set<string>;
  focusedEventIds: Set<string>;
  chunkById: Map<string, ProjectGraphChunkRecord>;
  entityById: Map<string, ProjectGraphEntityRecord>;
  eventById: Map<string, ProjectGraphEventRecord>;
  eventIdsByChunkId: Map<string, string[]>;
  chunkIdByEventId: Map<string, string>;
  eventIdsByEntityId: Map<string, string[]>;
  entityIdsByEventId: Map<string, string[]>;
  edges: ProjectGraphRecord["edges"];
  chunkEventEdges: ProjectGraphRecord["chunkEventEdges"];
  positionByNodeId: Map<string, GraphPosition>;
  selectedNodeId: string | null;
  activeQueryLabel: string;
  queryLinkedNodeIds: Set<string>;
  selectedEntityTypes: Set<string>;
  layoutStyle: GraphLayoutStyle;
  layoutRevision: number;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { hasFocusedGraph, visibleChunkIds, visibleEntityIds, visibleEventIds } =
    buildVisibleGraphScope(input);

  applyEntityVisibilityRules({
    visibleEntityIds,
    visibleEventIds,
    selectedEntityTypes: input.selectedEntityTypes,
    expandedEventIds: input.expandedEventIds,
    entityById: input.entityById,
    entityIdsByEventId: input.entityIdsByEventId,
  });

  const nodes: GraphNode[] = [];
  const chunkIds = [...visibleChunkIds]
    .filter((id) => input.chunkById.has(id))
    .sort((a, b) =>
      compareChunks(input.chunkById.get(a), input.chunkById.get(b)),
    );
  const entityIds = orderEntityIdsByTypeCluster(
    [...visibleEntityIds].filter((id) => input.entityById.has(id)),
    input.entityById,
  );
  const eventIds = [...visibleEventIds]
    .filter((id) => input.eventById.has(id))
    .sort((a, b) =>
      compareEvents(input.eventById.get(a), input.eventById.get(b)),
    );
  const focusedPositions = hasFocusedGraph
    ? buildFocusedPositionMap(
        chunkIds,
        entityIds,
        eventIds,
        input.layoutRevision,
        input.layoutStyle,
      )
    : null;

  if (hasFocusedGraph && input.activeQueryLabel.trim()) {
    const position =
      focusedPositions?.get(QUESTION_NODE_ID) ?? fallbackPosition();
    nodes.push(
      createGraphNode({
        id: QUESTION_NODE_ID,
        label: input.activeQueryLabel,
        kind: "question",
        expanded: false,
        x: position.x,
        y: position.y,
        root: true,
      }),
    );
  }

  for (const chunkId of chunkIds) {
    const chunk = input.chunkById.get(chunkId);
    if (!chunk) continue;
    const position =
      focusedPositions?.get(chunk.id) ??
      input.positionByNodeId.get(chunk.id) ??
      fallbackPosition();
    nodes.push(
      createGraphNode({
        id: chunk.id,
        label: chunk.heading || trimGraphLabel(chunk.content),
        kind: "chunk",
        expanded: false,
        x: position.x,
        y: position.y,
      }),
    );
  }

  for (const entityId of entityIds) {
    const entity = input.entityById.get(entityId);
    if (!entity) continue;
    const position =
      focusedPositions?.get(entity.id) ??
      input.positionByNodeId.get(entity.id) ??
      fallbackPosition();
    nodes.push(
      createGraphNode({
        id: entity.id,
        label: entity.name,
        kind: "entity",
        expanded: input.expandedEntityIds.has(entity.id),
        x: position.x,
        y: position.y,
        root: position.root,
        entityType: entity.type,
      }),
    );
  }

  for (const eventId of eventIds) {
    const event = input.eventById.get(eventId);
    if (!event) continue;
    const position =
      focusedPositions?.get(event.id) ??
      input.positionByNodeId.get(event.id) ??
      fallbackPosition();
    nodes.push(
      createGraphNode({
        id: event.id,
        label: event.title,
        kind: "event",
        expanded: input.expandedEventIds.has(event.id),
        x: position.x,
        y: position.y,
      }),
    );
  }

  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const visibleNodeById = new Map(nodes.map((node) => [node.id, node]));
  const chunkEdges: GraphEdge[] = input.chunkEventEdges
    .filter(
      (edge) =>
        visibleNodeIds.has(edge.chunkId) && visibleNodeIds.has(edge.eventId),
    )
    .map((edge) => {
      const visualLink = orientTopToBottomEdge({
        sourceId: edge.chunkId,
        targetId: edge.eventId,
        nodeById: visibleNodeById,
      });
      return {
        id: `${edge.chunkId}-${edge.eventId}`,
        type: "bus",
        source: visualLink.source,
        target: visualLink.target,
        animated: false,
        data: { preferredAxis: "horizontal", busOffset: 66 },
        interactionWidth: 14,
        zIndex: 0,
        style: {
          stroke: "#1b6fcc",
          strokeWidth: 1.45,
          opacity: 0.38,
          strokeDasharray: EDGE_DASH_PATTERN,
          animation: EDGE_DASH_ANIMATION,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
      };
    });
  const edges: GraphEdge[] = input.edges
    .filter(
      (edge) =>
        visibleNodeIds.has(edge.entityId) && visibleNodeIds.has(edge.eventId),
    )
    .map((edge) => {
      const eventExpandsEntity =
        input.expandedEventIds.has(edge.eventId) &&
        !input.expandedEntityIds.has(edge.entityId);
      const semanticSource = eventExpandsEntity ? edge.eventId : edge.entityId;
      const semanticTarget = eventExpandsEntity ? edge.entityId : edge.eventId;
      const visualLink = orientTopToBottomEdge({
        sourceId: semanticSource,
        targetId: semanticTarget,
        nodeById: visibleNodeById,
      });
      const entityColor = entityTypeDotColor(
        normalizeEntityType(input.entityById.get(edge.entityId)?.type),
      );
      return {
        id: `${edge.entityId}-${edge.eventId}`,
        type: "bus",
        source: visualLink.source,
        target: visualLink.target,
        animated: false,
        data: {
          preferredAxis: "horizontal",
          entityId: edge.entityId,
          entityTypeColor: entityColor,
        },
        interactionWidth: 14,
        zIndex: 0,
        style: {
          stroke: entityColor,
          strokeWidth: 1.35,
          opacity: 0.36,
          strokeDasharray: EDGE_DASH_PATTERN,
          animation: EDGE_DASH_ANIMATION,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
      };
    });
  if (visibleNodeIds.has(QUESTION_NODE_ID)) {
    const questionLinkedNodeIds = resolveQuestionLinkedNodeIds({
      layoutStyle: input.layoutStyle,
      queryLinkedNodeIds: input.queryLinkedNodeIds,
      visibleNodeIds,
      visibleChunkIds: chunkIds,
      visibleEntityIds: entityIds,
    });
    for (const nodeId of questionLinkedNodeIds) {
      const visualLink = orientTopToBottomEdge({
        sourceId: QUESTION_NODE_ID,
        targetId: nodeId,
        nodeById: visibleNodeById,
      });
      edges.push({
        id: `${QUESTION_NODE_ID}-${nodeId}`,
        type: "bus",
        source: visualLink.source,
        target: visualLink.target,
        animated: false,
        style: {
          stroke: "#22a06b",
          strokeWidth: 1.65,
          strokeDasharray: EDGE_DASH_PATTERN,
          animation: EDGE_DASH_ANIMATION,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        data: { preferredAxis: "horizontal", busOffset: 72 },
        interactionWidth: 14,
        zIndex: 0,
      });
    }
  }

  return applySelectionStyles({
    nodes,
    edges: [...chunkEdges, ...edges],
    selectedNodeId: input.selectedNodeId,
  });
}

function orientTopToBottomEdge(input: {
  sourceId: string;
  targetId: string;
  nodeById: Map<string, GraphNode>;
}) {
  const sourceNode = input.nodeById.get(input.sourceId);
  const targetNode = input.nodeById.get(input.targetId);
  if (!sourceNode || !targetNode) {
    return { source: input.sourceId, target: input.targetId };
  }

  const sourceCenterY = getNodeCenterY(sourceNode);
  const targetCenterY = getNodeCenterY(targetNode);
  if (sourceCenterY <= targetCenterY) {
    return { source: input.sourceId, target: input.targetId };
  }
  return { source: input.targetId, target: input.sourceId };
}

function getNodeCenterY(node: GraphNode) {
  const kind = (node.data as GraphNodeData).kind;
  const height = kind === "question" ? 72 : NODE_HEIGHT;
  return node.position.y + height / 2;
}

function createGraphNode(input: {
  id: string;
  label: string;
  kind: GraphNodeData["kind"];
  expanded: boolean;
  x: number;
  y: number;
  root?: boolean;
  entityType?: string | null;
}): GraphNode {
  const nodeWidth =
    input.kind === "question"
      ? QUESTION_NODE_WIDTH
      : input.root
        ? ENTITY_NODE_WIDTH + 20
        : input.kind === "chunk"
          ? CHUNK_NODE_WIDTH
          : input.kind === "entity"
            ? ENTITY_NODE_WIDTH
            : EVENT_NODE_WIDTH;
  const entityType =
    input.kind === "entity" ? normalizeEntityType(input.entityType) : "";
  const entityTypeColor =
    input.kind === "entity" ? entityTypeDotColor(entityType) : undefined;
  const sourcePosition = Position.Bottom;
  const targetPosition = Position.Top;
  return {
    id: input.id,
    type: "rich",
    position: { x: input.x, y: input.y },
    sourcePosition,
    targetPosition,
    data: {
      label: input.label,
      kind: input.kind,
      expanded: input.expanded,
      entityType,
      entityTypeColor,
    },
    style: {
      width: nodeWidth,
      borderRadius: 12,
      border:
        input.kind === "question"
          ? "1.5px solid #22a06b"
          : input.kind === "chunk"
            ? "1px solid rgba(27, 111, 204, 0.45)"
            : input.kind === "entity" && entityTypeColor
              ? input.expanded
                ? `1.7px solid ${entityTypeColor}`
                : `1px solid ${hexToRgba(entityTypeColor, 0.55)}`
              : input.expanded
                ? "1.5px solid #1b6fcc"
                : "1px solid #dce4ee",
      background:
        input.kind === "question"
          ? "linear-gradient(145deg, #ecfdf5, #f0fdf8)"
          : input.kind === "chunk"
            ? "linear-gradient(145deg, #eff6ff, #f8fbff)"
            : input.kind === "entity" && entityTypeColor
              ? `linear-gradient(145deg, ${entityTypeCardBackground(entityTypeColor, 0.88)}, ${entityTypeCardBackground(entityTypeColor, 0.96)})`
              : "#f5f9ff",
      color: "#18243a",
      fontSize: 12,
      fontWeight:
        input.kind === "question"
          ? 700
          : input.kind === "entity"
            ? 650
            : input.kind === "chunk"
              ? 600
              : 520,
      padding: input.kind === "question" ? "12px 14px" : "8px 10px",
      boxShadow:
        input.kind === "question"
          ? "0 14px 34px rgba(34, 160, 107, 0.16)"
          : input.kind === "chunk"
            ? "0 8px 20px rgba(27, 111, 204, 0.12)"
            : input.kind === "entity" && entityTypeColor
              ? input.expanded || input.root
                ? `0 12px 30px ${hexToRgba(entityTypeColor, 0.22)}`
                : `0 4px 12px ${hexToRgba(entityTypeColor, 0.1)}`
              : "0 4px 12px rgba(24, 36, 58, 0.07)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: input.kind === "question" ? "normal" : "nowrap",
      lineHeight: input.kind === "question" ? 1.5 : undefined,
    },
    className: cn(input.expanded && "ring-2 ring-ring/25"),
    zIndex: input.kind === "question" || input.root ? 3 : 2,
  };
}

function applySelectionStyles(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
}) {
  if (
    !input.selectedNodeId ||
    !input.nodes.some((node) => node.id === input.selectedNodeId)
  ) {
    return input;
  }

  const relatedNodeIds = new Set([input.selectedNodeId]);
  for (const edge of input.edges) {
    if (
      edge.source === input.selectedNodeId ||
      edge.target === input.selectedNodeId
    ) {
      relatedNodeIds.add(edge.source);
      relatedNodeIds.add(edge.target);
    }
  }

  return {
    nodes: input.nodes.map((node) => {
      const related = relatedNodeIds.has(node.id);
      const selected = node.id === input.selectedNodeId;
      const accentColor = getNodeAccentColor(node);
      return {
        ...node,
        style: {
          ...node.style,
          opacity: related ? 1 : 0.28,
          color: related ? node.style?.color : "#94a3b8",
          background: related
            ? node.style?.background
            : "rgba(248, 250, 252, 0.18)",
          border: selected
            ? `2px solid ${accentColor}`
            : related
              ? node.style?.border
              : "1px solid rgba(226, 232, 240, 0.42)",
          boxShadow: selected
            ? `0 12px 32px ${hexToRgba(accentColor, 0.24)}`
            : related
              ? node.style?.boxShadow
              : "none",
        },
        zIndex: selected ? 5 : related ? 4 : 0,
      };
    }),
    edges: input.edges.map((edge) => {
      const related =
        edge.source === input.selectedNodeId ||
        edge.target === input.selectedNodeId;
      return {
        ...edge,
        animated: false,
        zIndex: related ? 1 : 0,
        style: {
          ...edge.style,
          opacity: related ? 1 : 0,
          stroke: edge.style?.stroke,
          strokeWidth: related ? 2.2 : 1,
        },
      };
    }),
  };
}

function getNodeAccentColor(node: GraphNode) {
  const data = node.data as GraphNodeData;
  if (data.kind === "question") return "#22a06b";
  if (data.kind === "chunk") return "#1b6fcc";
  if (data.kind === "entity") return data.entityTypeColor ?? "#df5b25";
  return "#4f46e5";
}

function buildFocusedPositionMap(
  chunkIds: string[],
  entityIds: string[],
  eventIds: string[],
  revision: number,
  layoutStyle: GraphLayoutStyle,
) {
  if (layoutStyle === "columns") {
    return buildColumnFocusedPositionMap(chunkIds, entityIds, eventIds, revision);
  }
  if (layoutStyle === "entity_inner") {
    return buildSquareFocusedPositionMap({
      layers: [
        { ids: entityIds, nodeWidth: ENTITY_NODE_WIDTH },
        { ids: chunkIds, nodeWidth: CHUNK_NODE_WIDTH },
        { ids: eventIds, nodeWidth: EVENT_NODE_WIDTH },
      ],
      revision,
    });
  }
  return buildSearchLayerFocusedPositionMap(chunkIds, entityIds, eventIds, revision);
}

function buildSearchLayerFocusedPositionMap(
  chunkIds: string[],
  entityIds: string[],
  eventIds: string[],
  revision: number,
) {
  // Search-centered mode: put cited chunks on the inner ring, events on the
  // middle ring, and entities on the outer ring. This makes the visual graph
  // follow the evidence path: question -> chunk -> event -> entity.
  return buildSquareFocusedPositionMap({
    layers: [
      { ids: chunkIds, nodeWidth: CHUNK_NODE_WIDTH },
      { ids: eventIds, nodeWidth: EVENT_NODE_WIDTH },
      { ids: entityIds, nodeWidth: ENTITY_NODE_WIDTH },
    ],
    revision,
  });
}

function buildSquareFocusedPositionMap(input: {
  layers: Array<{ ids: string[]; nodeWidth: number }>;
  revision: number;
}) {
  const positions = new Map<string, GraphPosition>();

  positions.set(QUESTION_NODE_ID, {
    x: -QUESTION_NODE_WIDTH / 2,
    y: -54,
    angle: -Math.PI / 2,
    radius: 0,
    root: true,
  });

  let occupiedRingCount = 0;
  input.layers.forEach((layer, layerIndex) => {
    if (layer.ids.length === 0) return;
    const ringCount = placeOnSquareRings({
      ids: layer.ids,
      positions,
      startHalfWidth: 420 + occupiedRingCount * 280,
      startHalfHeight: 215 + occupiedRingCount * 158,
      ringGapX: 275,
      ringGapY: 152,
      slotSpacingX: Math.max(220, layer.nodeWidth + 65),
      slotSpacingY: 108,
      nodeWidth: layer.nodeWidth,
      nodeHeight: NODE_HEIGHT,
      revision: input.revision + layerIndex * 2,
    });
    occupiedRingCount += Math.max(1, ringCount);
  });

  return positions;
}

function placeOnSquareRings(input: {
  ids: string[];
  positions: Map<string, GraphPosition>;
  startHalfWidth: number;
  startHalfHeight: number;
  ringGapX: number;
  ringGapY: number;
  slotSpacingX: number;
  slotSpacingY: number;
  nodeWidth: number;
  nodeHeight: number;
  revision: number;
}) {
  let index = 0;
  let ring = 0;

  while (index < input.ids.length) {
    const halfWidth = input.startHalfWidth + ring * input.ringGapX;
    const halfHeight = input.startHalfHeight + ring * input.ringGapY;
    const points = squareRingPoints({
      halfWidth,
      halfHeight,
      slotSpacingX: input.slotSpacingX,
      slotSpacingY: input.slotSpacingY,
    });
    const offset = points.length > 0 ? input.revision % points.length : 0;

    for (let pointIndex = 0; pointIndex < points.length && index < input.ids.length; pointIndex += 1) {
      const point = points[(pointIndex + offset) % points.length];
      const id = input.ids[index];
      input.positions.set(id, {
        x: point.x - input.nodeWidth / 2,
        y: point.y - input.nodeHeight / 2,
        angle: Math.atan2(point.y, point.x),
        radius: ring + 1,
      });
      index += 1;
    }
    ring += 1;
  }

  return ring;
}

function squareRingPoints(input: {
  halfWidth: number;
  halfHeight: number;
  slotSpacingX: number;
  slotSpacingY: number;
}) {
  const points: Array<{ x: number; y: number }> = [];
  const topSlots = Math.max(3, Math.floor((input.halfWidth * 2) / input.slotSpacingX) + 1);
  const sideSlots = Math.max(1, Math.floor((input.halfHeight * 2) / input.slotSpacingY) - 1);

  for (let slot = 0; slot < topSlots; slot += 1) {
    const ratio = topSlots === 1 ? 0.5 : slot / (topSlots - 1);
    points.push({ x: -input.halfWidth + ratio * input.halfWidth * 2, y: -input.halfHeight });
  }
  for (let slot = 1; slot <= sideSlots; slot += 1) {
    const ratio = slot / (sideSlots + 1);
    points.push({ x: input.halfWidth, y: -input.halfHeight + ratio * input.halfHeight * 2 });
  }
  for (let slot = 0; slot < topSlots; slot += 1) {
    const ratio = topSlots === 1 ? 0.5 : slot / (topSlots - 1);
    points.push({ x: input.halfWidth - ratio * input.halfWidth * 2, y: input.halfHeight });
  }
  for (let slot = sideSlots; slot >= 1; slot -= 1) {
    const ratio = slot / (sideSlots + 1);
    points.push({ x: -input.halfWidth, y: -input.halfHeight + ratio * input.halfHeight * 2 });
  }

  return points;
}

function buildColumnFocusedPositionMap(
  chunkIds: string[],
  entityIds: string[],
  eventIds: string[],
  _revision: number,
) {
  const positions = new Map<string, GraphPosition>();
  const chunkColumns = Math.min(4, Math.max(1, chunkIds.length));
  const eventColumns = Math.min(4, Math.max(1, eventIds.length));
  const entityColumns = Math.min(5, Math.max(1, entityIds.length));
  const chunkGapX = 245;
  const eventGapX = 240;
  const entityGapX = 210;
  const rowGap = 96;
  const chunkStartY = 80;
  const chunkRows = Math.max(1, Math.ceil(chunkIds.length / chunkColumns));
  const eventStartY =
    chunkStartY + (chunkIds.length > 0 ? chunkRows * (rowGap + 10) : 0) + 24;
  const eventRows = Math.max(1, Math.ceil(eventIds.length / eventColumns));
  const entityStartY =
    eventStartY + (eventIds.length > 0 ? eventRows * (rowGap + 12) : 0) + 44;

  positions.set(QUESTION_NODE_ID, {
    x: -QUESTION_NODE_WIDTH / 2,
    y: -96,
    angle: -Math.PI / 2,
    radius: 0,
    root: true,
  });

  chunkIds.forEach((id, index) => {
    const row = Math.floor(index / chunkColumns);
    const column = index % chunkColumns;
    positions.set(id, {
      x: (column - (chunkColumns - 1) / 2) * chunkGapX - CHUNK_NODE_WIDTH / 2,
      y: chunkStartY + row * (rowGap + 10),
      angle: Math.PI / 2,
      radius: row + 1,
    });
  });

  eventIds.forEach((id, index) => {
    const row = Math.floor(index / eventColumns);
    const column = index % eventColumns;
    positions.set(id, {
      x: (column - (eventColumns - 1) / 2) * eventGapX - EVENT_NODE_WIDTH / 2,
      y: eventStartY + row * (rowGap + 12),
      angle: Math.PI / 2,
      radius: chunkRows + row + 2,
    });
  });

  entityIds.forEach((id, index) => {
    const row = Math.floor(index / entityColumns);
    const column = index % entityColumns;
    positions.set(id, {
      x:
        (column - (entityColumns - 1) / 2) * entityGapX - ENTITY_NODE_WIDTH / 2,
      y: entityStartY + row * rowGap,
      angle: 0,
      radius: chunkRows + eventRows + row + 3,
    });
  });

  return positions;
}

function buildCircularPositionMap(graph: ProjectGraphRecord) {
  const positions = new Map<string, GraphPosition>();
  const entities = orderEntitiesByTypeCluster(graph.entities);
  const [rootEntity, ...secondaryEntities] = entities;

  if (rootEntity) {
    positions.set(rootEntity.id, {
      x: -ENTITY_NODE_WIDTH / 2,
      y: -NODE_HEIGHT / 2,
      angle: -Math.PI / 2,
      radius: 0,
      root: true,
    });
  }

  placeOnRings({
    ids: secondaryEntities.map((entity) => entity.id),
    positions,
    startRadius: ENTITY_RING_START_RADIUS,
    ringGap: ENTITY_RING_GAP,
    slotSpacing: ENTITY_SLOT_SPACING,
    nodeWidth: ENTITY_NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    angleOffset: -Math.PI / 2,
  });

  placeEventsOnOuterRings({
    events: graph.events,
    positions,
    angleOffset: EVENT_ANGLE_OFFSET,
  });

  return positions;
}

function fallbackPosition(): GraphPosition {
  return {
    x: 0,
    y: 0,
    angle: 0,
    radius: 0,
  };
}

function placeEventsOnOuterRings(input: {
  events: ProjectGraphEventRecord[];
  positions: Map<string, GraphPosition>;
  angleOffset: number;
}) {
  const sortedEvents = [...input.events].sort(compareEvents);
  const occupiedSlotsByRing = new Map<number, Set<number>>();

  for (let index = 0; index < sortedEvents.length; index += 1) {
    const event = sortedEvents[index];
    const desiredAngle = index * GOLDEN_ANGLE;
    const slot = findEventSlot({
      desiredAngle,
      angleOffset: input.angleOffset,
      occupiedSlotsByRing,
    });
    const radius = EVENT_RING_START_RADIUS + slot.ring * EVENT_RING_GAP;
    const angle =
      input.angleOffset + (2 * Math.PI * slot.index) / slot.capacity;
    input.positions.set(event.id, {
      x: Math.cos(angle) * radius - EVENT_NODE_WIDTH / 2,
      y: Math.sin(angle) * radius - NODE_HEIGHT / 2,
      angle,
      radius,
    });
  }
}

function findEventSlot(input: {
  desiredAngle: number;
  angleOffset: number;
  occupiedSlotsByRing: Map<number, Set<number>>;
}) {
  let ring = 0;
  while (true) {
    const radius = EVENT_RING_START_RADIUS + ring * EVENT_RING_GAP;
    const capacity = Math.max(
      8,
      Math.floor((2 * Math.PI * radius) / EVENT_SLOT_SPACING),
    );
    const occupiedSlots =
      input.occupiedSlotsByRing.get(ring) ?? new Set<number>();
    const desiredSlot = modulo(
      Math.round(
        ((input.desiredAngle - input.angleOffset) / (2 * Math.PI)) * capacity,
      ),
      capacity,
    );
    const freeSlot = nearestFreeSlot(desiredSlot, capacity, occupiedSlots);
    if (freeSlot != null) {
      occupiedSlots.add(freeSlot);
      input.occupiedSlotsByRing.set(ring, occupiedSlots);
      return { ring, index: freeSlot, capacity };
    }
    ring += 1;
  }
}

function nearestFreeSlot(
  desiredSlot: number,
  capacity: number,
  occupiedSlots: Set<number>,
) {
  for (let distance = 0; distance < capacity; distance += 1) {
    const candidates =
      distance === 0
        ? [desiredSlot]
        : [
            modulo(desiredSlot - distance, capacity),
            modulo(desiredSlot + distance, capacity),
          ];
    for (const candidate of candidates) {
      if (!occupiedSlots.has(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function modulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function placeOnRings(input: {
  ids: string[];
  positions: Map<string, GraphPosition>;
  startRadius: number;
  ringGap: number;
  slotSpacing: number;
  nodeWidth: number;
  nodeHeight: number;
  angleOffset: number;
}) {
  let index = 0;
  let ring = 0;

  while (index < input.ids.length) {
    const radius = input.startRadius + ring * input.ringGap;
    const capacity = Math.max(
      6,
      Math.floor((2 * Math.PI * radius) / input.slotSpacing),
    );
    for (let slot = 0; slot < capacity && index < input.ids.length; slot += 1) {
      const id = input.ids[index];
      const angle = input.angleOffset + (2 * Math.PI * slot) / capacity;
      input.positions.set(id, {
        x: Math.cos(angle) * radius - input.nodeWidth / 2,
        y: Math.sin(angle) * radius - input.nodeHeight / 2,
        angle,
        radius,
      });
      index += 1;
    }
    ring += 1;
  }

  return ring;
}

function orderEntityIdsByTypeCluster(
  entityIds: string[],
  entityById: Map<string, ProjectGraphEntityRecord>,
) {
  const counts = new Map<string, number>();
  for (const entityId of entityIds) {
    const type = normalizeEntityType(entityById.get(entityId)?.type);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...entityIds].sort((leftId, rightId) => {
    const left = entityById.get(leftId);
    const right = entityById.get(rightId);
    const leftType = normalizeEntityType(left?.type);
    const rightType = normalizeEntityType(right?.type);
    return (
      (counts.get(rightType) ?? 0) - (counts.get(leftType) ?? 0) ||
      leftType.localeCompare(rightType) ||
      compareEntities(left, right)
    );
  });
}

function orderEntitiesByTypeCluster(entities: ProjectGraphEntityRecord[]) {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    const type = normalizeEntityType(entity.type);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...entities].sort((left, right) => {
    const leftType = normalizeEntityType(left.type);
    const rightType = normalizeEntityType(right.type);
    return (
      (counts.get(rightType) ?? 0) - (counts.get(leftType) ?? 0) ||
      leftType.localeCompare(rightType) ||
      compareEntities(left, right)
    );
  });
}

function compareChunks(
  a?: ProjectGraphChunkRecord,
  b?: ProjectGraphChunkRecord,
) {
  return (
    (a?.rank ?? 0) - (b?.rank ?? 0) ||
    (a?.heading ?? a?.content ?? "").localeCompare(b?.heading ?? b?.content ?? "")
  );
}

function trimGraphLabel(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 42 ? `${normalized.slice(0, 42)}...` : normalized;
}

function uniqueGraphIds(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compareEntities(
  a?: ProjectGraphEntityRecord,
  b?: ProjectGraphEntityRecord,
) {
  return (
    (b?.eventCount ?? 0) - (a?.eventCount ?? 0) ||
    (a?.name ?? "").localeCompare(b?.name ?? "")
  );
}

function compareEvents(
  a?: ProjectGraphEventRecord,
  b?: ProjectGraphEventRecord,
) {
  return (
    (a?.rank ?? 0) - (b?.rank ?? 0) ||
    (a?.title ?? "").localeCompare(b?.title ?? "")
  );
}

type GraphSuggestion = {
  id: string;
  label: string;
  kind: "chunk" | "entity" | "event";
  score: number;
  weight: number;
};

function rankGraphSuggestions(
  graph: ProjectGraphRecord,
  query: string,
): GraphSuggestion[] {
  const normalizedQuery = normalizeGraphText(query);
  if (!normalizedQuery) return [];
  const suggestions: GraphSuggestion[] = [];
  for (const chunk of graph.chunks ?? []) {
    const score = graphMatchScore(
      `${chunk.heading ?? ""} ${chunk.content.slice(0, 220)}`,
      normalizedQuery,
    );
    if (score > 0) {
      suggestions.push({
        id: chunk.id,
        label: chunk.heading || trimGraphLabel(chunk.content),
        kind: "chunk",
        score,
        weight: chunk.eventCount,
      });
    }
  }
  for (const entity of graph.entities) {
    const score = graphMatchScore(
      `${entity.name} ${entity.type}`,
      normalizedQuery,
    );
    if (score > 0) {
      suggestions.push({
        id: entity.id,
        label: entity.name,
        kind: "entity",
        score,
        weight: entity.eventCount,
      });
    }
  }
  for (const event of graph.events) {
    const score = graphMatchScore(event.title, normalizedQuery);
    if (score > 0) {
      suggestions.push({
        id: event.id,
        label: event.title,
        kind: "event",
        score,
        weight: -event.rank,
      });
    }
  }
  return suggestions.sort(
    (left, right) =>
      right.score - left.score ||
      graphSuggestionKindWeight(right.kind) - graphSuggestionKindWeight(left.kind) ||
      right.weight - left.weight ||
      left.label.localeCompare(right.label),
  );
}

function graphSuggestionKindWeight(kind: GraphSuggestion["kind"]) {
  if (kind === "chunk") return 3;
  if (kind === "entity") return 2;
  return 1;
}

function graphMatchScore(label: string, normalizedQuery: string): number {
  const normalizedLabel = normalizeGraphText(label);
  if (!normalizedLabel) return 0;
  if (normalizedLabel === normalizedQuery) return 120;
  if (normalizedLabel.startsWith(normalizedQuery)) return 105;
  if (normalizedLabel.includes(normalizedQuery)) {
    return 90 - Math.min(20, normalizedLabel.length - normalizedQuery.length);
  }
  if (normalizedQuery.includes(normalizedLabel)) return 82;
  const similarity = trigramSimilarity(normalizedLabel, normalizedQuery);
  if (similarity >= 0.18) return Math.round(similarity * 70);
  return isSubsequence(normalizedQuery, normalizedLabel)
    ? Math.max(
        10,
        Math.round((normalizedQuery.length / normalizedLabel.length) * 45),
      )
    : 0;
}

function normalizeGraphText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function trigramSimilarity(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return 0;
  const leftParts = ngrams(left, Math.min(3, left.length));
  const rightParts = ngrams(right, Math.min(3, right.length));
  let intersection = 0;
  for (const part of leftParts) {
    if (rightParts.has(part)) intersection += 1;
  }
  return (
    intersection / Math.max(1, leftParts.size + rightParts.size - intersection)
  );
}

function ngrams(value: string, size: number): Set<string> {
  const parts = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    parts.add(value.slice(index, index + size));
  }
  return parts;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index >= needle.length) return true;
  }
  return false;
}

const ENTITY_TYPE_FILTER_PANEL_TOP = 116;
const ENTITY_TYPE_FILTER_PANEL_Z_INDEX = 12;
const ENTITY_TYPE_FILTER_PANEL_WIDTH = 196;
const ENTITY_TYPE_FILTER_PANEL_COLLAPSED_WIDTH = 176;

function EntityTypeFilterPanel(props: {
  language: SupportedLanguage;
  options: EntityTypeOption[];
  totalCount: number;
  selectedTypes: Set<string>;
  query: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onQueryChange: (value: string) => void;
  onToggleType: (type: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const activeCount = props.options.filter(
    (option) => props.selectedTypes.has(option.type) || option.visibleCount > 0,
  ).length;

  if (props.collapsed) {
    return (
      <div
        className="absolute left-3 rounded-xl border border-border bg-background/95 p-1.5 shadow-[0_12px_36px_rgba(24,36,58,0.10)] backdrop-blur"
        style={{
          top: ENTITY_TYPE_FILTER_PANEL_TOP,
          zIndex: ENTITY_TYPE_FILTER_PANEL_Z_INDEX,
          width: ENTITY_TYPE_FILTER_PANEL_COLLAPSED_WIDTH,
          maxWidth: "calc(100% - 24px)",
        }}
      >
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-accent"
          onClick={props.onToggleCollapsed}
          title={graphText(
            props.language,
            "展开实体类型筛选",
            "Expand entity type filter",
          )}
        >
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {graphText(
              props.language,
              "当前画布实体类型",
              "Current canvas entity types",
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5">
              {activeCount}/{props.totalCount}
            </span>
            <span aria-hidden="true">▾</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="absolute left-3 rounded-xl border border-border bg-background/95 p-2 shadow-[0_12px_36px_rgba(24,36,58,0.10)] backdrop-blur"
      style={{
        top: ENTITY_TYPE_FILTER_PANEL_TOP,
        zIndex: ENTITY_TYPE_FILTER_PANEL_Z_INDEX,
        width: ENTITY_TYPE_FILTER_PANEL_WIDTH,
        maxWidth: "calc(100% - 24px)",
      }}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            className="flex max-w-full items-center gap-1.5 rounded-md text-left text-sm font-semibold text-foreground hover:text-primary"
            onClick={props.onToggleCollapsed}
            title={graphText(
              props.language,
              "收起实体类型筛选",
              "Collapse entity type filter",
            )}
          >
            <span className="truncate">
              {graphText(
                props.language,
                "当前画布实体类型",
                "Current canvas entity types",
              )}
            </span>
            <span
              className="shrink-0 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              ▴
            </span>
          </button>
          <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {graphText(
              props.language,
              "未勾选类型时不显示实体；单击事件展开关联实体，双击事件收起",
              "No entity types selected: hide entities; single-click events to reveal related entities, double-click to collapse",
            )}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {activeCount}/{props.totalCount}
        </span>
      </div>
      <div className="space-y-2">
        <input
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder={graphText(
            props.language,
            "筛选当前画布类型",
            "Filter current types",
          )}
          className="h-7 w-full rounded-lg border border-input bg-background/95 px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onSelectAll}
          >
            {graphText(props.language, "显示全部", "Show all")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onClear}
          >
            {graphText(props.language, "清空", "Clear")}
          </Button>
        </div>
      </div>
      <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto pr-0.5">
        {props.options.length > 0 ? (
          props.options.map((option) => {
            const checked =
              props.selectedTypes.has(option.type) || option.visibleCount > 0;
            return (
              <label
                key={option.type}
                className="flex cursor-pointer items-center justify-between gap-1.5 rounded-lg px-1.5 py-1.5 text-xs hover:bg-accent"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => props.onToggleType(option.type)}
                    className="h-3.5 w-3.5 shrink-0 rounded border-input"
                    style={{ accentColor: entityTypeDotColor(option.type) }}
                  />
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: entityTypeDotColor(option.type) }}
                  />
                  <span className="truncate" title={option.label}>
                    <RichTextFragment text={option.label} />
                  </span>
                </span>
                <span className="ml-1 shrink-0 text-[11px] text-muted-foreground">
                  {option.visibleCount}/{option.totalCount}
                </span>
              </label>
            );
          })
        ) : (
          <div className="rounded-lg bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
            {graphText(
              props.language,
              "当前画布没有匹配的实体类型",
              "No matching entity types in current canvas",
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function entityTypeDotColor(type: string) {
  const colors = [
    "#22a06b",
    "#df5b25",
    "#7c65d1",
    "#d6a84f",
    "#2f9c95",
    "#5b7caa",
    "#d77aa2",
    "#8a6f3d",
    "#2d8cc8",
    "#b45aa0",
    "#6f8f3a",
    "#c76c38",
  ];
  const normalizedType = normalizeEntityType(type);
  let hash = 0;
  for (let index = 0; index < normalizedType.length; index += 1) {
    hash = (hash * 31 + normalizedType.charCodeAt(index)) >>> 0;
  }
  return colors[hash % colors.length];
}

function entityTypeCardBackground(hex: string, whiteRatio: number) {
  return mixHexWithWhite(hex, whiteRatio);
}

function mixHexWithWhite(hex: string, whiteRatio: number) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    return "#f8fafc";
  }
  const ratio = Math.max(0, Math.min(1, whiteRatio));
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return rgbToHex(
    Math.round(red * (1 - ratio) + 255 * ratio),
    Math.round(green * (1 - ratio) + 255 * ratio),
    Math.round(blue * (1 - ratio) + 255 * ratio),
  );
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    return `rgba(24, 36, 58, ${alpha})`;
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function buildSelectedEntityTypes(
  entityIds: Iterable<string>,
  entityById: Map<string, ProjectGraphEntityRecord>,
) {
  const types = new Set<string>();
  for (const entityId of entityIds) {
    const entity = entityById.get(entityId);
    if (entity) types.add(normalizeEntityType(entity.type));
  }
  return types;
}

function buildGraphShowcase(input: {
  graph: ProjectGraphRecord;
  mode: GraphShowcaseMode;
  seed: number;
  language: SupportedLanguage;
}): GraphShowcase {
  const graphIndex = indexProjectGraph(input.graph);
  const chemicalEntities = input.graph.entities
    .filter((entity) => isChemicalGraphEntity(entity))
    .sort(compareEntities);

  if (chemicalEntities.length === 0) {
    return buildFallbackShowcase(input.graph, input.mode, input.language);
  }

  if (input.mode === "relations") {
    return buildRelationShowcase({ ...input, graphIndex, chemicalEntities });
  }
  if (input.mode === "events") {
    return buildEventShowcase({ ...input, graphIndex, chemicalEntities });
  }
  if (input.mode === "frequency") {
    return buildFrequencyShowcase({ ...input, graphIndex, chemicalEntities });
  }
  return buildOverviewShowcase({ ...input, graphIndex, chemicalEntities });
}

type GraphIndex = {
  entityById: Map<string, ProjectGraphEntityRecord>;
  eventById: Map<string, ProjectGraphEventRecord>;
  entityIdsByEventId: Map<string, string[]>;
  eventIdsByEntityId: Map<string, string[]>;
};

function indexProjectGraph(graph: ProjectGraphRecord): GraphIndex {
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const eventById = new Map(graph.events.map((event) => [event.id, event]));
  const entityIdsByEventId = new Map<string, string[]>();
  const eventIdsByEntityId = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const entityIds = entityIdsByEventId.get(edge.eventId) ?? [];
    entityIds.push(edge.entityId);
    entityIdsByEventId.set(edge.eventId, entityIds);

    const eventIds = eventIdsByEntityId.get(edge.entityId) ?? [];
    eventIds.push(edge.eventId);
    eventIdsByEntityId.set(edge.entityId, eventIds);
  }

  for (const [eventId, entityIds] of entityIdsByEventId.entries()) {
    entityIdsByEventId.set(
      eventId,
      uniqueStrings(entityIds).sort((a, b) =>
        compareEntities(entityById.get(a), entityById.get(b)),
      ),
    );
  }
  for (const [entityId, eventIds] of eventIdsByEntityId.entries()) {
    eventIdsByEntityId.set(
      entityId,
      uniqueStrings(eventIds).sort((a, b) =>
        compareEvents(eventById.get(a), eventById.get(b)),
      ),
    );
  }

  return { entityById, eventById, entityIdsByEventId, eventIdsByEntityId };
}

function buildOverviewShowcase(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
  mode: GraphShowcaseMode;
  seed: number;
  language: SupportedLanguage;
}): GraphShowcase {
  const pair = pickCoEventPair(input);
  const anchorEntityIds = new Set<string>();
  const candidateEventIds = new Set<string>();

  if (pair) {
    for (const entityId of pair.entityIds) anchorEntityIds.add(entityId);
    for (const eventId of pair.eventIds.slice(0, 8)) candidateEventIds.add(eventId);
  }

  for (const entity of seededShuffle(
    input.chemicalEntities.slice(0, Math.min(24, input.chemicalEntities.length)),
    input.seed + 11,
  ).slice(0, 8)) {
    anchorEntityIds.add(entity.id);
    for (const eventId of (input.graphIndex.eventIdsByEntityId.get(entity.id) ?? []).slice(0, 4)) {
      candidateEventIds.add(eventId);
    }
  }

  const eventIds = rankShowcaseEvents(
    [...candidateEventIds],
    input.graphIndex,
    anchorEntityIds,
  ).slice(0, SHOWCASE_EVENT_LIMIT);
  const entityIds = collectShowcaseEntities({
    eventIds,
    anchorEntityIds,
    graphIndex: input.graphIndex,
    limit: SHOWCASE_ENTITY_LIMIT,
    includeRelatedEntityLimit: 8,
  });

  const anchorNames = [...anchorEntityIds]
    .map((entityId) => input.graphIndex.entityById.get(entityId)?.name)
    .filter(Boolean)
    .slice(0, 3) as string[];
  return {
    mode: "overview",
    title: graphText(
      input.language,
      `精选知识总览 · ${anchorNames.join("、") || "核心化工品"}`,
      `Curated overview · ${anchorNames.join(", ") || "core chemicals"}`,
    ),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([
      ...(pair?.entityIds ?? []),
      ...eventIds.slice(0, 4),
      ...entityIds.slice(0, 4),
    ]),
  };
}

function buildFrequencyShowcase(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
  mode: GraphShowcaseMode;
  seed: number;
  language: SupportedLanguage;
}): GraphShowcase {
  const anchors = seededShuffle(
    input.chemicalEntities.slice(0, Math.min(SHOWCASE_TOP_CANDIDATE_LIMIT, input.chemicalEntities.length)),
    input.seed + 23,
  )
    .slice(0, 9)
    .sort(compareEntities);
  const anchorEntityIds = new Set(anchors.map((entity) => entity.id));
  const candidateEventIds = new Set<string>();
  for (const entity of anchors) {
    for (const eventId of (input.graphIndex.eventIdsByEntityId.get(entity.id) ?? []).slice(0, 6)) {
      candidateEventIds.add(eventId);
    }
  }
  const eventIds = rankShowcaseEvents(
    [...candidateEventIds],
    input.graphIndex,
    anchorEntityIds,
  ).slice(0, 10);
  const entityIds = collectShowcaseEntities({
    eventIds,
    anchorEntityIds,
    graphIndex: input.graphIndex,
    limit: SHOWCASE_ENTITY_LIMIT,
    includeRelatedEntityLimit: 6,
  });
  return {
    mode: "frequency",
    title: graphText(
      input.language,
      `高频化工品 · ${anchors.slice(0, 3).map((entity) => entity.name).join("、")}`,
      `Core chemicals · ${anchors.slice(0, 3).map((entity) => entity.name).join(", ")}`,
    ),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([...anchors.slice(0, 4).map((entity) => entity.id), ...eventIds.slice(0, 3)]),
  };
}

function buildRelationShowcase(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
  mode: GraphShowcaseMode;
  seed: number;
  language: SupportedLanguage;
}): GraphShowcase {
  const pair = pickCoEventPair(input);
  if (!pair) {
    return buildFrequencyShowcase(input);
  }

  const anchorEntityIds = new Set(pair.entityIds);
  const eventIds = pair.eventIds.slice(0, Math.min(10, SHOWCASE_EVENT_LIMIT));
  const entityIds = collectShowcaseEntities({
    eventIds,
    anchorEntityIds,
    graphIndex: input.graphIndex,
    limit: 30,
    includeRelatedEntityLimit: 4,
  });
  const [leftName, rightName] = pair.entityIds.map(
    (entityId) => input.graphIndex.entityById.get(entityId)?.name ?? "",
  );
  return {
    mode: "relations",
    title: graphText(
      input.language,
      `产业链关系 · ${leftName} ↔ ${rightName}（共同事件 ${pair.sharedEventCount} 个）`,
      `Co-event pair · ${leftName} ↔ ${rightName} (${pair.sharedEventCount} shared events)`,
    ),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([...pair.entityIds, ...eventIds.slice(0, 4)]),
  };
}

function buildEventShowcase(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
  mode: GraphShowcaseMode;
  seed: number;
  language: SupportedLanguage;
}): GraphShowcase {
  const chemicalEntityIdSet = new Set(input.chemicalEntities.map((entity) => entity.id));
  const eventCandidates = input.graph.events
    .map((event) => {
      const entityIds = input.graphIndex.entityIdsByEventId.get(event.id) ?? [];
      const chemicalCount = entityIds.filter((entityId) => chemicalEntityIdSet.has(entityId)).length;
      const score = chemicalCount * 6 + entityIds.length * 2 - event.rank * 0.02;
      return { event, score, chemicalCount, entityCount: entityIds.length };
    })
    .filter((candidate) => candidate.chemicalCount > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.chemicalCount - left.chemicalCount ||
        right.entityCount - left.entityCount ||
        compareEvents(left.event, right.event),
    );

  const selectedEvents = seededShuffle(
    eventCandidates.slice(0, Math.min(16, eventCandidates.length)),
    input.seed + 41,
  )
    .slice(0, 6)
    .sort((left, right) => compareEvents(left.event, right.event));
  const eventIds = selectedEvents.map((candidate) => candidate.event.id);
  const anchorEntityIds = new Set<string>();
  for (const eventId of eventIds) {
    for (const entityId of input.graphIndex.entityIdsByEventId.get(eventId) ?? []) {
      const entity = input.graphIndex.entityById.get(entityId);
      if (entity && isChemicalGraphEntity(entity)) anchorEntityIds.add(entityId);
    }
  }
  const entityIds = collectShowcaseEntities({
    eventIds,
    anchorEntityIds,
    graphIndex: input.graphIndex,
    limit: SHOWCASE_ENTITY_LIMIT,
    includeRelatedEntityLimit: 10,
  });
  const firstEventTitle = truncateGraphLabel(selectedEvents[0]?.event.title ?? "核心事件", 18);
  return {
    mode: "events",
    title: graphText(
      input.language,
      `高关联事件视角 · ${firstEventTitle}`,
      `Key-event view · ${firstEventTitle}`,
    ),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([...eventIds.slice(0, 5), ...entityIds.slice(0, 5)]),
  };
}

type CoEventPairCandidate = {
  entityIds: [string, string];
  eventIds: string[];
  sharedEventCount: number;
  score: number;
};

function pickCoEventPair(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
  seed: number;
}) {
  const candidates = buildCoEventPairCandidates(input);
  if (candidates.length === 0) return null;
  return seededShuffle(
    candidates.slice(0, Math.min(SHOWCASE_TOP_CANDIDATE_LIMIT, candidates.length)),
    input.seed + 53,
  )[0];
}

function buildCoEventPairCandidates(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
}): CoEventPairCandidate[] {
  const chemicalEntityIdSet = new Set(input.chemicalEntities.map((entity) => entity.id));
  const pairEventIds = new Map<string, Set<string>>();

  for (const event of input.graph.events) {
    const chemicalIds = uniqueStrings(
      (input.graphIndex.entityIdsByEventId.get(event.id) ?? []).filter((entityId) =>
        chemicalEntityIdSet.has(entityId),
      ),
    )
      .sort((left, right) =>
        compareEntities(
          input.graphIndex.entityById.get(left),
          input.graphIndex.entityById.get(right),
        ),
      )
      .slice(0, 10);
    for (let leftIndex = 0; leftIndex < chemicalIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < chemicalIds.length; rightIndex += 1) {
        const leftId = chemicalIds[leftIndex];
        const rightId = chemicalIds[rightIndex];
        const key = leftId < rightId ? `${leftId}|||${rightId}` : `${rightId}|||${leftId}`;
        const current = pairEventIds.get(key) ?? new Set<string>();
        current.add(event.id);
        pairEventIds.set(key, current);
      }
    }
  }

  return [...pairEventIds.entries()]
    .map(([key, eventIdSet]) => {
      const [leftId, rightId] = key.split("|||") as [string, string];
      const left = input.graphIndex.entityById.get(leftId);
      const right = input.graphIndex.entityById.get(rightId);
      const eventIds = rankShowcaseEvents(
        [...eventIdSet],
        input.graphIndex,
        new Set([leftId, rightId]),
      );
      const sharedEventCount = eventIds.length;
      return {
        entityIds: [leftId, rightId] as [string, string],
        eventIds,
        sharedEventCount,
        score:
          sharedEventCount * 100 +
          (left?.eventCount ?? 0) +
          (right?.eventCount ?? 0) -
          averageEventRank(eventIds, input.graphIndex) * 0.05,
      };
    })
    .filter((candidate) => candidate.sharedEventCount > 0)
    .sort((left, right) => right.score - left.score);
}

function rankShowcaseEvents(
  eventIds: string[],
  graphIndex: GraphIndex,
  anchorEntityIds: Set<string>,
) {
  return uniqueStrings(eventIds).sort((leftId, rightId) => {
    const leftEvent = graphIndex.eventById.get(leftId);
    const rightEvent = graphIndex.eventById.get(rightId);
    return (
      scoreShowcaseEvent(rightId, graphIndex, anchorEntityIds) -
        scoreShowcaseEvent(leftId, graphIndex, anchorEntityIds) ||
      compareEvents(leftEvent, rightEvent)
    );
  });
}

function scoreShowcaseEvent(
  eventId: string,
  graphIndex: GraphIndex,
  anchorEntityIds: Set<string>,
) {
  const entityIds = graphIndex.entityIdsByEventId.get(eventId) ?? [];
  const anchorHits = entityIds.filter((entityId) => anchorEntityIds.has(entityId)).length;
  const chemicalHits = entityIds.filter((entityId) => {
    const entity = graphIndex.entityById.get(entityId);
    return entity ? isChemicalGraphEntity(entity) : false;
  }).length;
  const event = graphIndex.eventById.get(eventId);
  return anchorHits * 40 + chemicalHits * 8 + entityIds.length * 2 - (event?.rank ?? 0) * 0.02;
}

function averageEventRank(eventIds: string[], graphIndex: GraphIndex) {
  if (eventIds.length === 0) return 0;
  return (
    eventIds.reduce(
      (total, eventId) => total + (graphIndex.eventById.get(eventId)?.rank ?? 0),
      0,
    ) / eventIds.length
  );
}

function collectShowcaseEntities(input: {
  eventIds: string[];
  anchorEntityIds: Set<string>;
  graphIndex: GraphIndex;
  limit: number;
  includeRelatedEntityLimit: number;
}) {
  const chemicalIds = new Set<string>(input.anchorEntityIds);
  const relatedIds = new Set<string>();

  for (const eventId of input.eventIds) {
    for (const entityId of input.graphIndex.entityIdsByEventId.get(eventId) ?? []) {
      const entity = input.graphIndex.entityById.get(entityId);
      if (!entity) continue;
      if (isChemicalGraphEntity(entity)) {
        chemicalIds.add(entityId);
      } else if (!isLowValueGraphEntity(entity)) {
        relatedIds.add(entityId);
      }
    }
  }

  const chemicalEntityIds = [...chemicalIds]
    .filter((entityId) => input.graphIndex.entityById.has(entityId))
    .sort((leftId, rightId) =>
      compareEntities(
        input.graphIndex.entityById.get(leftId),
        input.graphIndex.entityById.get(rightId),
      ),
    )
    .slice(0, Math.max(0, input.limit - input.includeRelatedEntityLimit));
  const relatedEntityIds = [...relatedIds]
    .filter((entityId) => input.graphIndex.entityById.has(entityId))
    .sort((leftId, rightId) =>
      compareEntities(
        input.graphIndex.entityById.get(leftId),
        input.graphIndex.entityById.get(rightId),
      ),
    )
    .slice(0, Math.min(input.includeRelatedEntityLimit, input.limit - chemicalEntityIds.length));

  return uniqueStrings([...chemicalEntityIds, ...relatedEntityIds]).slice(0, input.limit);
}

function buildFallbackShowcase(
  graph: ProjectGraphRecord,
  mode: GraphShowcaseMode,
  language: SupportedLanguage,
): GraphShowcase {
  const entityIds = graph.entities.slice(0, 18).map((entity) => entity.id);
  const entityIdSet = new Set(entityIds);
  const eventIds = graph.events
    .filter((event) => event.entityIds.some((entityId) => entityIdSet.has(entityId)))
    .slice(0, 8)
    .map((event) => event.id);
  return {
    mode,
    title: graphText(language, "精选知识总览", "Curated overview"),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([...eventIds.slice(0, 4), ...entityIds.slice(0, 4)]),
  };
}

function isChemicalGraphEntity(entity: ProjectGraphEntityRecord) {
  const type = normalizeGraphText(entity.type);
  const name = normalizeGraphText(entity.name);
  const positiveTypeKeywords = [
    "化工",
    "化学",
    "产品",
    "原料",
    "中间体",
    "能源品种",
    "品种",
    "材料",
    "单体",
    "聚合物",
    "树脂",
    "橡胶",
    "塑料",
    "溶剂",
    "助剂",
    "添加剂",
    "催化剂",
    "燃料",
    "油品",
    "芳烃",
    "烯烃",
    "醇",
    "酸",
    "酯",
    "酮",
  ];
  const negativeTypeKeywords = [
    "企业",
    "公司",
    "集团",
    "机构",
    "组织",
    "交易所",
    "交易中心",
    "国家",
    "地区",
    "城市",
    "政策",
    "法规",
    "报告",
    "文档",
    "文件",
    "项目",
    "装置",
    "工艺",
    "产业链",
    "行业",
    "市场",
    "价格",
    "指标",
    "单位",
    "标准",
  ];
  const negativeNameKeywords = [
    "有限公司",
    "股份",
    "集团",
    "交易所",
    "交易中心",
    "委员会",
    "协会",
    "研究院",
    "报告",
    "项目",
    "装置",
    "产业链",
    "市场",
  ];

  if (negativeTypeKeywords.some((keyword) => type.includes(normalizeGraphText(keyword)))) {
    return false;
  }
  if (negativeNameKeywords.some((keyword) => name.includes(normalizeGraphText(keyword)))) {
    return false;
  }
  return positiveTypeKeywords.some((keyword) => type.includes(normalizeGraphText(keyword)));
}

function isLowValueGraphEntity(entity: ProjectGraphEntityRecord) {
  const type = normalizeGraphText(entity.type);
  const name = normalizeGraphText(entity.name);
  const keywords = [
    "报告",
    "文档",
    "文件",
    "指标",
    "单位",
    "价格",
    "市场",
    "行业",
    "产业链",
    "项目",
    "装置",
    "工艺",
    "标准",
    "术语",
  ];
  return keywords.some((keyword) =>
    type.includes(normalizeGraphText(keyword)) || name.includes(normalizeGraphText(keyword)),
  );
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = Math.max(1, Math.floor(Math.abs(seed)) % 2147483647);
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 48271) % 2147483647;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function uniqueStrings(values: Iterable<string>) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function truncateGraphLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-2.5 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-1 text-sm font-semibold text-primary">{value}</span>
    </div>
  );
}
