import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Circle,
  Database,
  Factory,
  ListTree,
  Search,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import {
  chainAtlas,
  chainRelations,
  chemicalIdentityTerms,
  entityBelongsToChemical,
  normalizeAtlasSearch,
  type ChainNode,
  type ChainTrack,
  type Chemical,
} from "../lib/chain-atlas";
import type { ChainAtlasEntityMatch, SourceRecord } from "../types";
import "./chain-atlas.css";

const RESULT_LIMIT = 60;
const MATCH_BATCH_SIZE = 100;

interface TreeSelection {
  rootId?: string;
  expanded: Set<string>;
  focusedId?: string;
}

function collapsedSelection(rootId?: string): TreeSelection {
  return { rootId, expanded: new Set() };
}

function visibleNodes(nodes: ChainNode[], expanded: Set<string>): ChainNode[] {
  return nodes.flatMap(node => [node, ...(expanded.has(node.id) ? visibleNodes(node.children, expanded) : [])]);
}

export type AtlasKnowledgeOpenInput = {
  entityIds: string[];
  title: string;
  chemical?: Chemical;
  terms?: string[];
  cas?: string;
  projectId?: string;
};

export default function ChainAtlasWorkspace({
  project,
  onOpenEntity,
  onOpenKnowledge,
}: {
  project: SourceRecord | null;
  onOpenEntity: (entityId: string) => void;
  onOpenKnowledge?: (input: AtlasKnowledgeOpenInput) => void;
}) {
  const { t } = useI18n();
  const [track, setTrack] = useState<ChainTrack>("source");
  const [selections, setSelections] = useState<Record<ChainTrack, TreeSelection>>(() => ({
    source: collapsedSelection(),
    applications: collapsedSelection(),
  }));
  const [query, setQuery] = useState("");
  const searchTerm = normalizeAtlasSearch(useDeferredValue(query));
  const [scope, setScope] = useState<"library" | "project">("library");
  const projectId = scope === "project" && !project?.archivedAt ? project?.id : undefined;
  const [expandedMatch, setExpandedMatch] = useState<string>();
  const [retry, setRetry] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const atlas = chainAtlas[track];
  const selection = selections[track];
  const root = atlas.roots.find(item => item.id === selection.rootId);
  const branches = useMemo(() => atlas.entries.filter(node => node.children.length), [atlas]);

  const results = useMemo(() => {
    if (!searchTerm) return [];
    return atlas.entries.filter(item => item.searchText.includes(searchTerm));
  }, [atlas, searchTerm]);
  const nodes = useMemo(
    () => {
      if (searchTerm) return results.slice(0, RESULT_LIMIT);
      return root ? [root, ...visibleNodes(root.children, selection.expanded)] : visibleNodes(atlas.roots, selection.expanded);
    },
    [searchTerm, results, root, atlas.roots, selection.expanded],
  );
  const terms = useMemo(
    () => [...new Set(nodes.flatMap(node => node.terms))],
    [nodes],
  );
  const cache = useRef({ projectId, terms: new Map<string, ChainAtlasEntityMatch[]>() });
  const [lookup, setLookup] = useState<{
    projectId?: string;
    terms: Map<string, ChainAtlasEntityMatch[]>;
    error?: boolean;
  }>({ projectId, terms: new Map() });

  useEffect(() => {
    if (cache.current.projectId !== projectId) cache.current = { projectId, terms: new Map() };
    const found = cache.current.terms;
    const pending = terms.filter(term => !found.has(term));
    const controller = new AbortController();
    async function resolveMatches() {
      for (let offset = 0; offset < pending.length; offset += MATCH_BATCH_SIZE) {
        const requested = pending.slice(offset, offset + MATCH_BATCH_SIZE);
        const result = await api.matchChainAtlasEntities(requested, projectId, controller.signal);
        if (controller.signal.aborted) return;
        for (const term of requested) found.set(term, []);
        for (const match of result.matches) found.get(match.term)?.push(match);
        // Update the first rows promptly and batch subsequent updates when the whole tree is open.
        if (offset === 0 || offset % (4 * MATCH_BATCH_SIZE) === 0) {
          setLookup({ projectId, terms: new Map(found) });
        }
      }
      if (!controller.signal.aborted) setLookup({ projectId, terms: new Map(found) });
    }
    resolveMatches().catch(() => {
      if (!controller.signal.aborted) setLookup({ projectId, terms: new Map(found), error: true });
    });
    return () => controller.abort();
  }, [projectId, retry, terms]);

  const failed = lookup.projectId === projectId && lookup.error;

  function updateSelection(updater: (current: TreeSelection) => TreeSelection) {
    setSelections(current => ({ ...current, [track]: updater(current[track]) }));
  }

  function clearRowFeedback() {
    setExpandedMatch(undefined);
  }

  function chooseTrack(value: ChainTrack) {
    setTrack(value);
    setQuery("");
    clearRowFeedback();
    content.current?.scrollTo(0, 0);
  }

  function chooseRoot(item: ChainNode) {
    setQuery("");
    clearRowFeedback();
    updateSelection(() => collapsedSelection(item.id));
    content.current?.scrollTo(0, 0);
  }

  function toggleNode(item: ChainNode) {
    clearRowFeedback();
    updateSelection(current => {
      const expanded = new Set(current.expanded);
      if (expanded.has(item.id)) expanded.delete(item.id);
      else expanded.add(item.id);
      return { ...current, expanded, focusedId: item.id };
    });
  }

  function locate(item: ChainNode) {
    const parents = item.parents;
    const targetRoot = parents[0] ?? item;
    updateSelection(() => ({
      rootId: targetRoot.id,
      expanded: new Set(parents.map(parent => parent.id)),
      focusedId: item.id === targetRoot.id ? undefined : item.id,
    }));
    setQuery("");
    clearRowFeedback();
  }

  useEffect(() => {
    if (query || searchTerm || !selection.focusedId) return;
    content.current?.querySelector(`[data-chain-node="${selection.focusedId}"] > .chain-atlas-row`)
      ?.scrollIntoView({ block: "nearest" });
  }, [query, searchTerm, selection.focusedId]);

  function setAllExpanded(open: boolean) {
    updateSelection(() => open
      ? { expanded: new Set(branches.map(item => item.id)) }
      : collapsedSelection());
    clearRowFeedback();
    content.current?.scrollTo(0, 0);
  }

  function matchesFor(item: ChainNode) {
    if (lookup.projectId !== projectId) return [];
    const matches = new Map<string, ChainAtlasEntityMatch>();
    for (const term of item.terms) {
      for (const match of lookup.terms.get(term) ?? []) matches.set(match.id, match);
    }
    return [...matches.values()];
  }

  function knowledgeMatches(item: ChainNode, matches: ChainAtlasEntityMatch[]) {
    const chemical = item.chemical;
    if (!chemical || !onOpenKnowledge) return [];
    return matches.filter((match) => entityBelongsToChemical(match, chemical));
  }

  function openMatch(item: ChainNode, matches: ChainAtlasEntityMatch[]) {
    if (item.chemical && onOpenKnowledge) {
      const confirmed = knowledgeMatches(item, matches);
      if (confirmed.length > 0) {
        clearRowFeedback();
        onOpenKnowledge({
          entityIds: confirmed.map((match) => match.id),
          title: item.chemical.name || item.label,
          chemical: item.chemical,
          terms: chemicalIdentityTerms(item.chemical),
          cas: item.chemical.cas,
          projectId,
        });
        return;
      }
      // Unconfirmed identity: never fall back to aggregating all matches.
      if (matches.length === 1) {
        clearRowFeedback();
        onOpenEntity(matches[0].id);
      } else if (matches.length > 1) {
        setExpandedMatch((current) => (current === item.id ? undefined : item.id));
      }
      return;
    }
    if (matches.length === 1) {
      clearRowFeedback();
      onOpenEntity(matches[0].id);
    } else {
      setExpandedMatch((current) => (current === item.id ? undefined : item.id));
    }
  }

  function renderMatches(item: ChainNode, matches: ChainAtlasEntityMatch[]) {
    if (expandedMatch !== item.id) return null;
    const confirmed = new Set(knowledgeMatches(item, matches).map((match) => match.id));
    const remaining = matches.filter((match) => !confirmed.has(match.id));
    if (!remaining.length) return null;
    return (
      <div className="chain-atlas-matches">
        {remaining.map(match => (
          <button key={match.id} type="button" onClick={() => onOpenEntity(match.id)}>
            <Database size={15} />
            <span><strong>{match.name}</strong><small>{match.sourceName} · {match.type}</small></span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
    );
  }

  function renderMatchAction(item: ChainNode, matches: ChainAtlasEntityMatch[]) {
    if (!matches.length) return null;
    const confirmed = knowledgeMatches(item, matches).length;
    const remaining = matches.length - confirmed;
    return (
      <>
        <button type="button" className="chain-atlas-match" onClick={() => openMatch(item, matches)}
          aria-expanded={!confirmed && matches.length > 1 ? expandedMatch === item.id : undefined}
          aria-label={`${confirmed ? t("查看知识", "View knowledge") : t("查看知识库记录", "View library records")} ${item.label}`}>
          <Database size={13} />
          <span>{confirmed ? t("查看知识", "View knowledge")
            : matches.length === 1 ? t("查看实体", "View entity")
              : t(`${matches.length} 个实体`, `${matches.length} entities`)}</span>
          <ArrowUpRight size={13} />
        </button>
        {confirmed > 0 && remaining > 0 && (
          <button type="button" className="chain-atlas-match" aria-expanded={expandedMatch === item.id}
            onClick={() => setExpandedMatch((current) => current === item.id ? undefined : item.id)}>
            {t(`其他记录 ${remaining} 条`, `Other records (${remaining})`)}
          </button>
        )}
      </>
    );
  }

  const rootMatches = root && !searchTerm ? matchesFor(root) : [];

  function renderNode(item: ChainNode, searchResult: boolean) {
    const matches = matchesFor(item);
    const branch = item.children.length > 0;
    const open = selection.expanded.has(item.id);
    const relation = item.relation ? chainRelations[item.relation] : undefined;
    const rowContent = (
      <>
        <span className="chain-atlas-disclosure" aria-hidden="true">
          {searchResult ? <ArrowDownRight size={16} /> : branch
            ? open ? <ChevronDown size={16} /> : <ChevronRight size={16} />
            : <Circle size={7} className="chain-atlas-leaf-icon" />}
        </span>
        <span className="chain-atlas-node-body">
          {searchResult && item.parents.length > 0 ? (
            <span className="chain-atlas-breadcrumb">{item.parents.map(parent => parent.label).join(" / ")}</span>
          ) : null}
          <span className="chain-atlas-node-title">
            {item.code ? <code>{item.code}</code> : null}
            <span className="chain-atlas-node-label">{item.label}</span>
            {relation ? <span className="chain-atlas-relation" data-relation={item.relation}>{t(...relation)}</span> : null}
          </span>
          {item.chemical ? (
            <span className="chain-atlas-chemical">
              <span>{item.chemical.english}</span>
              {item.chemical.cas ? <code title="CAS">CAS {item.chemical.cas}</code> : null}
            </span>
          ) : null}
        </span>
        {branch && !searchResult ? (
          <span className="chain-atlas-branch-count">{item.children.length} {t("分支", "branches")}</span>
        ) : null}
      </>
    );
    return (
      <li key={item.id} data-chain-node={item.id} className="chain-atlas-node">
        <div className="chain-atlas-row" data-focused={selection.focusedId === item.id} data-branch={branch} data-root={item.parents.length === 0}>
          {searchResult || branch ? (
            <button className="chain-atlas-row-main" type="button"
              aria-expanded={searchResult ? undefined : open}
              aria-label={searchResult ? `${t("定位", "Locate")} ${item.label}` : undefined}
              onClick={() => searchResult ? locate(item) : toggleNode(item)}>
              {rowContent}
            </button>
          ) : <span className="chain-atlas-row-main">{rowContent}</span>}
          {renderMatchAction(item, matches)}
        </div>
        {renderMatches(item, matches)}
        {!searchResult && open && branch ? (
          <ul className="chain-atlas-children">{item.children.map(child => renderNode(child, false))}</ul>
        ) : null}
      </li>
    );
  }

  return (
    <section className="chain-atlas" aria-labelledby="chain-atlas-title">
      <header className="chain-atlas-header">
        <div>
          <h1 id="chain-atlas-title">{t("产业链图谱", "Supply chain atlas")}</h1>
          <p>{track === "source" ? t("从一次原料追踪生产路径", "Trace production from primary materials") :
            t("沿行业分类查看化学品应用", "Explore chemical uses by industry")}</p>
        </div>
        <div className="chain-atlas-tabs" aria-label={t("图谱路线", "Atlas tracks")}>
          <button type="button" aria-pressed={track === "source"} onClick={() => chooseTrack("source")}>
            <ListTree size={17} /> {t("来源路径", "Source pathways")}
          </button>
          <button type="button" aria-pressed={track === "applications"} onClick={() => chooseTrack("applications")}>
            <Factory size={17} /> {t("应用去向", "Industry applications")}
          </button>
        </div>
      </header>

      <div className="chain-atlas-layout">
        <nav className="chain-atlas-index" aria-label={t("图谱目录", "Atlas index")}>
          <div className="chain-atlas-index-heading">
            <span>{track === "source" ? t("一次原料", "Primary materials") : t("行业门类", "Industry sectors")}</span>
          </div>
          <ul>
            {atlas.roots.map(item => (
              <li key={item.id}>
                <button type="button" aria-current={!searchTerm && root?.id === item.id ? "true" : undefined}
                  onClick={() => chooseRoot(item)}>
                  <code>{item.code}</code>
                  <span>{item.label}</span>
                  <ChevronRight size={14} />
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="chain-atlas-content">
          <div className="chain-atlas-toolbar">
            <div className="chain-atlas-search">
              <Search size={16} aria-hidden="true" />
              <input value={query} type="search" aria-label={t("搜索图谱节点", "Search atlas nodes")}
                placeholder={t("搜索标准名称、别名、CAS 或行业编码", "Search names, aliases, CAS or industry codes")}
                onChange={event => { setQuery(event.target.value); clearRowFeedback(); }} />
              {query ? <button type="button" onClick={() => { setQuery(""); clearRowFeedback(); }}
                aria-label={t("清空搜索", "Clear search")}><X size={15} /></button> : null}
            </div>
            <label className="chain-atlas-scope">
              <Database size={15} aria-hidden="true" />
              <select aria-label={t("实体查询范围", "Entity lookup scope")}
                value={projectId ? "project" : "library"}
                onChange={event => { setScope(event.target.value === "project" ? "project" : "library"); clearRowFeedback(); }}>
                <option value="library">{t("全部知识库", "Entire library")}</option>
                {project && !project.archivedAt ? <option value="project">{t("当前项目", "Current project")} · {project.name}</option> : null}
              </select>
            </label>
          </div>

          <div className="chain-atlas-scroll" ref={content}>
            <div className="chain-atlas-section-heading">
              <div>
                {root && !searchTerm ? <code>{root.code}</code> : null}
                <h2>{searchTerm ? t("搜索结果", "Search results") : root?.label
                  ?? (track === "source" ? t("全部来源", "All sources") : t("全部行业", "All industries"))}</h2>
                <span>{searchTerm
                  ? t(`${results.length} 个结果${results.length > RESULT_LIMIT ? ` · 显示前 ${RESULT_LIMIT} 个` : ""}`,
                    `${results.length} results${results.length > RESULT_LIMIT ? ` · First ${RESULT_LIMIT} shown` : ""}`)
                  : t(`${root ? root.size - 1 : atlas.entries.length} 个节点`,
                    `${root ? root.size - 1 : atlas.entries.length} nodes`)}</span>
              </div>
              <div className="chain-atlas-section-actions">
                {root ? renderMatchAction(root, rootMatches) : null}
                {!searchTerm ? (
                  <>
                    <button type="button" onClick={() => setAllExpanded(true)}
                      disabled={!root && selection.expanded.size === branches.length}>
                      {t("全部展开", "Expand all")}
                    </button>
                    <button type="button" onClick={() => setAllExpanded(false)}
                      disabled={!root && selection.expanded.size === 0}>
                      {t("全部收起", "Collapse all")}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            {root && !searchTerm ? renderMatches(root, rootMatches) : null}

            {failed ? (
              <p className="chain-atlas-status" role="status">
                {t("知识库查询失败", "Library lookup failed")}
                <button type="button" onClick={() => { setLookup(current => ({ ...current, error: false })); setRetry(value => value + 1); }}>{t("重试", "Retry")}</button>
              </p>
            ) : null}

            {searchTerm && !results.length ? (
              <div className="chain-atlas-empty">
                <BookOpen size={25} />
                <p>{t("当前路线未找到匹配节点", "No matching nodes in this track")}</p>
              </div>
            ) : (
              <ul className={searchTerm ? "chain-atlas-results" : "chain-atlas-tree"}>
                {(searchTerm ? nodes : root?.children ?? atlas.roots).map(item => renderNode(item, Boolean(searchTerm)))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
