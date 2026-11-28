import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  getViewportForBounds,
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
  ProjectGraphSuggestionRecord,
  QuestionAnchor,
} from "../types";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { SupportedLanguage } from "../i18n";
import { RichTextFragment } from "./RichText";
import { buildSceneData, layoutUniverse, type SceneNode } from "../lib/graph-scene-data";
import { ParticleGalaxy } from "./universe/ParticleGalaxy";
import "./universe/universe.css";

const ProjectGraph3D = lazy(() => import("./ProjectGraph3D"));

class SceneBoundary extends Component<{ onUnavailable: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { this.props.onUnavailable(); }

  render() { return this.state.failed ? null : this.props.children; }
}

type GraphNodeData = {
  label: string;
  kind: "chunk" | "entity" | "event" | "question";
  expanded: boolean;
  entityType?: string;
  entityTypeColor?: string;
  category?: string;
  showLabel?: boolean;
  labelSide?: "left" | "right";
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
const FOCUS_ENTITY_LIMIT = 96;
const SEARCH_LAYER_EVENT_LIMIT = 66;
const COLUMN_EVENT_LIMIT = 28;
const DEFAULT_FOCUS_EVENT_LIMIT = SEARCH_LAYER_EVENT_LIMIT;
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

type ActiveEventBatch = {
  kind: "entity" | "focus";
  label: string;
  sourceEntityIds: string[];
  eventIds: string[];
  offset: number;
};

const GRAPH_SHOWCASE_BUTTONS: Array<{
  mode: GraphShowcaseMode;
  zh: string;
  en: string;
}> = [
  { mode: "frequency", zh: "高频化工品", en: "Core chemicals" },
  { mode: "events", zh: "高关联事件", en: "Key events" },
];

const DEFAULT_GRAPH_SHOWCASE_MODES: GraphShowcaseMode[] = [
  "frequency",
  "events",
];

export type GraphLayoutStyle = "search_layers" | "entity_inner" | "columns";

type GraphProps = {
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
  compact?: boolean;
  universe2D?: boolean;
  preferenceKey?: string;
  selectedExternalId?: string;
  onPickNode?: (node: QuestionAnchor & { label: string }) => void;
  language: SupportedLanguage;
  onSearch?: (query: string) => void;
  onRequestSuggestions?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<ProjectGraphSuggestionRecord[]>;
  onSelectSuggestion?: (suggestion: ProjectGraphSuggestionRecord) => void;
  onOpenChunk: (chunkId: string) => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
};

export function ProjectGraphFlow(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <ProjectGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ProjectGraphCanvas(props: GraphProps) {
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
  const [mode, setMode] = useState<"2d" | "3d">(() =>
    props.preferenceKey && localStorage.getItem(`${props.preferenceKey}:mode`) === "3d" ? "3d" : "2d");
  const [storedFilters] = useState(() => {
    if (!props.preferenceKey) return [];
    try {
      const value = JSON.parse(localStorage.getItem(`${props.preferenceKey}:types`) ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  });
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const camera = useRef<{ x: number; y: number; z: number } | null>(null);
  const [graphQuery, setGraphQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [remoteSuggestionState, setRemoteSuggestionState] = useState<{
    query: string;
    loading: boolean;
    suggestions: GraphSuggestion[];
  }>({ query: "", loading: false, suggestions: [] });
  const [activeQueryLabel, setActiveQueryLabel] = useState("");
  const [queryLinkedNodeIds, setQueryLinkedNodeIds] = useState<Set<string>>(
    new Set(),
  );
  const starView = mode === "3d" || Boolean(props.universe2D);
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<Set<string>>(
    () => new Set(storedFilters),
  );
  const [entityTypeQuery, setEntityTypeQuery] = useState("");
  const [entityTypeFilterCollapsed, setEntityTypeFilterCollapsed] =
    useState(Boolean(props.universe2D));
  const [activeGraphMode, setActiveGraphMode] = useState<ActiveGraphMode>(() =>
    randomGraphShowcaseMode(),
  );
  const [activeEventBatch, setActiveEventBatch] =
    useState<ActiveEventBatch | null>(null);
  const [ignoredFocusKey, setIgnoredFocusKey] = useState<string | null>(null);
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
  const [eventCategory, setEventCategory] = useState("");
  const [entityFilterUsed, setEntityFilterUsed] = useState(() =>
    Boolean(props.preferenceKey && localStorage.getItem(`${props.preferenceKey}:entity-filter`) === "true")
  );
  useEffect(() => {
    if (!props.preferenceKey) return;
    localStorage.setItem(`${props.preferenceKey}:mode`, mode);
    localStorage.setItem(`${props.preferenceKey}:types`, JSON.stringify([...selectedEntityTypes]));
    localStorage.setItem(`${props.preferenceKey}:entity-filter`, String(entityFilterUsed));
  }, [mode, selectedEntityTypes, entityFilterUsed, props.preferenceKey]);
  const sceneNodes = useMemo(() => {
    const categoryByEvent = new Map(props.graph.events.map((event) => [event.id, event.category?.trim()]));
    const visible = nodes.flatMap((node): SceneNode[] => node.data.kind === "question" ? [] : [{
      id: node.id, kind: node.data.kind, label: node.data.label,
      category: node.data.kind === "event" ? categoryByEvent.get(node.id) ||
        graphText(props.language, "未分类", "Uncategorized") : undefined
    }]);
    if (!starView) return visible;
    const seen = new Set(visible.map((node) => node.id));
    const eventIds = new Set(visible.filter((node) => node.kind === "event").map((node) => node.id));
    const linkedEntities = new Set(props.graph.edges.filter((edge) => eventIds.has(edge.eventId)).map((edge) => edge.entityId));
    const linkedChunks = new Set(props.graph.chunkEventEdges.filter((edge) => eventIds.has(edge.eventId)).map((edge) => edge.chunkId));
    const filterEntities = entityFilterUsed || selectedEntityTypes.size > 0;
    for (const entity of props.graph.entities) {
      if (linkedEntities.has(entity.id) && !seen.has(entity.id) && (!filterEntities || selectedEntityTypes.has(entity.type))) {
        visible.push({ id: entity.id, kind: "entity", label: entity.name });
      }
    }
    for (const chunk of props.graph.chunks ?? []) {
      if (linkedChunks.has(chunk.id) && !seen.has(chunk.id)) {
        visible.push({ id: chunk.id, kind: "chunk", label: chunk.heading || chunk.content.slice(0, 56) });
      }
    }
    return visible;
  }, [nodes, props.graph, props.language, selectedEntityTypes, starView, entityFilterUsed]);
  const categories = useMemo(() =>
    [...new Set(sceneNodes.flatMap((node) => node.category ? [node.category] : []))].sort(),
  [sceneNodes]);
  const category = categories.includes(eventCategory) ? eventCategory : "";
  const sceneData = useMemo(() => buildSceneData({
    nodes: sceneNodes,
    graph: props.graph,
    priority: new Set([...(selectedNodeId ? [selectedNodeId] : []), ...queryLinkedNodeIds, ...expandedEventIds]),
    compact: props.compact ?? false,
    category
  }), [sceneNodes, props.graph, selectedNodeId, queryLinkedNodeIds, expandedEventIds, props.compact, category]);
  const flatScene = useMemo(() => {
    if (!props.universe2D || mode !== "2d") return null;
    const positions = layoutUniverse(sceneData.nodes, sceneData.links);
    let labeled = 0;
    return {
      nodes: sceneData.nodes.map((node): GraphNode => {
        const position = positions.get(node.id)!;
        const selected = selectedNodeId === node.id;
        return { id: node.id, type: "universe", width: 25, height: 25, position: { x: position.x * 3, y: -position.y * 3 },
          selected, draggable: false, ariaLabel: [node.label, node.category].filter(Boolean).join(" · "),
          data: { ...node, expanded: false, labelSide: position.x > 0 ? "left" : "right",
            showLabel: selected || (node.kind === "event" && labeled++ < 8) } };
      }),
      edges: sceneData.links.map(({ source, target }): GraphEdge => ({
        id: JSON.stringify([source, target]), source, target, type: "straight", selectable: false,
        style: { stroke: "#9ccbd6", strokeWidth: 1, opacity: 0.35 }
      }))
    };
  }, [props.universe2D, mode, sceneData, selectedNodeId]);
  const { fitView, getNode, setCenter, setViewport } = useReactFlow<GraphNode, GraphEdge>();
  const graphEdgeTypes = useMemo(() => ({ bus: BusEdge }), []);
  const graphNodeTypes = useMemo(() => ({ rich: RichGraphNode, universe: UniverseGraphNode }), []);
  const clickTimerRef = useRef<number | null>(null);
  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  const graphToolbarRef = useRef<HTMLDivElement>(null);
  const shouldFitViewRef = useRef(true);
  const pendingCenterNodeIdRef = useRef<string | null>(null);
  const pendingFitNodeIdsRef = useRef<{
    nodeIds: string[];
    centerNodeId?: string;
  } | null>(null);
  const appliedFocusKeyRef = useRef<string | null>(null);
  const effectiveFocus =
    props.focus && props.focus.key !== ignoredFocusKey ? props.focus : null;

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
    const linkChunkToEvent = (chunkId: string, eventId: string) => {
      if (!chunkId || !eventId || !eventById.has(eventId)) return;
      const eventIds = map.get(chunkId) ?? [];
      eventIds.push(eventId);
      map.set(chunkId, eventIds);
    };
    for (const event of props.graph.events) {
      if (event.chunkId) {
        linkChunkToEvent(event.chunkId, event.id);
      }
    }
    for (const edge of props.graph.chunkEventEdges ?? []) {
      linkChunkToEvent(edge.chunkId, edge.eventId);
    }
    for (const [chunkId, eventIds] of map.entries()) {
      map.set(
        chunkId,
        uniqueGraphIds(eventIds).sort((a, b) =>
          compareEvents(eventById.get(a), eventById.get(b)),
        ),
      );
    }
    return map;
  }, [eventById, props.graph.chunkEventEdges, props.graph.events]);
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
    const linkEntityToEvent = (entityId: string, eventId: string) => {
      if (!entityId || !eventId || !eventById.has(eventId)) return;
      const eventIds = map.get(entityId) ?? [];
      eventIds.push(eventId);
      map.set(entityId, eventIds);
    };
    for (const edge of props.graph.edges) {
      linkEntityToEvent(edge.entityId, edge.eventId);
    }
    for (const event of props.graph.events) {
      for (const entityId of event.entityIds ?? []) {
        linkEntityToEvent(entityId, event.id);
      }
    }
    for (const [entityId, eventIds] of map.entries()) {
      map.set(
        entityId,
        uniqueGraphIds(eventIds).sort((a, b) =>
          compareEvents(eventById.get(a), eventById.get(b)),
        ),
      );
    }
    return map;
  }, [eventById, props.graph.edges, props.graph.events]);
  const entityIdsByEventId = useMemo(() => {
    const map = new Map<string, string[]>();
    const linkEventToEntity = (eventId: string, entityId: string) => {
      if (!eventId || !entityId || !entityById.has(entityId)) return;
      const entityIds = map.get(eventId) ?? [];
      entityIds.push(entityId);
      map.set(eventId, entityIds);
    };
    for (const edge of props.graph.edges) {
      linkEventToEntity(edge.eventId, edge.entityId);
    }
    for (const event of props.graph.events) {
      for (const entityId of event.entityIds ?? []) {
        linkEventToEntity(event.id, entityId);
      }
    }
    for (const [eventId, entityIds] of map.entries()) {
      map.set(
        eventId,
        uniqueGraphIds(entityIds).sort((a, b) =>
          compareEntities(entityById.get(a), entityById.get(b)),
        ),
      );
    }
    return map;
  }, [entityById, props.graph.edges, props.graph.events]);
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
  const eventDisplayLimit = getGraphEventDisplayLimit(layoutStyle);
  const localSuggestions = useMemo(
    () => rankGraphSuggestions(props.graph, graphQuery, 10, eventDisplayLimit),
    [eventDisplayLimit, graphQuery, props.graph],
  );
  const normalizedSuggestionQuery = graphQuery.trim();
  const remoteSuggestions = useMemo(
    () =>
      remoteSuggestionState.query === normalizedSuggestionQuery
        ? remoteSuggestionState.suggestions
        : [],
    [normalizedSuggestionQuery, remoteSuggestionState],
  );
  const suggestions = useMemo(
    () =>
      diversifyGraphSuggestions(
        [...remoteSuggestions, ...localSuggestions].sort(compareGraphSuggestions),
        10,
      ),
    [localSuggestions, remoteSuggestions],
  );
  const suggestionsLoading =
    Boolean(normalizedSuggestionQuery && props.onRequestSuggestions) &&
    (remoteSuggestionState.query !== normalizedSuggestionQuery ||
      remoteSuggestionState.loading);
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
    addSelectedTypeEntitiesFromVisibleEvents({
      visibleEntityIds: nextScope.visibleEntityIds,
      visibleEventIds: nextScope.visibleEventIds,
      selectedEntityTypes,
      entityById,
      entityIdsByEventId,
    });
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

  const entityTypeScopeEntityIds = useMemo(
    () =>
      collectPotentialEntityIdsForScope({
        visibleEntityIds: visibleGraphScope.visibleEntityIds,
        visibleEventIds: visibleGraphScope.visibleEventIds,
        entityIdsByEventId,
      }),
    [
      entityIdsByEventId,
      visibleGraphScope.visibleEntityIds,
      visibleGraphScope.visibleEventIds,
    ],
  );

  const entityTypeOptions = useMemo(
    () =>
      buildEntityTypeOptionsFromScope({
        scopeEntityIds: entityTypeScopeEntityIds,
        visibleEntityIds: starView
          ? new Set(sceneData.nodes.filter((node) => node.kind === "entity").map((node) => node.id))
          : visibleGraphScopeAfterEntityFilter.visibleEntityIds,
        entityById,
        language: props.language,
      }),
    [
      entityById,
      entityTypeScopeEntityIds,
      props.language,
      sceneData,
      starView,
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
        activeQueryLabel: props.compact ? "" : activeQueryLabel,
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
      props.compact,
      queryLinkedNodeIds,
      selectedEntityTypes,
      layoutStyle,
      layoutRevision,
      selectedNodeId,
    ],
  );

  function applyShowcase(showcase: GraphShowcase | null) {
    if (!showcase) return;
    setActiveEventBatch(null);
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
    setSelectedEntityTypes(new Set());
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
      return;
    }
    const pendingFit = pendingFitNodeIdsRef.current;
    if (pendingFit) {
      window.requestAnimationFrame(() =>
        fitGraphNodes(pendingFit.nodeIds, pendingFit.centerNodeId),
      );
      return;
    }
    const pendingNodeId = pendingCenterNodeIdRef.current;
    if (pendingNodeId) {
      window.requestAnimationFrame(() => centerGraphNode(pendingNodeId));
    }
  }, [
    fitView,
    graphModel.edges,
    graphModel.nodes,
    setEdges,
    setNodes,
    getNode,
    setCenter,
    setViewport,
  ]);

  useEffect(() => {
    if (effectiveFocus) return;
    if (!activeShowcase) return;
    applyShowcase(activeShowcase);
  }, [activeShowcase, graphIdentity, effectiveFocus?.key]);

  useEffect(() => {
    const query = graphQuery.trim();
    if (!query || !suggestionsOpen || !props.onRequestSuggestions) {
      setRemoteSuggestionState({ query: "", loading: false, suggestions: [] });
      return;
    }

    const controller = new AbortController();
    setRemoteSuggestionState({ query, loading: true, suggestions: [] });
    const timer = window.setTimeout(() => {
      void props
        .onRequestSuggestions?.(query, controller.signal)
        .then((items) => {
          if (controller.signal.aborted) return;
          setRemoteSuggestionState({
            query,
            loading: false,
            suggestions: items.map((item) => ({
              ...item,
              remote: true,
              visibleEventCount:
                item.kind === "entity"
                  ? Math.min(item.relatedEventCount ?? 0, eventDisplayLimit)
                  : undefined,
            })),
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setRemoteSuggestionState({ query, loading: false, suggestions: [] });
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    eventDisplayLimit,
    graphQuery,
    props.onRequestSuggestions,
    suggestionsOpen,
  ]);

  useEffect(() => {
    if (effectiveFocus || !appliedFocusKeyRef.current) return;
    appliedFocusKeyRef.current = null;
    shouldFitViewRef.current = true;
    setGraphQuery("");
    setActiveGraphMode(randomGraphShowcaseMode());
    setShowcaseSeed(Math.floor(Math.random() * 1_000_000));
    setShowcaseRevision((current) => current + 1);
    setSuggestionsOpen(false);
  }, [effectiveFocus?.key]);

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
    if (!effectiveFocus) return;
    appliedFocusKeyRef.current = effectiveFocus.key;
    setIgnoredFocusKey(null);
    const focusChunkIds = effectiveFocus.chunkIds.filter((id) => chunkById.has(id));
    const eventIdsFromChunks = uniqueGraphIds(
      focusChunkIds.flatMap((chunkId) => eventIdsByChunkId.get(chunkId) ?? []),
    );
    const directEventIds = effectiveFocus.eventIds.filter((id) =>
      eventById.has(id),
    );
    const directEntityIds = effectiveFocus.entityIds
      .filter((id) => entityById.has(id))
      .slice(0, FOCUS_ENTITY_LIMIT);
    const eventIdsFromEntities = uniqueGraphIds(
      directEntityIds.flatMap((entityId) => eventIdsByEntityId.get(entityId) ?? []),
    );
    const isQueryOnlyFocus =
      Boolean(effectiveFocus.query.trim()) &&
      focusChunkIds.length === 0 &&
      directEventIds.length === 0 &&
      directEntityIds.length === 0 &&
      props.graph.scope === "focus";
    const queryScopeEventIds = isQueryOnlyFocus
      ? [...eventById.keys()]
      : [];
    const normalizedFocusQuery = normalizeGraphText(effectiveFocus.query);
    const queryScopeEntityIds = isQueryOnlyFocus
      ? normalizedFocusQuery
        ? [...entityById.values()]
          .filter(
            (entity) =>
              maxGraphMatchScore(
                [
                  entity.name,
                  entity.normalizedName,
                  `${entity.name} ${entity.type}`,
                ],
                normalizedFocusQuery,
              ) > 0,
          )
          .map((entity) => entity.id)
          .slice(0, FOCUS_ENTITY_LIMIT)
        : []
      : directEntityIds;
    const directEvidenceEventIds =
      directEventIds.length > 0 ? directEventIds : eventIdsFromChunks;
    const allEventIds =
      directEvidenceEventIds.length > 0
        ? directEvidenceEventIds
        : eventIdsFromEntities.length > 0
          ? eventIdsFromEntities
          : queryScopeEventIds;

    if (allEventIds.length > 0) {
      applyEventBatch(
        {
          kind: "focus",
          label: effectiveFocus.query,
          sourceEntityIds: queryScopeEntityIds,
          eventIds: allEventIds,
          offset: 0,
        },
        eventDisplayLimit,
      );
      return;
    }

    setActiveGraphMode("manual");
    setActiveEventBatch(null);
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setFocusedChunkIds(new Set(props.compact ? focusChunkIds : []));
    setFocusedEntityIds(new Set(queryScopeEntityIds));
    setFocusedEventIds(new Set());
    if (!props.compact) {
      setSelectedNodeId(null);
      setSelectedEntityTypes(buildSelectedEntityTypes(queryScopeEntityIds, entityById));
    }
    setGraphQuery(effectiveFocus.query);
    setActiveQueryLabel(
      `${graphText(props.language, "当前搜索", "Search")} · ${effectiveFocus.query}`,
    );
    setQueryLinkedNodeIds(new Set(queryScopeEntityIds));
    setSuggestionsOpen(false);
    setLayoutRevision((current) => current + 1);
    shouldFitViewRef.current = true;
  }, [
    chunkById,
    effectiveFocus?.key,
    entityById,
    eventById,
    eventIdsByChunkId,
    eventIdsByEntityId,
    eventDisplayLimit,
    props.graph.scope,
    props.language,
  ]);

  useEffect(() => {
    expandedEventIdsRef.current = expandedEventIds;
  }, [expandedEventIds]);

  useEffect(
    () => () => {
      clearClickTimer();
    },
    [],
  );

  useEffect(() => {
    const handleGraphNodeFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string }>).detail;
      if (!detail?.nodeId) return;
      requestGraphNodeFocus(detail.nodeId);
    };
    window.addEventListener("sag:graph-focus-node", handleGraphNodeFocus);
    return () =>
      window.removeEventListener("sag:graph-focus-node", handleGraphNodeFocus);
  }, [
    eventById,
    entityById,
    entityIdsByEventId,
    eventIdsByEntityId,
    expandedEventIds,
    focusedEventIds,
    queryLinkedNodeIds,
  ]);

  useEffect(() => {
    if (props.selectedExternalId) {
      setEventCategory("");
      requestGraphNodeFocus(props.selectedExternalId);
    }
  }, [props.selectedExternalId, props.graph]);

  useEffect(() => {
    if (!props.universe2D || mode !== "2d") return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.36, maxZoom: 1.15, duration: 220 });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.universe2D, mode, props.graph, category, fitView]);

  useEffect(() => {
    const toolbar = graphToolbarRef.current;
    const container = flowContainerRef.current;
    if (!starView || !toolbar || !container) return;
    const fitToolbar = () => container.style.setProperty("--atlas-graph-toolbar-height", `${toolbar.offsetHeight}px`);
    const observer = new ResizeObserver(fitToolbar);
    observer.observe(toolbar);
    fitToolbar();
    return () => observer.disconnect();
  }, [starView]);

  const onNodeClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    selectGraphNode(node.id, node.data);
  };

  function selectGraphNode(id: string, data: Pick<GraphNodeData, "kind" | "label">) {
    clearClickTimer();
    if (data.kind === "question") {
      setSelectedNodeId(null);
      return;
    }

    setSelectedNodeId(id);
    props.onPickNode?.({ kind: data.kind, id, label: data.label });
    if (data.kind === "chunk") {
      props.onOpenChunk(id);
      return;
    }
    if (data.kind === "entity") {
      props.onOpenEntity(id);
      return;
    }

    props.onOpenEvent(id);
    clickTimerRef.current = window.setTimeout(() => {
      expandEventNode(id);
      requestEventEntityFit(id);
      clickTimerRef.current = null;
    }, 220);
  }

  function unavailable() {
    setSceneUnavailable(true);
    setMode("2d");
  }

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

  function requestEventEntityFit(eventId: string, centerNodeId = eventId) {
    pendingFitNodeIdsRef.current = {
      nodeIds: [eventId, ...(entityIdsByEventId.get(eventId) ?? [])],
      centerNodeId,
    };
    shouldFitViewRef.current = false;
  }

  function expandEventNode(eventId: string) {
    setExpandedEventIds((current) => {
      if (current.size === 1 && current.has(eventId)) {
        return current;
      }
      return new Set([eventId]);
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

  function centerGraphNode(nodeId: string) {
    const node = getNode(nodeId);
    if (!node) return;
    pendingCenterNodeIdRef.current = null;
    const { width, height } = graphNodeSize(node as GraphNode);
    const visibleArea = getGraphVisibleArea(flowContainerRef.current);
    const zoom = 1.05;
    const horizontalOffset = visibleArea
      ? (visibleArea.fullWidth / 2 -
          (visibleArea.left + visibleArea.width / 2)) /
        zoom
      : 0;
    const verticalOffset = visibleArea
      ? (visibleArea.fullHeight / 2 -
          (visibleArea.top + visibleArea.height / 2)) /
        zoom
      : 0;
    setCenter(
      node.position.x + width / 2 + horizontalOffset,
      node.position.y + height / 2 + verticalOffset,
      {
        zoom,
        duration: 320,
      },
    );
  }

  function fitGraphNodes(nodeIds: string[], centerNodeId?: string) {
    pendingFitNodeIdsRef.current = null;
    pendingCenterNodeIdRef.current = null;
    const visibleNodes = uniqueGraphIds(nodeIds)
      .map((nodeId) => getNode(nodeId) as GraphNode | undefined)
      .filter((node): node is GraphNode => Boolean(node));
    if (visibleNodes.length === 0) {
      return;
    }
    if (visibleNodes.length === 1) {
      centerGraphNode(centerNodeId ?? visibleNodes[0].id);
      return;
    }

    const visibleArea = getGraphVisibleArea(flowContainerRef.current);
    if (!visibleArea) {
      fitView({
        nodes: visibleNodes.map((node) => ({ id: node.id })),
        padding: 0.26,
        maxZoom: 1.05,
        duration: 360,
      });
      return;
    }

    const viewport = getViewportForBounds(
      getGraphNodesBounds(visibleNodes),
      visibleArea.width,
      visibleArea.height,
      0.12,
      1.05,
      0.26,
    );
    setViewport(
      {
        ...viewport,
        x: viewport.x + visibleArea.left,
        y: viewport.y + visibleArea.top,
      },
      { duration: 360 },
    );
  }

  function requestGraphNodeFocus(nodeId: string) {
    if (!nodeId) return;
    shouldFitViewRef.current = false;
    pendingCenterNodeIdRef.current = nodeId;
    setSelectedNodeId(nodeId);

    if (eventById.has(nodeId)) {
      const relatedEntityIds = entityIdsByEventId.get(nodeId) ?? [];
      const chunkId = chunkIdByEventId.get(nodeId);
      if (chunkId) {
        setFocusedChunkIds((current) => new Set(current).add(chunkId));
      }
      setFocusedEventIds((current) => new Set(current).add(nodeId));
      setFocusedEntityIds((current) => {
        const next = new Set(current);
        for (const entityId of relatedEntityIds) next.add(entityId);
        return next;
      });
      setQueryLinkedNodeIds((current) => new Set(current).add(nodeId));
      setExpandedEventIds(new Set([nodeId]));
      requestEventEntityFit(nodeId);
      setLayoutRevision((current) => current + 1);
      return;
    }

    const entity = entityById.get(nodeId);
    if (entity) {
      const relatedEventIds = eventIdsByEntityId.get(nodeId) ?? [];
      const hasCurrentEventContext = focusedEventIds.size > 0;
      const preferredEventId =
        relatedEventIds.find((eventId) => expandedEventIds.has(eventId)) ??
        relatedEventIds.find((eventId) => focusedEventIds.has(eventId)) ??
        relatedEventIds.find((eventId) => queryLinkedNodeIds.has(eventId)) ??
        (hasCurrentEventContext ? undefined : relatedEventIds[0]);
      setFocusedEntityIds((current) => new Set(current).add(nodeId));
      if (preferredEventId) {
        const chunkId = chunkIdByEventId.get(preferredEventId);
        if (chunkId) {
          setFocusedChunkIds((current) => new Set(current).add(chunkId));
        }
        setFocusedEventIds((current) => new Set(current).add(preferredEventId));
        setExpandedEventIds(new Set([preferredEventId]));
        setQueryLinkedNodeIds((current) => new Set(current).add(preferredEventId));
        requestEventEntityFit(preferredEventId, nodeId);
      } else {
        setQueryLinkedNodeIds((current) => new Set(current).add(nodeId));
        pendingCenterNodeIdRef.current = nodeId;
        shouldFitViewRef.current = false;
      }
      setLayoutRevision((current) => current + 1);
    }
  }

  function clearChatFocusForShowcase() {
    appliedFocusKeyRef.current = null;
    setActiveEventBatch(null);
    setIgnoredFocusKey(props.focus?.key ?? null);
    setSuggestionsOpen(false);
    setSelectedNodeId(null);
    setGraphQuery("");
  }

  function resetGraph() {
    shouldFitViewRef.current = true;
    clearChatFocusForShowcase();
    setActiveGraphMode(randomGraphShowcaseMode());
    setShowcaseSeed(Math.floor(Math.random() * 1_000_000));
    setShowcaseRevision((current) => current + 1);
  }

  function showGraphPreset(mode: GraphShowcaseMode) {
    shouldFitViewRef.current = true;
    clearChatFocusForShowcase();
    setActiveGraphMode(mode);
    setShowcaseSeed(Math.floor(Math.random() * 1_000_000));
    setShowcaseRevision((current) => current + 1);
  }

  function rotateGraphShowcase() {
    shouldFitViewRef.current = true;
    clearChatFocusForShowcase();
    setActiveGraphMode((current) =>
      current === "manual" || current === "overview"
        ? randomGraphShowcaseMode()
        : current,
    );
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
    if (activeEventBatch) {
      applyEventBatch(activeEventBatch, getGraphEventDisplayLimit(value));
      return;
    }
    setLayoutRevision((current) => current + 1);
  }

  function collectEntityBatchEventIds(entityIds: string[]) {
    return uniqueGraphIds(
      entityIds.flatMap((entityId) => eventIdsByEntityId.get(entityId) ?? []),
    );
  }

  function collectBatchEntityIds(seedEntityIds: string[], eventIds: string[]) {
    const entityIds = new Set(seedEntityIds.filter((id) => entityById.has(id)));
    for (const eventId of eventIds) {
      for (const entityId of entityIdsByEventId.get(eventId) ?? []) {
        entityIds.add(entityId);
        if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
      }
      if (entityIds.size >= FOCUS_ENTITY_LIMIT) break;
    }
    return entityIds;
  }

  function applyEventBatch(
    input: ActiveEventBatch,
    displayLimit = eventDisplayLimit,
  ) {
    const totalEventCount = input.eventIds.length;
    const offset = totalEventCount > 0 ? input.offset % totalEventCount : 0;
    const visibleEventIds = input.eventIds.slice(
      offset,
      offset + displayLimit,
    );
    const entityIds = collectBatchEntityIds(input.sourceEntityIds, visibleEventIds);
    setActiveGraphMode("manual");
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setFocusedChunkIds(new Set(props.compact ? effectiveFocus?.chunkIds ?? [] : []));
    setFocusedEntityIds(entityIds);
    setFocusedEventIds(new Set(visibleEventIds));
    if (!props.compact) {
      setSelectedNodeId(null);
      setSelectedEntityTypes(new Set());
    }
    setGraphQuery(input.label);
    setActiveQueryLabel(
      `${graphText(props.language, "当前搜索", "Search")} · ${input.label}`,
    );
    setQueryLinkedNodeIds(
      new Set(visibleEventIds.length > 0 ? visibleEventIds : input.sourceEntityIds),
    );
    setActiveEventBatch({
      ...input,
      offset,
    });
    setSuggestionsOpen(false);
    setLayoutRevision((current) => current + 1);
    shouldFitViewRef.current = true;
  }

  function showNextEventBatch() {
    if (!activeEventBatch) return;
    const nextOffset =
      activeEventBatch.offset + eventDisplayLimit >= activeEventBatch.eventIds.length
        ? 0
        : activeEventBatch.offset + eventDisplayLimit;
    applyEventBatch({ ...activeEventBatch, offset: nextOffset });
  }

  function selectSuggestion(suggestion: GraphSuggestion) {
    const shouldLoadFromProject =
      Boolean(suggestion.remote) ||
      (suggestion.kind === "entity" && Boolean(props.onSelectSuggestion));
    if (!shouldLoadFromProject) {
      revealSuggestion(suggestion);
      return;
    }
    setGraphQuery(suggestion.label);
    setSuggestionsOpen(false);
    if (props.onSelectSuggestion) {
      props.onSelectSuggestion(suggestion);
      return;
    }
    props.onSearch?.(suggestion.label);
  }

  function revealSuggestion(suggestion: GraphSuggestion) {
    appliedFocusKeyRef.current = null;
    setIgnoredFocusKey(props.focus?.key ?? null);
    setActiveEventBatch(null);

    if (suggestion.kind === "entity") {
      const suggestionEntityIds = suggestion.entityIds?.length
        ? suggestion.entityIds
        : [suggestion.id];
      applyEventBatch({
        kind: "entity",
        label: suggestion.label,
        sourceEntityIds: suggestionEntityIds,
        eventIds: collectEntityBatchEventIds(suggestionEntityIds),
        offset: 0,
      });
      return;
    }

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
        if (eventIds.size >= eventDisplayLimit) break;
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
    setFocusedChunkIds(new Set());
    setFocusedEntityIds(new Set());
    setFocusedEventIds(eventIds);
    setSelectedNodeId(null);
    setSelectedEntityTypes(new Set());
    setGraphQuery(suggestion.label);
    setActiveQueryLabel(
      `${graphText(props.language, "当前搜索", "Search")} · ${suggestion.label}`,
    );
    setQueryLinkedNodeIds(
      new Set(eventIds.size > 0 ? [...eventIds] : [suggestion.id]),
    );
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

  const starTypesDefault = starView && !entityFilterUsed && selectedEntityTypes.size === 0;
  return (
    <div
      ref={flowContainerRef}
      className={cn("relative h-full min-h-0 overflow-hidden rounded-xl bg-background",
        starView && "atlas-universe", props.universe2D && "atlas-universe-explore")}
      data-graph-renderer={mode === "3d" ? "universe-3d" : props.universe2D ? "universe-2d" : "atlas-2d"}
    >
      {flatScene && <div className="atlas-universe-backdrop" aria-hidden="true"><ParticleGalaxy /></div>}
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
      <div ref={graphToolbarRef} className="pointer-events-none absolute inset-x-3 top-3 z-20">
      <div className="atlas-graph-toolbar pointer-events-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-background/90 p-2 shadow-[0_10px_30px_rgba(24,36,58,0.08)] backdrop-blur">
        <div role="group" aria-label={graphText(props.language, "图谱视图", "Graph view")} className="flex gap-1">
          <Button type="button" size="sm" variant={mode === "2d" ? "default" : "outline"}
            aria-pressed={mode === "2d"} onClick={() => setMode("2d")}>2D</Button>
          <Button type="button" size="sm" variant={mode === "3d" ? "default" : "outline"}
            aria-pressed={mode === "3d"} onClick={() => { setSceneUnavailable(false); setMode("3d"); }}>3D</Button>
        </div>
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={rotateGraphShowcase}
        >
          {graphText(props.language, "换一批", "Shuffle")}
        </Button>
        {activeEventBatch ? (
          <div data-graph-batch="" className="flex h-8 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 text-xs text-amber-900">
            <span>{formatActiveEventBatchLabel(activeEventBatch, props.language, eventDisplayLimit)}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={showNextEventBatch}
              disabled={activeEventBatch.eventIds.length <= eventDisplayLimit}
              title={
                activeEventBatch.eventIds.length <= eventDisplayLimit
                  ? graphText(
                      props.language,
                      "当前事件已全部展示",
                      "All events are already shown",
                    )
                  : undefined
              }
            >
              {graphText(props.language, "下一批", "Next batch")}
            </Button>
          </div>
        ) : activeShowcase && activeGraphMode !== "manual" ? (
          <div data-graph-batch="" className="flex h-8 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 text-xs text-amber-900">
            <span>{formatShowcaseEventLabel(activeShowcase, props.language, eventDisplayLimit)}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={rotateGraphShowcase}
              title={graphText(
                props.language,
                "按当前模式重新挑选一批事件和实体",
                "Pick another batch for the current mode",
              )}
            >
              {graphText(props.language, "下一批", "Next batch")}
            </Button>
          </div>
        ) : null}
        {!starView && <select
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
        </select>}
        {!starView && <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={autoLayoutCurrentGraph}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {graphText(props.language, "自动重排", "Auto layout")}
        </Button>}
        {starView && categories.length > 0 && <select
          aria-label={graphText(props.language, "事件分类", "Event category")}
          className="atlas-universe-category h-8 max-w-36 rounded-md px-2 text-xs"
          value={category}
          onChange={(event) => { setSelectedNodeId(null); setEventCategory(event.target.value); }}
        >
          <option value="">{graphText(props.language, "全部事件分类", "All event categories")}</option>
          {categories.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>}
        {sceneUnavailable && <span className="text-xs text-muted-foreground" role="status">
          {graphText(props.language, "当前设备无法使用 3D，已返回 2D。", "3D is unavailable on this device. Returned to 2D.")}
        </span>}
      </div>
      <div className="pointer-events-auto relative mt-2 w-full max-w-[520px]">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          value={graphQuery}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setGraphQuery(nextQuery);
            setSuggestionsOpen(true);
          }}
          onCompositionEnd={(event) => {
            setGraphQuery(event.currentTarget.value);
            setSuggestionsOpen(true);
          }}
          onFocus={() => setSuggestionsOpen(true)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Enter" && suggestions[0]) {
              event.preventDefault();
              selectSuggestion(suggestions[0]);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              props.onSearch?.(graphQuery.trim());
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
                  key={graphSuggestionDedupeKey(suggestion)}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(suggestion)}
                >
                  <span className="min-w-0 truncate text-sm">
                    <RichTextFragment text={suggestion.label} />
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatGraphSuggestionKindLabel(suggestion, props.language)}
                  </span>
                </button>
              ))
            ) : suggestionsLoading ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {graphText(
                  props.language,
                  "正在搜索全项目知识库…",
                  "Searching the full project knowledge base…",
                )}
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {graphText(
                  props.language,
                  "没有找到相似切片、实体或事件",
                  "No similar chunk, entity or event found",
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
      </div>
      <EntityTypeFilterPanel
        language={props.language}
        options={filteredEntityTypeOptions}
        totalCount={entityTypeOptions.length}
        selectedTypes={starTypesDefault ? new Set(entityTypeOptions.map((option) => option.type)) : selectedEntityTypes}
        query={entityTypeQuery}
        collapsed={entityTypeFilterCollapsed}
        onToggleCollapsed={() =>
          setEntityTypeFilterCollapsed((collapsed) => !collapsed)
        }
        onQueryChange={setEntityTypeQuery}
        onToggleType={(type) => {
          setEntityFilterUsed(true);
          if (starTypesDefault) {
            shouldFitViewRef.current = true;
            setSelectedNodeId(null);
            setSelectedEntityTypes(new Set(entityTypeOptions.filter((option) => option.type !== type).map((option) => option.type)));
          } else {
            toggleEntityType(type);
          }
        }}
        onSelectAll={() => { setEntityFilterUsed(true); selectAllEntityTypes(); }}
        onClear={() => { setEntityFilterUsed(true); clearEntityTypeFilter(); }}
      />
      <div className={cn("absolute inset-0", mode === "3d" && "invisible pointer-events-none")} aria-hidden={mode === "3d"}>
      <ReactFlow<GraphNode, GraphEdge>
        className="sag-graph-flow"
        nodes={flatScene?.nodes ?? nodes}
        edges={flatScene?.edges ?? edges}
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
        {!props.universe2D && <Background variant={BackgroundVariant.Dots} gap={24} size={1} />}
        <Controls showInteractive={false} />
        {!props.universe2D && <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as GraphNodeData;
            return data.kind === "question"
              ? "#22a06b"
              : data.kind === "chunk"
                ? "#1b6fcc"
                : data.kind === "entity"
                  ? (data.entityTypeColor ?? "#df5b25")
                  : "#4f46e5";
          }}
          maskColor="rgba(238,242,247,0.72)"
        />}
      </ReactFlow>
      </div>
      {mode === "3d" && (
        <SceneBoundary onUnavailable={unavailable}>
          <Suspense fallback={<div role="status" className="grid h-full place-items-center text-sm text-muted-foreground">
            {graphText(props.language, "正在加载 3D 图谱", "Loading 3D graph")}
          </div>}>
            <ProjectGraph3D data={sceneData} selectedId={selectedNodeId} camera={camera}
              onUnavailable={unavailable} onClear={() => setSelectedNodeId(null)}
              onSelect={(id) => { const node = sceneData.nodes.find((item) => item.id === id); if (node) selectGraphNode(id, node); }} />
          </Suspense>
          {sceneData.cropped && <span className="pointer-events-none absolute bottom-3 left-3 rounded bg-background/85 px-2 py-1 text-xs text-muted-foreground">
            {graphText(props.language, "3D 已限制显示范围，搜索可聚焦更多节点。", "3D display is capped. Search to focus other nodes.")}
          </span>}
        </SceneBoundary>
      )}
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
          isQuestion
            ? "sag-rich-graph-label-question"
            : "sag-rich-graph-label-inline",
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

