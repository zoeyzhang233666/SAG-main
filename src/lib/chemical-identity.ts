import chemicalData from "../data/chain-chemicals.json" with { type: "json" };

export interface Chemical {
  name: string;
  english: string;
  cas?: string;
  formula?: string;
  aliases?: string[];
  materialEntityTypes?: string[];
}

export type ChemicalMatchCandidate = {
  name: string;
  description?: string | null;
  type?: string;
};

const AMBIGUOUS_ABBREVIATIONS = new Set([
  "AA", "AM", "AS", "BA", "COC", "CR", "DMC", "DME", "EA", "EC", "EDC", "EO",
  "IPA", "MA", "PAC", "PC", "PI", "POP", "PO", "TPO", "VC",
]);

export function normalizeChemicalSearch(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–−]/gu, "-")
    .replace(/\s+/gu, "");
}

function dictionaryNames(chemical: Chemical): string[] {
  return [chemical.name, chemical.english, ...(chemical.aliases ?? [])].filter(
    (name) => !AMBIGUOUS_ABBREVIATIONS.has(name.toUpperCase()),
  );
}

const chemicals: Chemical[] = chemicalData as Chemical[];
const chemicalsByName = new Map<string, Chemical | null>();
for (const chemical of chemicals) {
  for (const name of dictionaryNames(chemical)) {
    const key = normalizeChemicalSearch(name);
    const previous = chemicalsByName.get(key);
    chemicalsByName.set(
      key,
      previous === undefined || previous === chemical ? chemical : null,
    );
  }
}
const chemicalsByCas = new Map(
  chemicals.filter((item) => item.cas).map((item) => [item.cas!, item]),
);

export function resolveChemicalByName(name: string): Chemical | undefined {
  const hit = chemicalsByName.get(normalizeChemicalSearch(name));
  return hit || undefined;
}

export function resolveChemicalByCas(cas: string): Chemical | undefined {
  return chemicalsByCas.get(cas.trim()) ?? undefined;
}

/** True when a dictionary key maps to more than one chemical (shared alias). */
export function isAmbiguousChemicalTerm(term: string): boolean {
  return chemicalsByName.get(normalizeChemicalSearch(term)) === null;
}

/**
 * Only unambiguous identity labels for a chemical: canonical name, english,
 * unique aliases, and CAS. Shared/ambiguous aliases are excluded.
 */
export function chemicalIdentityTerms(chemical: Chemical): string[] {
  const terms = [...dictionaryNames(chemical), ...(chemical.cas ? [chemical.cas] : [])];
  return [...new Set(terms)].filter((term) => {
    if (chemical.cas && term.trim() === chemical.cas.trim()) return true;
    const resolved = resolveChemicalByName(term);
    return resolved?.name === chemical.name;
  });
}

export function resolveChemicalFromQuery(input: {
  terms?: string[];
  cas?: string;
  chemicalName?: string;
}): Chemical | undefined {
  if (input.chemicalName) {
    const byName = resolveChemicalByName(input.chemicalName);
    if (byName) return byName;
  }
  if (input.cas) {
    const byCas = resolveChemicalByCas(input.cas);
    if (byCas) return byCas;
  }
  for (const term of input.terms ?? []) {
    const hit = resolveChemicalByName(term);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Conservative identity: entity name must exactly equal an unambiguous
 * identity term for the chemical. Description mentions are never enough —
 * plants, mixtures, and downstream products often mention a chemical.
 */
export function entityBelongsToChemical(
  candidate: ChemicalMatchCandidate,
  chemical: Chemical,
): boolean {
  if (chemical.materialEntityTypes && !chemical.materialEntityTypes.some(
    (type) => normalizeChemicalSearch(type) === normalizeChemicalSearch(candidate.type ?? ""),
  )) return false;
  const nameKey = normalizeChemicalSearch(candidate.name);
  if (!nameKey) return false;

  const resolved = chemicalsByName.get(nameKey);
  if (resolved === null) return false;
  if (resolved && resolved.name !== chemical.name) return false;

  const identityKeys = new Set(
    chemicalIdentityTerms(chemical).map((term) => normalizeChemicalSearch(term)),
  );
  return identityKeys.has(nameKey);
}

export function matchBelongsToChemical(
  matchName: string,
  chemical: Chemical,
  _description?: string | null,
): boolean {
  return entityBelongsToChemical({ name: matchName }, chemical);
}

/** Resolve chemical only from the entity name — never from description text. */
export function resolveEntityChemical(
  entity: ChemicalMatchCandidate,
): Chemical | undefined {
  const chemical = resolveChemicalByName(entity.name);
  return chemical && entityBelongsToChemical(entity, chemical) ? chemical : undefined;
}

export function filterEntitiesBelongingToChemical<T extends ChemicalMatchCandidate & { id: string }>(
  entities: T[],
  chemical: Chemical,
): T[] {
  return entities.filter((entity) => entityBelongsToChemical(entity, chemical));
}
