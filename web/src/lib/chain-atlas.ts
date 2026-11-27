import source from "../data/chain-source.json";
import applications from "../data/chain-applications.json";
import chemicalData from "../data/chain-chemicals.json";
import supplements from "../data/chain-supplements.json";

export type ChainTrack = "source" | "applications";

interface Chemical {
  name: string;
  english: string;
  cas?: string;
  formula?: string;
  aliases?: string[];
}

interface AtlasReference {
  label: string;
  url: string;
}

interface AtlasNode {
  label: string;
  code?: string;
  notes?: string[];
  children?: AtlasNode[];
  displayName?: string;
  reference?: AtlasReference;
}

type SupplementalNode = string | {
  label: string;
  notes?: string[];
  children?: SupplementalNode[];
};

interface Supplement {
  under: string;
  path?: string[];
  note?: string;
  displayName?: string;
  children?: SupplementalNode[];
  reference: string;
}

export interface ChainNode extends Omit<AtlasNode, "children" | "displayName"> {
  id: string;
  children: ChainNode[];
  size: number;
  terms: string[];
  searchText: string;
  parents: ChainNode[];
  chemical?: Chemical;
  context?: string;
}

const AMBIGUOUS_TERMS = new Set(["AA", "AM", "AS", "COC", "CR", "DMC", "EC", "EO", "MA", "PAC", "PC", "PI", "POP", "PO", "TPO", "VC"]);

export function normalizeAtlasSearch(value: string) {
  return value.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–−]/gu, "-")
    .replace(/\s+/gu, "");
}

function chemicalNames(chemical: Chemical) {
  return [chemical.name, chemical.english, ...(chemical.aliases ?? [])]
    .filter(name => !AMBIGUOUS_TERMS.has(name.toUpperCase()));
}

const chemicals: Chemical[] = chemicalData;
const chemicalsByName = new Map<string, Chemical | null>();
for (const chemical of chemicals) {
  for (const name of chemicalNames(chemical)) {
    const key = normalizeAtlasSearch(name);
    const previous = chemicalsByName.get(key);
    chemicalsByName.set(key, previous === undefined || previous === chemical ? chemical : null);
  }
}

const chemicalsByCas = new Map(chemicals.filter(item => item.cas).map(item => [item.cas, item]));

function cleanLabel(label: string) {
  return label.replace(/\s*(?:★\s*注[：:]|注[：:]|★\s*修订[：:]).*$/u, "")
    .replace(/\[\s*★+\s*\]/gu, "")
    .replace(/[★☆]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function labelParts(label: string) {
  const text = cleanLabel(label).normalize("NFKC");
  const unqualified = text.replace(/\([^()]*\)/gu, "").trim();
  const head = unqualified.split(/[→←↔]/u, 1)[0].trim();
  const withoutCas = head.replace(/\[[^\]]+\]/gu, "").trim();
  const name = withoutCas.match(/^(.*?\p{Script=Han})\s+[A-Za-z]/u)?.[1] ?? withoutCas;
  return { text, unqualified, head, withoutCas, name };
}

function chemicalFor(node: AtlasNode) {
  if (node.displayName) return chemicalsByName.get(normalizeAtlasSearch(node.displayName)) ?? undefined;

  const { head, withoutCas, name } = labelParts(node.label);
  const applicationName = node.code?.startsWith("A-") && name.includes("-") ? name.slice(name.indexOf("-") + 1) : "";
  const named = [name, withoutCas, applicationName]
    .map(candidate => chemicalsByName.get(normalizeAtlasSearch(candidate)))
    .find(Boolean);
  const cas = head.match(/\[(\d{2,7}-\d{2}-\d)\]/u)?.[1];
  if (named && (!cas || !named.cas || cas === named.cas)) return named;
  if (/[\/、;；]/u.test(name)) return undefined;
  if (cas) return chemicalsByCas.get(cas);
}

function entityTerms(label: string, code?: string) {
  if (label.startsWith("（不涉及") || label === "消耗少") return [];
  const text = labelParts(label).unqualified.replace(/\[[^\]]+\]/gu, "");
  const terms = new Set<string>();
  const add = (value: string) => {
    const term = value.trim();
    if (term.length < 1 || term.length > 120 || AMBIGUOUS_TERMS.has(term.toUpperCase())) return;
    if (/^[A-Z]-\d+(?:-\d+)*$/iu.test(term) || /^\d+(?:-\d+)+$/u.test(term)) return;
    if (/[\p{L}]/u.test(term)) terms.add(term);
  };

  for (const segment of text.split(/[→←↔/／、；;]+/u)) {
    const term = segment.trim();
    add(term);
    const name = term.match(/^(.*?\p{Script=Han})\s*[A-Z][A-Z0-9]{1,8}$/u)?.[1]
      ?? term.match(/^(.*?\p{Script=Han})\s+[A-Za-z]/u)?.[1]
      ?? term;
    add(name);
    if (code?.startsWith("A-") && /^\p{Script=Han}+(?:[-—]\p{Script=Han}+)+$/u.test(name)) {
      add(name.split(/[-—]/u).at(-1)!);
    }
  }
  add(text);
  return [...terms].slice(0, 10);
}