function UniverseGraphNode({ data }: NodeProps<GraphNode>) {
  return (
    <div className="atlas-universe-node" data-kind={data.kind} title={[data.label, data.category].filter(Boolean).join(" · ")}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="atlas-universe-star" aria-hidden="true" />
      <span className="atlas-universe-label" data-kind={data.kind} data-visible={data.showLabel} data-side={data.labelSide}>
        {data.category && <small data-event-category="">{data.category}</small>}
        <strong>{data.label}</strong>
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function graphText(language: SupportedLanguage, zh: string, en: string) {
  return language === "en" ? en : zh;
}

function formatActiveEventBatchLabel(
  batch: ActiveEventBatch,
  language: SupportedLanguage,
  displayLimit: number,
) {
  const total = batch.eventIds.length;
  const start = total === 0 ? 0 : batch.offset + 1;
  const end = Math.min(total, batch.offset + displayLimit);
  const zhPrefix = batch.kind === "focus" ? "当前搜索" : "实体";
  const enPrefix = batch.kind === "focus" ? "Search" : "Entity";
  return graphText(
    language,
    `${zhPrefix} · 展示事件 ${start}-${end}/${total} 个`,
    `${enPrefix} · showing events ${start}-${end}/${total}`,
  );
}

function formatShowcaseEventLabel(
  showcase: GraphShowcase,
  language: SupportedLanguage,
  displayLimit: number,
) {
  const total = showcase.eventIds.length;
  const start = total === 0 ? 0 : 1;
  const end = Math.min(total, displayLimit);
  const zhPrefix =
    showcase.mode === "events"
      ? "高关联事件"
      : showcase.mode === "frequency"
        ? "高频化工品"
        : showcase.mode === "relations"
          ? "产业链关系"
          : "知识总览";
  const enPrefix =
    showcase.mode === "events"
      ? "Key events"
      : showcase.mode === "frequency"
        ? "Core chemicals"
        : showcase.mode === "relations"
          ? "Industry relations"
          : "Overview";
  return graphText(
    language,
    `${zhPrefix} · 展示事件 ${start}-${end}/${total} 个`,
    `${enPrefix} · showing events ${start}-${end}/${total}`,
  );
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
  return value === "entity_inner" ||
    value === "columns" ||
    value === "search_layers"
    ? value
    : "columns";
}

function getGraphEventDisplayLimit(layoutStyle: GraphLayoutStyle) {
  return layoutStyle === "columns"
    ? COLUMN_EVENT_LIMIT
    : SEARCH_LAYER_EVENT_LIMIT;
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
  const visibleEntityIds = new Set<string>(
    hasFocusedGraph ? input.focusedEntityIds : [],
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

function collectPotentialEntityIdsForScope(input: {
  visibleEntityIds: Set<string>;
  visibleEventIds: Set<string>;
  entityIdsByEventId: Map<string, string[]>;
}) {
  const entityIds = new Set<string>(input.visibleEntityIds);
  for (const eventId of input.visibleEventIds) {
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      entityIds.add(entityId);
    }
  }
  return entityIds;
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

function addSelectedTypeEntitiesFromVisibleEvents(input: {
  visibleEntityIds: Set<string>;
  visibleEventIds: Set<string>;
  selectedEntityTypes: Set<string>;
  entityById: Map<string, ProjectGraphEntityRecord>;
  entityIdsByEventId: Map<string, string[]>;
}) {
  if (input.selectedEntityTypes.size === 0) return;
  for (const eventId of input.visibleEventIds) {
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      const entity = input.entityById.get(entityId);
      if (!entity) continue;
      if (input.selectedEntityTypes.has(normalizeEntityType(entity.type))) {
        input.visibleEntityIds.add(entityId);
      }
    }
  }
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
  visibleEventIds: string[];
  visibleEntityIds: string[];
}) {
  const linkedNodeIds = [...input.queryLinkedNodeIds].filter((nodeId) =>
    input.visibleNodeIds.has(nodeId),
  );
  const linkedEventIds = linkedNodeIds.filter((nodeId) =>
    input.visibleEventIds.includes(nodeId),
  );
  if (linkedEventIds.length > 0) return linkedEventIds;

  const eventIds = input.visibleEventIds.filter((eventId) =>
    input.visibleNodeIds.has(eventId),
  );
  if (eventIds.length > 0) return eventIds;

  if (input.layoutStyle === "entity_inner") {
    const entityIds = input.visibleEntityIds.filter((entityId) =>
      input.visibleNodeIds.has(entityId),
    );
    if (entityIds.length > 0) return entityIds;
  }

  return linkedNodeIds;
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
  const {
    hasFocusedGraph,
    visibleChunkIds,
    visibleEntityIds,
    visibleEventIds,
  } = buildVisibleGraphScope(input);

  addSelectedTypeEntitiesFromVisibleEvents({
    visibleEntityIds,
    visibleEventIds,
    selectedEntityTypes: input.selectedEntityTypes,
    entityById: input.entityById,
    entityIdsByEventId: input.entityIdsByEventId,
  });

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
  const eventEntityPairs = buildVisibleEventEntityPairs({
    edges: input.edges,
    eventIds,
    entityIdsByEventId: input.entityIdsByEventId,
  });
  const edges: GraphEdge[] = eventEntityPairs
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
      visibleEventIds: eventIds,
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
    edges,
    selectedNodeId: input.selectedNodeId,
  });
}


