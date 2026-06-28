import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Bot,
  Building2,
  CircleCheck,
  Check,
  Copy,
  Database,
  Download,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Layers3,
  Loader2,
  MoreHorizontal,
  Network,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
  Zap
} from "lucide-react";
import { api } from "./lib/api";
import { cn, formatDate, shortId } from "./lib/utils";
import type {
  ChunkRecord,
  DocumentRecord,
  EmbeddingPreview,
  EntityDetailRecord,
  EntityRecord,
  EventDetailRecord,
  EventRecord,
  McpSessionDetail,
  McpSessionRecord,
  McpMessageRecord,
  McpStreamEvent,
  McpToolCallRecord,
  ManualImportFormat,
  ModelCallLogRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  ChunkingMode,
  PublicAiProviderSettings,
  PublicMcpSettings,
  SearchMode,
  SearchResult,
  SearchStreamEvent,
  SourceRecord,
  UploadJobRecord
} from "./types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { ProjectGraphFlow } from "./components/ProjectGraphFlow";
import { MarkdownMessage } from "./components/MarkdownMessage";
import { ThemeToggleButton, ThemeSettingsCard } from "./components/ThemeControls";
import { I18nProvider, useI18n, useLanguageController, type LanguagePreference, type SupportedLanguage } from "./i18n";

