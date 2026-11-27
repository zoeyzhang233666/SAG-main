import { useId } from "react";
import { z } from "zod";
import { useI18n } from "../i18n";

const sourceIndex = z.number().int().positive().max(50);
const artifactSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1), kind: z.literal("flow"),
    nodes: z.array(z.object({
      id: z.guid(), label: z.string().max(96), kind: z.enum(["event", "entity"]),
      citation: sourceIndex.optional()
    })).min(2).max(12),
    edges: z.array(z.object({ from: z.guid(), to: z.guid() })).min(1).max(16)
  }),
  z.object({
    version: z.literal(1), kind: z.literal("metrics"),
    chunks: z.number().int().nonnegative().max(50),
    events: z.number().int().nonnegative().max(100),
    entities: z.number().int().nonnegative().max(500)
  }),
  z.object({
    version: z.literal(1), kind: z.literal("table"),
    rows: z.array(z.object({ index: sourceIndex, heading: z.string().max(160).optional() })).min(1).max(10)
  })
]);

type Flow = Extract<z.infer<typeof artifactSchema>, { kind: "flow" }>;

function wrapLabel(value: string) {
  const chars = Array.from(value);
  const rows = [];
  for (let start = 0; start < Math.min(chars.length, 54); start += 18) {
    rows.push(chars.slice(start, Math.min(start + 18, 54)).join(""));
  }
  if (chars.length > 54) rows[2] += "…";
  return rows;
}

function FlowFigure({ flow, onCitation }: { flow: Flow; onCitation: (index: number) => void }) {
  const { t } = useI18n();
  const title = useId();
  const events = flow.nodes.filter((node) => node.kind === "event");
  const entities = flow.nodes.filter((node) => node.kind === "entity");
  const height = Math.max(events.length, entities.length) * 67 + 37;
  const nodes = [...events.map((node, i) => ({ ...node, x: 12, y: 30 + i * 67 })),
    ...entities.map((node, i) => ({ ...node, x: 352, y: 30 + i * 67 }))];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = flow.edges.flatMap((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    return from?.kind === "event" && to?.kind === "entity" ? [{ from, to }] : [];
  });
  if (!edges.length) return null;
  return (
    <figure className="chem-answer-artifact">
      <figcaption>{t("检索到的事件与实体", "Retrieved events and entities")}</figcaption>
      <div className="chem-answer-flow-scroll" tabIndex={0} aria-label={t("横向滚动查看图", "Scroll to view the diagram")}>
        <svg viewBox={`0 0 620 ${height}`} role="img" aria-labelledby={title}>
          <title id={title}>{t("事件与实体关联", "Event and entity links")}</title>
          <desc>{edges.map(({ from, to }) => `${from.label} · ${to.label}`).join("。")}</desc>
          <text x="12" y="19" className="chem-answer-flow-heading">{t("事件", "Events")}</text>
          <text x="352" y="19" className="chem-answer-flow-heading">{t("实体", "Entities")}</text>
          {edges.map(({ from, to }, index) => (
            <path key={`${from.id}-${to.id}-${index}`} className="chem-answer-flow-edge"
              d={`M ${from.x + 248} ${from.y + 28} C 310 ${from.y + 28}, 310 ${to.y + 28}, ${to.x} ${to.y + 28}`} />
          ))}
          {nodes.map((node) => (
            <g key={node.id} data-kind={node.kind}>
              <title>{node.label}</title>
              <rect x={node.x} y={node.y} width="248" height="56" rx="9" />
              <text x={node.x + 11} y={node.y + 18}>
                {wrapLabel(node.label).map((line, index) => (
                  <tspan key={index} x={node.x + 11} dy={index ? 15 : 0}>{line}</tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap gap-1">
        {[...new Set(events.flatMap((item) => item.citation ? [item.citation] : []))].map((index) =>
          <button key={index} className="chem-citation-link" type="button"
            aria-label={t(`查看引用 ${index}`, `Open citation ${index}`)} onClick={() => onCitation(index)}>{index}</button>
        )}
      </div>
    </figure>
  );
}

export function AnswerArtifacts({ value, onCitation }: { value: unknown; onCitation: (index: number) => void }) {
  const { t } = useI18n();
  if (!Array.isArray(value)) return null;
  return value.slice(0, 2).map((item, index) => {
    const checked = artifactSchema.safeParse(item);
    if (!checked.success) return null;
    const artifact = checked.data;
    if (artifact.kind === "flow") return <FlowFigure key={index} flow={artifact} onCitation={onCitation} />;
    if (artifact.kind === "metrics") {
      return (
        <dl key={index} className="chem-answer-artifact grid grid-cols-3 gap-2">
          {([[t("原文片段", "Excerpts"), artifact.chunks], [t("关联事件", "Events"), artifact.events],
            [t("关联实体", "Entities"), artifact.entities]] as const).map(([label, count]) => (
            <div key={label} className="rounded-lg border border-border bg-background px-2 py-1">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      );
    }
    return (
      <div key={index} className="chem-answer-artifact overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="mb-1 text-left font-medium">{t("对照证据", "Comparison sources")}</caption>
          <tbody>{artifact.rows.map((row) => (
            <tr key={row.index} className="border-b border-border">
              <td className="py-1 pr-3">{row.heading || t("原文片段", "Source excerpt")}</td>
              <td><button type="button" className="chem-citation-link" onClick={() => onCitation(row.index)}>{row.index}</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
  });
}