function buildVisibleEventEntityPairs(input: {
  edges: ProjectGraphRecord["edges"];
  eventIds: string[];
  entityIdsByEventId: Map<string, string[]>;
}) {
  const pairs = new Map<string, { entityId: string; eventId: string }>();
  const addPair = (entityId: string, eventId: string) => {
    if (!entityId || !eventId) return;
    pairs.set(`${entityId}-${eventId}`, { entityId, eventId });
  };
  for (const edge of input.edges) {
    addPair(edge.entityId, edge.eventId);
  }
  for (const eventId of input.eventIds) {
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      addPair(entityId, eventId);
    }
  }
  return [...pairs.values()];
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
  const { height } = graphNodeSize(node);
  return node.position.y + height / 2;
}

function graphNodeSize(node: GraphNode) {
  const data = node.data as GraphNodeData;
  const measured = node.measured as
    | { width?: number; height?: number }
    | undefined;
  const widthFromStyle =
    typeof node.style?.width === "number" ? node.style.width : undefined;
  return {
    width:
      node.width ??
      measured?.width ??
      widthFromStyle ??
      (data.kind === "question"
        ? QUESTION_NODE_WIDTH
        : data.kind === "chunk"
          ? CHUNK_NODE_WIDTH
          : data.kind === "entity"
            ? ENTITY_NODE_WIDTH
            : EVENT_NODE_WIDTH),
    height: node.height ?? measured?.height ?? (data.kind === "question" ? 72 : NODE_HEIGHT),
  };
}


