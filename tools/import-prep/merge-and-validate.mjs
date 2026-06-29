#!/usr/bin/env node
/**
 * merge-and-validate.mjs
 *
 * 把"按章节分别让网页版 AI 抽取出来的多个 JSON 片段"合并成 SAG 可以一次性导入的
 * 单个文档 JSON，并按导入端的真实规则做校验 + 连续重新编号切片。
 *
 * 解决的问题：
 *   1. 网页版 AI 输出常见瑕疵：包了 ```json 代码块、前后有解释文字、结尾多了逗号、BOM。
 *      —— 这里会自动剥离 / 修复后再 JSON.parse。
 *   2. 同一来源文档的内容必须在"同一次导入"里才能落到同一个文档下（导入端每次都新建文档）。
 *      —— 这里把所有章节的 chunks 合并进 1 个 document。
 *   3. 切片编号必须在文档内唯一。
 *      —— 这里统一重排成 1..N，章节之间天然连续，无需你手动维护。
 *   4. 导入端校验：每个切片必须有 content、event.title、且至少 1 个有名字的实体。
 *      —— 这里提前校验并精确报错，"过了脚本 = 能导入"。
 *
 * 用法：
 *   node tools/import-prep/merge-and-validate.mjs <章节JSON所在目录> [选项]
 *
 * 选项：
 *   --title "文档标题"     覆盖文档标题（否则取 meta.json 的 title，再否则取目录名）
 *   --out   <输出文件>     输出路径（默认 <目录>/<标题>-simple-import.json）
 *   --meta  <meta.json>    指定来源信息文件（默认读取 <目录>/meta.json）
 *   --force                即使有校验错误也写出文件（默认有错就只报错不写）
 *
 * meta.json 示例（放在章节目录里即可被自动读取）：
 *   {
 *     "title": "ABS产业链梳理",
 *     "source": { "name": "某券商化工深度", "type": "report",
 *                 "date": "2025-03", "author": "XX证券", "url": "" }
 *   }
 *
 * 章节文件：目录下所有 *.json（除 meta.json 和已生成的 *-simple-import.json）。
 * 每个文件可以是以下任意一种形状，脚本都能识别：
 *   { "chunks": [ ... ] }
 *   { "documents": [ { "chunks": [ ... ] } ] }
 *   [ {chunk}, {chunk} ]            // 直接是 chunk 数组
 * 文件名建议用 01-xxx.json、02-xxx.json…… 以保证合并顺序。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith("--")) {
  console.error("用法: node tools/import-prep/merge-and-validate.mjs <章节JSON目录> [--title ..] [--out ..] [--meta ..] [--force]");
  process.exit(2);
}
const inputDir = argv[0];
const opts = {};
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--force") opts.force = true;
  else if (a === "--title") opts.title = argv[++i];
  else if (a === "--out") opts.out = argv[++i];
  else if (a === "--meta") opts.meta = argv[++i];
  else console.error(`忽略未知参数: ${a}`);
}
if (!existsSync(inputDir)) {
  console.error(`目录不存在: ${inputDir}`);
  process.exit(2);
}

// ---------- JSON 容错解析 ----------

/** 从一段可能含代码块/解释文字的文本中，抽出第一个完整的 JSON 值（{...} 或 [...]）。 */
function extractJsonText(raw) {
  let text = raw.replace(/^﻿/, "").trim();
  // 整段恰好是一个 ```json ... ``` 代码块时剥掉围栏
  const fence = text.match(/^```(?:json|json5|txt)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  if (fence) text = fence[1].trim();
  // 否则从第一个 { 或 [ 开始做括号配对（忽略字符串里的括号）扫到闭合
  const start = text.search(/[{[]/);
  if (start === -1) return text;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start); // 不平衡也先返回，交给 JSON.parse 报错
}

/** 去掉对象/数组结尾的多余逗号（仅在初次解析失败后兜底）。 */
function removeTrailingCommas(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      // 向后看下一个非空白字符是否是 } 或 ]
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue; // 丢弃这个逗号
    }
    out += c;
  }
  return out;
}

function parseLoose(raw, file) {
  const text = extractJsonText(raw);
  try {
    return JSON.parse(text);
  } catch (e1) {
    try {
      return JSON.parse(removeTrailingCommas(text));
    } catch (e2) {
      const pos = Number((/position (\d+)/.exec(e2.message) || [])[1]);
      let hint = "";
      if (!Number.isNaN(pos)) {
        const s = Math.max(0, pos - 60);
        hint = `\n  出错位置附近: …${text.slice(s, pos + 60).replace(/\n/g, "⏎")}…`;
      }
      throw new Error(`[${file}] JSON 解析失败：${e2.message}${hint}`);
    }
  }
}

// ---------- chunk 抽取与规范化 ----------

function chunksFrom(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.chunks)) return parsed.chunks;
  if (parsed && Array.isArray(parsed.documents)) {
    return parsed.documents.flatMap((d) => (Array.isArray(d?.chunks) ? d.chunks : []));
  }
  return [];
}

function str(v) {
  if (v == null) return "";
  return (typeof v === "string" ? v : String(v)).trim();
}

function normKeywords(v) {
  if (Array.isArray(v)) return [...new Set(v.map(str).filter(Boolean))];
  return [...new Set(str(v).split(/[;；、,，]/).map((s) => s.trim()).filter(Boolean))];
}

/** 规范化一个 chunk，并收集硬错误(errors)/软提醒(warnings)。idx 为全局序号(从1)。 */
function normalizeChunk(rawChunk, idx, file, errors, warnings) {
  const ev = (rawChunk && typeof rawChunk.event === "object" && rawChunk.event) ? rawChunk.event : rawChunk || {};
  const content = str(rawChunk?.content) || str(rawChunk?.rawContent) || str(rawChunk?.chunkContent) || str(ev?.content) || str(ev?.eventContent);
  const eventTitle = str(ev?.title) || str(ev?.eventTitle) || str(rawChunk?.heading) || str(rawChunk?.chunkHeading);
  const rawEntities = Array.isArray(ev?.entities) ? ev.entities : [];
  const entities = rawEntities
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      type: str(e.type) || str(e.entityType) || "subject",
      name: str(e.name) || str(e.entityName),
      description: str(e.description) || str(e.entityDescription) || `在事件「${eventTitle || `事件 ${idx}`}」中被提及`,
      relation: str(e.relation) || str(e.relationDescription) || undefined
    }))
    .filter((e) => e.name.length > 0);

  const where = `切片#${idx}（来自 ${file}）`;
  if (!content) errors.push(`${where}：缺少 content / 原文切片`);
  if (!eventTitle) errors.push(`${where}：缺少 event.title / 事件标题`);
  if (entities.length === 0) errors.push(`${where}：没有有效实体（至少需要 1 个含 name 的实体）`);
  // 软提醒：不阻断导入，但质量相关
  if (content && eventTitle && content === str(ev?.content)) {
    warnings.push(`${where}：content 与 event.content 完全相同（提示词要求两者一般应不同）`);
  }
  if (entities.length === 1 && content.length > 120) {
    warnings.push(`${where}：只有 1 个实体但原文较长，注意是否漏抽`);
  }

  return {
    key: String(idx), // 统一连续重排，保证文档内唯一
    heading: str(rawChunk?.heading) || str(rawChunk?.chunkHeading) || eventTitle || `切片 ${idx}`,
    content,
    event: {
      title: eventTitle || `事件 ${idx}`,
      summary: str(ev?.summary) || str(ev?.eventSummary) || content,
      content: str(ev?.content) || str(ev?.eventContent) || content,
      category: str(ev?.category) || str(ev?.eventCategory) || undefined,
      keywords: normKeywords(ev?.keywords),
      entities
    }
  };
}

// ---------- 主流程 ----------

const files = readdirSync(inputDir)
  .filter((f) => f.toLowerCase().endsWith(".json"))
  .filter((f) => f.toLowerCase() !== "meta.json")
  .filter((f) => !f.toLowerCase().endsWith("-simple-import.json"))
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

if (files.length === 0) {
  console.error(`目录里没有可合并的章节 JSON：${inputDir}`);
  process.exit(2);
}

// 读取 meta.json（来源信息）
let meta = {};
const metaPath = opts.meta || join(inputDir, "meta.json");
if (existsSync(metaPath)) {
  try { meta = parseLoose(readFileSync(metaPath, "utf8"), basename(metaPath)); }
  catch (e) { console.error(`meta 读取失败：${e.message}`); process.exit(2); }
}

const errors = [];
const warnings = [];
const mergedChunks = [];
let counter = 0;

for (const f of files) {
  const full = join(inputDir, f);
  let parsed;
  try { parsed = parseLoose(readFileSync(full, "utf8"), f); }
  catch (e) { errors.push(e.message); continue; }
  const chunks = chunksFrom(parsed);
  if (chunks.length === 0) {
    warnings.push(`[${f}] 没有解析出任何 chunk（结构是否为 {chunks:[...]}？）`);
    continue;
  }
  for (const c of chunks) {
    counter += 1;
    mergedChunks.push(normalizeChunk(c, counter, f, errors, warnings));
  }
}

const title = str(opts.title) || str(meta.title) || basename(inputDir.replace(/[\\/]+$/, "")) || "网页版 AI 导入";
const source = (meta.source && typeof meta.source === "object") ? meta.source : undefined;

// ---------- 报告 ----------
console.log(`\n=== 合并报告 ===`);
console.log(`目录：${inputDir}`);
console.log(`章节文件：${files.length} 个 → ${mergedChunks.length} 个切片`);
console.log(`文档标题：${title}`);
if (warnings.length) {
  console.log(`\n⚠ 软提醒 ${warnings.length} 条（不阻断导入）：`);
  for (const w of warnings.slice(0, 50)) console.log(`  - ${w}`);
  if (warnings.length > 50) console.log(`  …还有 ${warnings.length - 50} 条`);
}
if (errors.length) {
  console.log(`\n✗ 硬错误 ${errors.length} 条（修好对应章节文件后重跑）：`);
  for (const e of errors) console.log(`  - ${e}`);
}

if (errors.length && !opts.force) {
  console.log(`\n未写出文件。修复后重跑，或加 --force 强行写出（不推荐）。`);
  process.exit(1);
}
if (mergedChunks.length === 0) {
  console.error(`\n没有任何切片，终止。`);
  process.exit(1);
}

const outDoc = { documents: [{ title, ...(source ? { source } : {}), chunks: mergedChunks }] };
const outPath = opts.out || join(inputDir, `${title}-simple-import.json`);
writeFileSync(outPath, JSON.stringify(outDoc, null, 2), "utf8");
console.log(`\n✓ 已写出可导入文件：${outPath}`);
console.log(`  → 到 SAG 网页"粘贴或上传网页版 AI 的数据"上传此文件即可（一次导入 = 一个文档）。`);
if (errors.length) console.log(`  注意：--force 模式下仍有 ${errors.length} 条硬错误，导入端可能再次拒绝。`);
