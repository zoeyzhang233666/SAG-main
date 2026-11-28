import type { EventRecord } from "../types.js";

export const EVENT_CATEGORY_DEFAULT_VISIBLE = 8;

/** Trim only; blank values become the provided uncategorized label. No synonym merging. */
export function normalizeEventCategory(
  category: string | null | undefined,
  uncategorizedLabel: string,
): string {
  const trimmed = category == null ? "" : String(category).trim();
  return trimmed || uncategorizedLabel;
}

export type EventCategoryOption = {
  category: string;
  count: number;
};

/** Aggregate from the full related-event set; sorted by count desc then name. */
export function buildEventCategoryOptions(
  events: EventRecord[],
  uncategorizedLabel: string,
): EventCategoryOption[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = normalizeEventCategory(event.category, uncategorizedLabel);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.category.localeCompare(right.category, "zh"),
    );
}

/** Empty selection means "all". Multi-select uses the union of categories. */
export function filterEventsByCategories(
  events: EventRecord[],
  selectedCategories: ReadonlySet<string>,
  uncategorizedLabel: string,
): EventRecord[] {
  if (selectedCategories.size === 0) {
    return events;
  }
  return events.filter((event) =>
    selectedCategories.has(
      normalizeEventCategory(event.category, uncategorizedLabel),
    ),
  );
}