function getGraphNodesBounds(nodes: GraphNode[]) {
  const firstNode = nodes[0];
  if (!firstNode) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const { width, height } = graphNodeSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      x: firstNode.position.x,
      y: firstNode.position.y,
      width: 1,
      height: 1,
    };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function getGraphVisibleArea(container: HTMLDivElement | null) {
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width <= 0 || containerRect.height <= 0) return null;

  const drawer = getActiveDetailDrawerElement();
  const drawerRect = drawer?.getBoundingClientRect();
  let reservedRightWidth = 0;
  if (drawerRect && drawerRect.width > 0 && drawerRect.height > 0) {
    const horizontalOverlap = getRectHorizontalOverlap(containerRect, drawerRect);
    const verticalOverlap = getRectVerticalOverlap(containerRect, drawerRect);
    const drawerCoversRightSide =
      horizontalOverlap > 0 &&
      verticalOverlap > 0 &&
      drawerRect.left < containerRect.right &&
      drawerRect.right >= containerRect.right - 2;
    if (drawerCoversRightSide) {
      reservedRightWidth = Math.min(
        containerRect.width * 0.7,
        horizontalOverlap + 32,
      );
    }
  }

  const entityTypePanel = getEntityTypeFilterPanelElement();
  const entityTypePanelRect = entityTypePanel?.getBoundingClientRect();
  let reservedLeftWidth = 0;
  if (
    entityTypePanelRect &&
    entityTypePanelRect.width > 0 &&
    entityTypePanelRect.height > 0
  ) {
    const horizontalOverlap = getRectHorizontalOverlap(
      containerRect,
      entityTypePanelRect,
    );
    const verticalOverlap = getRectVerticalOverlap(
      containerRect,
      entityTypePanelRect,
    );
    const panelCoversLeftSide =
      horizontalOverlap > 0 &&
      verticalOverlap > 0 &&
      entityTypePanelRect.left <= containerRect.left + 24;
    if (panelCoversLeftSide) {
      reservedLeftWidth = Math.min(
        containerRect.width * 0.45,
        horizontalOverlap + 36,
      );
    }
  }

  const availableWidth = Math.max(
    260,
    containerRect.width - reservedLeftWidth - reservedRightWidth,
  );

  return {
    fullWidth: containerRect.width,
    fullHeight: containerRect.height,
    left: reservedLeftWidth,
    top: 0,
    width: availableWidth,
    height: Math.max(220, containerRect.height),
  };
}

