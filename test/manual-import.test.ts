import { describe, expect, it } from "vitest";
import { parseManualKnowledge, parseManualKnowledgeDocuments } from "../src/ingestion/manual-import.js";

const headers = [
  "文档标题", "切片编号", "切片标题", "原文切片", "事件标题", "事件摘要",
  "事件内容", "事件分类", "关键词", "实体类型", "实体名称", "实体说明"
];

describe("manual knowledge import", () => {
  it("groups CSV rows into one event with multiple entities", () => {
    const csv = `\`\`\`csv\n${[
      headers.join(","),
      "煤化工,1,煤气化,煤气化生成合成气,煤气化生产合成气,煤转化为合成气,煤经气化生成合成气,生产工艺,煤；合成气,原料,煤,气化原料",
      "煤化工,1,煤气化,煤气化生成合成气,煤气化生产合成气,煤转化为合成气,煤经气化生成合成气,生产工艺,煤；合成气,中间体,合成气,气化产物"
    ].join("\n")}\n\`\`\``;
    const result = parseManualKnowledge(csv, { format: "csv" });
    expect(result.title).toBe("煤化工");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].event.entities.map((entity) => entity.name)).toEqual(["煤", "合成气"]);
  });

  it("parses Markdown table rows", () => {
    const markdown = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      "| 氯碱产业链 | 1 | 电解食盐水 | 食盐水电解生成烧碱和氯气 | 氯碱电解 | 食盐水经电解转化 | 食盐水电解生成烧碱、氯气和氢气 | 生产工艺 | 食盐水；烧碱 | 原料 | 食盐水 | 电解原料 |"
    ].join("\n");
    const result = parseManualKnowledge(markdown, { format: "markdown" });
    expect(result.chunks[0].event.title).toBe("氯碱电解");
    expect(result.chunks[0].event.entities[0].type).toBe("原料");
  });

  it("parses structured JSON", () => {
    const result = parseManualKnowledge(JSON.stringify({
      title: "甲醇产业链",
      chunks: [{
        heading: "甲醇制烯烃",
        content: "甲醇通过 MTO 工艺生产乙烯和丙烯。",
        event: {
          title: "MTO 生产烯烃",
          summary: "甲醇转化为烯烃。",
          content: "甲醇通过 MTO 工艺生产乙烯和丙烯。",
          keywords: ["甲醇", "MTO"],
          entities: [
            { type: "原料", name: "甲醇", description: "MTO 工艺原料" },
            { type: "产品", name: "乙烯", description: "MTO 工艺产品" }
          ]
        }
      }]
    }), { format: "json" });
    expect(result.title).toBe("甲醇产业链");
    expect(result.chunks[0].event.entities).toHaveLength(2);
  });

  it("restores multiple documents from project export CSV", () => {
    const csv = [
      "document_id,document_title,chunk_id,chunk_heading,chunk_content,event_title,event_summary,event_content,event_category,keywords,entity_type,entity_name,entity_description",
      "doc-1,煤化工,1,煤气化,煤经气化生成合成气,煤气化生成合成气,煤转化为合成气,煤经气化生成合成气,生产工艺,煤;合成气,原料,煤,煤气化原料",
      "doc-2,氯碱产业链,1,食盐水电解,食盐水电解生成烧碱,食盐水电解,食盐水经电解转化,食盐水电解生成烧碱,生产工艺,食盐水;烧碱,原料,食盐水,电解原料"
    ].join("\n");
    const documents = parseManualKnowledgeDocuments(csv, { format: "csv" });
    expect(documents.map((document) => document.title)).toEqual(["煤化工", "氯碱产业链"]);
    expect(documents.map((document) => document.chunks[0].key)).toEqual(["1", "1"]);
  });

  it("restores project export JSON", () => {
    const documents = parseManualKnowledgeDocuments(JSON.stringify({
      schemaVersion: 1,
      project: { id: "project-id", name: "化工项目" },
      documents: [{
        id: "document-id",
        title: "聚氨酯产业链",
        chunks: [{
          id: "12",
          systemChunkId: "chunk-uuid",
          heading: "聚醚多元醇生产",
          content: "环氧丙烷开环聚合生成聚醚多元醇。",
          events: [{
            id: "event-uuid",
            title: "环氧丙烷生产聚醚多元醇",
            summary: "环氧丙烷经聚合生成聚醚多元醇。",
            content: "环氧丙烷开环聚合生成聚醚多元醇。",
            category: "生产工艺",
            keywords: ["环氧丙烷", "聚醚多元醇"],
            entities: [{
              entityId: "entity-uuid",
              entityType: "原料",
              entityName: "环氧丙烷",
              entityDescription: "聚醚多元醇原料",
              relationDescription: "开环聚合的原料"
            }]
          }]
        }]
      }]
    }), { format: "json" });
    expect(documents).toHaveLength(1);
    expect(documents[0].title).toBe("聚氨酯产业链");
    expect(documents[0].chunks[0].event.entities[0]).toEqual({
      type: "原料",
      name: "环氧丙烷",
      description: "聚醚多元醇原料",
      relation: "开环聚合的原料"
    });
  });
});
