#!/usr/bin/env node
/**
 * Split a Markdown source document into stable per-agent tasks for SAG JSON extraction.
 *
 * This script deliberately does not extract JSON. It only prepares deterministic
 * section files and a task manifest, so workflow agents can spend their time on
 * semantic extraction instead of re-inventing splitting rules.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);

function usage() {
  console.error(`Usage:
  node tools/import-prep/split-markdown-for-agents.mjs <source.md> <json-output-dir> [options]

Options:
  --sections-dir <dir>       Where to write markdown section tasks. Default: <json-output-dir>/_sections
  --max-chars <n>            Preferred max characters per agent task. Default: 6500
  --min-chars <n>            Merge small neighboring blocks up to this size. Default: 900
  --context-chars <n>        Visible original-text overlap chars for long-block splits. Default: 900
  --max-heading-level <1-6>  Only start fresh tasks at headings up to this level. Default: 6
  --clean                   Remove previous generated files in the sections dir before writing
  --no-comments             Do not add HTML metadata comments to section files
`);
}

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

if (argv.length < 2 || argv[0]?.startsWith("--")) {
  usage();
  process.exit(2);
}

const sourcePath = resolve(argv[0]);
const jsonOutputDir = resolve(argv[1]);
const opts = {
  sectionsDir: null,
  maxChars: 6500,
  minChars: 900,
  contextChars: 900,
  maxHeadingLevel: 6,
  clean: false,
  comments: true
};

for (let i = 2; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--sections-dir") opts.sectionsDir = resolve(argv[++i]);
  else if (a === "--max-chars") opts.maxChars = positiveInt(argv[++i], "--max-chars");
  else if (a === "--min-chars") opts.minChars = positiveInt(argv[++i], "--min-chars");
  else if (a === "--context-chars") opts.contextChars = positiveInt(argv[++i], "--context-chars");
  else if (a === "--max-heading-level") opts.maxHeadingLevel = headingLevel(argv[++i]);
  else if (a === "--clean") opts.clean = true;
  else if (a === "--no-comments") opts.comments = false;
  else die(`Unknown option: ${a}`);
}

opts.sectionsDir ||= join(jsonOutputDir, "_sections");

if (!existsSync(sourcePath)) die(`Source file does not exist: ${sourcePath}`);
if (opts.minChars > opts.maxChars) die("--min-chars must be <= --max-chars");

mkdirSync(jsonOutputDir, { recursive: true });
prepareSectionsDir(opts.sectionsDir, opts.clean);

const source = readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");
const blocks = parseMarkdownBlocks(source, opts.maxHeadingLevel);
const tasks = buildTasks(blocks, opts);
writeTasks(tasks, {
  sourcePath,
  jsonOutputDir,
  sectionsDir: opts.sectionsDir,
  maxChars: opts.maxChars,
  minChars: opts.minChars,
  contextChars: opts.contextChars,
  comments: opts.comments
});

console.log(`Prepared ${tasks.length} agent section files.`);
console.log(`Sections dir: ${opts.sectionsDir}`);
console.log(`Task list: ${join(opts.sectionsDir, "agent-tasks.md")}`);
console.log(`After extraction, save JSON as 01.json, 02.json, ... in: ${jsonOutputDir}`);

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) die(`${label} must be a positive integer`);
  return n;
}

function headingLevel(value) {
  const n = positiveInt(value, "--max-heading-level");
  if (n < 1 || n > 6) die("--max-heading-level must be between 1 and 6");
  return n;
}

function prepareSectionsDir(dir, clean) {
  mkdirSync(dir, { recursive: true });
  if (!clean) return;
  const allowed = new Set(["manifest.json", "agent-tasks.md"]);
  for (const name of readdirSync(dir)) {
    if (/^\d{2,}\.md$/u.test(name) || allowed.has(name)) {
      rmSync(join(dir, name), { force: true });
    }
  }
}

function parseMarkdownBlocks(markdown, maxHeadingLevel) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const stack = [];
  let current = null;
  let preface = [];
  let inFence = false;

  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)/u);
    if (fence) inFence = !inFence;

    const heading = !inFence ? parseHeading(line) : null;
    if (heading && heading.level <= maxHeadingLevel) {
      finishCurrent();
      if (preface.length && hasMeaningfulText(preface)) {
        blocks.push({
          level: 0,
          title: "Preface",
          path: [],
          lines: trimOuterBlankLines(preface)
        });
      }
      preface = [];
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push({ level: heading.level, title: heading.title });
      current = {
        level: heading.level,
        title: heading.title,
        path: [...stack],
        lines: [line]
      };
    } else if (current) {
      current.lines.push(line);
    } else {
      preface.push(line);
    }
  }

  finishCurrent();
  if (preface.length && hasMeaningfulText(preface)) {
    blocks.push({ level: 0, title: "Preface", path: [], lines: trimOuterBlankLines(preface) });
  }
  return blocks.filter((block) => hasMeaningfulText(block.lines));

  function finishCurrent() {
    if (!current) return;
    current.lines = trimOuterBlankLines(current.lines);
    if (hasMeaningfulText(current.lines)) blocks.push(current);
    current = null;
  }
}

function parseHeading(line) {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function hasMeaningfulText(lines) {
  return lines.some((line) => line.trim() && !/^\s*<!--.*-->\s*$/u.test(line));
}

function trimOuterBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function buildTasks(blocks, opts) {
  const tasks = [];
  let pending = null;

  for (const block of blocks) {
    const blockText = block.lines.join("\n").trim();
    if (blockText.length > opts.maxChars) {
      flushPending();
      for (const part of splitLargeBlock(block, opts.maxChars, opts.contextChars)) tasks.push(part);
      continue;
    }

    if (!pending) {
      pending = taskFromBlocks([block]);
      continue;
    }

    const merged = taskFromBlocks([...pending.blocks, block]);
    const previousIsSmall = pending.text.length < opts.minChars;
    const currentIsSmall = blockText.length < opts.minChars;
    const canMerge = merged.text.length <= opts.maxChars;

    if (canMerge && (previousIsSmall || currentIsSmall)) {
      pending = merged;
    } else {
      flushPending();
      pending = taskFromBlocks([block]);
    }
  }

  flushPending();
  return tasks.map((task, index) => ({ ...task, id: index + 1 }));

  function flushPending() {
    if (!pending) return;
    tasks.push(pending);
    pending = null;
  }
}

function taskFromBlocks(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (lines.length) lines.push("");
    lines.push(...block.lines);
  }
  const path = commonPath(blocks.map((block) => block.path));
  const title = path.at(-1)?.title || blocks[0]?.title || "Untitled";
  return {
    title,
    path,
    blocks,
    splitFromLongBlock: false,
    hasVisibleContext: false,
    text: lines.join("\n").trim()
  };
}

function commonPath(paths) {
  if (!paths.length) return [];
  const out = [];
  for (let i = 0; ; i += 1) {
    const first = paths[0][i];
    if (!first) break;
    if (paths.every((path) => path[i]?.level === first.level && path[i]?.title === first.title)) {
      out.push(first);
    } else {
      break;
    }
  }
  return out;
}

function splitLargeBlock(block, maxChars, contextChars) {
  const headingLine = block.lines[0] && parseHeading(block.lines[0]) ? block.lines[0] : null;
  const body = headingLine ? block.lines.slice(1) : block.lines;
  const prefix = buildContextPrefix(block);
  const budget = Math.max(1000, maxChars - prefix.join("\n").length - 4);
  const units = splitIntoSemanticUnits(body).flatMap((unit) => splitOversizedUnit(unit, budget));
  const parts = [];
  let current = [];

  for (const unit of units) {
    const next = [...current, ...(current.length ? [""] : []), ...unit];
    if (current.length && next.join("\n").length > budget) {
      parts.push(current);
      current = unit;
    } else {
      current = next;
    }
  }
  if (current.length) parts.push(current);

  const introAnchor = excerptFromLines(parts[0] || [], contextChars);
  return parts.map((part, index) => {
    const visibleContext = [];
    if (index > 0 && introAnchor) {
      visibleContext.push(
        "> [SAG 本节开头重叠原文，可作为证据；不要把本行标记写入 chunk.content]",
        ...prefixBlockquote(introAnchor),
        ""
      );
    }
    const previousTail = index > 0 ? excerptFromLines(parts[index - 1], contextChars, "tail") : "";
    if (previousTail) {
      visibleContext.push(
        "> [SAG 上一分片结尾重叠原文，可作为证据；不要把本行标记写入 chunk.content]",
        ...prefixBlockquote(previousTail),
        ""
      );
    }
    if (visibleContext.length) {
      visibleContext.push("> [SAG 当前分片原文从下一行开始；不要把本行标记写入 chunk.content]", "");
    }

    return {
      title: `${block.title} (${index + 1}/${parts.length})`,
      path: block.path,
      blocks: [block],
      splitFromLongBlock: true,
      hasVisibleContext: visibleContext.length > 0,
      text: [...prefix, "", ...visibleContext, ...trimOuterBlankLines(part)].join("\n").trim()
    };
  });
}

function buildContextPrefix(block) {
  if (block.path.length) {
    return block.path.map((item) => `${"#".repeat(item.level)} ${item.title}`);
  }
  return block.title ? [`# ${block.title}`] : [];
}

function splitIntoSemanticUnits(lines) {
  const units = [];
  let current = [];
  let inFence = false;

  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)/u);
    if (fence) inFence = !inFence;

    if (!inFence && !line.trim()) {
      if (current.length) {
        units.push(trimOuterBlankLines(current));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) units.push(trimOuterBlankLines(current));
  return units.filter((unit) => unit.length);
}

function splitOversizedUnit(unit, maxChars) {
  const text = unit.join("\n").trim();
  if (text.length <= maxChars) return [unit];
  const pieces = text
    .split(/(?<=[。！？；;.!?])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (pieces.length <= 1) return hardWrapText(text, maxChars).map((part) => [part]);

  const out = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}${piece}` : piece;
    if (current && next.length > maxChars) {
      out.push([current]);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) out.push([current]);
  return out;
}

function hardWrapText(text, maxChars) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxChars) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts;
}

function excerptFromLines(lines, maxChars, side = "head") {
  const cleanLines = trimOuterBlankLines(lines);
  const text = cleanLines.join("\n").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return side === "tail"
    ? takeTailLines(cleanLines, maxChars).join("\n").trim()
    : takeHeadLines(cleanLines, maxChars).join("\n").trim();
}

function prefixBlockquote(text) {
  return String(text || "")
    .split("\n")
    .map((line) => `> ${line}`);
}

function takeHeadLines(lines, maxChars) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const nextUsed = used + line.length + 1;
    if (nextUsed <= maxChars) {
      out.push(line);
      used = nextUsed;
      continue;
    }
    const remaining = maxChars - used;
    if (remaining > 20 && out.length === 0) out.push(line.slice(0, remaining));
    break;
  }
  return out;
}

function takeTailLines(lines, maxChars) {
  const out = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const nextUsed = used + line.length + 1;
    if (nextUsed <= maxChars) {
      out.unshift(line);
      used = nextUsed;
      continue;
    }
    const remaining = maxChars - used;
    if (remaining > 20 && out.length === 0) out.unshift(line.slice(-remaining));
    break;
  }
  return out;
}

function writeTasks(tasks, ctx) {
  const pad = String(tasks.length).length < 2 ? 2 : String(tasks.length).length;
  const manifest = {
    source: ctx.sourcePath,
    jsonOutputDir: ctx.jsonOutputDir,
    sectionsDir: ctx.sectionsDir,
    generatedAt: new Date().toISOString(),
    settings: {
      maxChars: ctx.maxChars,
      minChars: ctx.minChars,
      contextChars: ctx.contextChars
    },
    tasks: []
  };

  for (const task of tasks) {
    const id = String(task.id).padStart(pad, "0");
    const mdFile = `${id}.md`;
    const jsonFile = `${id}.json`;
    const sectionPath = join(ctx.sectionsDir, mdFile);
    const jsonPath = join(ctx.jsonOutputDir, jsonFile);
    const headingPath = task.path.map((item) => item.title).join(" / ");
    const text = ctx.comments
      ? [
          "<!--",
          `SAG_SECTION_ID: ${id}`,
          `SAG_JSON_OUTPUT: ${jsonPath}`,
          `SAG_HEADING_PATH: ${headingPath || task.title}`,
          "Do not copy this HTML metadata comment into chunk.content.",
          "-->",
          "",
          task.text
        ].join("\n")
      : task.text;

    writeFileSync(sectionPath, `${text.trim()}\n`, "utf8");
    manifest.tasks.push({
      id,
      title: task.title,
      headingPath,
      markdownFile: sectionPath,
      jsonFile: jsonPath,
      chars: task.text.length,
      splitFromLongBlock: task.splitFromLongBlock,
      hasVisibleContext: task.hasVisibleContext
    });
  }

  writeFileSync(join(ctx.sectionsDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(ctx.sectionsDir, "agent-tasks.md"), renderAgentTasks(manifest), "utf8");
}

function renderAgentTasks(manifest) {
  const rows = manifest.tasks
    .map((task) => `| ${task.id} | ${task.chars} | ${escapePipe(task.headingPath || task.title)} | \`${task.markdownFile}\` | \`${task.jsonFile}\` |`)
    .join("\n");

  return `# SAG JSON extraction task list

Source Markdown:
\`${manifest.source}\`

Final JSON output directory:
\`${manifest.jsonOutputDir}\`

Instructions for each subagent:
- Read the extraction prompt file specified by the workflow.
- Read exactly one section markdown file from the table below.
- Some long-section splits contain visible quoted overlap blocks marked with \`[SAG ...重叠原文]\`.
- The quoted overlap text is copied from the original document and may be used as \`chunk.content\` evidence.
- Do not copy the generated \`[SAG ...]\` marker lines themselves into \`chunk.content\`.
- Extract JSON semantically; do not use mechanical fallback extraction.
- Save the result as the matching JSON file name shown below.
- The output shape should be \`{ "chunks": [...] }\`.
- \`event.title\` must be generated from \`event.content\`, not copied from the markdown heading.

| ID | chars | heading path | section markdown | JSON output |
| --- | ---: | --- | --- | --- |
${rows}
`;
}

function escapePipe(value) {
  return String(value || "").replace(/\|/gu, "\\|");
}