function getRectHorizontalOverlap(
  leftRect: DOMRect,
  rightRect: DOMRect,
) {
  return Math.max(
    0,
    Math.min(leftRect.right, rightRect.right) -
      Math.max(leftRect.left, rightRect.left),
  );
}

function getRectVerticalOverlap(leftRect: DOMRect, rightRect: DOMRect) {
  return Math.max(
    0,
    Math.min(leftRect.bottom, rightRect.bottom) -
      Math.max(leftRect.top, rightRect.top),
  );
}

function getActiveDetailDrawerElement() {
  return document.querySelector<HTMLElement>(
    '[data-sag-detail-drawer="true"], aside.pointer-events-auto.absolute.inset-y-0.right-0',
  );
}

function getEntityTypeFilterPanelElement() {
  return document.querySelector<HTMLElement>(
    '[data-sag-entity-type-panel="true"]',
  );
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

  const { relatedNodeIds, relatedEdgeIds } = collectSelectedEvidencePath({
    nodes: input.nodes,
    edges: input.edges,
    selectedNodeId: input.selectedNodeId,
  });

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
      const related = relatedEdgeIds.has(edge.id);
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

function collectSelectedEvidencePath(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string;
}) {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const selectedNode = nodeById.get(input.selectedNodeId);
  const selectedKind = getGraphNodeKind(selectedNode);
  const relatedNodeIds = new Set<string>([input.selectedNodeId]);
  const relatedEdgeIds = new Set<string>();
  const queryEdges: GraphEdge[] = [];
  const chunkEventEdgesByChunkId = new Map<string, GraphEdge[]>();
  const chunkEventEdgesByEventId = new Map<string, GraphEdge[]>();
  const eventEntityEdgesByEventId = new Map<string, GraphEdge[]>();
  const eventEntityEdgesByEntityId = new Map<string, GraphEdge[]>();

  const addEdge = (edge: GraphEdge) => {
    relatedEdgeIds.add(edge.id);
    relatedNodeIds.add(edge.source);
    relatedNodeIds.add(edge.target);
  };
  const addEdgeToMap = (
    map: Map<string, GraphEdge[]>,
    key: string,
    edge: GraphEdge,
  ) => {
    const edges = map.get(key) ?? [];
    edges.push(edge);
    map.set(key, edges);
  };

  for (const edge of input.edges) {
    const sourceKind = getGraphNodeKind(nodeById.get(edge.source));
    const targetKind = getGraphNodeKind(nodeById.get(edge.target));
    if (!sourceKind || !targetKind) continue;

    if (sourceKind === "question" || targetKind === "question") {
      queryEdges.push(edge);
      continue;
    }

    if (
      (sourceKind === "chunk" && targetKind === "event") ||
      (sourceKind === "event" && targetKind === "chunk")
    ) {
      const chunkId = sourceKind === "chunk" ? edge.source : edge.target;
      const eventId = sourceKind === "event" ? edge.source : edge.target;
      addEdgeToMap(chunkEventEdgesByChunkId, chunkId, edge);
      addEdgeToMap(chunkEventEdgesByEventId, eventId, edge);
      continue;
    }

    if (
      (sourceKind === "event" && targetKind === "entity") ||
      (sourceKind === "entity" && targetKind === "event")
    ) {
      const eventId = sourceKind === "event" ? edge.source : edge.target;
      const entityId = sourceKind === "entity" ? edge.source : edge.target;
      addEdgeToMap(eventEntityEdgesByEventId, eventId, edge);
      addEdgeToMap(eventEntityEdgesByEntityId, entityId, edge);
    }
  }

  const addQueryEdgeToNode = (nodeId: string) => {
    for (const edge of queryEdges) {
      if (edge.source === nodeId || edge.target === nodeId) {
        addEdge(edge);
      }
    }
  };

  const addEventToEntityEdges = (eventId: string, onlyEntityId?: string) => {
    for (const edge of eventEntityEdgesByEventId.get(eventId) ?? []) {
      if (
        onlyEntityId &&
        edge.source !== onlyEntityId &&
        edge.target !== onlyEntityId
      ) {
        continue;
      }
      addEdge(edge);
    }
  };

  const addFullPathThroughEvent = (eventId: string, onlyEntityId?: string) => {
    relatedNodeIds.add(eventId);
    const chunkEdges = chunkEventEdgesByEventId.get(eventId) ?? [];
    if (chunkEdges.length > 0) {
      for (const edge of chunkEdges) {
        addEdge(edge);
        const chunkId = getOtherGraphEdgeEndpoint(edge, eventId);
        if (chunkId) addQueryEdgeToNode(chunkId);
      }
    } else {
      addQueryEdgeToNode(eventId);
    }
    addEventToEntityEdges(eventId, onlyEntityId);
  };

  const addFullPathThroughChunk = (chunkId: string) => {
    relatedNodeIds.add(chunkId);
    addQueryEdgeToNode(chunkId);
    for (const edge of chunkEventEdgesByChunkId.get(chunkId) ?? []) {
      addEdge(edge);
      const eventId = getOtherGraphEdgeEndpoint(edge, chunkId);
      if (eventId) addEventToEntityEdges(eventId);
    }
  };

  if (selectedKind === "chunk") {
    addFullPathThroughChunk(input.selectedNodeId);
  } else if (selectedKind === "event") {
    addFullPathThroughEvent(input.selectedNodeId);
  } else if (selectedKind === "entity") {
    relatedNodeIds.add(input.selectedNodeId);
    const eventEdges =
      eventEntityEdgesByEntityId.get(input.selectedNodeId) ?? [];
    for (const edge of eventEdges) {
      addEdge(edge);
      const eventId = getOtherGraphEdgeEndpoint(edge, input.selectedNodeId);
      if (eventId) addFullPathThroughEvent(eventId, input.selectedNodeId);
    }
    if (eventEdges.length === 0) {
      addQueryEdgeToNode(input.selectedNodeId);
    }
  }

  if (relatedEdgeIds.size === 0) {
    for (const edge of input.edges) {
      if (
        edge.source === input.selectedNodeId ||
        edge.target === input.selectedNodeId
      ) {
        addEdge(edge);
      }
    }
  }

  return { relatedNodeIds, relatedEdgeIds };
}

