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

## 结构化导入的向量（embedding）修复与配置

### 问题背景

结构化导入（`manual-ingestion-service`）以前**写死使用确定性哈希向量**（`deterministicEmbedding`），即使在「设置」里配置了真正的 embedding 模型也不会使用。哈希向量不表达语义，因此结构化导入的内容**无法被智能问答的向量检索召回**，提问时正文和下方都不会出现引用切片（而正常「上传文档」走 `ingestion-service`，用的是真 embedding，可被引用）。

此外，最终筛选 `filterUsefulEventIds` 要求“向量分数达标，或中文词级命中”。哈希向量分数≈0，而中文整句缺少分词，导致结构化导入的中文事件被全部过滤掉。

### 本次修复

`manual-ingestion-service` 改为使用配置的 embedding 客户端 `embeddingClient`，与「上传文档」一致：

- **填了远程 embedding API Key → 使用真正的语义向量**，结构化导入的内容可被检索和引用。
- **没填 → `embeddingClient` 内部自动退回确定性哈希向量**，离线仍可运行（行为同此前）。

也就是“有真模型就用真的，没有就退回”，自动切换，无需额外开关。

### 维度要求

数据库向量列固定为 `vector(1024)`，`EMBEDDING_DIMENSIONS` 强制为 `1024`（见 `src/config/env.ts`）。**所选 embedding 模型必须输出 1024 维**，否则写入失败。

### 推荐配置：免费的 bge-m3（云端 API，无需显卡 / 本地部署）

embedding 模型是云端 API，不需要显卡，也不需要本地部署。推荐免费、1024 维、对中文友好的 **`BAAI/bge-m3`**（硅基流动 SiliconFlow，OpenAI 兼容）：

- 接口地址 / baseUrl：`https://api.siliconflow.cn/v1`
- 模型 / model：`BAAI/bge-m3`
- API Key：在 siliconflow.cn 注册后于控制台「API 密钥」创建
- 维度 / dimensions：`1024`

备选（都支持 1024 维、需充值）：阿里百炼 `text-embedding-v3`、智谱 `embedding-3`。

### 配置后的生效步骤

1. 在「设置」填好上述 embedding 配置并保存。
2. 重新构建并重启服务：`npm run build`，然后 `npm run dev` 或 `npm start`。
3. **删除旧的结构化导入文档并重新导入**：旧数据里仍是哈希向量，需要用真向量覆盖。到「知识资产」删除旧文档，再重新上传 `*-simple-import.json`。
4. 提问时带上确定在实体里的具体词（产品名、企业名等），例如“原油最近的供需和价格怎么样，为什么？”，即可看到引用切片。

### 常见报错：`embedding request failed: 400 ... parameter is invalid`（code 20015）

原因：embedding 请求里发送了 `dimensions` 参数，而 **bge-m3 等固定维度模型不接受该参数**，硅基流动直接返回 400。

修复：embedding 请求现在**默认不发送 `dimensions`**（bge-m3 原生输出 1024 维，发回的维度仍会被校验是否等于 1024）。无需任何额外设置，重新 `npm run build` 并重启即可。

仅当你改用支持自定义维度、且原生维度不是 1024 的模型（如 OpenAI `text-embedding-3-*`）需要降维到 1024 时，才在环境变量里设 `EMBEDDING_SEND_DIMENSIONS=true` 重新发送该参数。

## rerank（重排）模型配置

rerank 只在「快速」检索模式使用；「标准」模式由 LLM 重排。没有可用的远程 rerank 时会自动降级为本地关键词+向量分数重排，**不是必需项**。

默认 rerank 复用问答 LLM 的地址和 key。如果你的问答 LLM 服务商没有 rerank 接口（如某些中转站只提供对话模型），可以让 rerank 独立指向其它服务商：

```bash
# 例：用硅基流动免费的 BAAI/bge-reranker-v2-m3（与 embedding 同一个 key 即可）
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_BASE_URL=https://api.siliconflow.cn/v1   # 留空则回退到 embedding 地址
RERANK_API_KEY=<硅基流动的 key>
```

填了 `RERANK_API_KEY` 就用这组独立配置；否则回退到 LLM 的地址/key（旧行为）。接口路径默认拼成单数 `/rerank`（硅基流动、Cohere、Jina、Voyage 等的标准），若 `RERANK_BASE_URL` 已以 `/rerank` 或 `/reranks` 结尾则原样使用。改完需 `npm run build` 并重启。
