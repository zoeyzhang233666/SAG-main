import source from "../data/chain-source.json" with { type: "json" };
import applications from "../data/chain-applications.json" with { type: "json" };
import chemicalData from "../data/chain-chemicals.json" with { type: "json" };
import supplements from "../data/chain-supplements.json" with { type: "json" };

export type ChainTrack = "source" | "applications";

export const chainRelations: Record<string, readonly [string, string]> = {
  feedstock: ["原料", "Feedstock"],
  intermediate: ["中间体", "Intermediate"],
  product: ["产品", "Product"],
  byproduct: ["副产物", "By-product"],
  use: ["用途", "Use"],
  auxiliary: ["助剂", "Additive"],
  grade: ["品类", "Grade"],
  historical: ["历史路线", "Historical route"]
};

export interface Chemical {
  name: string;
  english: string;
  cas?: string;
  formula?: string;
  aliases?: string[];
}

interface AtlasNode {
  label: string;
  code?: string;
  children?: AtlasNode[];
  displayName?: string;
  relation?: string;
}

type SupplementalNode = string | {
  label: string;
  relation?: string;
  children?: SupplementalNode[];
};

interface AtlasPath {
  under: string;
  path?: string[];
}

interface Supplement extends AtlasPath {
  moveTo?: AtlasPath;
  label?: string;
  remove?: boolean;
  relation?: string;
  displayName?: string;
  children?: SupplementalNode[];
}

export interface ChainNode extends Pick<AtlasNode, "label" | "code" | "relation"> {
  id: string;
  children: ChainNode[];
  size: number;
  terms: string[];
  searchText: string;
  parents: ChainNode[];
  chemical?: Chemical;
}

const AMBIGUOUS_TERMS = new Set(["AA", "AM", "AS", "BA", "COC", "CR", "DMC", "DME", "EA", "EC", "EDC", "EO", "IPA", "MA", "PAC", "PC", "PI", "POP", "PO", "TPO", "VC"]);

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

export function resolveChemicalByName(name: string): Chemical | undefined {
  const hit = chemicalsByName.get(normalizeAtlasSearch(name));
  return hit || undefined;
}

export function resolveChemicalByCas(cas: string): Chemical | undefined {
  return chemicalsByCas.get(cas.trim()) ?? undefined;
}

export function chemicalIdentityTerms(chemical: Chemical): string[] {
  return [...new Set([
    ...chemicalNames(chemical),
    ...(chemical.cas ? [chemical.cas] : []),
  ])];
}

export type ChemicalMatchCandidate = {
  name: string;
  description?: string | null;
};

/** True when a dictionary key maps to more than one chemical (shared alias). */
export function isAmbiguousChemicalTerm(term: string): boolean {
  return chemicalsByName.get(normalizeAtlasSearch(term)) === null;
}

function descriptionMentionsIdentity(description: string, term: string): boolean {
  const hay = description.normalize("NFKC");
  const needle = term.normalize("NFKC").trim();
  if (!needle || needle.length < 2) return false;
  return hay.includes(needle);
}

/**
 * Conservative identity check: exact dictionary terms / CAS, or CAS/name confirmed via description.
 * Broad labels such as 「盐」 are not treated as 氯化钠 unless identity evidence exists.
 */
export function entityBelongsToChemical(
  candidate: ChemicalMatchCandidate,
  chemical: Chemical,
): boolean {
  const nameKey = normalizeAtlasSearch(candidate.name);
  if (!nameKey) return false;
  const identityKeys = new Set(
    chemicalIdentityTerms(chemical).map((term) => normalizeAtlasSearch(term)),
  );
  if (identityKeys.has(nameKey)) return true;

  const other = chemicalsByName.get(nameKey);
  if (other && other.name !== chemical.name) return false;
  if (other === null) return false;

  const description = candidate.description?.trim() ?? "";
  if (chemical.cas) {
    const casKey = normalizeAtlasSearch(chemical.cas);
    if (nameKey === casKey) return true;
    if (description.includes(chemical.cas)) return true;
  }

  if (!description) return false;
  for (const term of [chemical.name, chemical.english, ...(chemical.aliases ?? [])]) {
    if (!term || isAmbiguousChemicalTerm(term)) continue;
    if (term.trim().length < 2) continue;
    if (descriptionMentionsIdentity(description, term)) return true;
  }
  return false;
}

export function matchBelongsToChemical(
  matchName: string,
  chemical: Chemical,
  description?: string | null,
): boolean {
  return entityBelongsToChemical({ name: matchName, description }, chemical);
}

