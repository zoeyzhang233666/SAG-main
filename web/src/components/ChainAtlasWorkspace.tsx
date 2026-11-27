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
import { chainAtlas, chainRelations, normalizeAtlasSearch, type ChainNode, type ChainTrack } from "../lib/chain-atlas";
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

export default function ChainAtlasWorkspace({
  project,
  onOpenEntity,
}: {
  project: SourceRecord | null;
  onOpenEntity: (entityId: string) => void;
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
  const [unmatched, setUnmatched] = useState<string>();
  const [retry, setRetry] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const atlas = chainAtlas[track];
  const selection = selections[track];
  const root = atlas.roots.find(item => item.id === selection.rootId);

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
  const lookupKey = JSON.stringify([projectId, terms]);
  const [lookup, setLookup] = useState<{ key: string; rows: ChainAtlasEntityMatch[]; error?: boolean }>({ key: "", rows: [] });

  useEffect(() => {
    if (!terms.length) return;
    const controller = new AbortController();
    async function resolveMatches() {
      const rows: ChainAtlasEntityMatch[] = [];
      for (let offset = 0; offset < terms.length; offset += MATCH_BATCH_SIZE) {
        const result = await api.matchChainAtlasEntities(terms.slice(offset, offset + MATCH_BATCH_SIZE), projectId, controller.signal);
        rows.push(...result.matches);
      }
      if (!controller.signal.aborted) setLookup({ key: lookupKey, rows });
    }
    resolveMatches().catch(() => {
      if (!controller.signal.aborted) setLookup({ key: lookupKey, rows: [], error: true });
    });
    return () => controller.abort();
  }, [lookupKey, projectId, retry, terms]);

  const byTerm = useMemo(() => {
    const map = new Map<string, ChainAtlasEntityMatch[]>();
    if (lookup.key !== lookupKey) return map;
    for (const match of lookup.rows) {
      const current = map.get(match.term);
      if (current) current.push(match);
      else map.set(match.term, [match]);
    }
    return map;
  }, [lookup, lookupKey]);
  const loading = terms.length > 0 && lookup.key !== lookupKey;
  const failed = lookup.key === lookupKey && lookup.error;

  function updateSelection(updater: (current: TreeSelection) => TreeSelection) {
    setSelections(current => ({ ...current, [track]: updater(current[track]) }));
  }

  function clearRowFeedback() {
    setExpandedMatch(undefined);
    setUnmatched(undefined);
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
    content.current?.querySelector(`[data-chain-node="${selection.focusedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [query, searchTerm, selection.focusedId]);

  function matchesFor(item: ChainNode) {
    const matches = new Map<string, ChainAtlasEntityMatch>();
    for (const term of item.terms) {
      for (const match of byTerm.get(term) ?? []) matches.set(match.id, match);
    }
    return [...matches.values()];
  }

  function chooseNode(item: ChainNode, matches: ChainAtlasEntityMatch[]) {
    if (matches.length === 1) {
      clearRowFeedback();
      onOpenEntity(matches[0].id);
      return;
    }
    if (matches.length > 1) {
      setUnmatched(undefined);
      setExpandedMatch(expandedMatch === item.id ? undefined : item.id);
      return;
    }
    if (searchTerm) locate(item);
    else if (item.children.length) toggleNode(item);
    else if (!loading && !failed && item.terms.length) setUnmatched(item.id);
  }

  function renderMatches(item: ChainNode, matches: ChainAtlasEntityMatch[]) {
    if (expandedMatch !== item.id || matches.length < 2) return null;
    return (
      <div className="chain-atlas-matches">
        {matches.map(match => (
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
    return (
      <button type="button" className="chain-atlas-match" onClick={() => chooseNode(item, matches)}
        aria-expanded={matches.length > 1 ? expandedMatch === item.id : undefined}
        aria-label={`${t("查看知识库记录", "View library records")} ${item.label}`}>
        <Database size={13} />
        <span>{matches.length === 1 ? t("查看实体", "View entity") : t(`${matches.length} 个实体`, `${matches.length} entities`)}</span>
        <ArrowUpRight size={13} />
      </button>
    );
  }

  const rootMatches = root && !searchTerm ? matchesFor(root) : [];

  function renderNode(item: ChainNode, searchResult: boolean) {
    const matches = matchesFor(item);
    const open = selection.expanded.has(item.id);
    const showChoices = expandedMatch === item.id && matches.length > 1;
    const actionable = searchResult || item.children.length > 0 || item.terms.length > 0;
    const label = <span className="chain-atlas-node-label">{item.label}</span>;
    const relation = item.relation ? chainRelations[item.relation] : undefined;
    return (
      <li key={item.id} data-chain-node={item.id} className="chain-atlas-node">
        <div className="chain-atlas-row" data-focused={selection.focusedId === item.id} data-branch={item.children.length > 0} data-root={item.parents.length === 0}>
          {searchResult ? (
            <button className="chain-atlas-disclosure" type="button" onClick={() => locate(item)}
              title={t("在目录中定位", "Locate in tree")} aria-label={`${t("定位", "Locate")} ${item.label}`}>
              <ArrowDownRight size={16} />
            </button>
          ) : item.children.length ? (
            <button className="chain-atlas-disclosure" type="button" onClick={() => toggleNode(item)}
              aria-expanded={open} aria-label={`${open ? t("折叠", "Collapse") : t("展开", "Expand")} ${item.label}`}>
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : (
            <span className="chain-atlas-leaf" aria-hidden="true"><Circle size={7} /></span>
          )}
          <div className="chain-atlas-node-body">
            {searchResult && item.parents.length > 0 ? (
              <span className="chain-atlas-breadcrumb">{item.parents.map(parent => parent.label).join(" / ")}</span>
            ) : null}
            <div className="chain-atlas-node-title">
              {item.code ? <code>{item.code}</code> : null}
              {actionable ? (
                <button type="button" className="chain-atlas-name" onClick={() => chooseNode(item, matches)}
                  aria-expanded={matches.length > 1 ? showChoices : undefined}>
                  {label}
                </button>
              ) : label}
              {relation ? <span className="chain-atlas-relation" data-relation={item.relation}>{t(...relation)}</span> : null}
            </div>
            {item.chemical ? (
              <div className="chain-atlas-chemical">
                <span>{item.chemical.english}</span>
                {item.chemical.formula ? <code>{item.chemical.formula}</code> : null}
                {item.chemical.cas ? <code title="CAS">CAS {item.chemical.cas}</code> : null}
              </div>
            ) : null}
            {item.context ? <p className="chain-atlas-note">{item.context}</p> : null}
            {item.notes?.map((note, index) => <p className="chain-atlas-note" key={index}>{note}</p>)}
            {item.reference && (open || searchResult || item.notes?.length) ? (
              <a className="chain-atlas-reference" href={item.reference.url} target="_blank" rel="noreferrer">
                {item.reference.label} <ArrowUpRight size={12} />
              </a>
            ) : null}
          </div>
          {matches.length > 0 ? renderMatchAction(item, matches) : item.children.length > 0 && !searchResult ? (
            <span className="chain-atlas-branch-count">{item.children.length} {t("分支", "branches")}</span>
          ) : null}
        </div>
        {renderMatches(item, matches)}
        {unmatched === item.id && matches.length === 0 && !loading && !failed ? (
          <p className="chain-atlas-unmatched">{t("当前范围没有匹配的知识库实体", "No matching library entity in this scope")}</p>
        ) : null}
        {!searchResult && open && item.children.length > 0 ? (
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
            <small>{atlas.version}</small>
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
                {!searchTerm && (root || selection.expanded.size > 0) ? (
                  <button type="button" onClick={() => { updateSelection(() => collapsedSelection()); clearRowFeedback(); content.current?.scrollTo(0, 0); }}>
                    {t("全部收起", "Collapse all")}
                  </button>
                ) : null}
              </div>
            </div>
            {root && !searchTerm ? renderMatches(root, rootMatches) : null}

            {failed ? (
              <p className="chain-atlas-status" role="status">
                {t("知识库查询失败", "Library lookup failed")}
                <button type="button" onClick={() => { setLookup({ key: "", rows: [] }); setRetry(retry + 1); }}>{t("重试", "Retry")}</button>
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