type WorkspaceView = "chat" | "documents" | "graph" | "mcp" | "settings";
type ResultView = "overview" | "chunks" | "events" | "entities" | "search";
type ExportSplitMode = "none" | "documents" | "size";
type ContextPanelMode = "process" | "assets" | "logs";
type ProcessStepStatus = "running" | "done" | "failed";
type ProcessStep = {
  id: string;
  title: string;
  status: ProcessStepStatus;
  detail?: string;
  payload?: unknown;
  durationMs?: number | null;
};
type RunningMcpSearch = {
  id: string;
  toolName: string;
  query: string;
  searchMode?: string;
};
type AnswerCitation = {
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
type DetailDrawer =
  | { type: "event"; detail: EventDetailRecord }
  | { type: "entity"; detail: EntityDetailRecord }
  | { type: "citation"; citation: AnswerCitation }
  | null;
type GraphFocus = {
  key: string;
  query: string;
  eventIds: string[];
  entityIds: string[];
  primaryEntityId?: string;
};

const MODEL_LOGS_STORAGE_KEY = "sag:model-call-logs:v1";
const MODEL_LOG_CURSOR_STORAGE_KEY = "sag:model-call-log-cursor:v1";
const AUTO_MERMAID_STORAGE_KEY = "sag:auto-industry-chain-mermaid:v1";
const LEFT_RAIL_WIDTH_STORAGE_KEY = "sag:left-rail-width:v1";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "sag:right-panel-width:v1";
const DOC_RAIL_WIDTH_STORAGE_KEY = "sag:doc-rail-width:v1";
const AI_IMPORT_PROMPT_STORAGE_KEY = "sag:ai-import-prompts:v1";
const DOC_RAIL_MIN_WIDTH = 240;
const DOC_RAIL_MAX_WIDTH = 680;
const LEFT_RAIL_COLLAPSED_STORAGE_KEY = "sag:left-rail-collapsed:v1";
const RIGHT_PANEL_COLLAPSED_STORAGE_KEY = "sag:right-panel-collapsed:v1";
const MAX_BROWSER_MODEL_LOGS = 200;
const DOCUMENT_RESULT_PAGE_SIZE = 10;
const LEFT_RAIL_MIN_WIDTH = 224;
const LEFT_RAIL_MAX_WIDTH = 420;
const LEFT_RAIL_COLLAPSED_WIDTH = 72;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAX_WIDTH = 640;
const RIGHT_PANEL_COLLAPSED_WIDTH = 56;
const DEFAULT_SEARCH_QUERY_ZH = "基于当前项目资料检索";
const DEFAULT_SEARCH_QUERY_EN = "Search current project documents";

export default function App() {
  const i18n = useLanguageController();
  return (
    <I18nProvider value={i18n}>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const { language, preference: languagePreference, setPreference: setLanguagePreference, t } = useI18n();
  const [projects, setProjects] = useState<SourceRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [projectStats, setProjectStats] = useState<ProjectStatsRecord | null>(null);
  const [projectGraph, setProjectGraph] = useState<ProjectGraphRecord | null>(null);
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  const [sessionsByProjectId, setSessionsByProjectId] = useState<Record<string, McpSessionRecord[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [mcpDetail, setMcpDetail] = useState<McpSessionDetail | null>(null);
  const [aiSettings, setAiSettings] = useState<PublicAiProviderSettings | null>(null);
  const [mcpSettings, setMcpSettings] = useState<PublicMcpSettings | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [resultView, setResultView] = useState<ResultView>("overview");
  const [contextPanelMode, setContextPanelMode] = useState<ContextPanelMode>("process");
  const [drawer, setDrawer] = useState<DetailDrawer>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [showArchivedDocuments, setShowArchivedDocuments] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [status, setStatus] = useState(() => t("正在加载 SAG...", "Loading SAG..."));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploadJobs, setUploadJobs] = useState<UploadJobRecord[]>([]);
  const [isUploadQueueExpanded, setIsUploadQueueExpanded] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState(() => t(DEFAULT_SEARCH_QUERY_ZH, DEFAULT_SEARCH_QUERY_EN));
  const [searchMode, setSearchMode] = useState<SearchMode>("fast");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [processSteps, setProcessSteps] = useState<ProcessStep[]>([]);
  const [modelLogs, setModelLogs] = useState<ModelCallLogRecord[]>(() => loadStoredModelLogs());
  const [modelLogCursor, setModelLogCursor] = useState(() => loadStoredModelLogCursor());
  const [isSearching, setIsSearching] = useState(false);
  const [mcpInput, setMcpInput] = useState("");
  const [isMcpRunning, setIsMcpRunning] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState("");
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [runningMcpSearches, setRunningMcpSearches] = useState<RunningMcpSearch[]>([]);
  const [autoMermaid, setAutoMermaid] = useState(() => window.localStorage.getItem(AUTO_MERMAID_STORAGE_KEY) === "true");
  const [leftRailWidth, setLeftRailWidth] = useState(() => loadStoredNumber(LEFT_RAIL_WIDTH_STORAGE_KEY, 280, LEFT_RAIL_MIN_WIDTH, LEFT_RAIL_MAX_WIDTH));
  const [rightPanelWidth, setRightPanelWidth] = useState(() => loadStoredNumber(RIGHT_PANEL_WIDTH_STORAGE_KEY, 360, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH));
  const [isLeftRailCollapsed, setIsLeftRailCollapsed] = useState(() => loadStoredBoolean(LEFT_RAIL_COLLAPSED_STORAGE_KEY, false));
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(() => loadStoredBoolean(RIGHT_PANEL_COLLAPSED_STORAGE_KEY, false));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchStartedAtRef = useRef<number | null>(null);
  const refreshedUploadJobsRef = useRef<Set<string>>(new Set());
  const modelLogCursorRef = useRef(modelLogCursor);
  const pendingSessionIdRef = useRef<string | null>(null);
  const mcpAbortControllerRef = useRef<AbortController | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const visibleDocuments = useMemo(
    () => documents.filter((document) => showArchivedDocuments || !document.archivedAt),
    [documents, showArchivedDocuments]
  );

  const hasActiveUploads = useMemo(
    () => uploadJobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING"),
    [uploadJobs]
  );

  useEffect(() => {
    if (hasActiveUploads) {
      setIsUploadQueueExpanded(true);
      return;
    }
    if (uploadJobs.length > 0) {
      setIsUploadQueueExpanded(false);
    }
  }, [hasActiveUploads, uploadJobs.length]);

  useEffect(() => {
    void bootstrap();
  }, []);

  // 绿色「已保存 / 成功」提示横条几秒后自动消失（#10）
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 红色错误横条停留稍久一点后自动消失（#10）
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 7000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    setSearchQuery((current) => {
      if (current === DEFAULT_SEARCH_QUERY_ZH || current === DEFAULT_SEARCH_QUERY_EN) {
        return t(DEFAULT_SEARCH_QUERY_ZH, DEFAULT_SEARCH_QUERY_EN);
      }
      return current;
    });
  }, [language, t]);

  useEffect(() => {
    if (aiSettings?.defaultSearchMode) {
      setSearchMode(aiSettings.defaultSearchMode);
    }
  }, [aiSettings?.defaultSearchMode]);

  useEffect(() => {
    if (!selectedProjectId) return;
    setGraphFocus(null);
    setExpandedProjectIds((current) => {
      if (current.has(selectedProjectId)) return current;
      const next = new Set(current);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    modelLogCursorRef.current = modelLogCursor;
    window.localStorage.setItem(MODEL_LOG_CURSOR_STORAGE_KEY, String(modelLogCursor));
  }, [modelLogCursor]);

  useEffect(() => {
    persistModelLogs(modelLogs);
  }, [modelLogs]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_MERMAID_STORAGE_KEY, String(autoMermaid));
  }, [autoMermaid]);

  useEffect(() => {
    window.localStorage.setItem(LEFT_RAIL_WIDTH_STORAGE_KEY, String(leftRailWidth));
  }, [leftRailWidth]);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(LEFT_RAIL_COLLAPSED_STORAGE_KEY, String(isLeftRailCollapsed));
  }, [isLeftRailCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_COLLAPSED_STORAGE_KEY, String(isRightPanelCollapsed));
  }, [isRightPanelCollapsed]);

  useEffect(() => {
    void loadProjects();
  }, [showArchivedProjects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDocuments([]);
      setSelectedDocumentId("");
      setSelectedDocument(null);
      setProjectStats(null);
      setProjectGraph(null);
      setMcpDetail(null);
      return;
    }
    void loadProjectWorkspace(selectedProjectId);
  }, [selectedProjectId, showArchivedDocuments]);

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null);
      setChunks([]);
      setEvents([]);
      setEntities([]);
      return;
    }
    void loadDocumentWorkspace(selectedDocumentId);
  }, [selectedDocumentId]);

  useEffect(() => {
    const activeJobs = uploadJobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
    if (activeJobs.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void pollUploadJobs(activeJobs.map((job) => job.id));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [uploadJobs]);

  useEffect(() => {
    if (contextPanelMode !== "logs" && !hasActiveUploads && !isSearching && !isMcpRunning) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void syncModelLogs();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [contextPanelMode, hasActiveUploads, isSearching, isMcpRunning]);

  async function bootstrap() {
    try {
      setError("");
      const [projectsResponse, settingsResponse, mcpSettingsResponse] = await Promise.all([
        api.listProjects(showArchivedProjects),
        api.getAiSettings(),
        api.getMcpSettings()
      ]);
      setProjects(projectsResponse.projects);
      void refreshSessionsForProjects(projectsResponse.projects.map((project) => project.id));
      setAiSettings(settingsResponse.settings);
      setMcpSettings(mcpSettingsResponse.settings);
      const firstActiveProject = projectsResponse.projects.find((project) => !project.archivedAt);
      if (firstActiveProject) {
        setSelectedProjectId(firstActiveProject.id);
      } else {
        setStatus(t("请先创建项目", "Create a project first"));
      }
      await syncModelLogs();
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus(t("加载失败", "Failed to load"));
    }
  }

  async function loadProjects() {
    try {
      const response = await api.listProjects(showArchivedProjects);
      setProjects(response.projects);
      void refreshSessionsForProjects(response.projects.map((project) => project.id));
      if (selectedProjectId && !response.projects.some((project) => project.id === selectedProjectId)) {
        setSelectedProjectId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadProjectWorkspace(projectId: string) {
    try {
      setError("");
      const [documentsResponse, sessionsResponse, statsResponse, graphResponse] = await Promise.all([
        api.listDocuments(projectId, showArchivedDocuments),
        api.listMcpSessions(projectId),
        api.getProjectStats(projectId),
        api.getProjectGraph(projectId)
      ]);
      setDocuments(documentsResponse.documents);
      setSessionsByProjectId((current) => ({
        ...current,
        [projectId]: sessionsResponse.sessions
      }));
      setProjectStats(statsResponse.stats);
      setProjectGraph(graphResponse.graph);
      if (documentsResponse.documents[0] && !documentsResponse.documents.some((item) => item.id === selectedDocumentId)) {
        setSelectedDocumentId(documentsResponse.documents[0].id);
      }
      if (!documentsResponse.documents[0]) {
        setSelectedDocumentId("");
      }
      const preferredSessionId = pendingSessionIdRef.current;
      const sessionToOpen = preferredSessionId && sessionsResponse.sessions.some((session) => session.id === preferredSessionId)
        ? preferredSessionId
        : sessionsResponse.sessions[0]?.id;
      pendingSessionIdRef.current = null;
      if (sessionToOpen) {
        await loadMcpSession(sessionToOpen);
      } else {
        setMcpDetail(null);
      }
      setStatus(t("就绪", "Ready"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadDocumentWorkspace(documentId: string) {
    try {
      setError("");
      const [documentResponse, chunksResponse, eventsResponse, entitiesResponse] = await Promise.all([
        api.getDocument(documentId),
        api.listChunks(documentId),
        api.listEvents(documentId),
        api.listEntities(documentId)
      ]);
      setSelectedDocument(documentResponse.document);
      setChunks(chunksResponse.chunks);
      setEvents(eventsResponse.events);
      setEntities(entitiesResponse.entities);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function refreshKnowledgeWorkspace(documentId = selectedDocumentId) {
    const projectId = selectedProjectId;
    try {
      if (projectId) {
        const [statsResponse, graphResponse] = await Promise.all([
          api.getProjectStats(projectId),
          api.getProjectGraph(projectId)
        ]);
        setProjectStats(statsResponse.stats);
        setProjectGraph(graphResponse.graph);
      }
      if (documentId) {
        await loadDocumentWorkspace(documentId);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function pollUploadJobs(jobIds: string[]) {
    try {
      const responses = await Promise.all(jobIds.map((jobId) => api.getUploadJob(jobId)));
      const latestJobs = responses.map((response) => response.job);
      setUploadJobs((current) => current.map((job) => latestJobs.find((latest) => latest.id === job.id) ?? job));
      await syncModelLogs();
      const completedJobs = latestJobs.filter((job) => job.status === "COMPLETED" && job.documentId);
      for (const job of completedJobs) {
        if (refreshedUploadJobsRef.current.has(job.id)) {
          continue;
        }
        refreshedUploadJobsRef.current.add(job.id);
        if (selectedProjectId) {
          await loadProjectWorkspace(selectedProjectId);
        }
        if (job.documentId) {
          setSelectedDocumentId(job.documentId);
          setResultView("overview");
        }
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function syncModelLogs() {
    try {
      const response = await api.listModelCallLogs(modelLogCursorRef.current);
      if (response.latestSequence < modelLogCursorRef.current) {
        modelLogCursorRef.current = 0;
        setModelLogCursor(0);
        setModelLogs([]);
        if (response.latestSequence === 0) {
          return;
        }
        const freshResponse = await api.listModelCallLogs(0);
        if (freshResponse.logs.length > 0) {
          setModelLogs(freshResponse.logs.slice(-MAX_BROWSER_MODEL_LOGS));
        }
        modelLogCursorRef.current = freshResponse.latestSequence;
        setModelLogCursor(freshResponse.latestSequence);
        return;
      }
      if (response.logs.length > 0) {
        setModelLogs((current) => mergeModelLogs(current, response.logs));
      }
      if (response.latestSequence > modelLogCursorRef.current) {
        modelLogCursorRef.current = response.latestSequence;
        setModelLogCursor(response.latestSequence);
      }
    } catch (err) {
      console.warn("Failed to sync model logs", err);
    }
  }

  function setActivityPanelMode(mode: ContextPanelMode) {
    setContextPanelMode(mode);
    if (mode === "logs") {
      void syncModelLogs();
    }
  }

  function startLeftRailResize(event: ReactPointerEvent) {
    if (isLeftRailCollapsed) return;
    startPanelResize(event, {
      startWidth: leftRailWidth,
      minWidth: LEFT_RAIL_MIN_WIDTH,
      maxWidth: LEFT_RAIL_MAX_WIDTH,
      getWidth: (startWidth, deltaX) => startWidth + deltaX,
      onResize: setLeftRailWidth
    });
  }

  function startRightPanelResize(event: ReactPointerEvent) {
    if (isRightPanelCollapsed) return;
    startPanelResize(event, {
      startWidth: rightPanelWidth,
      minWidth: RIGHT_PANEL_MIN_WIDTH,
      maxWidth: RIGHT_PANEL_MAX_WIDTH,
      getWidth: (startWidth, deltaX) => startWidth - deltaX,
      onResize: setRightPanelWidth
    });
  }

  async function refreshSessionsForProjects(projectIds: string[]) {
    const uniqueProjectIds = [...new Set(projectIds.filter(Boolean))];
    if (uniqueProjectIds.length === 0) {
      setSessionsByProjectId({});
      return;
    }
    try {
      const entries = await Promise.all(uniqueProjectIds.map(async (projectId) => {
        const response = await api.listMcpSessions(projectId);
        return [projectId, response.sessions] as const;
      }));
      setSessionsByProjectId((current) => {
        const next = { ...current };
        for (const [projectId, projectSessions] of entries) {
          next[projectId] = projectSessions;
        }
        return next;
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function clearModelLogs() {
    try {
      const response = await api.listModelCallLogs(modelLogCursorRef.current);
      if (response.latestSequence !== modelLogCursorRef.current) {
        modelLogCursorRef.current = response.latestSequence;
        setModelLogCursor(response.latestSequence);
      }
    } catch (err) {
      console.warn("Failed to sync model log cursor before clearing", err);
    }
    setModelLogs([]);
    window.localStorage.removeItem(MODEL_LOGS_STORAGE_KEY);
    window.localStorage.setItem(MODEL_LOG_CURSOR_STORAGE_KEY, String(modelLogCursorRef.current));
    setStatus(t("已清空浏览器缓存中的原始日志", "Raw logs in browser cache have been cleared"));
  }

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) return false;
    try {
      setError("");
      const response = await api.createProject({ name });
      setNewProjectName("");
      await loadProjects();
      setSelectedProjectId(response.project.id);
      setWorkspaceView("chat");
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    }
  }

  async function renameProject(project: SourceRecord, name: string) {
    const nextName = name.trim();
    if (!nextName || nextName === project.name) return false;
    setError("");
    try {
      await api.updateProject(project.id, { name: nextName });
      await loadProjects();
      setStatus(t(`已重命名项目为「${nextName}」。`, `Project renamed to "${nextName}".`));
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    }
  }

  async function archiveOrRestoreProject(project: SourceRecord) {
    const confirmText = project.archivedAt
      ? t(`恢复项目「${project.name}」？`, `Restore project "${project.name}"?`)
      : t(`归档项目「${project.name}」？`, `Archive project "${project.name}"?`);
    if (!window.confirm(confirmText)) return;
    try {
      if (project.archivedAt) {
        await api.restoreProject(project.id);
      } else {
        await api.archiveProject(project.id);
      }
      await loadProjects();
      if (!project.archivedAt && selectedProjectId === project.id) {
        setSelectedProjectId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function permanentlyDeleteProject(project: SourceRecord) {
    const confirmed = window.confirm(t(
      `永久删除项目「${project.name}」？\n\n这会级联删除该项目下的文档、切片、事件、实体和相关关系，且不可恢复。`,
      `Permanently delete project "${project.name}"?\n\nThis will cascade delete documents, chunks, events, entities, and relations under this project. This action cannot be undone.`
    ));
    if (!confirmed) {
      setError("");
      setStatus(t("已取消永久删除项目。", "Permanent project deletion canceled."));
      return;
    }
    try {
      setError("");
      await api.deleteProject(project.id);
      await loadProjects();
      if (selectedProjectId === project.id) {
        setSelectedProjectId("");
      }
      setStatus(t(`已永久删除项目「${project.name}」。`, `Project "${project.name}" has been permanently deleted.`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function renameDocument(document: DocumentRecord) {
    const title = window.prompt(t("请输入新的文档名称", "Enter a new document name"), document.title)?.trim();
    if (!title || title === document.title) return;
    try {
      await api.updateDocument(document.id, { title });
      await loadProjectWorkspace(document.sourceId);
      if (selectedDocumentId === document.id) {
        await loadDocumentWorkspace(document.id);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function archiveOrRestoreDocument(document: DocumentRecord) {
    const confirmText = document.archivedAt
      ? t(`恢复文档「${document.title}」？`, `Restore document "${document.title}"?`)
      : t(`归档文档「${document.title}」？`, `Archive document "${document.title}"?`);
    if (!window.confirm(confirmText)) return;
    try {
      if (document.archivedAt) {
        await api.restoreDocument(document.id);
      } else {
        await api.archiveDocument(document.id);
      }
      await loadProjectWorkspace(document.sourceId);
      if (!document.archivedAt && selectedDocumentId === document.id) {
        setSelectedDocumentId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function permanentlyDeleteDocument(document: DocumentRecord) {
    const confirmed = window.confirm(t(
      `永久删除文档「${document.title}」？\n\n这会删除相关切片、事件、实体关系，且不可恢复。`,
      `Permanently delete document "${document.title}"?\n\nThis will delete related chunks, event relations, and entity relations. This action cannot be undone.`
    ));
    if (!confirmed) {
      setError("");
      setStatus(t("已取消永久删除文档。", "Permanent document deletion canceled."));
      return;
    }
    try {
      setError("");
      await api.deleteDocument(document.id);
      await loadProjectWorkspace(document.sourceId);
      if (selectedDocumentId === document.id) {
        setSelectedDocumentId("");
      }
      setStatus(t(`已永久删除文档「${document.title}」。`, `Document "${document.title}" has been permanently deleted.`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleUploadFiles(files: File[]) {
    if (!selectedProjectId) {
      setError(t("请先创建或选择项目，再添加文档。", "Create or select a project before adding documents."));
      return;
    }
    if (files.length === 0) {
      return;
    }
    const invalidFile = files.find((file) => {
      const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
      return ![".md", ".txt"].includes(extension) || file.size === 0 || file.size > 5 * 1024 * 1024;
    });
    if (invalidFile) {
      setError(t(
        `文件「${invalidFile.name}」不符合要求：只支持非空 .md/.txt，单个文件不超过 5MB。`,
        `File "${invalidFile.name}" is invalid: only non-empty .md/.txt files up to 5 MB are supported.`
      ));
      return;
    }
    try {
      setError("");
      setStatus(t(`已提交 ${files.length} 个文档处理任务`, `${files.length} document processing job(s) submitted`));
      for (const file of files) {
        setStatus(t(`正在读取：${file.name}`, `Reading: ${file.name}`));
        const content = await file.text();
        const response = await api.createUploadJob({
          sourceId: selectedProjectId,
          title: file.name.replace(/\.[^.]+$/, ""),
          fileName: file.name,
          content
        });
        refreshedUploadJobsRef.current.delete(response.job.id);
        setUploadJobs((current) => [response.job, ...current].slice(0, 20));
      }
      setStatus(t("文档正在处理中", "Documents are being processed"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleStructuredImport(input: {
    title?: string;
    fileName?: string;
    format: ManualImportFormat;
    content: string;
  }) {
    if (!selectedProjectId) {
      throw new Error(t("请先创建或选择项目。", "Create or select a project first."));
    }
    setError("");
    setStatus(t("正在导入网页版 AI 表格数据...", "Importing structured AI data..."));
    try {
      const response = await api.importStructuredKnowledge({
        sourceId: selectedProjectId,
        ...input
      });
      await loadProjectWorkspace(selectedProjectId);
      setSelectedDocumentId(response.documentId);
      setResultView("overview");
      setStatus(t(
        `导入完成：${response.documentCount ?? 1} 个文档，${response.chunkCount} 个切片，${response.eventCount} 个事件`,
        `Import complete: ${response.documentCount ?? 1} document(s), ${response.chunkCount} chunks and ${response.eventCount} events`
      ));
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      throw err;
    }
  }

  async function exportProject(format: "csv" | "json", split: ExportSplitMode = "none", maxBytes?: number) {
    if (!selectedProjectId) return;
    try {
      setError("");
      setStatus(t(`正在导出 ${format.toUpperCase()}...`, `Exporting ${format.toUpperCase()}...`));
      if (split === "none") {
        await api.downloadProjectExport(selectedProjectId, format);
        setStatus(t("项目数据已导出", "Project data exported"));
      } else {
        const result = await api.downloadProjectExportFiles(selectedProjectId, { format, split, maxBytes });
        setStatus(t(
          result.fileCount > 1 ? `项目数据已打包导出：${result.fileCount} 个数据文件` : "项目数据已导出",
          result.fileCount > 1 ? `Project data exported as one archive with ${result.fileCount} data files` : "Project data exported"
        ));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function resetProcess(title: string, detail?: string) {
    setContextPanelMode("process");
    setProcessSteps([{
      id: makeStepId("start"),
      title,
      detail,
      status: "running"
    }]);
  }

  function addProcessStep(step: Omit<ProcessStep, "id"> & { id?: string }) {
    setProcessSteps((current) => [...current, {
      id: step.id ?? makeStepId("step"),
      title: step.title,
      detail: step.detail,
      status: step.status,
      payload: step.payload,
      durationMs: step.durationMs
    }]);
  }

  function upsertProcessStep(step: ProcessStep) {
    setProcessSteps((current) => {
      const existingIndex = current.findIndex((item) => item.id === step.id);
      if (existingIndex === -1) {
        return [...current, step];
      }
      return current.map((item, index) => {
        if (index !== existingIndex) return item;
        return {
          ...item,
          title: step.title,
          detail: step.detail,
          status: step.status,
          payload: step.payload ?? item.payload,
          durationMs: step.durationMs ?? item.durationMs
        };
      });
    });
  }

  function finishRunningSteps() {
    setProcessSteps((current) => current.map((step) => (
      step.status === "running" ? { ...step, status: "done" } : step
    )));
  }

  function appendMessageToDetail(message: McpMessageRecord) {
    setMcpDetail((current) => {
      if (!current || current.session.id !== message.sessionId) return current;
      if (current.messages.some((item) => item.id === message.id)) return current;
      return {
        ...current,
        messages: [...current.messages, message]
      };
    });
  }

  function appendToolCallToDetail(toolCall: McpToolCallRecord) {
    setMcpDetail((current) => {
      if (!current || current.session.id !== toolCall.sessionId) return current;
      if (current.toolCalls.some((item) => item.id === toolCall.id)) return current;
      return {
        ...current,
        toolCalls: [...current.toolCalls, toolCall]
      };
    });
  }

  function handleMcpStreamEvent(event: McpStreamEvent) {
    if (event.type === "stage") {
      return;
    }
    if (event.type === "message") {
      appendMessageToDetail(event.message);
      if (event.message.role === "user") {
        setPendingUserMessage("");
      }
      if (event.message.role === "assistant") {
        setStreamingAssistantText("");
      }
      return;
    }
    if (event.type === "assistant_delta") {
      setContextPanelMode("process");
      setStreamingAssistantText((current) => current + event.delta);
      return;
    }
    if (event.type === "tool_start") {
      if (event.toolName === "sag_search") {
        setRunningMcpSearches((current) => [
          ...current,
          buildRunningMcpSearch(event.toolName, event.arguments, language)
        ]);
        resetProcess(t("MCP 搜索语句", "MCP search query"), getMcpSearchQuery(event.arguments, language));
        addProcessStep({
          id: "mcp-sag-search-running",
          title: t("SAG 检索执行中", "SAG retrieval is running"),
          detail: t(
            "MCP 工具已发起 sag_search，正在实时接收 SAG 内部检索阶段。",
            "The MCP tool has started sag_search and is receiving SAG internal retrieval stages in real time."
          ),
          status: "running",
          payload: event.arguments
        });
      }
      return;
    }
    if (event.type === "search_progress") {
      upsertProcessStep({
        id: `search-${event.event.key}`,
        title: event.event.title,
        detail: event.event.detail,
        status: event.event.status,
        payload: event.event.payload,
        durationMs: event.event.durationMs
      });
      return;
    }
    if (event.type === "tool_end") {
      appendToolCallToDetail(event.toolCall);
      if (event.toolCall.toolName === "sag_search") {
        if (event.toolCall.status === "FAILED") {
          setProcessSteps([{
            id: makeStepId("sag-search-failed"),
            title: t("SAG 检索失败", "SAG retrieval failed"),
            detail: event.toolCall.error ?? t("工具返回失败", "Tool returned a failure"),
            status: "failed"
          }]);
          return;
        }
        const parsed = parseToolResponse(event.toolCall.result);
        const trace = extractSearchTrace(parsed);
        const focus = buildGraphFocus(parsed, getRawMcpSearchQuery(event.toolCall.arguments));
        if (focus) {
          setGraphFocus(focus);
        }
        if (trace) {
          setProcessSteps([
            buildMcpSearchQueryStep(event.toolCall, language),
            ...buildTraceProcessSteps(trace, t("SAG 检索链路", "SAG retrieval trace"), language),
            ...buildMcpSearchResultSteps(parsed, language)
          ]);
        } else {
          setProcessSteps([
            buildMcpSearchQueryStep(event.toolCall, language),
            {
              id: makeStepId("sag-search-no-trace"),
              title: t("SAG 检索链路", "SAG retrieval trace"),
              detail: t("工具返回了检索结果，但没有返回 trace 字段。", "The tool returned retrieval results but did not include a trace field."),
              status: "failed",
              payload: parsed
            }
          ]);
        }
      }
      return;
    }
    if (event.type === "done") {
      if (event.detail) {
        setMcpDetail(event.detail);
      }
      finishRunningSteps();
      setContextPanelMode("assets");
      setStatus(t("对话完成", "Conversation complete"));
      return;
    }
    if (event.type === "error") {
      addProcessStep({
        title: t("执行失败", "Execution failed"),
        detail: event.message,
        status: "failed"
      });
      setError(event.message);
    }
  }

  function handleSearchStreamEvent(event: SearchStreamEvent) {
    if (event.type === "step") {
      upsertProcessStep({
        id: `search-${event.key}`,
        title: event.title,
        detail: event.detail,
        status: event.status,
        payload: event.payload,
        durationMs: event.durationMs
      });
      return;
    }
    if (event.type === "done") {
      setSearchResult(event.result);
      const focus = buildGraphFocus(event.result, searchQuery.trim());
      if (focus) {
        setGraphFocus(focus);
      }
      finishRunningSteps();
      addProcessStep({
        id: "search-complete",
        title: t("检索完成", "Search complete"),
        detail: t(`返回 ${event.result.sections.length} 个切片结果`, `${event.result.sections.length} chunk result(s) returned`),
        status: "done",
        payload: {
          traceId: event.result.traceId,
          sections: event.result.sections.map((section) => ({
            heading: section.heading,
            contentPreview: section.content.slice(0, 160),
            score: section.score,
            rank: section.rank
          }))
        },
        durationMs: searchStartedAtRef.current == null
          ? undefined
          : Math.round(performance.now() - searchStartedAtRef.current)
      });
      setStatus(t("检索完成", "Search complete"));
      return;
    }
    if (event.type === "error") {
      addProcessStep({
        title: t("检索失败", "Search failed"),
        detail: event.message,
        status: "failed"
      });
      setError(event.message);
    }
  }

  async function runSearch() {
    if (!selectedProjectId) {
      setError(t("请先选择项目。", "Select a project first."));
      return;
    }
    if (!searchQuery.trim()) {
      setError(t("请输入检索问题。", "Enter a search question."));
      return;
    }
    setIsSearching(true);
    setSearchResult(null);
    searchStartedAtRef.current = performance.now();
    resetProcess(t("开始检索", "Start search"), searchQuery.trim());
    try {
      setError("");
      await api.streamSearch({
        query: searchQuery.trim(),
        sourceIds: [selectedProjectId],
        searchMode
      }, handleSearchStreamEvent);
      await syncModelLogs();
    } catch (err) {
      await syncModelLogs();
      setError(getErrorMessage(err));
      addProcessStep({
        title: t("检索失败", "Search failed"),
        detail: getErrorMessage(err),
        status: "failed"
      });
    } finally {
      setIsSearching(false);
    }
  }

  async function createMcpSession() {
    if (!selectedProjectId) {
      setError(t("请先选择项目。", "Select a project first."));
      return;
    }
    const response = await api.createMcpSession({ sourceIds: [selectedProjectId] });
    const sessionsResponse = await api.listMcpSessions(selectedProjectId);
    setSessionsByProjectId((current) => ({
      ...current,
      [selectedProjectId]: sessionsResponse.sessions
    }));
    await loadMcpSession(response.session.id);
    setWorkspaceView("chat");
  }

  async function loadMcpSession(sessionId: string) {
    const detail = await api.getMcpSession(sessionId);
    setMcpDetail(detail);
    const latestSearch = [...detail.toolCalls]
      .reverse()
      .find((toolCall) => toolCall.toolName === "sag_search" && toolCall.status === "SUCCEEDED");
    if (latestSearch) {
      const focus = buildGraphFocus(
        parseToolResponse(latestSearch.result),
        getRawMcpSearchQuery(latestSearch.arguments)
      );
      if (focus) {
        setGraphFocus(focus);
      }
    }
  }

  async function clearCurrentMcpSession() {
    if (!mcpDetail) {
      setError(t("请先选择对话。", "Select a conversation first."));
      return;
    }
    if (!window.confirm(t(
      "清空当前对话记录？\n\n这会删除该会话里的消息和工具调用记录，但会保留会话本身。",
      "Clear the current conversation history?\n\nThis will delete messages and tool call records in this session, while keeping the session itself."
    ))) {
      return;
    }
    try {
      setError("");
      const detail = await api.clearMcpSession(mcpDetail.session.id);
      setMcpDetail(detail);
      setProcessSteps([]);
      setSearchResult(null);
      setStatus(t("对话记录已清空", "Conversation history cleared"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteCurrentMcpSession() {
    if (!mcpDetail) {
      setError(t("请先选择对话。", "Select a conversation first."));
      return;
    }
    if (!window.confirm(t(
      `删除对话「${mcpDetail.session.title}」？\n\n这会永久删除该会话、消息和工具调用记录，且不可恢复。`,
      `Delete conversation "${mcpDetail.session.title}"?\n\nThis will permanently delete the session, messages, and tool call records. This action cannot be undone.`
    ))) {
      return;
    }
    try {
      setError("");
      const deletedSessionId = mcpDetail.session.id;
      await api.deleteMcpSession(deletedSessionId);
      const sessionsResponse = await api.listMcpSessions(selectedProjectId || undefined);
      if (selectedProjectId) {
        setSessionsByProjectId((current) => ({
          ...current,
          [selectedProjectId]: sessionsResponse.sessions
        }));
      }
      const nextSession = sessionsResponse.sessions.find((session) => session.id !== deletedSessionId) ?? null;
      if (nextSession) {
        await loadMcpSession(nextSession.id);
      } else {
        setMcpDetail(null);
      }
      setProcessSteps([]);
      setSearchResult(null);
      setStatus(t("对话已删除", "Conversation deleted"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function sendMcpMessage(contentOverride?: string) {
    const content = (contentOverride ?? mcpInput).trim();
    if (!content || !selectedProjectId) return;
    let sessionId = mcpDetail?.session.id;
    const abortController = new AbortController();
    mcpAbortControllerRef.current = abortController;
    setIsMcpRunning(true);
    setPendingUserMessage(content);
    setStreamingAssistantText("");
    setRunningMcpSearches([]);
    setMcpInput("");
    setContextPanelMode("process");
    setProcessSteps([]);
    try {
      setError("");
      if (!sessionId) {
        const response = await api.createMcpSession({ sourceIds: [selectedProjectId] });
        sessionId = response.session.id;
        const sessionsResponse = await api.listMcpSessions(selectedProjectId);
        setSessionsByProjectId((current) => ({
          ...current,
          [selectedProjectId]: sessionsResponse.sessions
        }));
        await loadMcpSession(sessionId);
      }
      await api.streamMcpMessage(sessionId, content, handleMcpStreamEvent, {
        signal: abortController.signal,
        autoMermaid
      });
      await syncModelLogs();
      await refreshSessionsForProjects([selectedProjectId]);
    } catch (err) {
      await syncModelLogs();
      if (isAbortError(err)) {
        setStatus(t("已停止生成", "Generation stopped"));
        if (sessionId) {
          await loadMcpSession(sessionId);
          await refreshSessionsForProjects([selectedProjectId]);
        }
        addProcessStep({
          title: t("已停止", "Stopped"),
          detail: t("你手动停止了本轮 MCP 对话。", "You manually stopped this MCP conversation turn."),
          status: "done"
        });
        return;
      }
      setError(getErrorMessage(err));
      addProcessStep({
        title: t("对话失败", "Conversation failed"),
        detail: getErrorMessage(err),
        status: "failed"
      });
    } finally {
      if (mcpAbortControllerRef.current === abortController) {
        mcpAbortControllerRef.current = null;
      }
      setPendingUserMessage("");
      setStreamingAssistantText("");
      setIsMcpRunning(false);
    }
  }

  function stopMcpMessage() {
    if (!isMcpRunning) return;
    setStatus(t("正在停止生成...", "Stopping generation..."));
    mcpAbortControllerRef.current?.abort();
  }

  async function requestMermaidRedraw(input: { source: string; error?: string }) {
    if (isMcpRunning) return;
    const hasSyntaxError = Boolean(input.error?.trim());
    const prompt = hasSyntaxError
      ? [
        "上一条回答中的 Mermaid 产业链图渲染失败。请根据下面的错误信息和原 Mermaid 代码，重新生成一份语法正确、保守兼容的 Mermaid flowchart/graph 代码。",
        "",
        "要求：",
        "1. 不要使用 HTML、click、icon 或 Mermaid 不稳定语法。",
        "2. 节点和边标签里不要使用会破坏语法的方括号引用写法；如果需要引用，请放在普通回答文字里，不要放进 Mermaid 标签。",
        "3. 每条边单独一行，避免把 end 和下一条边写在同一行。",
        "4. 只输出修复后的简短说明和一个完整闭合的 ```mermaid 代码块。",
        "",
        "Mermaid 报错：",
        "```text",
        input.error?.trim() ?? "",
        "```",
        "",
        "原 Mermaid 代码：",
        "```mermaid",
        input.source,
        "```"
      ].join("\n")
      : [
        "上一条回答中的 Mermaid 产业链图已经可以渲染，但我对这张图的表达效果不够满意。请在保持原有主题和证据含义的基础上，重新生成一份更清晰、更专业、更适合展示产业链关系的 Mermaid flowchart/graph 图。",
        "",
        "优化方向：",
        "1. 结构层级更清楚，尽量体现上游、中游、下游、应用或企业关系。",
        "2. 节点命名简洁，边关系清楚，每条边单独一行。",
        "3. 不要使用 HTML、click、icon 或 Mermaid 不稳定语法。",
        "4. 节点和边标签里不要放方括号引用，引用说明可以放在普通文字里。",
        "5. 只输出简短说明和一个完整闭合的 ```mermaid 代码块。",
        "",
        "原 Mermaid 代码：",
        "```mermaid",
        input.source,
        "```"
      ].join("\n");
    setMcpInput(prompt);
    await sendMcpMessage(prompt);
  }

  async function openEventDetail(eventId: string) {
    try {
      setDrawer({ type: "event", detail: await api.getEvent(eventId) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function openEntityDetail(entityId: string) {
    try {
      setDrawer({ type: "entity", detail: await api.getEntity(entityId) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function updateChunkAsset(chunkId: string, input: { heading?: string | null; content?: string; rawContent?: string | null }) {
    try {
      setError("");
      await api.updateChunk(chunkId, input);
      await refreshKnowledgeWorkspace();
      setNotice(t("切片已保存", "Chunk saved"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteChunkAsset(chunkId: string) {
    try {
      setError("");
      await api.deleteChunk(chunkId);
      await refreshKnowledgeWorkspace();
      setNotice(t("切片已删除", "Chunk deleted"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function updateEventAsset(eventId: string, input: { title?: string; summary?: string; content?: string }) {
    try {
      setError("");
      const response = await api.updateEvent(eventId, input);
      setDrawer((current) => current?.type === "event" && current.detail.event.id === eventId
        ? { type: "event", detail: response.detail }
        : current);
      await refreshKnowledgeWorkspace();
      setNotice(t("事件已保存", "Event saved"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteEventAsset(eventId: string) {
    try {
      setError("");
      await api.deleteEvent(eventId);
      setDrawer((current) => current?.type === "event" && current.detail.event.id === eventId ? null : current);
      await refreshKnowledgeWorkspace();
      setNotice(t("事件已删除", "Event deleted"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function updateEntityAsset(entityId: string, input: { type?: string; name?: string; description?: string | null }) {
    try {
      setError("");
      const response = await api.updateEntity(entityId, input);
      setDrawer((current) => current?.type === "entity" && current.detail.entity.id === entityId
        ? { type: "entity", detail: response.detail }
        : current);
      await refreshKnowledgeWorkspace();
      setNotice(t("实体已保存", "Entity saved"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteEntityAsset(entityId: string) {
    try {
      setError("");
      await api.deleteEntity(entityId);
      setDrawer((current) => current?.type === "entity" && current.detail.entity.id === entityId ? null : current);
      await refreshKnowledgeWorkspace();
      setNotice(t("实体已删除", "Entity deleted"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function saveAiSettings(input: SettingsInput) {
    setIsSavingSettings(true);
    try {
      setError("");
      const response = await api.updateAiSettings(input);
      setAiSettings(response.settings);
      setNotice(t("设置已成功保存", "Settings saved successfully"));
      setWorkspaceView("chat");
      setStatus(t("设置已保存", "Settings saved"));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSavingSettings(false);
    }
  }

  function toggleSettings() {
    setWorkspaceView((current) => current === "settings" ? "chat" : "settings");
  }

  function toggleProjectExpanded(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  async function selectProjectSession(projectId: string, sessionId: string) {
    setWorkspaceView("chat");
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
    if (selectedProjectId !== projectId) {
      pendingSessionIdRef.current = sessionId;
      setSelectedProjectId(projectId);
      return;
    }
    pendingSessionIdRef.current = null;
    await loadMcpSession(sessionId);
  }

  const showActivityPanel = workspaceView === "chat";
  const leftRailEffectiveWidth = isLeftRailCollapsed ? LEFT_RAIL_COLLAPSED_WIDTH : leftRailWidth;
  const rightPanelEffectiveWidth = isRightPanelCollapsed ? RIGHT_PANEL_COLLAPSED_WIDTH : rightPanelWidth;

  return (
    <div className={cn(
      "chem-app-shell grid h-dvh min-h-0 overflow-hidden text-foreground"
    )} style={{ "--chem-left-rail-width": `${leftRailEffectiveWidth}px` } as CSSProperties}>
      <ProjectRail
        projects={projects}
        selectedProjectId={selectedProjectId}
        sessionsByProjectId={sessionsByProjectId}
        expandedProjectIds={expandedProjectIds}
        selectedSessionId={mcpDetail?.session.id ?? ""}
        isSessionBusy={isMcpRunning}
        isSettingsOpen={workspaceView === "settings"}
        isCollapsed={isLeftRailCollapsed}
        showArchived={showArchivedProjects}
        newProjectName={newProjectName}
        onNewProjectNameChange={setNewProjectName}
        onToggleCollapsed={() => setIsLeftRailCollapsed((current) => !current)}
        onResizeStart={startLeftRailResize}
        onCreateProject={createProject}
        onSelectProject={(projectId) => {
          setSelectedProjectId(projectId);
          if (workspaceView === "settings") {
            setWorkspaceView("chat");
          }
        }}
        onToggleProjectExpanded={toggleProjectExpanded}
        onRenameProject={renameProject}
        onArchiveOrRestoreProject={(project) => void archiveOrRestoreProject(project)}
        onDeleteProject={(project) => void permanentlyDeleteProject(project)}
        onToggleArchived={setShowArchivedProjects}
        onOpenSettings={toggleSettings}
        onCreateSession={() => void createMcpSession()}
        onSelectProjectSession={(projectId, sessionId) => void selectProjectSession(projectId, sessionId)}
      />

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="chem-topbar flex min-h-[72px] shrink-0 items-center gap-4 border-b border-border px-4 py-2 md:px-6">
          {workspaceView === "settings" ? null : (
            <>
              <div className="hidden min-w-0 flex-1 lg:block">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  {t("CHEMCLOUD KNOWLEDGE ENGINE", "CHEMCLOUD KNOWLEDGE ENGINE")}
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-semibold">
                  <Building2 className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate">{selectedProject?.name ?? t("请选择知识空间", "Select a knowledge space")}</span>
                </div>
              </div>
              <MainWorkspaceTabs
                view={workspaceView}
                onChange={(view) => setWorkspaceView(view)}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <div className="chem-system-status hidden xl:inline-flex">
                  <span className="chem-status-dot" />
                  <span>{t("产业链知识引擎在线", "Industry knowledge engine online")}</span>
                </div>
                <ThemeToggleButton />
              </div>
            </>
          )}
          {workspaceView === "settings" ? (
            <div className="flex w-full items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">CHEMCLOUD SYSTEM</div>
                <div className="mt-1 text-sm font-semibold">{t("系统与模型设置", "System and model settings")}</div>
              </div>
              <ThemeToggleButton />
            </div>
          ) : null}
        </header>

        {error ? (
          <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 md:px-6">
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label={t("关闭", "Dismiss")}
              className="shrink-0 rounded p-0.5 text-red-500/80 transition hover:bg-red-100 hover:text-red-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="flex items-start gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 md:px-6">
            <span className="min-w-0 flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice("")}
              aria-label={t("关闭", "Dismiss")}
              className="shrink-0 rounded p-0.5 text-emerald-500/80 transition hover:bg-emerald-100 hover:text-emerald-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        <div
          className="chem-content-grid min-h-0 flex-1"
          data-activity-panel={showActivityPanel ? "true" : "false"}
          style={{ "--chem-right-panel-width": `${rightPanelEffectiveWidth}px` } as CSSProperties}
        >
          <main className="chem-main-workspace flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border">
            {workspaceView === "settings" ? (
              <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <SettingsPanel
                  settings={aiSettings}
                  isSaving={isSavingSettings}
                  language={language}
                  languagePreference={languagePreference}
                  onLanguagePreferenceChange={setLanguagePreference}
                  onSave={(input) => void saveAiSettings(input)}
                  onClose={() => setWorkspaceView("chat")}
                />
              </section>
            ) : workspaceView === "documents" ? (
              <ProjectDocumentsWorkspace
                project={selectedProject}
                documents={visibleDocuments}
                selectedDocumentId={selectedDocumentId}
                selectedDocument={selectedDocument}
                chunks={chunks}
                events={events}
                entities={entities}
                projectStats={projectStats}
                resultView={resultView}
                showArchivedDocuments={showArchivedDocuments}
                hasActiveUploads={hasActiveUploads}
                uploadJobs={uploadJobs}
                isUploadQueueExpanded={isUploadQueueExpanded}
                searchQuery={searchQuery}
                searchMode={searchMode}
                searchResult={searchResult}
                isSearching={isSearching}
                fileInputRef={fileInputRef}
                onUploadFiles={(files) => void handleUploadFiles(files)}
                onImportStructured={handleStructuredImport}
                onExportProject={(format, split, maxBytes) => void exportProject(format, split, maxBytes)}
                onToggleUploadQueue={() => setIsUploadQueueExpanded((current) => !current)}
                onSelectDocument={setSelectedDocumentId}
                onRenameDocument={(document) => void renameDocument(document)}
                onArchiveOrRestoreDocument={(document) => void archiveOrRestoreDocument(document)}
                onDeleteDocument={(document) => void permanentlyDeleteDocument(document)}
                onSetResultView={setResultView}
                onToggleArchivedDocuments={setShowArchivedDocuments}
                onSearchQueryChange={setSearchQuery}
                onSearchModeChange={setSearchMode}
                onSearch={() => void runSearch()}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
                onUpdateChunk={(chunkId, input) => void updateChunkAsset(chunkId, input)}
                onDeleteChunk={(chunkId) => void deleteChunkAsset(chunkId)}
                onUpdateEvent={(eventId, input) => void updateEventAsset(eventId, input)}
                onDeleteEvent={(eventId) => void deleteEventAsset(eventId)}
                onUpdateEntity={(entityId, input) => void updateEntityAsset(entityId, input)}
                onDeleteEntity={(entityId) => void deleteEntityAsset(entityId)}
              />
            ) : workspaceView === "graph" ? (
              <ProjectGraphWorkspace
                project={selectedProject}
                graph={projectGraph}
                focus={graphFocus}
                defaultLayoutStyle={aiSettings?.graphDefaultLayoutStyle}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
              />
            ) : workspaceView === "mcp" ? (
              <ProjectMcpWorkspace
                project={selectedProject}
                settings={mcpSettings}
              />
            ) : (
              <ConversationWorkspace
                project={selectedProject}
                graph={projectGraph}
                welcomePromptTemplates={aiSettings?.welcomePromptTemplates}
                detail={mcpDetail}
                input={mcpInput}
                isRunning={isMcpRunning}
                pendingUserMessage={pendingUserMessage}
                streamingAssistantText={streamingAssistantText}
                runningMcpSearches={runningMcpSearches}
                autoMermaid={autoMermaid}
                mermaidPendingText={aiSettings?.mermaidPendingText}
                onRequestMermaidRedraw={(input) => void requestMermaidRedraw(input)}
                onInputChange={setMcpInput}
                onAutoMermaidChange={setAutoMermaid}
                onCreateSession={() => void createMcpSession()}
                onClearSession={() => void clearCurrentMcpSession()}
                onDeleteSession={() => void deleteCurrentMcpSession()}
                onOpenCitation={(citation) => setDrawer({ type: "citation", citation })}
                onStop={() => stopMcpMessage()}
                onSend={() => void sendMcpMessage()}
                onSendPrompt={(text) => {
                  setMcpInput(text);
                  void sendMcpMessage(text);
                }}
              />
            )}
          </main>

          {showActivityPanel ? (
            <ActivityPanel
              className="hidden lg:flex"
              mode={contextPanelMode}
              detail={mcpDetail}
              processSteps={processSteps}
              modelLogs={modelLogs}
              isCollapsed={isRightPanelCollapsed}
              onSetMode={setActivityPanelMode}
              onToggleCollapsed={() => setIsRightPanelCollapsed((current) => !current)}
              onResizeStart={startRightPanelResize}
              onRefreshModelLogs={() => void syncModelLogs()}
              onClearModelLogs={() => void clearModelLogs()}
            />
          ) : null}
        </div>
      </div>

      {drawer ? (
        <DetailDrawer
          drawer={drawer}
          onClose={() => setDrawer(null)}
          onOpenEvent={(eventId) => void openEventDetail(eventId)}
          onOpenEntity={(entityId) => void openEntityDetail(entityId)}
        />
      ) : null}
    </div>
  );
}

function ProjectRail(props: {
  projects: SourceRecord[];
  selectedProjectId: string;
  sessionsByProjectId: Record<string, McpSessionRecord[]>;
  expandedProjectIds: Set<string>;
  selectedSessionId: string;
  isSessionBusy: boolean;
  isSettingsOpen: boolean;
  isCollapsed: boolean;
  showArchived: boolean;
  newProjectName: string;
  onNewProjectNameChange: (value: string) => void;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent) => void;
  onCreateProject: () => Promise<boolean>;
  onSelectProject: (projectId: string) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onRenameProject: (project: SourceRecord, name: string) => Promise<boolean>;
  onArchiveOrRestoreProject: (project: SourceRecord) => void;
  onDeleteProject: (project: SourceRecord) => void;
  onToggleArchived: (value: boolean) => void;
  onOpenSettings: () => void;
  onCreateSession: () => void;
  onSelectProjectSession: (projectId: string, sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<SourceRecord | null>(null);
  const [renameProjectName, setRenameProjectName] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const canCreateProject = props.newProjectName.trim().length > 0 && !isCreatingProject;
  const canRenameProject = Boolean(renameProjectTarget)
    && renameProjectName.trim().length > 0
    && renameProjectName.trim() !== renameProjectTarget?.name
    && !isRenamingProject;

  function openCreateProjectDialog() {
    props.onNewProjectNameChange("");
    setCreateProjectDialogOpen(true);
  }

  function closeCreateProjectDialog() {
    if (isCreatingProject) return;
    props.onNewProjectNameChange("");
    setCreateProjectDialogOpen(false);
  }

  function openRenameProjectDialog(project: SourceRecord) {
    setCreateProjectDialogOpen(false);
    setRenameProjectTarget(project);
    setRenameProjectName(project.name);
  }

  function closeRenameProjectDialog() {
    if (isRenamingProject) return;
    setRenameProjectTarget(null);
    setRenameProjectName("");
  }

  async function submitCreateProject() {
    if (!canCreateProject) return;
    setIsCreatingProject(true);
    try {
      const created = await props.onCreateProject();
      if (created) {
        setCreateProjectDialogOpen(false);
      }
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function submitRenameProject() {
    if (!renameProjectTarget || !canRenameProject) return;
    setIsRenamingProject(true);
    try {
      const renamed = await props.onRenameProject(renameProjectTarget, renameProjectName);
      if (renamed) {
        setRenameProjectTarget(null);
        setRenameProjectName("");
      }
    } finally {
      setIsRenamingProject(false);
    }
  }

  return (
    <>
      <aside className={cn("chem-sidebar relative z-10 flex min-h-0 flex-col overflow-hidden border-r border-border", props.isCollapsed && "chem-sidebar-collapsed")}>
        {props.isCollapsed ? (
          <div className="chem-sidebar-compact-content flex min-h-0 flex-1 flex-col items-center gap-2 px-2 py-4">
            <ChemCloudMark className="h-10 w-10 shrink-0" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              title={t("展开左侧栏", "Expand sidebar")}
              aria-label={t("展开左侧栏", "Expand sidebar")}
              onClick={props.onToggleCollapsed}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant={props.isSettingsOpen ? "secondary" : "ghost"}
              size="icon"
              className="h-9 w-9"
              title={t("全局设置", "Global settings")}
              aria-label={t("全局设置", "Global settings")}
              onClick={props.onOpenSettings}
            >
              <Settings className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              title={t("新建项目", "New project")}
              aria-label={t("新建项目", "New project")}
              onClick={openCreateProjectDialog}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <div className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto scrollbar-thin">
              {props.projects.map((project) => {
                const selected = project.id === props.selectedProjectId;
                const expanded = props.expandedProjectIds.has(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground",
                      selected && "bg-background text-primary shadow-sm"
                    )}
                    title={project.name}
                    aria-label={project.name}
                    onClick={() => props.onSelectProject(project.id)}
                  >
                    {expanded || selected ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="chem-sidebar-full-content flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border px-4 py-5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <ChemCloudMark className="h-10 w-10" />
              <div className="min-w-0">
                <div className="whitespace-nowrap text-base font-bold tracking-tight">ChemClaw</div>
                <div className="truncate text-[11px] text-muted-foreground">{t("芯化和云 · 化工产业链智能体", "ChemCloud · Chemical industry agent")}</div>
              </div>
            </div>
            <Button
              variant={props.isSettingsOpen ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 shrink-0"
              title={t("全局设置", "Global settings")}
              aria-label={t("全局设置", "Global settings")}
              onClick={props.onOpenSettings}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{t("知识空间", "Knowledge spaces")}</div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={props.showArchived} onChange={(event) => props.onToggleArchived(event.target.checked)} />
            {t("归档", "Archived")}
          </label>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 scrollbar-thin">
          <button
            type="button"
            className="chem-new-space mb-3 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm font-medium text-muted-foreground"
            onClick={openCreateProjectDialog}
          >
            <Plus className="h-4 w-4 shrink-0" />
            {t("新建项目", "New project")}
          </button>
          {props.projects.length === 0 ? (
            <EmptyLine text={t("暂无项目，请先新建项目。", "No projects yet. Create a project first.")} />
          ) : props.projects.map((project) => {
          const selected = project.id === props.selectedProjectId;
          const menuOpen = openProjectMenuId === project.id;
          const expanded = props.expandedProjectIds.has(project.id);
          const projectSessions = props.sessionsByProjectId[project.id] ?? [];
          const closeMenu = () => setOpenProjectMenuId(null);
          return (
            <div key={project.id} className={cn("group relative rounded-xl", selected && "chem-project-active")}>
              <div className="flex items-start gap-1">
                <button
                  type="button"
                  className="ml-1 mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                  title={expanded ? t("收起项目对话", "Collapse project conversations") : t("展开项目对话", "Expand project conversations")}
                  aria-label={expanded
                    ? t(`收起项目对话：${project.name}`, `Collapse project conversations: ${project.name}`)
                    : t(`展开项目对话：${project.name}`, `Expand project conversations: ${project.name}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeMenu();
                    props.onToggleProjectExpanded(project.id);
                  }}
                >
                  <ChevronRight className={cn("h-4 w-4 transition-transform", expanded && "rotate-90")} />
                </button>
                <button
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-lg py-2 pr-1 text-left text-sm hover:bg-accent/70"
                  onClick={() => {
                    closeMenu();
                    props.onSelectProject(project.id);
                  }}
                >
                  {expanded || selected ? (
                    <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.archivedAt ? t("已归档", "Archived") : shortId(project.id)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "mr-2 mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus:bg-background focus:text-foreground",
                    menuOpen || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  title={t("项目操作", "Project actions")}
                  aria-label={t(`项目操作：${project.name}`, `Project actions: ${project.name}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenProjectMenuId((current) => current === project.id ? null : project.id);
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
              {menuOpen ? (
                <div
                  className="absolute right-2 top-9 z-50 w-28 rounded-md border border-border bg-background p-1 shadow-sm"
                  role="menu"
                >
                  <ProjectMenuItem
                    onClick={() => {
                      closeMenu();
                      openRenameProjectDialog(project);
                    }}
                  >
                    {t("重命名", "Rename")}
                  </ProjectMenuItem>
                  <ProjectMenuItem
                    onClick={() => {
                      closeMenu();
                      props.onArchiveOrRestoreProject(project);
                    }}
                  >
                    {project.archivedAt ? t("恢复", "Restore") : t("归档", "Archive")}
                  </ProjectMenuItem>
                  <ProjectMenuItem
                    danger
                    onClick={() => {
                      closeMenu();
                      props.onDeleteProject(project);
                    }}
                  >
                    {t("永久删除", "Delete forever")}
                  </ProjectMenuItem>
                </div>
              ) : null}
              {expanded && !props.isSettingsOpen ? (
                <div className="space-y-1 pb-2 pl-9 pr-2">
                  {selected ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={props.onCreateSession}
                      disabled={props.isSessionBusy}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                      {t("新建对话", "New chat")}
                    </button>
                  ) : null}
                  {projectSessions.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("暂无对话", "No chats")}</div>
                  ) : projectSessions.map((session) => {
                    const sessionSelected = session.id === props.selectedSessionId;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                          sessionSelected && "bg-background text-foreground shadow-sm"
                        )}
                        onClick={() => props.onSelectProjectSession(project.id, session.id)}
                        disabled={props.isSessionBusy}
                        title={session.title}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{session.title}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
          })} 
        </div>
        <div className="m-3 mt-0 rounded-xl border border-primary/15 bg-primary/[0.06] p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <CircleCheck className="h-4 w-4 text-primary" />
            {t("ChemClaw 集成就绪", "ChemClaw integration ready")}
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
            {t("知识问答、超图检索与 MCP 能力可嵌入公司统一智能入口。", "Q&A, hypergraph retrieval, and MCP are ready for the unified intelligence portal.")}
          </p>
        </div>
        </div>
        {!props.isCollapsed ? (
          <>
            <button
              type="button"
              className="chem-sidebar-collapse-button"
              title={t("收起左侧栏", "Collapse sidebar")}
              aria-label={t("收起左侧栏", "Collapse sidebar")}
              onClick={props.onToggleCollapsed}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div
              className="chem-sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              title={t("拖拽调整左侧栏宽度", "Drag to resize sidebar")}
              onPointerDown={props.onResizeStart}
            />
          </>
        ) : null}
      </aside>

      {createProjectDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <div id="create-project-title" className="text-sm font-semibold">{t("新建项目", "New project")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("输入项目名称后创建，文档和对话都会归属到这个项目。", "Enter a project name. Documents and chats will belong to this project.")}</p>
            <Input
              autoFocus
              className="mt-4"
              value={props.newProjectName}
              onChange={(event) => props.onNewProjectNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeCreateProjectDialog();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitCreateProject();
                }
              }}
              placeholder={t("项目名称", "Project name")}
              disabled={isCreatingProject}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeCreateProjectDialog} disabled={isCreatingProject}>
                {t("取消", "Cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitCreateProject()} disabled={!canCreateProject}>
                {isCreatingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("确定", "Confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {renameProjectTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
            <div id="rename-project-title" className="text-sm font-semibold">{t("重命名项目", "Rename project")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("输入新的项目名称。", "Enter a new project name.")}</p>
            <Input
              autoFocus
              className="mt-4"
              value={renameProjectName}
              onChange={(event) => setRenameProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeRenameProjectDialog();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRenameProject();
                }
              }}
              placeholder={t("项目名称", "Project name")}
              disabled={isRenamingProject}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeRenameProjectDialog} disabled={isRenamingProject}>
                {t("取消", "Cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitRenameProject()} disabled={!canRenameProject}>
                {isRenamingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("确定", "Confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ProjectMenuItem({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "block w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
        danger && "text-red-600 hover:text-red-700"
      )}
      role="menuitem"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MainWorkspaceTabs(props: {
  view: WorkspaceView;
  onChange: (view: Exclude<WorkspaceView, "settings">) => void;
}) {
  const { t } = useI18n();
  const tabs: Array<{ value: Exclude<WorkspaceView, "settings">; label: string; icon: typeof Sparkles }> = [
    { value: "chat", label: t("智能问答", "Q&A"), icon: Sparkles },
    { value: "documents", label: t("知识资产", "Assets"), icon: Database },
    { value: "graph", label: t("知识超图", "Hypergraph"), icon: Network },
    { value: "mcp", label: t("ChemClaw 接入", "ChemClaw"), icon: Plug }
  ];
  return (
    <div className="chem-workspace-tabs grid w-full min-w-0 max-w-[560px] grid-cols-4 rounded-xl border border-border p-1 sm:w-auto sm:min-w-[440px]">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
        <button
          key={tab.value}
          type="button"
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
            props.view === tab.value && "chem-tab-active text-foreground"
          )}
          onClick={() => props.onChange(tab.value)}
        >
          <Icon className="hidden h-3.5 w-3.5 sm:block" />
          {tab.label}
        </button>
      )})}
    </div>
  );
}

function ChemCloudMark({ className }: { className?: string }) {
  return (
    <div className={cn("chemcloud-mark shrink-0", className)} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path d="M10.5 14.5 20 9l9.5 5.5v11L20 31l-9.5-5.5v-11Z" stroke="currentColor" strokeWidth="2.2" />
        <path d="m11 15 9 5 9-5M20 20v10" stroke="currentColor" strokeWidth="1.8" opacity=".88" />
        <circle cx="20" cy="9" r="2.5" fill="currentColor" />
        <circle cx="10.5" cy="25.5" r="2.5" fill="currentColor" />
        <circle cx="29.5" cy="25.5" r="2.5" fill="currentColor" />
      </svg>
    </div>
  );
}

function ConversationWelcome(props: {
  projectName: string;
  graph: ProjectGraphRecord | null;
  promptTemplates?: string[];
  onSelectPrompt: (value: string) => void;
}) {
  const { t } = useI18n();
  const prompts = useMemo(
    () => buildWelcomePrompts({
      projectName: props.projectName,
      graph: props.graph,
      promptTemplates: props.promptTemplates,
      t
    }),
    [props.graph, props.projectName, props.promptTemplates, t]
  );
  return (
    <div className="chem-welcome mx-auto my-auto w-full max-w-3xl rounded-[28px] border border-border p-6 md:p-8">
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          <ChemCloudMark className="h-16 w-16" />
          <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full border-2 border-white bg-[#1b6fcc] text-white">
            <Bot className="h-3.5 w-3.5" />
          </span>
        </div>
        <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/[0.06] px-3 py-1 text-[11px] font-semibold text-primary">
          <Layers3 className="h-3.5 w-3.5" />
          {props.projectName}
        </div>
        <h2 className="mt-4 text-2xl font-bold tracking-tight text-foreground md:text-3xl">
          {t("化工产业链知识超图问答", "Chemical Industry Knowledge Hypergraph Q&A")}
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t(
            "融合项目文档、产业事件、企业实体与上下游关系，为研发、市场、采购和战略分析提供可追溯的知识答案。",
            "Combining project documents, industry events, company entities, and value-chain relationships to provide traceable answers for R&D, market, sourcing, and strategy."
          )}
        </p>
      </div>
      <div className="mt-7 grid gap-2 md:grid-cols-2">
        {prompts.map((prompt, index) => (
          <button
            key={prompt}
            type="button"
            className="chem-prompt-card group flex items-start gap-3 rounded-xl border border-border p-3 text-left text-sm leading-5"
            onClick={() => props.onSelectPrompt(prompt)}
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/[0.08] text-xs font-bold text-primary">
              {index + 1}
            </span>
            <span>{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildWelcomePrompts(input: {
  projectName: string;
  graph: ProjectGraphRecord | null;
  promptTemplates?: string[];
  t: (zh: string, en: string) => string;
}) {
  const topEntities = [...(input.graph?.entities ?? [])]
    .sort((left, right) => (right.eventCount ?? 0) - (left.eventCount ?? 0) || left.name.localeCompare(right.name))
    .slice(0, 6);
  const productLike = topEntities.find((entity) => /product|产品|化学品|品类/i.test(entity.type)) ?? topEntities[0];
  const secondEntity = topEntities.find((entity) => entity.id !== productLike?.id) ?? topEntities[1] ?? productLike;
  const focus = productLike?.name || input.projectName || input.t("当前数据库", "the current database");
  const secondary = secondEntity?.name || input.t("相关实体", "related entities");
  const defaultPrompts = [
    input.t(
      `请用表格整理「${focus}」相关的产业链关系：上游原料、工艺/事件、相关企业、下游应用和证据来源。`,
      `Build a table for "${focus}" covering upstream feedstocks, processes/events, related companies, downstream applications, and evidence.`
    ),
    input.t(
      `基于当前项目内容，为「${focus}」生成一份 Markdown 大纲式思维导图，按原料、工艺、中间体、产品、下游应用、终端行业分层展开。`,
      `Generate a Markdown outline mind map for "${focus}", organized by feedstocks, processes, intermediates, products, downstream applications, and end-use industries.`
    ),
    input.t(
      `写一份研究报告风格的「${input.projectName}」产业链分析，包含核心关系、关键企业、机会、风险和证据缺口。`,
      `Write a research-report style industry-chain analysis for "${input.projectName}", covering key relationships, companies, opportunities, risks, and evidence gaps.`
    ),
    input.t(
      `用通俗易懂的方式解释「${focus}」和「${secondary}」的关系。多用短句，少用长句，语气轻松一点，可以适当吐槽，不要说无关话。`,
      `Explain the relationship between "${focus}" and "${secondary}" in plain language. Use short sentences, keep it relaxed, add mild critique when useful, and answer directly.`
    )
  ];
  return (input.promptTemplates && input.promptTemplates.length > 0 ? input.promptTemplates : defaultPrompts)
    .map((prompt) => applyPromptTemplate(prompt, {
      projectName: input.projectName,
      focus,
      secondary
    }))
    .slice(0, 8);
}

function applyPromptTemplate(template: string, values: { projectName: string; focus: string; secondary: string }) {
  return template
    .replaceAll("{projectName}", values.projectName)
    .replaceAll("{focus}", values.focus)
    .replaceAll("{secondary}", values.secondary);
}

function buildFollowUpQuestions(input: {
  question: string;
  answer: string;
  graph: ProjectGraphRecord | null;
  t: (zh: string, en: string) => string;
}): string[] {
  const { t } = input;
  const haystack = `${input.question}\n${input.answer}`.toLocaleLowerCase();
  const scored = (input.graph?.entities ?? [])
    .map((entity) => entity.name?.trim() ?? "")
    .filter((name) => name.length >= 2)
    .map((name) => ({ name, mentioned: haystack.includes(name.toLocaleLowerCase()) }))
    .filter((item) => item.mentioned);
  // 去重并保留出现顺序
  const seen = new Set<string>();
  const mentioned: string[] = [];
  for (const item of scored) {
    const key = item.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mentioned.push(item.name);
  }

  const questions: string[] = [];
  if (mentioned[0]) {
    questions.push(t(
      `${mentioned[0]} 的上游原料与下游应用分别有哪些？`,
      `What are the upstream feedstocks and downstream applications of ${mentioned[0]}?`
    ));
  }
  if (mentioned[1]) {
    questions.push(t(
      `${mentioned[1]} 近期有哪些重要进展或产能变化？`,
      `What recent developments or capacity changes are there for ${mentioned[1]}?`
    ));
  }
  if (mentioned[0] && mentioned[1]) {
    questions.push(t(
      `${mentioned[0]} 与 ${mentioned[1]} 在产业链上是什么关系？`,
      `How are ${mentioned[0]} and ${mentioned[1]} related in the industry chain?`
    ));
  }

  const fallbacks = [
    t("这个结论背后的关键风险与不确定性是什么？", "What are the key risks and uncertainties behind this conclusion?"),
    t("能否补充相关的时间线或最新市场进展？", "Can you add a related timeline or the latest market developments?"),
    t("还有哪些关键企业、产能或政策值得关注？", "Which other key companies, capacities, or policies are worth watching?")
  ];
  for (const fallback of fallbacks) {
    if (questions.length >= 3) break;
    if (!questions.includes(fallback)) questions.push(fallback);
  }
  return questions.slice(0, 3);
}

function ConversationWorkspace(props: {
  project: SourceRecord | null;
  graph: ProjectGraphRecord | null;
  welcomePromptTemplates?: string[];
  detail: McpSessionDetail | null;
  input: string;
  isRunning: boolean;
  pendingUserMessage: string;
  streamingAssistantText: string;
  runningMcpSearches: RunningMcpSearch[];
  autoMermaid: boolean;
  mermaidPendingText?: string;
  onInputChange: (value: string) => void;
  onAutoMermaidChange: (value: boolean) => void;
  onCreateSession: () => void;
  onClearSession: () => void;
  onDeleteSession: () => void;
  onOpenCitation: (citation: AnswerCitation) => void;
  onRequestMermaidRedraw: (input: { source: string; error?: string }) => void;
  onStop: () => void;
  onSend: () => void;
  onSendPrompt: (text: string) => void;
}) {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (props.pendingUserMessage) {
      shouldAutoScrollRef.current = true;
    }
    if (shouldAutoScrollRef.current) {
      scrollAnchorRef.current?.scrollIntoView({ block: "end" });
    }
  }, [props.detail?.messages.length, props.pendingUserMessage, props.streamingAssistantText, props.isRunning, props.runningMcpSearches.length]);

  function handleConversationScroll() {
    const element = scrollContainerRef.current;
    if (!element) return;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldAutoScrollRef.current = distanceToBottom < 96;
  }

  // 回答结束后，结合「用户上一问 + 本次回答 + 项目知识超图」推荐三个后续问题（#3）。
  const followUpQuestions = useMemo(() => {
    const messages = props.detail?.messages ?? [];
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return [] as string[];
    if (props.isRunning || props.streamingAssistantText || props.pendingUserMessage) return [] as string[];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    return buildFollowUpQuestions({
      question: lastUser?.content ?? "",
      answer: last.content,
      graph: props.graph,
      t
    });
  }, [props.detail?.messages, props.isRunning, props.streamingAssistantText, props.pendingUserMessage, props.graph, t]);

  if (!props.project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先创建项目", "Create a project first")} description={t("项目是文档、切片、事件、实体和 MCP 对话的共同归属。", "A project contains documents, chunks, events, entities, and MCP chats.")} />
      </section>
    );
  }

  return (
    <section className="chem-conversation flex min-h-0 flex-1 flex-col">
      <div className="chem-section-header flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:flex-nowrap md:items-center md:px-6">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
            <Sparkles className="h-3 w-3" />
            {t("化工产业链智能问答", "CHEMICAL INDUSTRY Q&A")}
          </div>
          <h1 className="truncate text-base font-semibold" title={props.detail?.session.title ?? t("新建产业链问答", "New industry-chain inquiry")}>{props.detail?.session.title ?? t("新建产业链问答", "New industry-chain inquiry")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {props.detail ? `${formatModelName(props.detail.session.model, t)} · ${shortId(props.detail.session.id)}` : t("新建会话后开始测试 MCP 工具", "Create a chat to test MCP tools")}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onCreateSession} disabled={props.isRunning}>
            <Plus className="h-4 w-4" />
            {t("新对话", "New chat")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onClearSession} disabled={!props.detail || props.isRunning}>
            <RotateCcw className="h-4 w-4" />
            {t("清空记录", "Clear history")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onDeleteSession} disabled={!props.detail || props.isRunning}>
            <Trash2 className="h-4 w-4" />
            {t("删除对话", "Delete chat")}
          </Button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="chem-conversation-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6"
        onScroll={handleConversationScroll}
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {!props.detail || props.detail.messages.length === 0 ? (
            <ConversationWelcome
              projectName={props.project.name}
              graph={props.graph}
              promptTemplates={props.welcomePromptTemplates}
              onSelectPrompt={props.onInputChange}
            />
          ) : props.detail.messages.map((message) => {
            const citations = getMessageCitations(message);
            return (
              <div key={message.id} className={cn("flex items-start gap-2.5", message.role === "user" ? "justify-end" : "justify-start")}>
                {message.role === "user" ? null : <ChemCloudMark className="mt-0.5 h-8 w-8" />}
                <div className={cn(
                  "chem-message max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6",
                  message.role === "user" ? "chem-message-user bg-primary text-primary-foreground" : "chem-message-assistant border border-border"
                )}>
                  <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                    {formatMessageRole(message.role, t)}
                    <span>{formatDate(message.createdAt)}</span>
                  </div>
                  <MarkdownMessage
                    content={formatMessageContent(message.content, t)}
                    citations={citations}
                    mermaidPendingText={props.mermaidPendingText}
                    onOpenCitation={props.onOpenCitation}
                    onRequestMermaidRedraw={message.role === "assistant" ? props.onRequestMermaidRedraw : undefined}
                  />
                  {message.role === "assistant" && citations.length > 0 ? (
                    <CitationStrip citations={citations} onOpenCitation={props.onOpenCitation} />
                  ) : null}
                </div>
              </div>
            );
          })}

          {props.pendingUserMessage ? (
            <div className="flex justify-end">
              <div className="chem-message chem-message-user max-w-[86%] rounded-2xl bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground">
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">{t("用户", "User")}</div>
                <MarkdownMessage content={props.pendingUserMessage} mermaidPendingText={props.mermaidPendingText} />
              </div>
            </div>
          ) : null}

          {props.isRunning && !props.streamingAssistantText ? (
            <div className="flex justify-start">
              <RunningMcpSearchPanel searches={props.runningMcpSearches} />
            </div>
          ) : null}

          {props.streamingAssistantText ? (
            <div className="flex items-start gap-2.5 justify-start">
              <ChemCloudMark className="mt-0.5 h-8 w-8" />
              <div className="chem-message chem-message-assistant max-w-[86%] rounded-2xl border border-border px-4 py-3 text-sm leading-6">
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">{t("助手", "Assistant")}</div>
                <MarkdownMessage
                  content={formatMessageContent(props.streamingAssistantText, t)}
                  mermaidPendingText={props.mermaidPendingText}
                  isStreaming
                  onRequestMermaidRedraw={props.onRequestMermaidRedraw}
                />
              </div>
            </div>
          ) : null}

          {followUpQuestions.length > 0 ? (
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 h-8 w-8 shrink-0" />
              <div className="flex max-w-[86%] flex-col gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles className="h-3 w-3" />
                  {t("猜你想继续问", "You might also want to ask")}
                </div>
                <div className="flex flex-col gap-2">
                  {followUpQuestions.map((question, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => props.onSendPrompt(question)}
                      className="group flex items-center gap-2 rounded-xl border border-border bg-background/80 px-3 py-2 text-left text-xs text-foreground transition hover:border-primary/50 hover:bg-primary/[0.06]"
                    >
                      <Send className="h-3 w-3 shrink-0 text-muted-foreground transition group-hover:text-primary" />
                      <span className="min-w-0">{question}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <div ref={scrollAnchorRef} />
        </div>
      </div>

      <div className="chem-composer-wrap shrink-0 border-t border-border px-4 py-3 md:px-6">
        <div className="chem-composer mx-auto flex max-w-4xl gap-2 rounded-2xl border border-border p-2">
          <Textarea
            className="h-12 min-h-12 flex-1 border-0 bg-transparent px-3 focus-visible:ring-0"
            value={props.input}
            onChange={(event) => props.onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!props.isRunning && props.input.trim()) {
                  props.onSend();
                }
              }
            }}
            placeholder={t("询问产品、原料、工艺、企业、产能或产业链关系…", "Ask about products, feedstocks, processes, companies, capacity, or industry-chain relations…")}
          />
          <Button
            className="h-11 self-end rounded-xl px-4"
            variant={props.isRunning ? "destructive" : "default"}
            onClick={props.isRunning ? props.onStop : props.onSend}
            disabled={!props.isRunning && !props.input.trim()}
          >
            {props.isRunning ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {props.isRunning ? t("停止", "Stop") : t("发送", "Send")}
          </Button>
        </div>
        <label className="mx-auto mt-2 flex max-w-4xl cursor-pointer items-center justify-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={props.autoMermaid}
            onChange={(event) => props.onAutoMermaidChange(event.target.checked)}
          />
          {t(
            "自动在回答底部生成美化的 Mermaid 产业链图（仅在检索证据支持时生成）",
            "Append a styled Mermaid industry-chain diagram when supported by retrieved evidence"
          )}
        </label>
        <div className="mx-auto mt-1.5 max-w-4xl text-center text-[10px] text-muted-foreground">
          {t("回答由项目知识资产与知识超图共同提供依据，请核验关键业务结论。", "Answers are grounded in project assets and the knowledge hypergraph; verify critical business conclusions.")}
        </div>
      </div>
    </section>
  );
}

function RunningMcpSearchPanel(props: { searches: RunningMcpSearch[] }) {
  const { t } = useI18n();
  const searchCount = props.searches.length;
  return (
    <div className="max-w-[86%] rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm leading-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span className="font-medium text-foreground">{t("正在使用 MCP 检索", "Using MCP retrieval")}</span>
        <Badge className="border-border bg-background text-muted-foreground">{t(`${searchCount} 次搜索`, `${searchCount} search(es)`)}</Badge>
      </div>
      {searchCount === 0 ? (
        <div className="text-sm text-muted-foreground">{t("正在分析问题，等待 MCP 搜索语句...", "Analyzing the question and waiting for MCP search queries...")}</div>
      ) : (
        <div className="space-y-1.5">
          {props.searches.map((search, index) => (
            <div key={search.id} className="rounded-md border border-border bg-background/70 px-2.5 py-1.5">
              <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t(`搜索 ${index + 1}：`, `Search ${index + 1}:`)}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm text-foreground">
                  {search.query}
                </span>
              </div>
              {search.searchMode ? (
                <div className="mt-1 text-xs text-muted-foreground">{t("模式", "Mode")}：{search.searchMode}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CitationStrip(props: { citations: AnswerCitation[]; onOpenCitation: (citation: AnswerCitation) => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{t("引用原文", "Source citations")}</div>
      <div className="flex flex-wrap gap-1.5">
        {props.citations.map((citation) => (
          <button
            key={`${citation.index}-${citation.chunkId}`}
            type="button"
            className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            title={citation.heading || citation.chunkId}
            onClick={() => props.onOpenCitation(citation)}
          >
            {citation.index}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectDocumentsWorkspace(props: {
  project: SourceRecord | null;
  documents: DocumentRecord[];
  selectedDocumentId: string;
  selectedDocument: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
  projectStats: ProjectStatsRecord | null;
  resultView: ResultView;
  showArchivedDocuments: boolean;
  hasActiveUploads: boolean;
  uploadJobs: UploadJobRecord[];
  isUploadQueueExpanded: boolean;
  searchQuery: string;
  searchMode: SearchMode;
  searchResult: SearchResult | null;
  isSearching: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onUploadFiles: (files: File[]) => void;
  onImportStructured: (input: {
    title?: string;
    fileName?: string;
    format: ManualImportFormat;
    content: string;
  }) => Promise<void>;
  onExportProject: (format: "csv" | "json", split: ExportSplitMode, maxBytes?: number) => void;
  onToggleUploadQueue: () => void;
  onSelectDocument: (documentId: string) => void;
  onRenameDocument: (document: DocumentRecord) => void;
  onArchiveOrRestoreDocument: (document: DocumentRecord) => void;
  onDeleteDocument: (document: DocumentRecord) => void;
  onSetResultView: (view: ResultView) => void;
  onToggleArchivedDocuments: (value: boolean) => void;
  onSearchQueryChange: (value: string) => void;
  onSearchModeChange: (value: SearchMode) => void;
  onSearch: () => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
  onUpdateChunk: (chunkId: string, input: { heading?: string | null; content?: string; rawContent?: string | null }) => void;
  onDeleteChunk: (chunkId: string) => void;
  onUpdateEvent: (eventId: string, input: { title?: string; summary?: string; content?: string }) => void;
  onDeleteEvent: (eventId: string) => void;
  onUpdateEntity: (entityId: string, input: { type?: string; name?: string; description?: string | null }) => void;
  onDeleteEntity: (entityId: string) => void;
}) {
  const { language, t } = useI18n();
  const [resultTitleQuery, setResultTitleQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [manualImportOpen, setManualImportOpen] = useState(false);
  const [manualImportContent, setManualImportContent] = useState("");
  const [manualImportTitle, setManualImportTitle] = useState("");
  const [manualImportFileName, setManualImportFileName] = useState("");
  const [manualImportFiles, setManualImportFiles] = useState<Array<{ fileName: string; content: string }>>([]);
  const [manualImportFormat, setManualImportFormat] = useState<ManualImportFormat>("auto");
  const [manualImportError, setManualImportError] = useState("");
  const [isManualImporting, setIsManualImporting] = useState(false);
  const [exportSplit, setExportSplit] = useState<ExportSplitMode>("none");
  const [exportMaxMb, setExportMaxMb] = useState(50);
  const [docRailWidth, setDocRailWidth] = useState(() => loadStoredNumber(DOC_RAIL_WIDTH_STORAGE_KEY, 340, DOC_RAIL_MIN_WIDTH, DOC_RAIL_MAX_WIDTH));
  const manualImportFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(DOC_RAIL_WIDTH_STORAGE_KEY, String(docRailWidth));
    } catch {
      // 忽略 localStorage 不可用的情况
    }
  }, [docRailWidth]);

  function startDocRailResize(event: ReactPointerEvent) {
    startPanelResize(event, {
      startWidth: docRailWidth,
      minWidth: DOC_RAIL_MIN_WIDTH,
      maxWidth: DOC_RAIL_MAX_WIDTH,
      getWidth: (startWidth, deltaX) => startWidth + deltaX,
      onResize: setDocRailWidth
    });
  }
  const searchableResultView = props.resultView === "chunks" || props.resultView === "events" || props.resultView === "entities";
  const normalizedResultTitleQuery = normalizeKeyword(resultTitleQuery);
  const filteredChunks = useMemo(
    () => filterByKeyword(props.chunks, normalizedResultTitleQuery, (chunk) => chunk.heading || t("未命名切片", "Untitled chunk")),
    [normalizedResultTitleQuery, props.chunks]
  );
  const filteredEvents = useMemo(
    () => filterByKeyword(props.events, normalizedResultTitleQuery, (event) => event.title),
    [normalizedResultTitleQuery, props.events]
  );
  const filteredEntities = useMemo(
    () => filterByKeyword(props.entities, normalizedResultTitleQuery, (entity) => entity.name),
    [normalizedResultTitleQuery, props.entities]
  );
  const activeResultCount = props.resultView === "chunks"
    ? filteredChunks.length
    : props.resultView === "events"
      ? filteredEvents.length
      : props.resultView === "entities"
        ? filteredEntities.length
        : 0;
  const activeTotalCount = props.resultView === "chunks"
    ? props.chunks.length
    : props.resultView === "events"
      ? props.events.length
      : props.resultView === "entities"
        ? props.entities.length
        : 0;
  const resultPageCount = Math.max(1, Math.ceil(activeResultCount / DOCUMENT_RESULT_PAGE_SIZE));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const paginatedChunks = useMemo(
    () => paginateItems(filteredChunks, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredChunks]
  );
  const paginatedEvents = useMemo(
    () => paginateItems(filteredEvents, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredEvents]
  );
  const paginatedEntities = useMemo(
    () => paginateItems(filteredEntities, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredEntities]
  );

  useEffect(() => {
    setResultPage(1);
  }, [normalizedResultTitleQuery, props.resultView, props.selectedDocumentId]);

  useEffect(() => {
    if (resultPage > resultPageCount) {
      setResultPage(resultPageCount);
    }
  }, [resultPage, resultPageCount]);

  function closeManualImport() {
    if (isManualImporting) return;
    setManualImportOpen(false);
    setManualImportError("");
  }

  async function submitManualImport() {
    if ((!manualImportContent.trim() && manualImportFiles.length === 0) || isManualImporting) return;
    setIsManualImporting(true);
    setManualImportError("");
    try {
      if (manualImportFiles.length > 0) {
        for (const file of manualImportFiles) {
          await props.onImportStructured({
            title: manualImportFiles.length === 1 ? manualImportTitle.trim() || undefined : undefined,
            fileName: file.fileName,
            format: manualImportFormat,
            content: file.content
          });
        }
      } else {
        await props.onImportStructured({
          title: manualImportTitle.trim() || undefined,
          fileName: manualImportFileName.trim() || undefined,
          format: manualImportFormat,
          content: manualImportContent
        });
      }
      setManualImportOpen(false);
      setManualImportContent("");
      setManualImportTitle("");
      setManualImportFileName("");
      setManualImportFiles([]);
      setManualImportFormat("auto");
    } catch (error) {
      setManualImportError(getErrorMessage(error));
    } finally {
      setIsManualImporting(false);
    }
  }

  return (
    <section className="chem-documents flex min-h-0 flex-1 flex-col">
      <div className="chem-section-header flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-primary">{t("KNOWLEDGE ASSETS", "KNOWLEDGE ASSETS")}</div>
          <h2 className="truncate text-base font-semibold">{t("产业链知识资产中心", "Industry-chain knowledge assets")}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {props.project?.name ?? t("请选择项目", "Select a project")}
            {props.selectedDocument ? ` · ${props.selectedDocument.title}` : ""}
          </p>
        </div>
        {props.project ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={exportSplit}
              onChange={(event) => setExportSplit(event.target.value as ExportSplitMode)}
              title={t("导出拆分方式", "Export split mode")}
            >
              <option value="none">{t("不拆分", "No split")}</option>
              <option value="documents">{t("按文档", "By document")}</option>
              <option value="size">{t("按大小", "By size")}</option>
            </select>
            {exportSplit === "size" ? (
              <label className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground">
                <Input
                  className="h-7 w-16 border-0 px-1 text-xs shadow-none focus-visible:ring-0"
                  type="number"
                  min={1}
                  max={1024}
                  value={exportMaxMb}
                  onChange={(event) => setExportMaxMb(Math.max(1, Number(event.target.value) || 1))}
                />
                MB
              </label>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.onExportProject("csv", exportSplit, exportSplit === "size" ? Math.round(exportMaxMb * 1024 * 1024) : undefined)}
            >
              <Download className="h-4 w-4" />
              {t("导出 CSV", "Export CSV")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.onExportProject("json", exportSplit, exportSplit === "size" ? Math.round(exportMaxMb * 1024 * 1024) : undefined)}
            >
              <Download className="h-4 w-4" />
              JSON
            </Button>
            <Button variant="outline" size="sm" onClick={() => setManualImportOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("导入 AI 表格", "Import AI table")}
            </Button>
            <Button size="sm" onClick={() => props.fileInputRef.current?.click()}>
              {props.hasActiveUploads ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t("添加文档", "Add document")}
            </Button>
          </div>
        ) : null}
      </div>

      <input
        ref={props.fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".md,.txt,text/markdown,text/plain"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = "";
          props.onUploadFiles(files);
        }}
      />

      {!props.project ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState title={t("没有项目", "No project")} description={t("创建项目后，才能上传文档并查看处理结果。", "Create a project before uploading documents and viewing processing results.")} />
        </div>
      ) : (
        <div
          className="chem-documents-grid relative grid min-h-0 flex-1 gap-0"
          style={{ ["--chem-doc-rail-width" as string]: `${docRailWidth}px` }}
        >
          <div
            className="chem-doc-rail-resize-handle hidden lg:block"
            role="separator"
            aria-orientation="vertical"
            title={t("拖拽调整文档栏宽度", "Drag to resize the document column")}
            style={{ left: `calc(var(--chem-doc-rail-width) - 5px)` }}
            onPointerDown={startDocRailResize}
          />
          <div className="chem-assets-rail min-h-0 overflow-y-auto border-r border-border p-4 scrollbar-thin">
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Metric label={t("文档", "Documents")} value={props.projectStats?.documentCount ?? props.documents.length} />
              <Metric label={t("切片", "Chunks")} value={props.projectStats?.chunkCount ?? props.chunks.length} />
              <Metric label={t("事件", "Events")} value={props.projectStats?.eventCount ?? props.events.length} />
              <Metric label={t("实体", "Entities")} value={props.projectStats?.entityCount ?? props.entities.length} />
            </div>

            {props.uploadJobs.length > 0 ? (
              <UploadJobsPanel
                jobs={props.uploadJobs}
                expanded={props.isUploadQueueExpanded}
                onToggle={props.onToggleUploadQueue}
              />
            ) : null}

            <PanelSection
              title={t("文档", "Documents")}
              action={(
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={props.showArchivedDocuments}
                    onChange={(event) => props.onToggleArchivedDocuments(event.target.checked)}
                  />
                  {t("归档", "Archived")}
                </label>
              )}
            >
              {props.documents.length === 0 ? (
                <EmptyLine text={t("当前项目还没有文档。", "The current project has no documents yet.")} />
              ) : props.documents.map((document) => (
                <div key={document.id} className={cn("rounded-xl border border-border bg-background/80", document.id === props.selectedDocumentId && "border-primary/30 bg-primary/[0.06]")}>
                  <button
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm"
                    onClick={() => props.onSelectDocument(document.id)}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium leading-snug">{document.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {document.archivedAt ? t("已归档", "Archived") : `${document.parseStatus} · ${formatDate(document.createdAt)}`}
                      </span>
                    </span>
                  </button>
                  {document.id === props.selectedDocumentId ? (
                    <div className="flex flex-wrap gap-1 px-3 pb-2">
                      <MiniButton onClick={() => props.onRenameDocument(document)}>{t("重命名", "Rename")}</MiniButton>
                      <MiniButton onClick={() => props.onArchiveOrRestoreDocument(document)}>
                        {document.archivedAt ? t("恢复", "Restore") : t("归档", "Archive")}
                      </MiniButton>
                      <MiniButton danger onClick={() => props.onDeleteDocument(document)}>{t("永久删除", "Delete forever")}</MiniButton>
                    </div>
                  ) : null}
                </div>
              ))}
            </PanelSection>
          </div>

          <div className="min-h-0 overflow-y-auto p-4 scrollbar-thin md:p-6">
            <div className="chem-result-tabs flex flex-wrap gap-1 rounded-xl border border-border bg-background/80 p-1">
              {(["overview", "chunks", "events", "entities", "search"] as ResultView[]).map((view) => (
                <button
                  key={view}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    props.resultView === view && "chem-tab-active text-foreground"
                  )}
                  onClick={() => props.onSetResultView(view)}
                >
                  {resultViewLabel(view, language)}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {searchableResultView ? (
                <ResultTitleSearch
                  label={resultViewLabel(props.resultView, language)}
                  query={resultTitleQuery}
                  totalCount={activeTotalCount}
                  matchedCount={activeResultCount}
                  onQueryChange={setResultTitleQuery}
                  onClear={() => setResultTitleQuery("")}
                />
              ) : null}
              {props.resultView === "overview" ? (
                <OverviewPanel document={props.selectedDocument} chunks={props.chunks} events={props.events} entities={props.entities} />
              ) : null}
              {props.resultView === "chunks" ? (
                <ChunksPanel
                  chunks={paginatedChunks}
                  hasFilter={Boolean(normalizedResultTitleQuery)}
                  onUpdateChunk={props.onUpdateChunk}
                  onDeleteChunk={props.onDeleteChunk}
                />
              ) : null}
              {props.resultView === "events" ? (
                <EventsPanel
                  events={paginatedEvents}
                  hasFilter={Boolean(normalizedResultTitleQuery)}
                  onOpenEvent={props.onOpenEvent}
                  onOpenEntity={props.onOpenEntity}
                  onUpdateEvent={props.onUpdateEvent}
                  onDeleteEvent={props.onDeleteEvent}
                />
              ) : null}
              {props.resultView === "entities" ? (
                <EntitiesPanel
                  entities={paginatedEntities}
                  hasFilter={Boolean(normalizedResultTitleQuery)}
                  onOpenEntity={props.onOpenEntity}
                  onUpdateEntity={props.onUpdateEntity}
                  onDeleteEntity={props.onDeleteEntity}
                />
              ) : null}
              {searchableResultView && activeResultCount > DOCUMENT_RESULT_PAGE_SIZE ? (
                <PaginationControls
                  className="mt-4"
                  page={currentResultPage}
                  pageSize={DOCUMENT_RESULT_PAGE_SIZE}
                  totalCount={activeResultCount}
                  onPageChange={setResultPage}
                />
              ) : null}
              {props.resultView === "search" ? (
                <SearchPanel
                  query={props.searchQuery}
                  searchMode={props.searchMode}
                  result={props.searchResult}
                  isSearching={props.isSearching}
                  onQueryChange={props.onSearchQueryChange}
                  onSearchModeChange={props.onSearchModeChange}
                  onSearch={props.onSearch}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {manualImportOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-background shadow-lg" role="dialog" aria-modal="true" aria-labelledby="manual-import-title">
            <div className="border-b border-border px-5 py-4">
              <div id="manual-import-title" className="text-sm font-semibold">{t("粘贴或上传网页版 AI 的数据", "Paste or upload AI-generated data")}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(
                  "默认自动识别 CSV、Markdown 表格或 JSON，也支持一次选择多个本项目导出的 CSV / JSON 备份文件批量恢复。导出文件中的多个文档会分别恢复；相同“切片编号”的多行会合并为一个事件和多个实体。事件 UUID 始终由系统重新生成，导出的系统 ID 不会被当作主键复用。此导入过程不会调用远程 API。",
                  "The default is auto detect for CSV, Markdown tables, or JSON. You can also select multiple exported CSV / JSON backup files and restore them in one batch. Multiple exported documents are restored separately. Rows with the same chunk ID are merged into one event with multiple entities. Event UUIDs are regenerated and exported system IDs are never reused as primary keys. No remote API is called."
                )}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <div className="grid gap-3 md:grid-cols-[1fr_180px]">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{t("文档标题（可选）", "Document title (optional)")}</div>
                  <Input value={manualImportTitle} onChange={(event) => setManualImportTitle(event.target.value)} placeholder={t("表格中有“文档标题”列时可留空", "May be blank when the table has a document title column")} />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{t("格式", "Format")}</div>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={manualImportFormat}
                    onChange={(event) => setManualImportFormat(event.target.value as ManualImportFormat)}
                  >
                    <option value="auto">{t("自动识别", "Auto detect")}</option>
                    <option value="csv">CSV</option>
                    <option value="markdown">Markdown</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                {t(
                  "推荐列：文档标题、切片编号、切片标题、原文切片、事件标题、事件摘要、事件内容、事件分类、关键词、实体类型、实体名称、实体说明。",
                  "Recommended columns: document_title, chunk_id, chunk_heading, chunk_content, event_title, event_summary, event_content, event_category, keywords, entity_type, entity_name, entity_description."
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={manualImportFileRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept=".csv,.tsv,.md,.markdown,.json,text/csv,text/markdown,application/json"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.currentTarget.value = "";
                    if (files.length === 0) return;
                    void Promise.all(files.map(async (file) => ({
                      fileName: file.name,
                      content: await file.text()
                    }))).then((items) => {
                      setManualImportFiles(items);
                      setManualImportFileName(items.map((item) => item.fileName).join(", "));
                      setManualImportContent(items.length === 1 ? items[0].content : "");
                      setManualImportFormat("auto");
                      setManualImportError("");
                    });
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => manualImportFileRef.current?.click()}>
                  <Upload className="h-4 w-4" />
                  {t("选择 CSV / MD / JSON 文件", "Choose CSV / MD / JSON")}
                </Button>
                <span className="text-xs text-muted-foreground">{t("下载模板：", "Templates:")}</span>
                {(["csv", "markdown", "json"] as ImportDocFormat[]).map((format) => (
                  <Button
                    key={format}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => downloadTextFile(
                      importTemplateFilename(format),
                      importTemplateContent(format, language),
                      importTemplateMime(format)
                    )}
                    title={t(`下载 ${importFormatLabel(format)} 导入模板`, `Download ${importFormatLabel(format)} import template`)}
                  >
                    <Download className="h-4 w-4" />
                    {importFormatLabel(format)}
                  </Button>
                ))}
                {manualImportFileName ? (
                  <span className="max-w-full truncate text-xs text-muted-foreground">
                    {manualImportFiles.length > 1
                      ? t(`已选择 ${manualImportFiles.length} 个文件`, `${manualImportFiles.length} files selected`)
                      : manualImportFileName}
                  </span>
                ) : null}
              </div>

              <AiImportPromptTools />

              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{t("直接粘贴数据", "Paste data directly")}</div>
                <Textarea
                  className="min-h-72 resize-y font-mono text-xs leading-5"
                  value={manualImportContent}
                  onChange={(event) => {
                    setManualImportContent(event.target.value);
                    setManualImportFiles([]);
                    setManualImportFileName("");
                    setManualImportError("");
                  }}
                  placeholder={t(
                    "文档标题,切片编号,切片标题,原文切片,事件标题,事件摘要,事件内容,事件分类,关键词,实体类型,实体名称,实体说明",
                    "document_title,chunk_id,chunk_heading,chunk_content,event_title,event_summary,event_content,event_category,keywords,entity_type,entity_name,entity_description"
                  )}
                />
              </div>
              {manualImportError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{manualImportError}</div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="ghost" size="sm" onClick={closeManualImport} disabled={isManualImporting}>{t("取消", "Cancel")}</Button>
              <Button size="sm" onClick={() => void submitManualImport()} disabled={(!manualImportContent.trim() && manualImportFiles.length === 0) || isManualImporting}>
                {isManualImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("导入项目", "Import into project")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type ImportDocFormat = "csv" | "markdown" | "json";

function importFormatLabel(format: ImportDocFormat): string {
  return format === "markdown" ? "MD" : format.toUpperCase();
}

function importTemplateFilename(format: ImportDocFormat): string {
  return format === "csv"
    ? "sag-import-template.csv"
    : format === "markdown"
      ? "sag-import-template.md"
      : "sag-import-template.json";
}

function importTemplateMime(format: ImportDocFormat): string {
  return format === "csv" ? "text/csv" : format === "markdown" ? "text/markdown" : "application/json";
}

// 导入模板用到的列（中英两套；解析器对两者都识别）
const IMPORT_HEADERS_ZH = ["文档标题", "切片编号", "切片标题", "原文切片", "事件标题", "事件摘要", "事件内容", "事件分类", "关键词", "实体类型", "实体名称", "实体说明"];
const IMPORT_HEADERS_EN = ["document_title", "chunk_id", "chunk_heading", "chunk_content", "event_title", "event_summary", "event_content", "event_category", "keywords", "entity_type", "entity_name", "entity_description"];
const IMPORT_JSON_KEYS = IMPORT_HEADERS_EN;

function importSampleRows(language: SupportedLanguage): string[][] {
  // 两行共用相同“切片编号”，演示「同一事件、多个实体」会被合并
  if (language === "en") {
    return [
      ["Sample document", "1", "Industry overview", "Paste the matching source passage here; it can be long.", "Product X capacity expansion", "One-line event summary.", "Detailed description of the event...", "Industry update", "keywordA;keywordB", "company", "Sample Chemical Co.", "Role of this company in the event"],
      ["Sample document", "1", "Industry overview", "Paste the matching source passage here; it can be long.", "Product X capacity expansion", "One-line event summary.", "Detailed description of the event...", "Industry update", "keywordA;keywordB", "product", "Sample product", "Role of this product in the event"]
    ];
  }
  return [
    ["示例文档", "1", "行业概述", "这里粘贴该事件对应的原文片段，可以较长。", "某产品扩产事件", "一句话事件摘要。", "事件的详细描述……", "行业动态", "关键词A;关键词B", "企业", "示例化工企业", "该企业在事件中的角色说明"],
    ["示例文档", "1", "行业概述", "这里粘贴该事件对应的原文片段，可以较长。", "某产品扩产事件", "一句话事件摘要。", "事件的详细描述……", "行业动态", "关键词A;关键词B", "产品", "示例产品", "该产品在事件中的角色说明"]
  ];
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function importTemplateContent(format: ImportDocFormat, language: SupportedLanguage): string {
  const headers = language === "en" ? IMPORT_HEADERS_EN : IMPORT_HEADERS_ZH;
  const rows = importSampleRows(language);
  if (format === "csv") {
    return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  }
  if (format === "markdown") {
    const headerLine = `| ${headers.join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const bodyLines = rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`);
    return [headerLine, separator, ...bodyLines].join("\n");
  }
  const objects = rows.map((row) => {
    const record: Record<string, unknown> = {};
    IMPORT_JSON_KEYS.forEach((key, index) => {
      record[key] = key === "keywords" ? row[index].split(/[;；]/).filter(Boolean) : row[index];
    });
    return record;
  });
  return JSON.stringify(objects, null, 2);
}

function defaultImportPrompt(format: ImportDocFormat, language: SupportedLanguage): string {
  const headersZh = IMPORT_HEADERS_ZH.join("，");
  const headersEn = IMPORT_HEADERS_EN.join(", ");
  if (language === "en") {
    if (format === "json") {
      return [
        "You are a knowledge-extraction assistant for the chemical industry chain. Convert the source text I provide below into JSON that can be imported directly.",
        "Requirements:",
        `1. Output a JSON array. Each element is a row object with these keys: ${headersEn}.`,
        "2. \"keywords\" must be an array of strings. Every event needs at least one entity; write multiple entities of the same event as separate objects that share the same \"chunk_id\" (the system merges rows with the same chunk_id into one event with multiple entities).",
        "3. Put the matching source passage in \"chunk_content\". Do not fabricate; leave a field empty (\"\") if unknown.",
        "4. Output ONLY the raw JSON array — no explanations and no ``` code fences.",
        "Source text:",
        "<paste the source text here>"
      ].join("\n");
    }
    const shape = format === "csv"
      ? "CSV (first line is the header row, comma-separated)"
      : "a Markdown table (header row, a separator row of ---, then data rows)";
    return [
      `You are a knowledge-extraction assistant for the chemical industry chain. Convert the source text I provide below into ${shape} that can be imported directly.`,
      "Requirements:",
      `1. Use exactly these column names in this order: ${headersEn}.`,
      "2. Every event needs at least one entity; write multiple entities of the same event as multiple rows that keep the SAME chunk_id (the system merges rows with the same chunk_id into one event with multiple entities).",
      "3. Separate multiple keywords with a semicolon (;)." + (format === "csv" ? " If a field contains a comma or newline, wrap it in double quotes." : " Replace any literal | inside a cell with \\|."),
      "4. Put the matching source passage in chunk_content. Do not fabricate; leave a field empty if unknown.",
      `5. Output ONLY the ${format === "csv" ? "CSV" : "Markdown table"} itself — no explanations and no \`\`\` code fences.`,
      "Source text:",
      "<paste the source text here>"
    ].join("\n");
  }
  if (format === "json") {
    return [
      "你是化工产业链知识抽取助手。请把我接下来提供的原文，转换成可直接导入的 JSON。",
      "要求：",
      `1. 输出一个 JSON 数组，每个元素是一行对象，包含这些键：${headersEn}。`,
      "2. keywords 用字符串数组。每个“事件”至少有 1 个实体；同一事件的多个实体写成多个对象，并让它们的 chunk_id 保持相同（系统会按 chunk_id 合并为一个事件、多个实体）。",
      "3. “chunk_content”填该事件对应的原文片段；不要编造，缺失就留空字符串（\"\"）。",
      "4. 只输出 JSON 数组本身，不要任何解释，也不要 ``` 代码块。",
      "原文如下：",
      "<在此粘贴原文>"
    ].join("\n");
  }
  const shapeZh = format === "csv"
    ? "可直接导入的 CSV（第一行为表头，逗号分隔）"
    : "可直接导入的 Markdown 表格（表头行 + 一行 --- 分隔 + 数据行）";
  return [
    `你是化工产业链知识抽取助手。请把我接下来提供的原文，转换成${shapeZh}。`,
    "要求：",
    `1. 严格使用这些列名（顺序一致）：${headersZh}。`,
    "2. 每个“事件”至少拆出 1 个实体；同一事件的多个实体写成多行，并让这些行的“切片编号”保持相同（系统会按切片编号合并为一个事件、多个实体）。",
    "3. 关键词用分号(;)分隔。" + (format === "csv" ? "字段内若含逗号或换行，请用英文双引号包裹。" : "单元格内若含 | 请写成 \\|。"),
    "4. “原文切片”填该事件对应的原文片段；不要编造内容，缺失就留空。",
    `5. 只输出${format === "csv" ? " CSV" : " Markdown 表格"}本身，不要多余解释，也不要 \`\`\` 代码块。`,
    "原文如下：",
    "<在此粘贴原文>"
  ].join("\n");
}

function loadCustomImportPrompts(): Partial<Record<ImportDocFormat, string>> {
  try {
    const raw = window.localStorage.getItem(AI_IMPORT_PROMPT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function AiImportPromptTools() {
  const { t, language } = useI18n();
  const [promptFormat, setPromptFormat] = useState<ImportDocFormat>("csv");
  const [customPrompts, setCustomPrompts] = useState<Partial<Record<ImportDocFormat, string>>>(() => loadCustomImportPrompts());
  const [editorOpen, setEditorOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const defaultPrompt = defaultImportPrompt(promptFormat, language);
  const promptValue = customPrompts[promptFormat] ?? defaultPrompt;
  const isCustom = customPrompts[promptFormat] != null && customPrompts[promptFormat] !== defaultPrompt;

  useEffect(() => {
    try {
      window.localStorage.setItem(AI_IMPORT_PROMPT_STORAGE_KEY, JSON.stringify(customPrompts));
    } catch {
      // 忽略 localStorage 不可用
    }
  }, [customPrompts]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(promptValue);
      setCopied(true);
    } catch {
      // 退回到老式复制
      const textarea = document.createElement("textarea");
      textarea.value = promptValue;
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand("copy"); setCopied(true); } catch { /* ignore */ }
      textarea.remove();
    }
  }

  function updateCustom(value: string) {
    setCustomPrompts((current) => ({ ...current, [promptFormat]: value }));
  }

  function resetCustom() {
    setCustomPrompts((current) => {
      const next = { ...current };
      delete next[promptFormat];
      return next;
    });
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">{t("用 AI 生成可导入文件的提示词", "AI prompt to generate an importable file")}</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          {(["csv", "markdown", "json"] as ImportDocFormat[]).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => setPromptFormat(format)}
              className={cn(
                "px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground",
                promptFormat === format && "bg-primary text-primary-foreground hover:text-primary-foreground"
              )}
            >
              {importFormatLabel(format)}
            </button>
          ))}
        </div>
        <Button type="button" size="sm" onClick={() => void copyPrompt()}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? t("已复制", "Copied") : t("复制提示词", "Copy prompt")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditorOpen((value) => !value)}>
          <Pencil className="h-4 w-4" />
          {editorOpen ? t("收起自定义", "Hide editor") : t("自定义提示词", "Customize")}
        </Button>
        {isCustom ? (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t("已自定义", "Customized")}</span>
        ) : null}
      </div>
      {editorOpen ? (
        <div className="mt-2 space-y-2">
          <Textarea
            className="min-h-40 resize-y font-mono text-xs leading-5"
            value={promptValue}
            onChange={(event) => updateCustom(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={resetCustom} disabled={!isCustom}>
              <RotateCcw className="h-4 w-4" />
              {t("恢复默认", "Reset to default")}
            </Button>
            <span className="self-center text-[11px] text-muted-foreground">
              {t("修改会自动保存到本浏览器。", "Edits are saved automatically in this browser.")}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProjectGraphWorkspace(props: {
  project: SourceRecord | null;
  graph: ProjectGraphRecord | null;
  focus: GraphFocus | null;
  defaultLayoutStyle?: string;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t, language } = useI18n();
  const graph = props.graph;

  if (!props.project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先创建项目", "Create a project first")} description={t("项目里有文档、事件和实体后，图谱会在这里显示。", "The graph appears after the project has documents, events, and entities.")} />
      </section>
    );
  }

  if (!graph || graph.entities.length === 0 || graph.events.length === 0) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("暂无图谱数据", "No graph data yet")} description={t("上传并完成提取后，可以查看实体、事件和关系。", "Upload documents and finish extraction to view entities, events, and relations.")} />
      </section>
    );
  }

  return (
    <section className="chem-graph-workspace flex min-h-0 flex-1 flex-col p-3 md:p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">KNOWLEDGE HYPERGRAPH</div>
          <h2 className="mt-1 text-base font-semibold">{t("化工产业链知识超图", "Chemical industry knowledge hypergraph")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("探索企业、产品、原料、工艺与产业事件之间的多跳关联。", "Explore multi-hop links across companies, products, feedstocks, processes, and industry events.")}</p>
        </div>
        <Badge className="border-primary/20 bg-primary/[0.07] text-primary">{props.project.name}</Badge>
      </div>
      <div className="min-h-0 flex-1 rounded-2xl border border-border bg-background/90 p-1 shadow-sm">
        <ProjectGraphFlow
          graph={graph}
          focus={props.focus}
          defaultLayoutStyle={props.defaultLayoutStyle}
          language={language}
          onOpenEvent={props.onOpenEvent}
          onOpenEntity={props.onOpenEntity}
        />
      </div>
    </section>
  );
}

function ActivityPanel(props: {
  className?: string;
  mode: ContextPanelMode;
  detail: McpSessionDetail | null;
  processSteps: ProcessStep[];
  modelLogs: ModelCallLogRecord[];
  isCollapsed: boolean;
  onSetMode: (mode: ContextPanelMode) => void;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent) => void;
  onRefreshModelLogs: () => void;
  onClearModelLogs: () => void;
}) {
  const { t } = useI18n();
  if (props.isCollapsed) {
    return (
      <aside className={cn("chem-activity-panel chem-activity-panel-collapsed hidden min-h-0 flex-col items-center border-l border-border", props.className)}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mt-3 h-9 w-9"
          title={t("展开右侧栏", "Expand right panel")}
          aria-label={t("展开右侧栏", "Expand right panel")}
          onClick={props.onToggleCollapsed}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="mt-4 flex flex-1 items-center justify-center">
          <div className="chem-activity-collapsed-label">{contextPanelModeLabel(props.mode, t)}</div>
        </div>
      </aside>
    );
  }
  return (
    <aside className={cn("chem-activity-panel relative flex min-h-0 flex-col", props.className)}>
      <div
        className="chem-activity-resize-handle"
        role="separator"
        aria-orientation="vertical"
        title={t("拖拽调整右侧栏宽度", "Drag to resize right panel")}
        onPointerDown={props.onResizeStart}
      />
      <div className="border-b border-border p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{contextPanelModeLabel(props.mode, t)}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">{t("知识检索路径与模型调用依据", "Knowledge retrieval path and model evidence")}</p>
        </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            title={t("收起右侧栏", "Collapse right panel")}
            aria-label={t("收起右侧栏", "Collapse right panel")}
            onClick={props.onToggleCollapsed}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-3 rounded-md border border-border p-1">
          {(["process", "assets", "logs"] as ContextPanelMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                "rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                props.mode === mode && "bg-accent text-foreground"
              )}
              onClick={() => props.onSetMode(mode)}
            >
              {contextPanelModeLabel(mode, t)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {props.mode === "logs" ? (
          <RawLogsPanel
            logs={props.modelLogs}
            onRefresh={props.onRefreshModelLogs}
            onClear={props.onClearModelLogs}
          />
        ) : props.mode === "assets" ? (
          <KnowledgeAssetsPanel detail={props.detail} />
        ) : (
          <ProcessPanel steps={props.processSteps} />
        )}
      </div>
    </aside>
  );
}

type KnowledgeAssetOverview = {
  citations: AnswerCitation[];
  events: Array<{ id: string; title: string; summary?: string; score?: number; rank?: number }>;
  entities: Array<{ id: string; name: string; type?: string; description?: string; score?: number; eventCount?: number }>;
  searchCount: number;
};

type ChunkAssetLookup = {
  events: Array<EventRecord & { entities?: EntityRecord[] }>;
  entities: EntityRecord[];
};

function KnowledgeAssetsPanel({ detail }: { detail: McpSessionDetail | null }) {
  const { t } = useI18n();
  const [chunkAssets, setChunkAssets] = useState<ChunkAssetLookup | null>(null);
  const [isLoadingChunkAssets, setIsLoadingChunkAssets] = useState(false);
  const baseOverview = useMemo(() => buildKnowledgeAssetOverview(detail), [detail]);
  const chunkAssetKey = useMemo(() => baseOverview.citations.map((citation) => citation.chunkId).sort().join("|"), [baseOverview.citations]);
  useEffect(() => {
    const chunkIds = baseOverview.citations.map((citation) => citation.chunkId);
    if (chunkIds.length === 0) {
      setChunkAssets(null);
      return;
    }
    let active = true;
    setIsLoadingChunkAssets(true);
    void api.getChunkAssets(chunkIds)
      .then((result) => {
        if (active) setChunkAssets(result);
      })
      .catch(() => {
        if (active) setChunkAssets(null);
      })
      .finally(() => {
        if (active) setIsLoadingChunkAssets(false);
      });
    return () => {
      active = false;
    };
  }, [chunkAssetKey]);
  const overview = useMemo(() => mergeKnowledgeAssetOverview(baseOverview, chunkAssets), [baseOverview, chunkAssets]);
  if (!detail || (overview.citations.length === 0 && overview.events.length === 0 && overview.entities.length === 0)) {
    return (
      <EmptyState
        title={t("暂无引用资产", "No cited assets yet")}
        description={t("智能问答完成后，这里会汇总本对话引用过的切片、事件和实体。", "After Q&A completes, cited chunks, events, and entities appear here.")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-background/80 p-3 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-primary">KNOWLEDGE ASSETS</div>
            <div className="mt-1 text-sm font-semibold">{t("本对话引用概览", "Conversation asset overview")}</div>
          </div>
          <Badge className="border-border bg-muted text-muted-foreground">
            {isLoadingChunkAssets ? t("同步中", "Syncing") : `${overview.searchCount} SAG`}
          </Badge>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MiniMetric label={t("切片", "Chunks")} value={overview.citations.length} />
          <MiniMetric label={t("事件", "Events")} value={overview.events.length} />
          <MiniMetric label={t("实体", "Entities")} value={overview.entities.length} />
        </div>
      </div>

      <PanelSection title={t("引用切片", "Cited chunks")}>
        {overview.citations.length === 0 ? <EmptyLine text={t("暂无切片引用。", "No chunk citations yet.")} /> : (
          <div className="space-y-2">
            {overview.citations.map((citation) => (
              <div key={`${citation.index}-${citation.chunkId}`} className="rounded-lg border border-border bg-background/75 p-3">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div className="min-w-0 truncate text-sm font-semibold">{citation.heading || t("未命名切片", "Untitled chunk")}</div>
                  <Badge className="shrink-0 border-border bg-muted text-muted-foreground">[{citation.index}]</Badge>
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                  {citation.rank != null ? <span>Rank {citation.rank}</span> : null}
                  {citation.score != null ? <span>Score {citation.score.toFixed(3)}</span> : null}
                </div>
                <p className="line-clamp-4 text-xs leading-5 text-muted-foreground">{citation.content}</p>
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title={t("事件概览", "Event overview")}>
        {overview.events.length === 0 ? <EmptyLine text={t("当前 trace 未返回事件快照。", "The current trace did not return event snapshots.")} /> : (
          <div className="space-y-2">
            {overview.events.slice(0, 8).map((event) => (
              <div key={event.id} className="rounded-lg border border-border bg-background/75 p-3">
                <div className="text-sm font-semibold leading-5">{event.title}</div>
                {event.summary ? <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{event.summary}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {event.rank != null ? <Badge className="border-border bg-muted text-muted-foreground">Rank {event.rank}</Badge> : null}
                  {event.score != null ? <Badge className="border-border bg-muted text-muted-foreground">Score {event.score.toFixed(3)}</Badge> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title={t("实体概览", "Entity overview")}>
        {overview.entities.length === 0 ? <EmptyLine text={t("当前 trace 未返回实体快照。", "The current trace did not return entity snapshots.")} /> : (
          <div className="flex flex-wrap gap-2">
            {overview.entities.slice(0, 18).map((entity) => (
              <div key={entity.id} className="min-w-0 max-w-full rounded-full border border-border bg-background/85 px-3 py-1.5 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <span className="max-w-[180px] truncate text-xs font-semibold">{entity.name}</span>
                  {entity.type ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{entity.type}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelSection>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/35 px-2 py-2 text-center">
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function ProcessPanel({ steps }: { steps: ProcessStep[] }) {
  const { t } = useI18n();
  if (steps.length === 0) {
    return <EmptyState title={t("还没有搜索过程", "No search trace yet")} description={t("每次对话或检索都会清空这里，并展示新的执行链路。", "Each chat or search clears this panel and shows the latest execution trace.")} />;
  }

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <Card key={step.id} className={cn(step.status === "failed" && "border-red-200 bg-red-50/60")}>
          <CardContent className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="truncate text-sm font-semibold">{step.title}</div>
                </div>
                {step.detail ? (
                  <div className="mt-1 pl-7 text-xs leading-5 text-muted-foreground">{step.detail}</div>
                ) : null}
              </div>
              <Badge className={processStatusClassName(step.status)}>
                {step.status === "running" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                {processStatusLabel(step.status, t)}
              </Badge>
            </div>
            {step.durationMs != null ? (
              <div className="pl-7 text-xs text-muted-foreground">{t(`耗时：${step.durationMs} 毫秒`, `Duration: ${step.durationMs} ms`)}</div>
            ) : null}
            {step.payload !== undefined ? (
              <div className="pl-7">
                <JsonBlock title={t("数据", "Data")} value={step.payload} compact />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RawLogsPanel(props: {
  logs: ModelCallLogRecord[];
  onRefresh: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const latestLogs = [...props.logs].sort((a, b) => b.sequence - a.sequence);
  const llmLogCount = props.logs.filter((log) => log.kind === "llm").length;
  const embeddingLogCount = props.logs.filter((log) => log.kind === "embedding").length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          <div>{t(`浏览器缓存 ${props.logs.length} 条`, `Browser cache: ${props.logs.length} item(s)`)}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge className="border-border bg-muted text-muted-foreground">LLM {llmLogCount}</Badge>
            <Badge className="border-border bg-muted text-muted-foreground">Embedding {embeddingLogCount}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={props.onRefresh}>
            {t("同步日志", "Sync logs")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onClear} disabled={props.logs.length === 0}>
            <Trash2 className="h-4 w-4" />
            {t("删除日志", "Delete logs")}
          </Button>
        </div>
      </div>
      {latestLogs.length === 0 ? (
        <EmptyState title={t("暂无原始日志", "No raw logs yet")} description={t("上传、检索或对话触发 LLM / Embedding 后会显示原始请求和返回。", "Raw requests and responses appear after upload, search, or chat triggers LLM / Embedding calls.")} />
      ) : latestLogs.map((log) => (
        <Card key={log.id} className={cn(log.status === "FAILED" && "border-red-200 bg-red-50/60")}>
          <CardContent className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge>{log.kind === "llm" ? "LLM" : "Embedding"}</Badge>
                  <div className="truncate text-sm font-semibold">{log.operation}</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  #{log.sequence} · {formatDate(log.createdAt)} · {log.durationMs} {t("毫秒", "ms")}
                </div>
              </div>
              <Badge className={log.status === "FAILED" ? "border-red-200 bg-red-50 text-red-700" : ""}>
                {log.status === "FAILED" ? t("失败", "Failed") : t("成功", "Succeeded")}
              </Badge>
            </div>
            <JsonBlock title={t("请求", "Request")} value={log.request} compact preserveRaw />
            {log.response !== undefined ? <JsonBlock title={t("返回", "Response")} value={log.response} compact preserveRaw /> : null}
            {log.error ? (
              <div className="rounded-md bg-red-50 p-2 text-xs leading-5 text-red-700">{log.error}</div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UploadJobsPanel({ jobs, expanded, onToggle }: {
  jobs: UploadJobRecord[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const activeCount = jobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING").length;
  const completedCount = jobs.filter((job) => job.status === "COMPLETED").length;
  const failedCount = jobs.filter((job) => job.status === "FAILED").length;
  const latestJob = jobs[0];
  return (
    <section className="mb-4">
      <button
        type="button"
        className="mb-2 flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-accent"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{t("处理队列", "Processing queue")}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {activeCount > 0
              ? t(`${activeCount} 个任务处理中`, `${activeCount} job(s) processing`)
              : t(`已收起：完成 ${completedCount}，失败 ${failedCount}`, `Collapsed: ${completedCount} completed, ${failedCount} failed`)}
            {latestJob ? t(` · 最近：${latestJob.title || latestJob.fileName}`, ` · Latest: ${latestJob.title || latestJob.fileName}`) : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          <Badge>{expanded ? t("收起", "Collapse") : t("展开", "Expand")}</Badge>
        </div>
      </button>
      {expanded ? (
        <div className="space-y-2">
          {jobs.map((job) => (
            <Card key={job.id} className={cn(job.status === "FAILED" && "border-red-200 bg-red-50/60")}>
              <CardContent className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{job.title || job.fileName}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{job.fileName}</div>
                  </div>
                  <Badge className={job.status === "FAILED" ? "border-red-200 bg-red-50 text-red-700" : ""}>
                    {uploadStatusLabel(job.status, t)}
                  </Badge>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary transition-all",
                      job.status === "FAILED" && "bg-red-500"
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">{uploadStageLabel(job.stage, t)} · {job.message}</span>
                  <span className="shrink-0">{Math.round(job.progress)}%</span>
                </div>
                {job.totalChunks ? (
                  <div className="text-xs text-muted-foreground">
                    {t(`切片进度：${job.currentChunk ?? 0}/${job.totalChunks}`, `Chunk progress: ${job.currentChunk ?? 0}/${job.totalChunks}`)}
                  </div>
                ) : null}
                {job.status === "COMPLETED" ? (
                  <div className="text-xs text-muted-foreground">
                    {t(`已生成 ${job.chunkCount ?? 0} 个切片，${job.eventCount ?? 0} 个事件`, `Generated ${job.chunkCount ?? 0} chunk(s), ${job.eventCount ?? 0} event(s)`)}
                  </div>
                ) : null}
                {job.error ? (
                  <div className="text-xs text-red-700">{job.error}</div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function OverviewPanel(props: {
  document: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
}) {
  const { t } = useI18n();
  if (!props.document) {
    return <EmptyState title={t("未选择文档", "No document selected")} description={t("选择文档后可查看处理结果。", "Select a document to view processing results.")} />;
  }
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-semibold">{props.document.title}</div>
          <div className="text-xs text-muted-foreground">{t("处理状态", "Processing status")}：{props.document.parseStatus}</div>
          <div className="text-xs text-muted-foreground">{t("创建时间", "Created at")}：{formatDate(props.document.createdAt)}</div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-3 gap-2">
        <Metric label={t("切片", "Chunks")} value={props.chunks.length} />
        <Metric label={t("事件", "Events")} value={props.events.length} />
        <Metric label={t("实体", "Entities")} value={props.entities.length} />
      </div>
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-semibold">{t("Embedding 状态", "Embedding status")}</div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label={t("切片向量", "Chunk vectors")} value={props.chunks.filter((chunk) => Boolean(chunk.embedding)).length} />
            <Metric label={t("事件向量", "Event vectors")} value={props.events.filter((event) => Boolean(event.titleEmbedding || event.contentEmbedding)).length} />
            <Metric label={t("实体向量", "Entity vectors")} value={props.entities.filter((entity) => Boolean(entity.embedding)).length} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("列表卡片会显示维度和前 8 位样本，用来确认向量已经真实写入数据库。", "List cards show dimensions and the first 8 sample values to confirm vectors were written to the database.")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ResultTitleSearch(props: {
  label: string;
  query: string;
  totalCount: number;
  matchedCount: number;
  onQueryChange: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t(`按${props.label}标题搜索`, `Search ${props.label} titles`)}
          />
        </div>
        {props.query.trim() ? (
          <Button variant="ghost" size="sm" onClick={props.onClear}>{t("清空", "Clear")}</Button>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {props.query.trim()
          ? t(`匹配 ${props.matchedCount}/${props.totalCount}`, `Matched ${props.matchedCount}/${props.totalCount}`)
          : t(`共 ${props.totalCount} 条`, `${props.totalCount} total`)}
      </div>
    </div>
  );
}

function PaginationControls(props: {
  page: number;
  pageSize: number;
  totalCount: number;
  className?: string;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const pageCount = Math.max(1, Math.ceil(props.totalCount / props.pageSize));
  const from = props.totalCount === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
  const to = Math.min(props.page * props.pageSize, props.totalCount);
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3", props.className)}>
      <div className="text-xs text-muted-foreground">
        {t(`第 ${props.page}/${pageCount} 页 · ${from}-${to} / ${props.totalCount} 条`, `Page ${props.page}/${pageCount} · ${from}-${to} / ${props.totalCount}`)}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.page <= 1}
          onClick={() => props.onPageChange(Math.max(1, props.page - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
          {t("上一页", "Previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={props.page >= pageCount}
          onClick={() => props.onPageChange(Math.min(pageCount, props.page + 1))}
        >
          {t("下一页", "Next")}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ChunksPanel(props: {
  chunks: ChunkRecord[];
  hasFilter?: boolean;
  onUpdateChunk: (chunkId: string, input: { heading?: string | null; content?: string; rawContent?: string | null }) => void;
  onDeleteChunk: (chunkId: string) => void;
}) {
  const { t } = useI18n();
  if (props.chunks.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的切片", "No matching chunks")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无切片", "No chunks yet")} description={t("文档处理后会在这里展示切片。", "Chunks appear here after document processing.")} />;
  }
  return (
    <div className="space-y-2">
      {props.chunks.map((chunk) => (
        <ChunkCard
          key={chunk.id}
          chunk={chunk}
          onUpdateChunk={props.onUpdateChunk}
          onDeleteChunk={props.onDeleteChunk}
        />
      ))}
    </div>
  );
}

function EventsPanel(props: {
  events: EventRecord[];
  hasFilter?: boolean;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
  onUpdateEvent: (eventId: string, input: { title?: string; summary?: string; content?: string }) => void;
  onDeleteEvent: (eventId: string) => void;
}) {
  const { t } = useI18n();
  if (props.events.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的事件", "No matching events")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无事件", "No events yet")} description={t("开启抽取后，事件会显示关联实体。", "Events and related entities appear after extraction is enabled.")} />;
  }
  return (
    <div className="space-y-2">
      {props.events.map((event) => (
        <EventCard
          key={event.id}
          event={event}
          onOpenEvent={props.onOpenEvent}
          onOpenEntity={props.onOpenEntity}
          onUpdateEvent={props.onUpdateEvent}
          onDeleteEvent={props.onDeleteEvent}
        />
      ))}
    </div>
  );
}

function EntitiesPanel(props: {
  entities: EntityRecord[];
  hasFilter?: boolean;
  onOpenEntity: (entityId: string) => void;
  onUpdateEntity: (entityId: string, input: { type?: string; name?: string; description?: string | null }) => void;
  onDeleteEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  if (props.entities.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的实体", "No matching entities")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无实体", "No entities yet")} description={t("事件抽取后会在这里聚合实体。", "Entities are aggregated here after event extraction.")} />;
  }
  return (
    <div className="space-y-2">
      {props.entities.map((entity) => (
        <EntityCard
          key={entity.id}
          entity={entity}
          onOpenEntity={props.onOpenEntity}
          onUpdateEntity={props.onUpdateEntity}
          onDeleteEntity={props.onDeleteEntity}
        />
      ))}
    </div>
  );
}

// 知识资产里的「编辑」改为页内行内编辑（#2）：点击编辑后直接在卡片里出现
// 输入框/文本域，改完点保存即可，不再弹出只能看到一行的浏览器对话框。
function InlineEditActions(props: { onSave: () => void; onCancel: () => void; saveDisabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.saveDisabled}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10",
          props.saveDisabled && "cursor-not-allowed opacity-50"
        )}
      >
        <Check className="h-3.5 w-3.5" />
        {t("保存", "Save")}
      </button>
      <button
        type="button"
        onClick={props.onCancel}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
        {t("取消", "Cancel")}
      </button>
    </div>
  );
}

function ChunkCard(props: {
  chunk: ChunkRecord;
  onUpdateChunk: (chunkId: string, input: { heading?: string | null; content?: string; rawContent?: string | null }) => void;
  onDeleteChunk: (chunkId: string) => void;
}) {
  const { t } = useI18n();
  const { chunk } = props;
  const [editing, setEditing] = useState(false);
  const [heading, setHeading] = useState(chunk.heading ?? "");
  const [content, setContent] = useState(chunk.content);

  function startEdit() {
    setHeading(chunk.heading ?? "");
    setContent(chunk.content);
    setEditing(true);
  }
  function save() {
    if (!content.trim()) return;
    props.onUpdateChunk(chunk.id, { heading, content });
    setEditing(false);
  }

  return (
    <Card>
      <CardContent className="space-y-2">
        {editing ? (
          <div className="space-y-2">
            <Input value={heading} onChange={(event) => setHeading(event.target.value)} placeholder={t("切片标题", "Chunk title")} />
            <Textarea value={content} onChange={(event) => setContent(event.target.value)} rows={6} placeholder={t("切片内容", "Chunk content")} />
            <InlineEditActions onSave={save} onCancel={() => setEditing(false)} saveDisabled={!content.trim()} />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-sm font-medium">{chunk.heading || t("未命名切片", "Untitled chunk")}</div>
              <Badge>{t(`排序 ${chunk.rank}`, `Rank ${chunk.rank}`)}</Badge>
            </div>
            <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{chunk.content}</p>
            <EmbeddingPreviewBlock title={t("切片 Embedding", "Chunk Embedding")} preview={chunk.embedding} />
            <div className="flex flex-wrap gap-2">
              <MiniButton onClick={startEdit}>{t("编辑", "Edit")}</MiniButton>
              <MiniButton
                danger
                onClick={() => {
                  if (window.confirm(t("删除这个切片及其关联事件？", "Delete this chunk and its linked events?"))) {
                    props.onDeleteChunk(chunk.id);
                  }
                }}
              >
                {t("删除", "Delete")}
              </MiniButton>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EventCard(props: {
  event: EventRecord;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
  onUpdateEvent: (eventId: string, input: { title?: string; summary?: string; content?: string }) => void;
  onDeleteEvent: (eventId: string) => void;
}) {
  const { t } = useI18n();
  const { event } = props;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(event.title);
  const [summary, setSummary] = useState(event.summary ?? "");
  const [content, setContent] = useState(event.content || event.summary || event.title);

  function startEdit() {
    setTitle(event.title);
    setSummary(event.summary ?? "");
    setContent(event.content || event.summary || event.title);
    setEditing(true);
  }
  function save() {
    if (!title.trim() || !content.trim()) return;
    props.onUpdateEvent(event.id, { title, summary, content });
    setEditing(false);
  }

  return (
    <Card>
      <CardContent className="space-y-2">
        {editing ? (
          <div className="space-y-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("事件标题", "Event title")} />
            <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} placeholder={t("事件摘要", "Event summary")} />
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder={t("事件内容", "Event content")} />
            <InlineEditActions onSave={save} onCancel={() => setEditing(false)} saveDisabled={!title.trim() || !content.trim()} />
          </div>
        ) : (
          <>
            <button className="w-full text-left text-sm font-semibold hover:underline" onClick={() => props.onOpenEvent(event.id)}>
              {event.title}
            </button>
            <p className="line-clamp-3 text-sm text-muted-foreground">{event.summary || event.content}</p>
            <div className="flex flex-wrap gap-1">
              {(event.entities ?? []).length === 0 ? (
                <Badge>{t(`${event.entityCount ?? 0} 个实体`, `${event.entityCount ?? 0} entities`)}</Badge>
              ) : (event.entities ?? []).map((entity) => (
                <button key={entity.id} onClick={() => props.onOpenEntity(entity.id)}>
                  <Badge>{entity.name}</Badge>
                </button>
              ))}
            </div>
            <div className="grid min-w-0 gap-2">
              <EmbeddingPreviewBlock title={t("标题 Embedding", "Title Embedding")} preview={event.titleEmbedding} />
              <EmbeddingPreviewBlock title={t("内容 Embedding", "Content Embedding")} preview={event.contentEmbedding} />
            </div>
            <div className="flex flex-wrap gap-2">
              <MiniButton onClick={startEdit}>{t("编辑", "Edit")}</MiniButton>
              <MiniButton
                danger
                onClick={() => {
                  if (window.confirm(t("删除这个事件？", "Delete this event?"))) {
                    props.onDeleteEvent(event.id);
                  }
                }}
              >
                {t("删除", "Delete")}
              </MiniButton>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EntityCard(props: {
  entity: EntityRecord;
  onOpenEntity: (entityId: string) => void;
  onUpdateEntity: (entityId: string, input: { type?: string; name?: string; description?: string | null }) => void;
  onDeleteEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  const { entity } = props;
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState(entity.type);
  const [name, setName] = useState(entity.name);
  const [description, setDescription] = useState(entity.description || "");

  function startEdit() {
    setType(entity.type);
    setName(entity.name);
    setDescription(entity.description || "");
    setEditing(true);
  }
  function save() {
    if (!type.trim() || !name.trim()) return;
    props.onUpdateEntity(entity.id, { type, name, description });
    setEditing(false);
  }

  return (
    <div className="w-full min-w-0 max-w-full rounded-md border border-border bg-background/80 p-3 text-left">
      {editing ? (
        <div className="space-y-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("实体名称", "Entity name")} />
          <Input value={type} onChange={(e) => setType(e.target.value)} placeholder={t("实体类型", "Entity type")} />
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder={t("实体描述", "Entity description")} />
          <InlineEditActions onSave={save} onCancel={() => setEditing(false)} saveDisabled={!type.trim() || !name.trim()} />
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{entity.name}</div>
              <div className="text-xs text-muted-foreground">{entity.type}</div>
            </div>
            <Badge>{t(`${entity.eventCount ?? 0} 事件`, `${entity.eventCount ?? 0} events`)}</Badge>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{entity.description || entity.normalizedName}</p>
          <div className="mt-2 min-w-0">
            <EmbeddingPreviewBlock title={t("实体 Embedding", "Entity Embedding")} preview={entity.embedding} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <MiniButton onClick={() => props.onOpenEntity(entity.id)}>{t("查看", "View")}</MiniButton>
            <MiniButton onClick={startEdit}>{t("编辑", "Edit")}</MiniButton>
            <MiniButton
              danger
              onClick={() => {
                if (window.confirm(t("删除这个实体及其关联关系？", "Delete this entity and its relations?"))) {
                  props.onDeleteEntity(entity.id);
                }
              }}
            >
              {t("删除", "Delete")}
            </MiniButton>
          </div>
        </>
      )}
    </div>
  );
}

function SearchPanel(props: {
  query: string;
  searchMode: SearchMode;
  result: SearchResult | null;
  isSearching: boolean;
  onQueryChange: (value: string) => void;
  onSearchModeChange: (value: SearchMode) => void;
  onSearch: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/25 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Zap className="h-4 w-4" />
          {t("检索模式", "Search mode")}
        </div>
        <div className="flex rounded-md border border-border bg-background p-0.5">
          {([
            { value: "fast" as const, label: t("极速", "Fast") },
            { value: "standard" as const, label: t("标准", "Standard") }
          ]).map((mode) => (
            <button
              key={mode.value}
              className={cn(
                "rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground",
                props.searchMode === mode.value && "bg-foreground text-background hover:text-background"
              )}
              onClick={() => props.onSearchModeChange(mode.value)}
              type="button"
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="basis-full text-xs text-muted-foreground">
          {props.searchMode === "fast"
            ? t("实体全文匹配 + qwen3-rerank，不走 LLM 过滤。", "Entity full-text matching + qwen3-rerank, without LLM filtering.")
            : t("LLM 抽取查询实体 + LLM 重排，适合对比质量。", "LLM extracts query entities + LLM reranking, useful for quality comparison.")}
        </div>
      </div>
      <div className="flex gap-2">
        <Input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder={t("输入检索问题", "Enter a search question")} />
        <Button size="sm" onClick={props.onSearch} disabled={props.isSearching}>
          {props.isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>
      {props.result ? (
        <div className="space-y-2">
          {props.result.sections.map((section) => (
            <Card key={section.chunkId}>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-medium">{section.heading || t("结果切片", "Result chunk")}</div>
                  <Badge>{section.score.toFixed(3)}</Badge>
                </div>
                <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{section.content}</p>
              </CardContent>
            </Card>
          ))}
          <JsonBlock title={t("检索链路", "Search trace")} value={props.result.trace ?? { traceId: props.result.traceId }} compact />
        </div>
      ) : (
        <EmptyState title={t("还没有检索结果", "No search results yet")} description={t("检索范围固定为当前项目。", "The search scope is fixed to the current project.")} />
      )}
    </div>
  );
}

type SettingsInput = {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string;
  clearEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  answerSystemPrompt: string;
  mermaidTemplate: string;
  mermaidPendingText: string;
  mcpSearchMode: SearchMode;
  graphDefaultLayoutStyle: string;
  welcomePromptTemplates: string[];
  longTermMemoryEnabled: boolean;
};

const DEFAULT_SEARCH_TOP_K = 10;
const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
const DEFAULT_CHUNK_TOKEN_LIMIT = 512;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function normalizeChunkingMode(value: unknown): ChunkingMode {
  return value === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

function SettingsPanel(props: {
  settings: PublicAiProviderSettings | null;
  isSaving: boolean;
  language: SupportedLanguage;
  languagePreference: LanguagePreference;
  onLanguagePreferenceChange: (preference: LanguagePreference) => void;
  onSave: (input: SettingsInput) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(1024);
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [clearEmbeddingApiKey, setClearEmbeddingApiKey] = useState(false);
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [clearLlmApiKey, setClearLlmApiKey] = useState(false);
  const [llmTimeoutMs, setLlmTimeoutMs] = useState(300000);
  const [llmMaxRetries, setLlmMaxRetries] = useState(2);
  const [defaultSearchMode, setDefaultSearchMode] = useState<SearchMode>("fast");
  const [defaultSearchTopK, setDefaultSearchTopK] = useState(10);
  const [defaultChunkingMode, setDefaultChunkingMode] = useState<ChunkingMode>("heading_strict");
  const [chunkTokenLimit, setChunkTokenLimit] = useState(512);
  const [chunkOverlapTokens, setChunkOverlapTokens] = useState(100);
  const [answerSystemPrompt, setAnswerSystemPrompt] = useState("");
  const [mermaidTemplate, setMermaidTemplate] = useState("");
  const [mermaidPendingText, setMermaidPendingText] = useState("");
  const [mcpSearchMode, setMcpSearchMode] = useState<SearchMode>("fast");
  const [graphDefaultLayoutStyle, setGraphDefaultLayoutStyle] = useState("search_layers");
  const [welcomePromptText, setWelcomePromptText] = useState("");
  const [longTermMemoryEnabled, setLongTermMemoryEnabled] = useState(false);

  useEffect(() => {
    if (!props.settings) return;
    setEmbeddingBaseUrl(props.settings.embeddingBaseUrl);
    setEmbeddingModel(props.settings.embeddingModel);
    setEmbeddingDimensions(props.settings.embeddingDimensions);
    setEmbeddingApiKey("");
    setClearEmbeddingApiKey(false);
    setLlmBaseUrl(props.settings.llmBaseUrl);
    setLlmModel(props.settings.llmModel);
    setLlmApiKey("");
    setClearLlmApiKey(false);
    setLlmTimeoutMs(props.settings.llmTimeoutMs);
    setLlmMaxRetries(props.settings.llmMaxRetries);
    setDefaultSearchMode(props.settings.defaultSearchMode);
    setDefaultSearchTopK(boundedInteger(props.settings.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, 50));
    setDefaultChunkingMode(normalizeChunkingMode(props.settings.defaultChunkingMode));
    const normalizedTokenLimit = boundedInteger(props.settings.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    setChunkTokenLimit(normalizedTokenLimit);
    setChunkOverlapTokens(
      boundedInteger(props.settings.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, normalizedTokenLimit - 1)
    );
    setAnswerSystemPrompt(props.settings.answerSystemPrompt);
    setMermaidTemplate(props.settings.mermaidTemplate);
    setMermaidPendingText(props.settings.mermaidPendingText);
    setMcpSearchMode(props.settings.mcpSearchMode);
    setGraphDefaultLayoutStyle(props.settings.graphDefaultLayoutStyle);
    setWelcomePromptText(props.settings.welcomePromptTemplates.join("\n"));
    setLongTermMemoryEnabled(props.settings.longTermMemoryEnabled);
  }, [props.settings]);

  useEffect(() => {
    setChunkOverlapTokens((current) => Math.min(current, Math.max(0, chunkTokenLimit - 1)));
  }, [chunkTokenLimit]);

  if (!props.settings) return <EmptyState title={t("正在加载设置", "Loading settings")} description={t("请稍候。", "Please wait.")} />;

  return (
    <form
      className="mx-auto grid max-w-4xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave({
          embeddingBaseUrl,
          embeddingModel,
          embeddingDimensions,
          embeddingApiKey,
          clearEmbeddingApiKey,
          llmBaseUrl,
          llmModel,
          llmApiKey,
          clearLlmApiKey,
          llmTimeoutMs,
          llmMaxRetries,
          defaultSearchMode,
          defaultSearchTopK,
          defaultChunkingMode,
          chunkTokenLimit,
          chunkOverlapTokens,
          answerSystemPrompt,
          mermaidTemplate,
          mermaidPendingText,
          mcpSearchMode,
          graphDefaultLayoutStyle,
          welcomePromptTemplates: welcomePromptText.split("\n").map((item) => item.trim()).filter(Boolean),
          longTermMemoryEnabled
        });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">CHEMCLOUD SYSTEM</div>
          <h2 className="mt-1 text-base font-semibold">{t("知识引擎与模型设置", "Knowledge engine and model settings")}</h2>
          <p className="text-xs text-muted-foreground">{t("密钥只显示配置状态，不回显明文。", "Keys only show configuration status and are never echoed in plaintext.")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-xs text-muted-foreground">{t("更新于", "Updated")} {formatDate(props.settings.updatedAt)}</div>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>{t("退出设置", "Exit settings")}</Button>
        </div>
      </div>

      <ThemeSettingsCard />

      <SettingsCard title={t("界面", "Interface")} badge={props.language === "zh" ? "中文" : "English"}>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("界面语言", "Interface language")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "auto" as const, label: t("自动", "Auto") },
              { value: "zh" as const, label: "中文" },
              { value: "en" as const, label: "English" }
            ]).map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  props.languagePreference === option.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => props.onLanguagePreferenceChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {t(
              `当前显示语言：${props.language === "zh" ? "中文" : "英文"}。自动模式会根据浏览器语言选择。`,
              `Current display language: ${props.language === "zh" ? "Chinese" : "English"}. Auto mode follows the browser language.`
            )}
          </div>
        </div>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("知识超图默认重排样式", "Default graph layout")}</div>
          <div className="flex w-fit flex-wrap rounded-md border border-border bg-background p-0.5">
            {([
              { value: "search_layers", label: t("搜索居中", "Search-centered") },
              { value: "columns", label: t("分栏", "Columns") }
            ]).map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  graphDefaultLayoutStyle === option.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setGraphDefaultLayoutStyle(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t("欢迎页问题", "Welcome prompts")} badge={t("可编辑", "Editable")}>
        <div className="space-y-2 md:col-span-2">
          <div className="text-sm font-medium">{t("默认问题（每行一个）", "Default prompts (one per line)")}</div>
          <Textarea
            className="min-h-44 text-xs leading-5"
            value={welcomePromptText}
            onChange={(event) => setWelcomePromptText(event.target.value)}
          />
          <div className="text-xs leading-5 text-muted-foreground">
            {t(
              "支持占位符：{projectName}、{focus}、{secondary}。留空保存时会恢复默认问题。",
              "Supported placeholders: {projectName}, {focus}, {secondary}. Saving an empty value restores the defaults."
            )}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t("长期记忆", "Long-term memory")} badge={longTermMemoryEnabled ? t("已开启", "On") : t("已关闭", "Off")}>
        <div className="space-y-3 md:col-span-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={longTermMemoryEnabled}
              onChange={(event) => setLongTermMemoryEnabled(event.target.checked)}
            />
            {t("开启后，系统会总结本项目问答中的长期偏好，并用于后续回答风格和图谱呈现。", "When enabled, SAG summarizes long-term preferences in this project's chats and uses them for later answer style and graph presentation.")}
          </label>
          <div className="text-xs leading-5 text-muted-foreground">
            {t("默认关闭。关闭后不会读取或更新长期记忆；已保存的历史记忆会保留但不生效。", "Off by default. When disabled, memory is neither read nor updated; existing saved memory is kept but ignored.")}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="AI Provider" badge="302.ai">
        <Field label={t("Embedding 接口地址", "Embedding API base URL")}>
          <Input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} />
        </Field>
        <Field label={t("Embedding 模型", "Embedding model")}>
          <Input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />
        </Field>
        <Field label={t("向量维度（数据库固定）", "Vector dimensions (database fixed)")}>
          <Input type="number" min={1024} max={1024} value={embeddingDimensions} disabled onChange={(event) => setEmbeddingDimensions(Number(event.target.value))} />
        </Field>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 md:col-span-2">
          {t(
            "Embedding 必须填写“向量模型”的 OpenAI 兼容接口，本项目会自动请求 接口地址 + /embeddings，并且数据库固定要求 1024 维。DeepSeek 聊天模型通常只能填在 LLM 区域；如果第三方中转没有把 DeepSeek 密钥映射到可用的 embedding 模型，就会报错。建议选择支持 1024 维的 bge-m3、jina-embeddings-v3 或中转平台明确标注的 embedding 模型。",
            "Embedding must use an OpenAI-compatible embedding model endpoint. SAG calls base URL + /embeddings, and the database requires 1024 dimensions. DeepSeek chat models usually belong in the LLM fields; they will fail here unless your relay maps the key to a real embedding model. Use a 1024-dimensional model such as bge-m3, jina-embeddings-v3, or an embedding model explicitly listed by your relay."
          )}
        </div>
        <Field label={t(`Embedding 密钥：${props.settings.hasEmbeddingApiKey ? "已配置" : "未配置"}`, `Embedding key: ${props.settings.hasEmbeddingApiKey ? "configured" : "not configured"}`)}>
          <Input
            type="password"
            value={embeddingApiKey}
            onChange={(event) => {
              setEmbeddingApiKey(event.target.value);
              if (event.target.value.trim()) setClearEmbeddingApiKey(false);
            }}
            placeholder={t("留空不修改", "Leave blank to keep unchanged")}
          />
        </Field>
        <Field label={t("LLM 接口地址", "LLM API base URL")}>
          <Input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} />
        </Field>
        <Field label={t("LLM 模型", "LLM model")}>
          <Input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} />
        </Field>
        <Field label={t("超时毫秒（第三方中转建议 300000）", "Timeout in ms (300000 recommended for relays)")}>
          <Input type="number" min={10000} step={10000} value={llmTimeoutMs} onChange={(event) => setLlmTimeoutMs(Number(event.target.value))} />
        </Field>
        <Field label={t("重试次数", "Retry count")}>
          <Input type="number" min={0} max={10} value={llmMaxRetries} onChange={(event) => setLlmMaxRetries(Number(event.target.value))} />
        </Field>
        <Field label={t(`LLM 密钥：${props.settings.hasLlmApiKey ? "已配置" : "未配置"}`, `LLM key: ${props.settings.hasLlmApiKey ? "configured" : "not configured"}`)}>
          <Input
            type="password"
            value={llmApiKey}
            onChange={(event) => {
              setLlmApiKey(event.target.value);
              if (event.target.value.trim()) setClearLlmApiKey(false);
            }}
            placeholder={t("留空不修改", "Leave blank to keep unchanged")}
          />
        </Field>
      </SettingsCard>

      <SettingsCard title={t("回答风格", "Answer style")} badge={t("可编辑", "Editable")}>
        <div className="space-y-2 md:col-span-2">
          <div className="text-sm font-medium">{t("系统提示词", "System prompt")}</div>
          <Textarea
            className="min-h-36 font-mono text-xs leading-5"
            value={answerSystemPrompt}
            onChange={(event) => setAnswerSystemPrompt(event.target.value)}
          />
          <div className="text-xs leading-5 text-muted-foreground">
            {t(
              "用于控制智能问答最终答案的专业程度、语气、结构和引用方式。留空保存时会恢复默认提示词。",
              "Controls the final Q&A answer style, tone, structure, and citation behavior. Saving an empty value restores the default prompt."
            )}
          </div>
        </div>
        <div className="space-y-2 md:col-span-2">
          <div className="text-sm font-medium">{t("Mermaid 产业链图模板", "Mermaid industry-chain template")}</div>
          <Textarea
            className="min-h-72 font-mono text-xs leading-5"
            value={mermaidTemplate}
            onChange={(event) => setMermaidTemplate(event.target.value)}
          />
          <div className="text-xs leading-5 text-muted-foreground">
            {t(
              "开启“自动生成 Mermaid 图”后，模型会参考这个模板的分组和样式，并用检索证据替换节点与关系。",
              "When automatic Mermaid diagrams are enabled, the model follows this grouping and style template while replacing nodes and relationships with retrieved evidence."
            )}
          </div>
        </div>
        <Field label={t("Mermaid 等待文案", "Mermaid loading text")}>
          <Input
            value={mermaidPendingText}
            onChange={(event) => setMermaidPendingText(event.target.value)}
            placeholder="ChemClaw正在绘制产业链关系图"
          />
        </Field>
      </SettingsCard>

      <SettingsCard title={t("检索", "Search")} badge={defaultSearchMode === "fast" ? t("极速", "Fast") : t("标准", "Standard")}>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("默认检索模式", "Default search mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "fast" as const, label: t("极速模式", "Fast mode"), description: t("实体全文匹配 + qwen3-rerank，不调用 LLM 抽 key 和过滤。", "Entity full-text matching + qwen3-rerank, without LLM key extraction or filtering.") },
              { value: "standard" as const, label: t("标准模式", "Standard mode"), description: t("LLM 抽取查询实体 + LLM 重排，适合质量对比。", "LLM extracts query entities + LLM reranking, useful for quality comparison.") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  defaultSearchMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setDefaultSearchMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {defaultSearchMode === "fast"
              ? t("默认使用极速链路：问题直接匹配实体库，最后用 qwen3-rerank 选 top-k。", "Default fast path: match the question directly against the entity store, then use qwen3-rerank to select top-k.")
              : t("默认使用标准链路：先由 LLM 识别查询实体，最后由 LLM 选择候选事件。", "Default standard path: first let the LLM identify query entities, then let the LLM choose candidate events.")}
          </div>
        </div>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("智能问答 MCP 搜索模式", "Q&A MCP search mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "fast" as const, label: t("极速模式", "Fast mode") },
              { value: "standard" as const, label: t("标准模式", "Standard mode") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  mcpSearchMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setMcpSearchMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {mcpSearchMode === "fast"
              ? t("智能问答默认用极速链路，减少 LLM 重排等待。", "Q&A uses the fast path by default to reduce LLM rerank waits.")
              : t("智能问答默认用标准链路，会启用 LLM 抽取与重排，质量更高但更慢。", "Q&A uses the standard path by default, enabling LLM extraction and reranking; higher quality but slower.")}
          </div>
        </div>
        <Field label={t("默认 Top-K", "Default top-k")}>
          <Input
            type="number"
            min={1}
            max={50}
            value={defaultSearchTopK}
            onChange={(event) => setDefaultSearchTopK(Number(event.target.value))}
          />
        </Field>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("默认切片模式", "Default chunking mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "heading_strict" as const, label: t("标题严格", "Heading strict") },
              { value: "token" as const, label: t("Token 强制", "Token window") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  defaultChunkingMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setDefaultChunkingMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {defaultChunkingMode === "heading_strict"
              ? t("默认与 benchmark 一致：遇到新标题就形成独立切片，不按 token 合并短片段。", "Matches the benchmark default: each heading section becomes an independent chunk without token-based merging.")
              : t("强制按 token 窗口切片，并按 overlap 保留上下文。", "Force token-window chunking and keep context with overlap.")}
          </div>
        </div>
        <Field label={t("Token 数", "Token limit")}>
          <Input
            type="number"
            min={64}
            max={8192}
            value={chunkTokenLimit}
            onChange={(event) => setChunkTokenLimit(Number(event.target.value))}
          />
        </Field>
        <Field label={t("Overlap tokens", "Overlap tokens")}>
          <Input
            type="number"
            min={0}
            max={Math.max(0, chunkTokenLimit - 1)}
            value={chunkOverlapTokens}
            onChange={(event) => setChunkOverlapTokens(Number(event.target.value))}
          />
        </Field>
      </SettingsCard>

      <SettingsCard title={t("危险操作", "Danger zone")} badge={t("谨慎", "Careful")}>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={clearEmbeddingApiKey}
            onChange={(event) => {
              setClearEmbeddingApiKey(event.target.checked);
              if (event.target.checked) setEmbeddingApiKey("");
            }}
          />
          {t("清空 Embedding 密钥", "Clear Embedding key")}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={clearLlmApiKey}
            onChange={(event) => {
              setClearLlmApiKey(event.target.checked);
              if (event.target.checked) setLlmApiKey("");
            }}
          />
          {t("清空 LLM 密钥", "Clear LLM key")}
        </label>
      </SettingsCard>

      <div className="flex justify-end">
        <Button type="submit" disabled={props.isSaving}>
          {props.isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("保存设置", "Save settings")}
        </Button>
      </div>
    </form>
  );
}

function ProjectMcpWorkspace({ project, settings }: { project: SourceRecord | null; settings: PublicMcpSettings | null }) {
  const { t } = useI18n();
  if (!project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先选择项目", "Select a project first")} description={t("MCP server 会绑定到当前项目，选择项目后可查看对应的接入配置和工具说明。", "The MCP server binds to the current project. Select a project to view integration config and tool details.")} />
      </section>
    );
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto grid max-w-4xl gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">CHEMCLAW CONNECT</div>
            <h2 className="mt-1 text-base font-semibold">{t("接入 ChemClaw 智能入口", "Connect to the ChemClaw intelligence portal")}</h2>
            <p className="text-xs text-muted-foreground">{t("当前知识空间 ID 会写入 MCP server 启动配置，供 ChemClaw 直接调用产业链知识能力。", "The current knowledge-space ID is written into the MCP server config for direct ChemClaw access.")}</p>
          </div>
          <Badge>{project.name}</Badge>
        </div>
        <McpSettingsCard project={project} settings={settings} />
      </div>
    </section>
  );
}

function McpSettingsCard({ project, settings }: { project: SourceRecord; settings: PublicMcpSettings | null }) {
  const { t } = useI18n();
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null);

  if (!settings) {
    return (
      <SettingsCard title="MCP" badge={t("加载中", "Loading")}>
        <div className="text-sm text-muted-foreground">{t("正在加载 MCP 信息。", "Loading MCP information.")}</div>
      </SettingsCard>
    );
  }
  const externalClientConfig = settings.clientConfigs.find((clientConfig) => clientConfig.id === "stdio-npm")
    ?? settings.clientConfigs[0]
    ?? null;
  const externalClientConfigValue = externalClientConfig
    ? replaceMcpProjectPlaceholder(externalClientConfig.config, project.id)
    : null;
  return (
    <SettingsCard title="MCP" badge={t("自动可用", "Auto available")}>
      <PanelInfo
        label={t("当前项目", "Current project")}
        value={`${project.name} / ${project.id}`}
        multiline
      />
      <PanelInfo
        label={t("项目绑定", "Project binding")}
        value={t("MCP server 启动时读取 SAG_MCP_SOURCE_ID，所有工具默认只访问这个项目。", "The MCP server reads SAG_MCP_SOURCE_ID at startup, and all tools access only this project by default.")}
        multiline
      />
      <PanelInfo label={t("工具超时", "Tool timeout")} value={t(`${settings.toolTimeoutMs} 毫秒`, `${settings.toolTimeoutMs} ms`)} />
      {externalClientConfig && externalClientConfigValue ? (
        <div className="space-y-3 md:col-span-2">
          <div>
            <div className="text-xs font-medium text-muted-foreground">mcpServers JSON</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("复制给其他 Agent 后会直接绑定当前项目；切换项目后这里会自动换成对应项目 ID。", "Copy this to another agent to bind directly to the current project. Switching projects updates the project ID automatically.")}
            </div>
          </div>
          <CopyableCodeBlock
            label={t("JSON 配置", "JSON config")}
            value={JSON.stringify(externalClientConfigValue, null, 2) ?? ""}
          />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t("可用工具", "Available tools")}</div>
        <div className="grid gap-2">
          {settings.tools.map((tool) => (
            <McpToolCard
              key={tool.name}
              tool={tool}
              expanded={expandedToolName === tool.name}
              onToggle={() => setExpandedToolName((current) => current === tool.name ? null : tool.name)}
            />
          ))}
        </div>
      </div>
    </SettingsCard>
  );
}

function replaceMcpProjectPlaceholder(value: unknown, projectId: string): unknown {
  if (typeof value === "string") {
    return value === "__SAG_LITE_PROJECT_ID__" ? projectId : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceMcpProjectPlaceholder(item, projectId));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceMcpProjectPlaceholder(item, projectId)])
    );
  }
  return value;
}

function McpToolCard({
  tool,
  expanded,
  onToggle
}: {
  tool: PublicMcpSettings["tools"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("rounded-md border border-border", expanded && "border-foreground/30 bg-muted/20")}>
      <button
        type="button"
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{tool.name}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{expanded ? t("收起", "Collapse") : t("展开", "Expand")}</span>
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border p-3 pt-3">
          <JsonBlock title={t("输入参数 Schema", "Input schema")} value={tool.inputSchema} compact preserveRaw />
          <JsonBlock title={t("调用示例", "Call example")} value={tool.example} compact preserveRaw />
        </div>
      ) : null}
    </div>
  );
}

function CopyableCodeBlock({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? t("已复制", "Copied") : t("复制", "Copy")}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5">
        {value}
      </pre>
    </div>
  );
}

function DetailDrawer(props: {
  drawer: Exclude<DetailDrawer, null>;
  onClose: () => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  const drawer = props.drawer;
  const drawerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && drawerRef.current?.contains(target)) {
        return;
      }
      props.onClose();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [props]);
  return (
    <div className="pointer-events-none fixed inset-0 z-20" role="presentation">
      <aside
        ref={drawerRef}
        className="pointer-events-auto absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col border-l border-border bg-background shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="whitespace-normal break-words text-sm font-semibold leading-5">
              {drawer.type === "event"
                ? drawer.detail.event.title
                : drawer.type === "entity"
                  ? drawer.detail.entity.name
                  : t(`引用 ${drawer.citation.index}`, `Citation ${drawer.citation.index}`)}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {drawer.type === "event"
                ? t("事件详情", "Event details")
                : drawer.type === "entity"
                  ? t("实体详情", "Entity details")
                  : t("引用原文", "Source citation")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={props.onClose}>{t("关闭", "Close")}</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
          {drawer.type === "event" ? (
            <EventDetailPanel detail={drawer.detail} onOpenEntity={props.onOpenEntity} />
          ) : drawer.type === "entity" ? (
            <EntityDetailPanel detail={drawer.detail} onOpenEvent={props.onOpenEvent} />
          ) : (
            <CitationDetailPanel citation={drawer.citation} />
          )}
        </div>
      </aside>
    </div>
  );
}

function EventDetailPanel({ detail, onOpenEntity }: { detail: EventDetailRecord; onOpenEntity: (entityId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("所属文档", "Source document")} value={detail.document?.title ?? t("未知文档", "Unknown document")} />
      <PanelInfo label={t("事件内容", "Event content")} value={detail.event.content || detail.event.summary} multiline />
      <PanelSection title={t("关联实体", "Related entities")}>
        <div className="flex flex-wrap gap-2">
          {detail.entities.length === 0 ? <EmptyLine text={t("暂无关联实体。", "No related entities.")} /> : detail.entities.map((entity) => (
            <button key={entity.id} onClick={() => onOpenEntity(entity.id)}>
              <Badge>{entity.name}</Badge>
            </button>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t("关联切片", "Related chunk")}>
        {detail.chunk ? (
          <Card>
            <CardContent>
              <div className="mb-2 text-xs text-muted-foreground">{detail.chunk.heading || t(`排序 ${detail.chunk.rank ?? 0}`, `Rank ${detail.chunk.rank ?? 0}`)}</div>
              <p className="whitespace-pre-wrap text-sm leading-6">{detail.chunk.content}</p>
            </CardContent>
          </Card>
        ) : <EmptyLine text={t("没有关联切片。", "No related chunk.")} />}
      </PanelSection>
    </div>
  );
}

function EntityDetailPanel({ detail, onOpenEvent }: { detail: EntityDetailRecord; onOpenEvent: (eventId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("类型", "Type")} value={detail.entity.type} />
      <PanelInfo label={t("描述", "Description")} value={detail.entity.description || detail.entity.normalizedName} multiline />
      <PanelSection title={t(`关联事件（${detail.events.length}）`, `Related events (${detail.events.length})`)}>
        <div className="space-y-2">
          {detail.events.length === 0 ? <EmptyLine text={t("暂无关联事件。", "No related events.")} /> : detail.events.map((event) => (
            <button key={event.id} className="w-full rounded-md border border-border p-3 text-left hover:bg-accent" onClick={() => onOpenEvent(event.id)}>
              <div className="text-sm font-medium">{event.title}</div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{event.summary || event.content}</p>
            </button>
          ))}
        </div>
      </PanelSection>
    </div>
  );
}

function CitationDetailPanel({ citation }: { citation: AnswerCitation }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("切片标题", "Chunk title")} value={citation.heading || t(`引用 ${citation.index}`, `Citation ${citation.index}`)} />
      <div className="grid grid-cols-2 gap-3">
        <PanelInfo label={t("排序", "Rank")} value={citation.rank == null ? "-" : String(citation.rank)} />
        <PanelInfo label={t("得分", "Score")} value={citation.score == null ? "-" : citation.score.toFixed(4)} />
      </div>
      {citation.query ? <PanelInfo label={t("搜索语句", "Search query")} value={citation.query} multiline /> : null}
      <PanelInfo label={t("切片 ID", "Chunk ID")} value={citation.chunkId} />
      {citation.documentId ? <PanelInfo label={t("文档 ID", "Document ID")} value={citation.documentId} /> : null}
      <PanelSection title={t("原文块", "Original chunk")}>
        <Card>
          <CardContent>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{citation.content}</p>
          </CardContent>
        </Card>
      </PanelSection>
    </div>
  );
}

function SettingsCard({ title, badge, children }: { title: string; badge: string; children: ReactNode }) {
  return (
    <Card className="chem-settings-card">
      <CardHeader className="flex flex-row items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge>{badge}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function PanelInfo({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("break-words text-sm", multiline && "whitespace-pre-wrap leading-6")}>{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="chem-metric rounded-xl border border-border px-3 py-3">
      <div className="text-xl font-bold tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11px] font-medium text-muted-foreground">{label}</div>
    </div>
  );
}

function MiniButton({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground",
        danger && "text-red-600 hover:text-red-700"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function EmbeddingPreviewBlock({ title, preview }: { title: string; preview?: EmbeddingPreview | null }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/30 p-2 text-left">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{title}</span>
        <Badge className="shrink-0">{preview ? t(`${preview.dimensions} 维`, `${preview.dimensions} dims`) : t("未生成", "Not generated")}</Badge>
      </div>
      {preview ? (
        <code className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          [{preview.sample.map((value) => formatEmbeddingNumber(value)).join(", ")}{preview.dimensions > preview.sample.length ? ", ..." : ""}]
        </code>
      ) : (
        <div className="text-xs text-muted-foreground">{t("数据库中还没有这个向量。", "This vector is not in the database yet.")}</div>
      )}
    </div>
  );
}

function getMessageCitations(message: McpMessageRecord): AnswerCitation[] {
  const value = message.metadata.citations;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeAnswerCitation)
    .filter((citation): citation is AnswerCitation => citation !== null)
    .slice(0, 5);
}

function normalizeAnswerCitation(value: unknown): AnswerCitation | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const index = typeof value.index === "number" ? value.index : Number(value.index);
  const chunkId = typeof value.chunkId === "string" ? value.chunkId : "";
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : "";
  const content = typeof value.content === "string" ? value.content : "";
  if (!Number.isInteger(index) || index <= 0 || !chunkId || !sourceId || !content) {
    return null;
  }
  return {
    index,
    chunkId,
    sourceId,
    documentId: typeof value.documentId === "string" ? value.documentId : undefined,
    heading: typeof value.heading === "string" ? value.heading : undefined,
    content,
    rank: typeof value.rank === "number" ? value.rank : undefined,
    score: typeof value.score === "number" ? value.score : undefined,
    query: typeof value.query === "string" ? value.query : undefined
  };
}

function buildKnowledgeAssetOverview(detail: McpSessionDetail | null): KnowledgeAssetOverview {
  if (!detail) {
    return { citations: [], events: [], entities: [], searchCount: 0 };
  }
  const citations = uniqueCitations(
    detail.messages
      .filter((message) => message.role === "assistant")
      .flatMap(getMessageCitations)
  );
  const events = new Map<string, KnowledgeAssetOverview["events"][number]>();
  const entities = new Map<string, KnowledgeAssetOverview["entities"][number]>();
  let searchCount = 0;

  for (const toolCall of detail.toolCalls) {
    if (toolCall.toolName !== "sag_search") continue;
    searchCount += 1;
    const parsed = parseToolResponse(toolCall.result);
    const trace = extractSearchTrace(parsed);
    collectEventSnapshots(trace, events);
    collectEntitySnapshots(trace, entities);
  }

  return {
    citations,
    events: [...events.values()],
    entities: [...entities.values()],
    searchCount
  };
}

function mergeKnowledgeAssetOverview(base: KnowledgeAssetOverview, chunkAssets: ChunkAssetLookup | null): KnowledgeAssetOverview {
  if (!chunkAssets) {
    return base;
  }
  const events = new Map(base.events.map((event) => [event.id, event]));
  const entities = new Map(base.entities.map((entity) => [entity.id, entity]));
  for (const event of chunkAssets.events) {
    if (!events.has(event.id)) {
      events.set(event.id, {
        id: event.id,
        title: event.title,
        summary: event.summary || event.content,
        score: event.score,
        rank: event.rank
      });
    }
    for (const entity of event.entities ?? []) {
      if (!entities.has(entity.id)) {
        entities.set(entity.id, {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          description: entity.description ?? undefined,
          score: entity.score,
          eventCount: entity.eventCount
        });
      }
    }
  }
  for (const entity of chunkAssets.entities) {
    if (!entities.has(entity.id)) {
      entities.set(entity.id, {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        description: entity.description ?? undefined,
        score: entity.score,
        eventCount: entity.eventCount
      });
    }
  }
  return {
    ...base,
    events: [...events.values()],
    entities: [...entities.values()]
  };
}

function uniqueCitations(citations: AnswerCitation[]) {
  const byChunkId = new Map<string, AnswerCitation>();
  for (const citation of citations) {
    if (!byChunkId.has(citation.chunkId)) {
      byChunkId.set(citation.chunkId, citation);
    }
  }
  return [...byChunkId.values()];
}

function collectEventSnapshots(trace: Record<string, unknown> | null, target: Map<string, KnowledgeAssetOverview["events"][number]>) {
  if (!trace) return;
  for (const key of ["eventSnapshots", "rerankedEvents", "coarseRankedEvents", "queryEvents", "expandedEvents"]) {
    const items = Array.isArray(trace[key]) ? trace[key] : [];
    for (const item of items) {
      if (!isPlainRecord(item)) continue;
      const id = readRecordString(item, "id") || readRecordString(item, "eventId") || readRecordString(item, "systemEventId");
      const title = readRecordString(item, "title") || readRecordString(item, "eventTitle");
      if (!id || !title || target.has(id)) continue;
      target.set(id, {
        id,
        title,
        summary: readRecordString(item, "summary") || readRecordString(item, "content"),
        score: readRecordNumber(item, "score"),
        rank: readRecordNumber(item, "rank")
      });
    }
  }
}

function collectEntitySnapshots(trace: Record<string, unknown> | null, target: Map<string, KnowledgeAssetOverview["entities"][number]>) {
  if (!trace) return;
  for (const key of ["recalledEntities", "queryEntities", "entities"]) {
    const items = Array.isArray(trace[key]) ? trace[key] : [];
    for (const item of items) {
      if (typeof item === "string") {
        if (!target.has(item)) target.set(item, { id: item, name: item });
        continue;
      }
      if (!isPlainRecord(item)) continue;
      const name = readRecordString(item, "name") || readRecordString(item, "entityName");
      if (!name) continue;
      const id = readRecordString(item, "id") || readRecordString(item, "entityId") || `${readRecordString(item, "type")}:${name}`;
      if (target.has(id)) continue;
      target.set(id, {
        id,
        name,
        type: readRecordString(item, "type") || readRecordString(item, "entityType"),
        description: readRecordString(item, "description"),
        score: readRecordNumber(item, "score"),
        eventCount: readRecordNumber(item, "eventCount")
      });
    }
  }
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function JsonBlock({ title, value, compact, preserveRaw }: { title: string; value: unknown; compact?: boolean; preserveRaw?: boolean }) {
  const { t } = useI18n();
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const renderedValue = preserveRaw ? content : formatDataContent(content, t);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className={cn("overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5", compact ? "max-h-64" : "max-h-96")}>
        {renderedValue}
      </pre>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">{text}</div>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function resultViewLabel(view: ResultView, language: SupportedLanguage) {
  if (view === "overview") return language === "en" ? "Overview" : "概览";
  if (view === "chunks") return language === "en" ? "Chunks" : "切片";
  if (view === "events") return language === "en" ? "Events" : "事件";
  if (view === "entities") return language === "en" ? "Entities" : "实体";
  return language === "en" ? "Search" : "检索";
}

function filterByKeyword<T>(items: T[], keyword: string, getTitle: (item: T) => string) {
  if (!keyword) return items;
  return items.filter((item) => normalizeKeyword(getTitle(item)).includes(keyword));
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  return items.slice(offset, offset + pageSize);
}

function normalizeKeyword(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function contextPanelModeLabel(mode: ContextPanelMode, t: (zh: string, en: string) => string) {
  if (mode === "process") return t("推理链路", "Reasoning trace");
  if (mode === "assets") return t("引用资产", "Assets");
  return t("模型日志", "Model logs");
}

function loadStoredModelLogs(): ModelCallLogRecord[] {
  try {
    const raw = window.localStorage.getItem(MODEL_LOGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ModelCallLogRecord[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_BROWSER_MODEL_LOGS) : [];
  } catch {
    return [];
  }
}

function loadStoredNumber(key: string, fallback: number, min: number, max: number) {
  const value = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(value)) return fallback;
  return clampNumber(value, min, max);
}

function loadStoredBoolean(key: string, fallback: boolean) {
  const raw = window.localStorage.getItem(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function startPanelResize(
  event: ReactPointerEvent,
  options: {
    startWidth: number;
    minWidth: number;
    maxWidth: number;
    getWidth: (startWidth: number, deltaX: number) => number;
    onResize: (width: number) => void;
  }
) {
  event.preventDefault();
  const startX = event.clientX;
  document.body.classList.add("chem-panel-resizing");
  const onPointerMove = (moveEvent: PointerEvent) => {
    const nextWidth = options.getWidth(options.startWidth, moveEvent.clientX - startX);
    options.onResize(clampNumber(nextWidth, options.minWidth, options.maxWidth));
  };
  const onPointerUp = () => {
    document.body.classList.remove("chem-panel-resizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function loadStoredModelLogCursor(): number {
  const raw = window.localStorage.getItem(MODEL_LOG_CURSOR_STORAGE_KEY);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeModelLogs(current: ModelCallLogRecord[], incoming: ModelCallLogRecord[]): ModelCallLogRecord[] {
  const byId = new Map<string, ModelCallLogRecord>();
  for (const log of [...current, ...incoming]) {
    byId.set(log.id, log);
  }
  return [...byId.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-MAX_BROWSER_MODEL_LOGS);
}

function persistModelLogs(logs: ModelCallLogRecord[]) {
  for (const limit of [MAX_BROWSER_MODEL_LOGS, 100, 50, 20]) {
    try {
      window.localStorage.setItem(MODEL_LOGS_STORAGE_KEY, JSON.stringify(logs.slice(-limit)));
      return;
    } catch {
      // localStorage may exceed quota because embedding responses contain full vectors.
    }
  }
  try {
    window.localStorage.removeItem(MODEL_LOGS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; logs are diagnostic-only.
  }
}

function uploadStatusLabel(status: UploadJobRecord["status"], t: (zh: string, en: string) => string) {
  if (status === "QUEUED") return t("排队中", "Queued");
  if (status === "RUNNING") return t("处理中", "Processing");
  if (status === "COMPLETED") return t("完成", "Completed");
  return t("失败", "Failed");
}

function uploadStageLabel(stage: UploadJobRecord["stage"], t: (zh: string, en: string) => string) {
  if (stage === "QUEUED") return t("排队", "Queued");
  if (stage === "READING") return t("读取文件", "Reading file");
  if (stage === "PARSING") return t("解析文档", "Parsing document");
  if (stage === "CHUNKING") return t("生成切片", "Generating chunks");
  if (stage === "EMBEDDING_CHUNKS") return t("切片向量化", "Embedding chunks");
  if (stage === "EXTRACTING_EVENTS") return t("抽取事件", "Extracting events");
  if (stage === "EMBEDDING_EVENTS") return t("事件与实体向量化", "Embedding events and entities");
  if (stage === "WRITING_GRAPH") return t("写入图谱", "Writing graph");
  if (stage === "COMPLETED") return t("处理完成", "Completed");
  return t("处理失败", "Failed");
}

function processStatusLabel(status: ProcessStepStatus, t: (zh: string, en: string) => string) {
  if (status === "running") return t("运行中", "Running");
  if (status === "failed") return t("失败", "Failed");
  return t("完成", "Done");
}

function processStatusClassName(status: ProcessStepStatus) {
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  if (status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
  return "";
}

function makeStepId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomId}`;
}

function buildSearchProcessSteps(result: SearchResult, language: SupportedLanguage): ProcessStep[] {
  const trace = result.trace ?? { traceId: result.traceId };
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  return [
    {
      id: makeStepId("search-start"),
      title: t("开始检索", "Start search"),
      detail: t(
        `查询：${searchTraceText(trace, "query") ?? "当前问题"}；模式：${searchModeLabel(searchTraceText(trace, "searchMode"), language)}`,
        `Query: ${searchTraceText(trace, "query") ?? "current question"}; mode: ${searchModeLabel(searchTraceText(trace, "searchMode"), language)}`
      ),
      status: "done"
    },
    ...buildTraceProcessSteps(trace, t("检索链路", "Search trace"), language),
    {
      id: makeStepId("search-result"),
      title: t("生成结果", "Generate results"),
      detail: t(`返回 ${result.sections.length} 个切片结果`, `${result.sections.length} chunk result(s) returned`),
      status: "done",
      payload: {
        traceId: result.traceId,
        sections: result.sections.map((section) => ({
          chunkId: section.chunkId,
          heading: section.heading,
          score: section.score,
          rank: section.rank
        }))
      }
    }
  ];
}

function buildTraceProcessSteps(trace: unknown, groupTitle: string, language: SupportedLanguage): ProcessStep[] {
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const record = isPlainRecord(trace) ? trace : {};
  const timings = isPlainRecord(record.timings) ? record.timings : {};
  const orderedSteps: Array<{
    key: string;
    title: string;
    detail: string;
    payload?: unknown;
  }> = [
    {
      key: "queryEmbedding",
      title: t("查询向量化", "Query embedding"),
      detail: t("把用户问题转成向量，用于召回相关事件和切片。", "Convert the user question into a vector for recalling related events and chunks.")
    },
    {
      key: "step1Bm25Entities",
      title: t("BM25 匹配查询实体", "BM25 match query entities"),
      detail: countSummary(record.recalledEntities, t("个实体", "entities"), language),
      payload: record.recalledEntities
    },
    {
      key: "step1ExtractEntities",
      title: t("抽取查询实体", "Extract query entities"),
      detail: entitySummary(record.queryEntities, language),
      payload: record.queryEntities
    },
    {
      key: "step2RetrieveEntities",
      title: t("召回相关实体", "Retrieve related entities"),
      detail: countSummary(record.recalledEntities, t("个实体", "entities"), language),
      payload: record.recalledEntities
    },
    {
      key: "step3EntityEvents",
      title: t("实体关联事件", "Entity-linked events"),
      detail: countSummary(record.entityEvents ?? record.entityEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "entityEvents", "entityEventIds")
    },
    {
      key: "step3QueryEvents",
      title: t("标题向量召回事件", "Title-vector event recall"),
      detail: countSummary(record.queryEvents ?? record.queryEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "queryEvents", "queryEventIds")
    },
    {
      key: "step4FetchDetails",
      title: t("读取候选事件详情", "Fetch candidate event details"),
      detail: countSummary(record.eventSnapshots, t("个候选事件", "candidate events"), language),
      payload: record.eventSnapshots
    },
    {
      key: "step5Expand",
      title: t("事件扩展", "Event expansion"),
      detail: countSummary(record.expandedEvents ?? record.expandedEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "expandedEvents", "expandedEventIds")
    },
    {
      key: "step6CoarseRank",
      title: t("粗排事件", "Coarse-rank events"),
      detail: countSummary(record.coarseRankedEvents ?? record.coarseRankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "coarseRankedEvents", "coarseRankedEventIds")
    },
    {
      key: "step7LlmRerank",
      title: t("LLM 重排", "LLM rerank"),
      detail: countSummary(record.rerankedEvents ?? record.rerankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "rerankedEvents", "rerankedEventIds")
    },
    {
      key: "step7RerankModel",
      title: t("Rerank 模型重排", "Rerank model rerank"),
      detail: countSummary(record.rerankedEvents ?? record.rerankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "rerankedEvents", "rerankedEventIds")
    },
    {
      key: "step8FetchChunks",
      title: t("回取关联切片", "Fetch related chunks"),
      detail: t("读取最终事件关联的原文切片，作为回答上下文。", "Fetch original chunks linked to the final events as answer context.")
    }
  ];

  const steps: ProcessStep[] = orderedSteps
    .filter((step) => step.key in timings || step.payload !== undefined)
    .map((step) => ({
      id: makeStepId(step.key),
      title: step.title,
      detail: step.detail,
      status: "done" as const,
      durationMs: numberOrNull(timings[step.key]),
      payload: step.payload
    }));

  const fallbackReason = searchTraceText(record, "fallbackReason");
  if (fallbackReason) {
    steps.push({
      id: makeStepId("fallback"),
      title: t("降级路径", "Fallback path"),
      detail: fallbackReason,
      status: "done"
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: makeStepId("trace"),
      title: groupTitle,
      detail: t("工具返回了链路数据，但没有包含可拆解的阶段字段。", "The tool returned trace data but did not include decomposable stage fields."),
      status: "done",
      payload: trace
    });
  }

  return steps;
}

function buildToolProcessPayload(toolCall: McpToolCallRecord, language: SupportedLanguage) {
  return {
    [language === "en" ? "arguments" : "参数"]: toolCall.arguments,
    [language === "en" ? "result" : "结果"]: parseToolResponse(toolCall.result),
    [language === "en" ? "error" : "错误"]: toolCall.error ?? undefined
  };
}

function buildRunningMcpSearch(toolName: string, args: Record<string, unknown>, language: SupportedLanguage): RunningMcpSearch {
  const query = typeof args.query === "string" && args.query.trim()
    ? args.query.trim()
    : language === "en" ? `${toolName} did not provide a query argument` : `${toolName} 未提供 query 参数`;
  const searchMode = typeof args.searchMode === "string" ? searchModeLabel(args.searchMode, language) : undefined;
  return {
    id: makeStepId("running-mcp-search"),
    toolName,
    query,
    searchMode
  };
}

function getMcpSearchQuery(args: Record<string, unknown>, language: SupportedLanguage) {
  const query = getRawMcpSearchQuery(args);
  const mode = typeof args.searchMode === "string"
    ? language === "en" ? `; mode: ${searchModeLabel(args.searchMode, language)}` : `；模式：${searchModeLabel(args.searchMode, language)}`
    : "";
  return query
    ? `query: ${query}${mode}`
    : language === "en" ? "MCP called sag_search, but the arguments did not include a query field." : "MCP 调用了 sag_search，但参数里没有 query 字段。";
}

function getRawMcpSearchQuery(args: Record<string, unknown>) {
  return typeof args.query === "string" ? args.query.trim() : "";
}

function buildMcpSearchQueryStep(toolCall: McpToolCallRecord, language: SupportedLanguage): ProcessStep {
  const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
  return {
    id: makeStepId("mcp-search-query"),
    title: language === "en" ? "MCP search query" : "MCP 搜索语句",
    detail: getMcpSearchQuery(toolCall.arguments, language),
    status: "done",
    durationMs: toolCall.durationMs,
    payload: {
      query,
      strategy: toolCall.arguments.strategy,
      subStrategy: toolCall.arguments.subStrategy,
      searchMode: toolCall.arguments.searchMode,
      topK: toolCall.arguments.topK,
      returnTrace: toolCall.arguments.returnTrace
    }
  };
}

function buildMcpSearchResultSteps(result: unknown, language: SupportedLanguage): ProcessStep[] {
  if (!isPlainRecord(result) || !Array.isArray(result.sections)) {
    return [];
  }
  return [{
    id: makeStepId("mcp-search-result"),
    title: language === "en" ? "SAG returned chunks" : "SAG 返回切片",
    detail: language === "en" ? `${result.sections.length} chunk result(s) returned` : `返回 ${result.sections.length} 个切片结果`,
    status: "done",
    payload: {
      traceId: result.traceId,
      sections: result.sections.map((section) => {
        if (!isPlainRecord(section)) {
          return section;
        }
        return {
          heading: section.heading,
          contentPreview: typeof section.content === "string" ? section.content.slice(0, 160) : "",
          score: section.score,
          rank: section.rank
        };
      })
    }
  }];
}

function parseToolResponse(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value.content)) {
    return value;
  }
  const text = value.content
    .map((item) => isPlainRecord(item) && item.type === "text" ? String(item.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
  if (!text) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractSearchTrace(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  if (isPlainRecord(value.trace)) return value.trace;
  if ("timings" in value || "traceId" in value || "recalledEntities" in value || "queryEventIds" in value) {
    return value;
  }
  return null;
}

function buildGraphFocus(value: unknown, query: string): GraphFocus | null {
  const trace = extractSearchTrace(value);
  if (!trace) return null;

  const rerankedEventIds = stringArray(trace.rerankedEventIds);
  const eventIds = (Array.isArray(trace.rerankedEventIds)
    ? rerankedEventIds
    : firstNonEmptyStringArray(
      trace.textEventIds,
      trace.queryEventIds,
      trace.entityEventIds
    )
  ).slice(0, 30);
  const recalledEntities = Array.isArray(trace.recalledEntities)
    ? trace.recalledEntities.filter(isPlainRecord)
    : [];
  const normalizedQuery = normalizeKeyword(query).replace(/\s+/g, "");
  const directlyRelevantEntities = recalledEntities.filter((entity) => isDirectlyRelevantGraphEntity(entity, normalizedQuery));
  const entityIds = uniqueStrings(
    directlyRelevantEntities.map((entity) => typeof entity.id === "string" ? entity.id : "")
  ).slice(0, 8);
  if (eventIds.length === 0 && entityIds.length === 0) {
    return null;
  }

  const primaryEntity = [...directlyRelevantEntities].sort((left, right) => {
    const leftName = normalizeKeyword(String(left.name ?? "")).replace(/\s+/g, "");
    const rightName = normalizeKeyword(String(right.name ?? "")).replace(/\s+/g, "");
    const leftMentioned = leftName && normalizedQuery.includes(leftName) ? 1 : 0;
    const rightMentioned = rightName && normalizedQuery.includes(rightName) ? 1 : 0;
    return rightMentioned - leftMentioned ||
      Number(right.score ?? 0) - Number(left.score ?? 0);
  })[0];

  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    query,
    eventIds,
    entityIds,
    primaryEntityId: typeof primaryEntity?.id === "string" ? primaryEntity.id : entityIds[0]
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.map((item) => typeof item === "string" ? item : "")) : [];
}

function firstNonEmptyStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    const ids = stringArray(value);
    if (ids.length > 0) return ids;
  }
  return [];
}

function isDirectlyRelevantGraphEntity(entity: Record<string, unknown>, normalizedQuery: string) {
  const name = normalizeKeyword(String(entity.name ?? "")).replace(/\s+/g, "");
  if (name.length >= 2 && normalizedQuery.length >= 2 && (normalizedQuery.includes(name) || name.includes(normalizedQuery))) {
    return true;
  }
  const score = Number(entity.score ?? 0);
  return Number.isFinite(score) && score >= 0.88;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function searchTraceText(record: unknown, key: string) {
  if (!isPlainRecord(record)) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function searchModeLabel(value: string | null, language: SupportedLanguage) {
  if (value === "fast") return language === "en" ? "Fast" : "极速";
  if (value === "standard") return language === "en" ? "Standard" : "标准";
  return language === "en" ? "Default" : "默认";
}

function entitySummary(value: unknown, language: SupportedLanguage) {
  if (Array.isArray(value)) {
    if (value.length === 0) return language === "en" ? "No query entities identified" : "没有识别到查询实体";
    return language === "en" ? `${value.length} query entity/entities identified` : `识别到 ${value.length} 个查询实体`;
  }
  return language === "en" ? "Identify key entities in the user question" : "识别用户问题中的关键实体";
}

function countSummary(value: unknown, unit: string, language: SupportedLanguage) {
  if (Array.isArray(value)) return `${value.length} ${unit}`;
  return language === "en" ? "Waiting for the previous step" : "等待上一步结果";
}

function eventPayload(record: Record<string, unknown>, eventKey: string, idKey: string) {
  const direct = record[eventKey];
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }
  const ids = record[idKey];
  const snapshots = record.eventSnapshots;
  if (!Array.isArray(ids) || !Array.isArray(snapshots)) {
    return undefined;
  }
  const snapshotById = new Map(
    snapshots
      .filter(isPlainRecord)
      .map((event) => [String(event.id ?? ""), event])
  );
  const events = ids
    .map((id) => snapshotById.get(String(id)))
    .filter(Boolean);
  return events.length > 0 ? events : undefined;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

function formatModelName(model: string | null | undefined, t: (zh: string, en: string) => string) {
  if (!model) return t("未知模型", "Unknown model");
  if (model === "local-rule-fallback") return t("本地规则回退", "Local rule fallback");
  return model;
}

function formatMessageRole(role: string, t: (zh: string, en: string) => string) {
  if (role === "user") return t("用户", "User");
  if (role === "assistant") return t("助手", "Assistant");
  if (role === "tool") return t("工具", "Tool");
  return t("系统", "System");
}

function formatToolStatus(status: "PENDING" | "SUCCEEDED" | "FAILED", t: (zh: string, en: string) => string) {
  if (status === "SUCCEEDED") return t("成功", "Succeeded");
  if (status === "FAILED") return t("失败", "Failed");
  return t("等待中", "Pending");
}

function formatEmbeddingNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(5) : "0.00000";
}

function formatMessageContent(content: string, t: (zh: string, en: string) => string) {
  return formatDataContent(content, t)
    .replaceAll("sources", t("项目", "projects"))
    .replaceAll("source", t("项目", "project"))
    .replaceAll("Sources", t("项目", "Projects"))
    .replaceAll("Source", t("项目", "Project"))
    .replaceAll("来源", t("项目", "project"))
    .replaceAll("trace", t("检索链路", "trace"))
    .replaceAll(
      "Mock LLM planner completed MCP tool calls.",
      t("模拟 LLM 规划器已完成 MCP 工具调用。", "Mock LLM planner completed MCP tool calls.")
    )
    .replace(
      "当前未配置 LLM_API_KEY，已使用有限 fallback 通过真实 MCP client 测试工具。",
      t(
        "当前未配置 LLM 密钥，已使用有限本地规则回退，并通过真实 MCP 客户端测试工具。",
        "LLM key is not configured. A limited local rule fallback was used to test tools through the real MCP client."
      )
    )
    .replace(
      "当前 fallback 支持列出 sources、检索 search、查询 event。请尝试：列出 sources，并搜索 SAG multi search。",
      t(
        "当前本地规则回退支持列出项目、执行检索、查询事件。请尝试：列出项目，并搜索 SAG 多路检索。",
        "The local fallback supports listing projects, searching, and querying events. Try listing projects and searching SAG multi-search."
      )
    )
    .replace(
      "已通过 MCP 调用 sag_search，并返回检索结果和 trace。",
      t("已通过 MCP 调用 sag_search，并返回检索结果和检索链路。", "Called sag_search through MCP and returned retrieval results and trace.")
    );
}

function formatDataContent(content: string, t: (zh: string, en: string) => string) {
  const project = t("项目", "project");
  const projectList = t("项目列表", "project list");
  const projectIds = t("项目ID列表", "project ID list");
  const projectId = t("项目ID", "project ID");
  return content
    .replaceAll("sourceIds", projectIds)
    .replaceAll("sourceId", projectId)
    .replaceAll("source_id", projectId)
    .replaceAll("sources", projectList)
    .replaceAll("source", project)
    .replaceAll("Sources", projectList)
    .replaceAll("Source", project)
    .replaceAll("projects", projectList)
    .replaceAll("projectIds", projectIds)
    .replaceAll("projectId", projectId)
    .replaceAll("来源", project);
}