function directoryNodes(roots: AtlasNode[]): AtlasNode[] {
  return roots.flatMap(node => [node, ...directoryNodes(node.children ?? [])]);
}

function supplementalNode(node: SupplementalNode, reference: AtlasReference): AtlasNode {
  if (typeof node === "string") return { label: node, reference };
  return { ...node, reference, children: node.children?.map(child => supplementalNode(child, reference)) };
}

function appendChildren(parent: AtlasNode, children: AtlasNode[]) {
  const nameOf = (node: AtlasNode) => normalizeAtlasSearch(chemicalFor(node)?.name ?? cleanLabel(node.label));
  for (const child of children) {
    const existing = parent.children?.find(item => nameOf(item) === nameOf(child));
    if (!existing) (parent.children ??= []).push(child);
    else if (child.children?.length) appendChildren(existing, child.children);
  }
}

function applySupplements(original: AtlasNode[], changes: Supplement[]) {
  const roots = structuredClone(original);
  const nodes = directoryNodes(roots);
  for (const change of changes) {
    let parent = nodes.find(node => node.code === change.under);
    for (const prefix of change.path ?? []) {
      const matches: AtlasNode[] = parent?.children?.filter(child => child.label.startsWith(prefix)) ?? [];
      if (matches.length !== 1) throw new Error(`Ambiguous atlas path ${change.under} / ${prefix}: ${matches.length} matches`);
      parent = matches[0];
    }
    if (!parent) throw new Error(`Unknown atlas code ${change.under}`);
    const reference = (supplements.references as Record<string, AtlasReference>)[change.reference];
    if (!reference) throw new Error(`Unknown atlas reference ${change.reference}`);
    if (change.children) appendChildren(parent, change.children.map(node => supplementalNode(node, reference)));
    if (change.note) parent.notes = [...(parent.notes ?? []), change.note];
    if (change.displayName) parent.displayName = change.displayName;
    if (change.note || change.displayName) parent.reference = reference;
  }
  return roots;
}

function indexTree(input: { version: string; roots: AtlasNode[] }, changes: Supplement[]) {
  const entries: ChainNode[] = [];
  function visit(node: AtlasNode, id: string, parents: ChainNode[]): ChainNode {
    const chemical = chemicalFor(node) ?? undefined;
    const clean = cleanLabel(node.label);
    const label = chemical?.name ?? clean;
    const names = chemical ? chemicalNames(chemical) : [];
    const baseTerms = chemical ? [] : entityTerms(clean, node.code);
    const terms = [...new Set([...names, ...(chemical?.cas ? [chemical.cas] : []), ...baseTerms])];
    // Retain route, grade and class qualifiers from the source tree.
    const contextual = /[→←↔(（/]/u.test(clean) || node.displayName || node.code?.startsWith("A-");
    const context = chemical && contextual && label !== clean ? clean : undefined;
    const result: ChainNode = {
      ...node,
      label,
      chemical,
      context,
      id,
      parents,
      size: 1,
      children: [],
      terms,
      searchText: [node.code, node.label, label, chemical?.cas, chemical?.formula, chemical?.english,
        ...(chemical?.aliases ?? [])].filter(Boolean).map(value => normalizeAtlasSearch(value!)).join("\n")
    };
    entries.push(result);
    result.children = (node.children ?? []).map((child, index) =>
      visit(child, `${id}.${index}`, [...parents, result])
    );
    result.size += result.children.reduce((sum, child) => sum + child.size, 0);
    return result;
  }
  const roots = applySupplements(input.roots, changes).map((node, index) => visit(node, String(index), []));
  return { version: input.version, roots, entries };
}

export const chainAtlas = {
  source: indexTree(source, supplements.source),
  applications: indexTree(applications, supplements.applications)
};