export function resolveEntityChemical(
  entity: ChemicalMatchCandidate,
): Chemical | undefined {
  const byName = resolveChemicalByName(entity.name);
  if (byName) return byName;
  const description = entity.description?.trim() ?? "";
  const casHit = description.match(/\b(\d{2,7}-\d{2}-\d)\b/);
  if (casHit) return resolveChemicalByCas(casHit[1]);
  return undefined;
}


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

  const { head, withoutCas, name, unqualified } = labelParts(node.label);
  const applicationName = node.code?.startsWith("A-") && name.includes("-") ? name.slice(name.indexOf("-") + 1) : "";
  const arrowTail = unqualified.includes("→") || unqualified.includes("←") || unqualified.includes("↔")
    ? unqualified.split(/[→←↔]/u).at(-1)?.trim() ?? ""
    : "";
  const arrowPlain = arrowTail.replace(/\[[^\]]+\]/gu, "").trim();
  const arrowHan = arrowPlain.match(/^(.*?\p{Script=Han}+)/u)?.[1] ?? arrowPlain;
  const named = [name, withoutCas, applicationName, arrowPlain, arrowHan]
    .map(candidate => chemicalsByName.get(normalizeAtlasSearch(candidate)))
    .find(Boolean);
  const cas =
    unqualified.match(/\[(\d{2,7}-\d{2}-\d)\]/u)?.[1] ??
    head.match(/\[(\d{2,7}-\d{2}-\d)\]/u)?.[1];
  if (named && (!cas || !named.cas || cas === named.cas)) return named;
  // Prefer CAS identity before rejecting slash-joined feedstock labels.
  if (cas) return chemicalsByCas.get(cas);
  if (/[\/、;；]/u.test(name)) return undefined;
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

function supplementalNode(node: SupplementalNode): AtlasNode {
  if (typeof node === "string") return { label: node };
  return { label: node.label, relation: node.relation, children: node.children?.map(supplementalNode) };
}

function hasAtlasContent(node: AtlasNode) {
  const label = cleanLabel(node.label).normalize("NFKC");
  return label !== "(不涉及化学品)" && label !== "消耗少";
}

function appendChildren(parent: AtlasNode, children: AtlasNode[]) {
  const nameOf = (node: AtlasNode) => normalizeAtlasSearch(chemicalFor(node)?.name ?? cleanLabel(node.label));
  for (const child of children) {
    const existing = parent.children?.find(item => nameOf(item) === nameOf(child));
    if (!existing) (parent.children ??= []).push(child);
    else {
      if (child.relation) existing.relation ??= child.relation;
      if (child.children?.length) appendChildren(existing, child.children);
    }
  }
}

function applySupplements(original: AtlasNode[], changes: Supplement[]) {
  const roots = structuredClone(original);
  const nodes = directoryNodes(roots);
  function locate(target: AtlasPath) {
    let node = nodes.find(item => item.code === target.under);
    let parent: AtlasNode | undefined;
    for (const prefix of target.path ?? []) {
      parent = node;
      const matches: AtlasNode[] = parent?.children?.filter(child => child.label.startsWith(prefix)) ?? [];
      if (matches.length !== 1) throw new Error(`Ambiguous atlas path ${target.under} / ${prefix}: ${matches.length} matches`);
      node = matches[0];
    }
    if (!node) throw new Error(`Unknown atlas code ${target.under}`);
    return { node, parent };
  }

  for (const change of changes) {
    const { node, parent } = locate(change);
    if (change.remove) {
      if (!parent?.children || node.children?.length) throw new Error(`Only leaf atlas nodes may be removed: ${node.label}`);
      parent.children = parent.children.filter(child => child !== node);
      continue;
    }
    if (change.children) appendChildren(node, change.children.map(supplementalNode));
    if (change.displayName) node.displayName = change.displayName;
    if (change.label) node.label = change.label;
    if (change.relation) node.relation = change.relation;
    if (change.moveTo) {
      const destination = locate(change.moveTo).node;
      if (!parent?.children || directoryNodes([node]).includes(destination)) {
        throw new Error(`Invalid atlas move: ${node.label}`);
      }
      parent.children = parent.children.filter(child => child !== node);
      appendChildren(destination, [node]);
    }
  }
  return roots;
}

function indexTree(input: { version: string; roots: AtlasNode[] }, changes: Supplement[]) {
  const entries: ChainNode[] = [];
  function visit(node: AtlasNode, id: string, parents: ChainNode[]): ChainNode {
    if (node.relation && !Object.hasOwn(chainRelations, node.relation)) {
      throw new Error(`Unknown atlas relation ${node.relation}`);
    }
    const chemical = chemicalFor(node) ?? undefined;
    const clean = cleanLabel(node.label);
    const label = chemical?.name ?? clean;
    const names = chemical ? chemicalNames(chemical) : [];
    const baseTerms = chemical ? [] : entityTerms(clean, node.code);
    const terms = [...new Set([...names, ...(chemical?.cas ? [chemical.cas] : []), ...baseTerms])];
    const result: ChainNode = {
      label,
      code: node.code,
      relation: node.relation,
      chemical,
      id,
      parents,
      size: 1,
      children: [],
      terms,
      searchText: [node.code, node.label, label, chemical?.cas, chemical?.formula, chemical?.english,
        ...(chemical?.aliases ?? [])].filter(Boolean).map(value => normalizeAtlasSearch(value!)).join("\n")
    };
    entries.push(result);
    result.children = (node.children ?? []).flatMap((child, index) =>
      hasAtlasContent(child) ? [visit(child, `${id}.${index}`, [...parents, result])] : []
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