function getGraphNodeKind(node?: GraphNode) {
  return node ? ((node.data as GraphNodeData).kind ?? null) : null;
}

function getOtherGraphEdgeEndpoint(edge: GraphEdge, nodeId: string) {
  if (edge.source === nodeId) return edge.target;
  if (edge.target === nodeId) return edge.source;
  return null;
}

function getNodeAccentColor(node: GraphNode) {
  const data = node.data as GraphNodeData;
  if (data.kind === "question") return "#22a06b";
  if (data.kind === "chunk") return "#1b6fcc";
  if (data.kind === "entity") return data.entityTypeColor ?? "#df5b25";
  return "#4f46e5";
}

function buildFocusedPositionMap(
  _chunkIds: string[],
  entityIds: string[],
  eventIds: string[],
  revision: number,
  layoutStyle: GraphLayoutStyle,
) {
  if (layoutStyle === "columns") {
    return buildColumnFocusedPositionMap(entityIds, eventIds, revision);
  }
  if (layoutStyle === "entity_inner") {
    // Entity-inner-ring mode: keep entity cards closer to the current context
    // and place event cards on the outer ring.
    return buildSquareFocusedPositionMap({
      layers: [
        { ids: entityIds, nodeWidth: ENTITY_NODE_WIDTH },
        { ids: eventIds, nodeWidth: EVENT_NODE_WIDTH },
      ],
      revision,
    });
  }
  return buildSearchLayerFocusedPositionMap(entityIds, eventIds, revision);
}

