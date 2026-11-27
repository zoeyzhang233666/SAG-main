import { describe, expect, it } from "vitest";
import {
  buildEventCategoryOptions,
  filterEventsByCategories,
  normalizeEventCategory,
} from "../web/src/lib/event-category.js";
import type { EventRecord } from "../web/src/types.js";

const uncategorized = "未分类";

function event(
  id: string,
  category?: string | null,
): EventRecord {
  return {
    id,
    sourceId: "source",
    title: id,
    summary: "",
    content: "",
    category: category ?? undefined,
    rank: 0,
  };
}

describe("event category helpers", () => {
  it("normalizes only null, empty, and surrounding whitespace", () => {
    expect(normalizeEventCategory(null, uncategorized)).toBe(uncategorized);
    expect(normalizeEventCategory(undefined, uncategorized)).toBe(uncategorized);
    expect(normalizeEventCategory("  ", uncategorized)).toBe(uncategorized);
    expect(normalizeEventCategory(" 生产工艺 ", uncategorized)).toBe("生产工艺");
    expect(normalizeEventCategory("行业动态", uncategorized)).toBe("行业动态");
  });

  it("aggregates from the full event set and sorts by count descending", () => {
    const options = buildEventCategoryOptions(
      [
        event("1", "生产工艺"),
        event("2", "生产工艺"),
        event("3", "行业动态"),
        event("4", null),
        event("5", "  "),
        event("6", "原料供应"),
      ],
      uncategorized,
    );
    expect(options.slice(0, 2)).toEqual([
      { category: "生产工艺", count: 2 },
      { category: uncategorized, count: 2 },
    ]);
    expect(
      options.slice(2).map((item: { category: string }) => item.category).sort(),
    ).toEqual(["原料供应", "行业动态"]);
    expect(
      options.slice(2).every((item: { count: number }) => item.count === 1),
    ).toBe(true);
  });

  it("keeps full-set counts independent of selection and filters by union", () => {
    const events = [
      event("1", "生产工艺"),
      event("2", "生产工艺"),
      event("3", "行业动态"),
      event("4", null),
    ];
    const options = buildEventCategoryOptions(events, uncategorized);
    expect(options.find((item: { category: string }) => item.category === "生产工艺")?.count).toBe(2);

    const selected = new Set(["生产工艺", uncategorized]);
    const filtered = filterEventsByCategories(events, selected, uncategorized);
    expect(filtered.map((item: EventRecord) => item.id).sort()).toEqual(["1", "2", "4"]);
    expect(buildEventCategoryOptions(events, uncategorized)).toEqual(options);
  });

  it("treats an empty selection as all events", () => {
    const events = [event("1", "生产工艺"), event("2", "行业动态")];
    expect(
      filterEventsByCategories(events, new Set(), uncategorized),
    ).toEqual(events);
  });
});
