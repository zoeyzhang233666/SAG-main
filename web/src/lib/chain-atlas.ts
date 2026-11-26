import source from "../data/chain-source.json";
import applications from "../data/chain-applications.json";

export type ChainTrack = "source" | "applications";

interface AtlasNode {
  label: string;
  code?: string;
  notes?: string[];
  children?: AtlasNode[];
}

export interface ChainNode extends Omit<AtlasNode, "children"> {
  id: string;
  children: ChainNode[];
  size: number;
  terms: string[];
  searchText: string;
  parents: ChainNode[];
}

// These abbreviations have multiple meanings in the supplied trees.
const AMBIGUOUS_TERMS = new Set(["DMC", "POP", "COC", "TPO"]);

export function normalizeAtlasSearch(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "");
}

function entityTerms(label: string, code?: string) {
  if (label.startsWith("（不涉及") || label === "消耗少") return [];
  const text = label
    .replace(/\s*(?:★\s*注[：:]|注[：:]).*$/u, "")
    .replace(/\[[^\]]+\]/gu, "")
    .replace(/[★☆]/gu, "")
    .normalize("NFKC");
  const terms = new Set<string>();
  const add = (value: string) => {
    const term = value.trim();
    if (term.length < 1 || term.length > 120 || AMBIGUOUS_TERMS.has(term.toUpperCase())) return;
    if (/^[A-Z]-\d+(?:-\d+)*$/iu.test(term) || /^\d+(?:-\d+)+$/u.test(term)) return;
    if (/[\p{L}]/u.test(term)) terms.add(term);
  };

  // Keep full labels and exact names from paths. Parentheses often contain a grade,
  // a reference or a formula, so they do not by themselves become entity names.
  for (const segment of text.replace(/\([^()]*\)/gu, "").split(/[→←↔/／、；;]+/u)) {
    const term = segment.trim();
    add(term);
    const name = term.match(/^(.*?\p{Script=Han})\s*[A-Z][A-Z0-9]{1,8}$/u)?.[1]
      ?? term.match(/^(.*?\p{Script=Han})\s+[A-Za-z]/u)?.[1]
      ?? term;
    add(name);
    // Application headings such as "无机酸-硫酸" classify a named chemical.
    if (code?.startsWith("A-") && /^\p{Script=Han}+(?:[-—]\p{Script=Han}+)+$/u.test(name)) {
      add(name.split(/[-—]/u).at(-1)!);
    }
  }
  add(text.trim());
  return [...terms].slice(0, 10);
}

function indexTree(input: { version: string; roots: AtlasNode[] }) {
  const entries: ChainNode[] = [];
  function visit(node: AtlasNode, id: string, parents: ChainNode[]): ChainNode {
    const result: ChainNode = {
      ...node,
      id,
      parents,
      size: 1,
      children: [],
      terms: entityTerms(node.label, node.code),
      searchText: normalizeAtlasSearch([node.code, node.label].filter(Boolean).join(" "))
    };
    entries.push(result);
    result.children = (node.children ?? []).map((child, index) =>
      visit(child, `${id}.${index}`, [...parents, result])
    );
    result.size += result.children.reduce((sum, child) => sum + child.size, 0);
    return result;
  }
  const roots = input.roots.map((node, index) => visit(node, String(index), []));
  return { version: input.version, roots, entries };
}

export const chainAtlas = {
  source: indexTree(source),
  applications: indexTree(applications)
};