function buildSearchLayerFocusedPositionMap(
  entityIds: string[],
  eventIds: string[],
  revision: number,
) {
  // Search-centered mode: put events on the inner ring and entities on the
  // outer ring. The canvas intentionally hides chunk cards so the evidence
  // path stays concise: current context -> event -> entity.
  return buildSquareFocusedPositionMap({
    layers: [
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

    for (
      let pointIndex = 0;
      pointIndex < points.length && index < input.ids.length;
      pointIndex += 1
    ) {
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
  const topSlots = Math.max(
    3,
    Math.floor((input.halfWidth * 2) / input.slotSpacingX) + 1,
  );
  const sideSlots = Math.max(
    1,
    Math.floor((input.halfHeight * 2) / input.slotSpacingY) - 1,
  );

  for (let slot = 0; slot < topSlots; slot += 1) {
    const ratio = topSlots === 1 ? 0.5 : slot / (topSlots - 1);
    points.push({
      x: -input.halfWidth + ratio * input.halfWidth * 2,
      y: -input.halfHeight,
    });
  }
  for (let slot = 1; slot <= sideSlots; slot += 1) {
    const ratio = slot / (sideSlots + 1);
    points.push({
      x: input.halfWidth,
      y: -input.halfHeight + ratio * input.halfHeight * 2,
    });
  }
  for (let slot = 0; slot < topSlots; slot += 1) {
    const ratio = topSlots === 1 ? 0.5 : slot / (topSlots - 1);
    points.push({
      x: input.halfWidth - ratio * input.halfWidth * 2,
      y: input.halfHeight,
    });
  }
  for (let slot = sideSlots; slot >= 1; slot -= 1) {
    const ratio = slot / (sideSlots + 1);
    points.push({
      x: -input.halfWidth,
      y: -input.halfHeight + ratio * input.halfHeight * 2,
    });
  }

  return points;
}

function buildColumnFocusedPositionMap(
  entityIds: string[],
  eventIds: string[],
  _revision: number,
) {
  const positions = new Map<string, GraphPosition>();
  const eventColumns = Math.min(4, Math.max(1, eventIds.length));
  const entityColumns = Math.min(5, Math.max(1, entityIds.length));
  const eventGapX = 240;
  const entityGapX = 210;
  const rowGap = 96;
  const eventStartY = 92;
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

  eventIds.forEach((id, index) => {
    const row = Math.floor(index / eventColumns);
    const column = index % eventColumns;
    positions.set(id, {
      x: (column - (eventColumns - 1) / 2) * eventGapX - EVENT_NODE_WIDTH / 2,
      y: eventStartY + row * (rowGap + 12),
      angle: Math.PI / 2,
      radius: row + 1,
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
      radius: eventRows + row + 2,
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
    (a?.heading ?? a?.content ?? "").localeCompare(
      b?.heading ?? b?.content ?? "",
    )
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
  remote?: boolean;
  entityIds?: string[];
  entityCount?: number;
  relatedEventCount?: number;
  normalizedEntityName?: string;
  visibleEventCount?: number;
};

function rankGraphSuggestions(
  graph: ProjectGraphRecord,
  query: string,
  limit = 10,
  eventDisplayLimit = DEFAULT_FOCUS_EVENT_LIMIT,
): GraphSuggestion[] {
  const normalizedQuery = normalizeGraphText(query);
  if (!normalizedQuery) return [];

  const eventById = new Map(graph.events.map((event) => [event.id, event]));
  const eventIdsByEntityId = new Map<string, Set<string>>();
  const linkEntityToEvent = (entityId: string, eventId: string) => {
    if (!entityId || !eventId || !eventById.has(eventId)) return;
    const eventIds = eventIdsByEntityId.get(entityId) ?? new Set<string>();
    eventIds.add(eventId);
    eventIdsByEntityId.set(entityId, eventIds);
  };
  for (const edge of graph.edges) {
    linkEntityToEvent(edge.entityId, edge.eventId);
  }
  for (const event of graph.events) {
    for (const entityId of event.entityIds ?? []) {
      linkEntityToEvent(entityId, event.id);
    }
  }

  const suggestions: GraphSuggestion[] = [];
  const entityGroupsBySearchKey = new Map<string, ProjectGraphEntityRecord[]>();
  for (const entity of graph.entities) {
    const key = graphEntitySuggestionGroupKey(entity);
    const entities = entityGroupsBySearchKey.get(key) ?? [];
    entities.push(entity);
    entityGroupsBySearchKey.set(key, entities);
  }
  for (const groupEntities of entityGroupsBySearchKey.values()) {
    const scoredEntities = groupEntities
      .map((entity) => ({
        entity,
        score: maxGraphMatchScore(
          [entity.name, entity.normalizedName, `${entity.name} ${entity.type}`],
          normalizedQuery,
        ),
      }))
      .filter((item) => item.score > 0);
    if (scoredEntities.length === 0) continue;
    const orderedEntities = [...groupEntities].sort(compareEntities);
    const representative = orderedEntities[0] ?? scoredEntities[0].entity;
    const relatedEventIds = uniqueGraphIds(
      groupEntities.flatMap((entity) => [
        ...(eventIdsByEntityId.get(entity.id) ?? []),
      ]),
    );
    const relatedEventCount = relatedEventIds.length;
    const score = Math.max(...scoredEntities.map((item) => item.score));
    suggestions.push({
      id: representative.id,
      label: representative.name,
      kind: "entity",
      score: score + 8,
      weight: relatedEventCount,
      entityIds: orderedEntities.map((entity) => entity.id),
      entityCount: orderedEntities.length,
      relatedEventCount,
      normalizedEntityName: graphEntitySuggestionGroupKey(representative),
      visibleEventCount: Math.min(
        relatedEventCount,
        eventDisplayLimit,
      ),
    });
  }
  for (const event of graph.events) {
    const titleScore = graphMatchScore(event.title, normalizedQuery);
    const score = titleScore;
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
  for (const chunk of graph.chunks ?? []) {
    const chunkScore = graphMatchScore(
      `${chunk.heading ?? ""} ${chunk.content.slice(0, 220)}`,
      normalizedQuery,
    );
    const score = chunkScore;
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

  return diversifyGraphSuggestions(
    suggestions.sort(compareGraphSuggestions),
    limit,
  );
}

function diversifyGraphSuggestions(
  sortedSuggestions: GraphSuggestion[],
  limit: number,
): GraphSuggestion[] {
  const result: GraphSuggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of sortedSuggestions) {
    if (result.length >= limit) break;
    addGraphSuggestion(result, seen, suggestion);
  }
  return result;
}

function addGraphSuggestion(
  result: GraphSuggestion[],
  seen: Set<string>,
  suggestion: GraphSuggestion,
) {
  const key = graphSuggestionDedupeKey(suggestion);
  if (seen.has(key)) return;
  seen.add(key);
  result.push(suggestion);
}

function graphSuggestionDedupeKey(suggestion: GraphSuggestion) {
  if (suggestion.kind === "entity") {
    const nameKey =
      suggestion.normalizedEntityName?.trim() ||
      normalizeGraphEntityName(suggestion.label);
    return `${suggestion.kind}-${nameKey || suggestion.id}`;
  }
  return `${suggestion.kind}-${suggestion.id}`;
}

function graphEntitySuggestionGroupKey(entity: ProjectGraphEntityRecord) {
  return (
    entity.normalizedName?.normalize("NFKC").trim().toLocaleLowerCase() ||
    normalizeGraphEntityName(entity.name) ||
    entity.id
  );
}

function normalizeGraphEntityName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\u200B-\u200D\uFEFF\s]+/g, "")
    .replace(/[‐‑‒–—−﹣]/g, "-")
    .replace(/[、﹑]/g, ",")
    .replace(/[·•・]/g, "·");
}

function formatGraphSuggestionKindLabel(
  suggestion: GraphSuggestion,
  language: SupportedLanguage,
) {
  if (suggestion.kind === "chunk") return graphText(language, "切片", "Chunk");
  if (suggestion.kind === "event") return graphText(language, "事件", "Event");
  const entityCount =
    suggestion.entityCount ?? suggestion.entityIds?.length ?? 1;
  const relatedEventCount = suggestion.relatedEventCount ?? 0;
  return graphText(
    language,
    `同名实体 ${entityCount} 个 · 相关事件 ${relatedEventCount} 个`,
    `${entityCount} same-name ${
      entityCount === 1 ? "entity" : "entities"
    } · ${relatedEventCount} related ${
      relatedEventCount === 1 ? "event" : "events"
    }`,
  );
}

function compareGraphSuggestions(
  left: GraphSuggestion,
  right: GraphSuggestion,
) {
  return (
    graphSuggestionKindWeight(right.kind) -
      graphSuggestionKindWeight(left.kind) ||
    right.score - left.score ||
    right.weight - left.weight ||
    left.label.localeCompare(right.label)
  );
}

function maxGraphMatchScore(values: string[], normalizedQuery: string) {
  return values.reduce(
    (best, value) => Math.max(best, graphMatchScore(value, normalizedQuery)),
    0,
  );
}

function graphSuggestionKindWeight(kind: GraphSuggestion["kind"]) {
  if (kind === "entity") return 3;
  if (kind === "event") return 2;
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
        data-sag-entity-type-panel="true"
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
      data-sag-entity-type-panel="true"
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

function randomGraphShowcaseMode(): GraphShowcaseMode {
  return (
    DEFAULT_GRAPH_SHOWCASE_MODES[
      Math.floor(Math.random() * DEFAULT_GRAPH_SHOWCASE_MODES.length)
    ] ?? "frequency"
  );
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
    return buildFrequencyShowcase({ ...input, graphIndex, chemicalEntities });
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
  const entityById = new Map(
    graph.entities.map((entity) => [entity.id, entity]),
  );
  const eventById = new Map(graph.events.map((event) => [event.id, event]));
  const entityIdsByEventId = new Map<string, string[]>();
  const eventIdsByEntityId = new Map<string, string[]>();

  const linkEntityToEvent = (entityId: string, eventId: string) => {
    if (!entityId || !eventId || !eventById.has(eventId) || !entityById.has(entityId)) return;
    const entityIds = entityIdsByEventId.get(eventId) ?? [];
    entityIds.push(entityId);
    entityIdsByEventId.set(eventId, entityIds);

    const eventIds = eventIdsByEntityId.get(entityId) ?? [];
    eventIds.push(eventId);
    eventIdsByEntityId.set(entityId, eventIds);
  };

  for (const edge of graph.edges) {
    linkEntityToEvent(edge.entityId, edge.eventId);
  }
  for (const event of graph.events) {
    for (const entityId of event.entityIds ?? []) {
      linkEntityToEvent(entityId, event.id);
    }
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
    for (const eventId of pair.eventIds.slice(0, 8))
      candidateEventIds.add(eventId);
  }

  for (const entity of seededShuffle(
    input.chemicalEntities.slice(
      0,
      Math.min(24, input.chemicalEntities.length),
    ),
    input.seed + 11,
  ).slice(0, 8)) {
    anchorEntityIds.add(entity.id);
    for (const eventId of (
      input.graphIndex.eventIdsByEntityId.get(entity.id) ?? []
    ).slice(0, 4)) {
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
    input.chemicalEntities.slice(
      0,
      Math.min(SHOWCASE_TOP_CANDIDATE_LIMIT, input.chemicalEntities.length),
    ),
    input.seed + 23,
  )
    .slice(0, 9)
    .sort(compareEntities);
  const anchorEntityIds = new Set(anchors.map((entity) => entity.id));
  const candidateEventIds = new Set<string>();
  for (const entity of anchors) {
    for (const eventId of (
      input.graphIndex.eventIdsByEntityId.get(entity.id) ?? []
    ).slice(0, 6)) {
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
      `高频化工品 · ${anchors
        .slice(0, 3)
        .map((entity) => entity.name)
        .join("、")}`,
      `Core chemicals · ${anchors
        .slice(0, 3)
        .map((entity) => entity.name)
        .join(", ")}`,
    ),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([
      ...anchors.slice(0, 4).map((entity) => entity.id),
      ...eventIds.slice(0, 3),
    ]),
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
  const chemicalEntityIdSet = new Set(
    input.chemicalEntities.map((entity) => entity.id),
  );
  const eventCandidates = input.graph.events
    .map((event) => {
      const entityIds = input.graphIndex.entityIdsByEventId.get(event.id) ?? [];
      const chemicalCount = entityIds.filter((entityId) =>
        chemicalEntityIdSet.has(entityId),
      ).length;
      const score =
        chemicalCount * 6 + entityIds.length * 2 - event.rank * 0.02;
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
    for (const entityId of input.graphIndex.entityIdsByEventId.get(eventId) ??
      []) {
      const entity = input.graphIndex.entityById.get(entityId);
      if (entity && isChemicalGraphEntity(entity))
        anchorEntityIds.add(entityId);
    }
  }
  const entityIds = collectShowcaseEntities({
    eventIds,
    anchorEntityIds,
    graphIndex: input.graphIndex,
    limit: SHOWCASE_ENTITY_LIMIT,
    includeRelatedEntityLimit: 10,
  });
  const firstEventTitle = truncateGraphLabel(
    selectedEvents[0]?.event.title ?? "核心事件",
    18,
  );
  return {
    mode: "events",
    title: graphText(
      input.language,
      `高关联事件视角 · ${firstEventTitle}`,
      `Key-event view · ${firstEventTitle}`,
    ),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([
      ...eventIds.slice(0, 5),
      ...entityIds.slice(0, 5),
    ]),
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
    candidates.slice(
      0,
      Math.min(SHOWCASE_TOP_CANDIDATE_LIMIT, candidates.length),
    ),
    input.seed + 53,
  )[0];
}

function buildCoEventPairCandidates(input: {
  graph: ProjectGraphRecord;
  graphIndex: GraphIndex;
  chemicalEntities: ProjectGraphEntityRecord[];
}): CoEventPairCandidate[] {
  const chemicalEntityIdSet = new Set(
    input.chemicalEntities.map((entity) => entity.id),
  );
  const pairEventIds = new Map<string, Set<string>>();

  for (const event of input.graph.events) {
    const chemicalIds = uniqueStrings(
      (input.graphIndex.entityIdsByEventId.get(event.id) ?? []).filter(
        (entityId) => chemicalEntityIdSet.has(entityId),
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
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < chemicalIds.length;
        rightIndex += 1
      ) {
        const leftId = chemicalIds[leftIndex];
        const rightId = chemicalIds[rightIndex];
        const key =
          leftId < rightId
            ? `${leftId}|||${rightId}`
            : `${rightId}|||${leftId}`;
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
  const anchorHits = entityIds.filter((entityId) =>
    anchorEntityIds.has(entityId),
  ).length;
  const chemicalHits = entityIds.filter((entityId) => {
    const entity = graphIndex.entityById.get(entityId);
    return entity ? isChemicalGraphEntity(entity) : false;
  }).length;
  const event = graphIndex.eventById.get(eventId);
  return (
    anchorHits * 40 +
    chemicalHits * 8 +
    entityIds.length * 2 -
    (event?.rank ?? 0) * 0.02
  );
}

function averageEventRank(eventIds: string[], graphIndex: GraphIndex) {
  if (eventIds.length === 0) return 0;
  return (
    eventIds.reduce(
      (total, eventId) =>
        total + (graphIndex.eventById.get(eventId)?.rank ?? 0),
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
    for (const entityId of input.graphIndex.entityIdsByEventId.get(eventId) ??
      []) {
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
    .slice(
      0,
      Math.min(
        input.includeRelatedEntityLimit,
        input.limit - chemicalEntityIds.length,
      ),
    );

  return uniqueStrings([...chemicalEntityIds, ...relatedEntityIds]).slice(
    0,
    input.limit,
  );
}

function buildFallbackShowcase(
  graph: ProjectGraphRecord,
  mode: GraphShowcaseMode,
  language: SupportedLanguage,
): GraphShowcase {
  const entityIds = graph.entities.slice(0, 18).map((entity) => entity.id);
  const entityIdSet = new Set(entityIds);
  const eventIds = graph.events
    .filter((event) =>
      event.entityIds.some((entityId) => entityIdSet.has(entityId)),
    )
    .slice(0, 8)
    .map((event) => event.id);
  return {
    mode,
    title: graphText(language, "精选知识总览", "Curated overview"),
    entityIds,
    eventIds,
    linkedNodeIds: uniqueStrings([
      ...eventIds.slice(0, 4),
      ...entityIds.slice(0, 4),
    ]),
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

  if (
    negativeTypeKeywords.some((keyword) =>
      type.includes(normalizeGraphText(keyword)),
    )
  ) {
    return false;
  }
  if (
    negativeNameKeywords.some((keyword) =>
      name.includes(normalizeGraphText(keyword)),
    )
  ) {
    return false;
  }
  return positiveTypeKeywords.some((keyword) =>
    type.includes(normalizeGraphText(keyword)),
  );
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
  return keywords.some(
    (keyword) =>
      type.includes(normalizeGraphText(keyword)) ||
      name.includes(normalizeGraphText(keyword)),
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
