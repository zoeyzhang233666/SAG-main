# 简化 / 完整导入导出说明

本版本把项目导出明确分成两种模式，并且前端会调用不同的后端接口，避免“按钮分了但实际内容一样”的问题。

## 两种导出模式

### 简化导出

简化导出用于：

- 多个数据库 / 多个项目之间手动拼接知识内容
- 导入全新数据库，让系统重新生成 UUID、embedding、metadata、时间戳
- 给网页版 AI 生成和校验入库数据
- Excel 人工检查和二次整理

简化导出会保留：

- 文档标题
- 来源名称 / 来源类型 / 来源日期 / 来源作者 / 来源链接
- 切片编号、切片标题、原文切片
- 事件标题、摘要、内容、分类、关键词
- 实体类型、实体名称、实体说明、关系说明

简化导出**不包含**：

- 项目 ID / project_id
- 数据库 ID / document_id / chunk_id / event_id / entity_id
- embedding
- metadata
- createdAt / updatedAt
- status / parseStatus
- archivedAt

简化 JSON 文件名后缀为：

```text
-simple-import.json
```

简化 CSV 文件名后缀为：

```text
-simple-import.csv
```

### 完整导出

完整导出用于：

- 排查系统内部结构
- 保留更完整的 knowledge-export 参考字段
- 需要看项目 ID、文档 ID、事件 ID、实体 ID、metadata、时间戳时

完整导出文件名后缀为：

```text
-knowledge-export.json
-knowledge-export.csv
```

注意：完整导出仍然不是 PostgreSQL 级别数据库快照。重新用网页导入时，系统通常仍会重新生成数据库 ID 和 embedding。如果要完整保留数据库 ID 和 embedding，请使用 PostgreSQL `pg_dump` / `pg_restore`。

## 本版接口变化

为了避免 query 参数、缓存或旧前端导致模式混淆，本版新增了独立接口：

```text
GET /api/projects/:projectId/export-simple?format=json
GET /api/projects/:projectId/export-simple?format=csv
GET /api/projects/:projectId/export-full?format=json
GET /api/projects/:projectId/export-full?format=csv
```

拆分导出也有独立接口：

```text
GET /api/projects/:projectId/export-files-simple?format=json&split=documents
GET /api/projects/:projectId/export-files-full?format=json&split=documents
```

旧接口 `/export?profile=simple|full` 和 `/export-files?profile=simple|full` 仍保留兼容。

## 简化 JSON 结构

简化 JSON 顶层是：

```json
{
  "documents": [
    {
      "title": "文档标题",
      "source": {
        "name": "来源名称",
        "type": "report",
        "date": "2025-03",
        "author": "来源作者、机构、公众号、网站、研究所或公司名称",
        "url": "来源链接"
      },
      "chunks": [
        {
          "key": "1",
          "heading": "切片标题",
          "content": "原文切片",
          "event": {
            "title": "事件标题",
            "summary": "事件摘要",
            "content": "事件内容",
            "category": "事件分类",
            "keywords": ["关键词1", "关键词2"],
            "entities": [
              {
                "type": "实体类型",
                "name": "实体名称",
                "description": "实体本身说明",
                "relation": "实体和当前事件的关系说明"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

source.author 同时容纳作者和机构；本版不包含来源页码、来源章节、来源定位。

## 简化 CSV v2 表头

简化 CSV 有 18 列：

```csv
"文档标题","来源名称","来源类型","来源日期","来源作者","来源链接","切片编号","切片标题","原文切片","事件标题","事件摘要","事件内容","事件分类","关键词","实体类型","实体名称","实体说明","关系说明"
```

同一个事件有多个实体时，写多行，并保持“切片编号”完全相同。导入时系统会合并为一个事件和多个实体。

## 如果你发现导出还是一样

请重点检查是否还在运行旧的编译结果。

推荐步骤：

```bash
npm run build
npm run dev
```

如果你用的是生产启动：

```bash
npm run build
npm start
```

本压缩包已经包含新的 `dist/` 和 `web/dist/`，复制覆盖时请确认这些目录也被覆盖。

## 来源字段展示说明

本版本新增的来源字段（来源名称、来源类型、来源日期、来源作者、来源链接）会作为 `documents` 表的正式列保存，并在以下网页位置展示：

- 知识资产：文档列表与文档概览。
- 智能问答：右侧「引用资产」中的引用切片卡片，以及点击引用后的详情栏。
- 知识超图：点击事件后的详情栏；点击实体后的关联事件卡片会显示对应事件所属文档的来源摘要。

这些来源字段只用于网页展示和导入导出，不会加入最终问答生成上下文，也不会被拼进回答正文的参考资料。这样可以保留来源可追溯性，同时避免增加回答生成噪音。
