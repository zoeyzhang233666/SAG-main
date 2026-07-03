#!/usr/bin/env node
/**
 * Report extraction progress and generate restartable remaining task lists.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  loadManifest,
  parseIdSet,
  validateJsonFile
} from "./section-json-utils.mjs";

const argv = process.argv.slice(2);

function usage() {
  console.error(`Usage:
  node tools/import-prep/report-progress.mjs <json-output-dir> [options]

Options:
  --manifest <file>       Use a specific _sections/manifest.json
  --ids <list>            Only consider IDs, e.g. 01,02,10-20
  --batch-size <n>        Split remaining tasks into batch files. Default: 20
  --out <file>            Remaining task list path. Default: _sections/remaining-agent-tasks.md
  --batch-dir <dir>       Batch task list directory. Default: _sections/remaining-batches
  --no-batches            Do not write batch files
  --include-invalid-only  Only include invalid existing JSON files, not missing files
  --no-fail               Always exit 0 even when remaining tasks exist
`);
}

if (argv.length < 1 || argv[0]?.startsWith("--")) {
  usage();
  process.exit(2);
}

const outputDir = resolve(argv[0]);
const opts = {
  manifest: null,
  ids: null,
  batchSize: 20,
  out: null,
  batchDir: null,
  batches: true,
  invalidOnly: false,
  noFail: false
};

for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--manifest") opts.manifest = argv[++i];
  else if (a === "--ids") opts.ids = parseIdSet(argv[++i]);
  else if (a === "--batch-size") opts.batchSize = positiveInt(argv[++i], "--batch-size");
  else if (a === "--out") opts.out = resolve(argv[++i]);
  else if (a === "--batch-dir") opts.batchDir = resolve(argv[++i]);
  else if (a === "--no-batches") opts.batches = false;
  else if (a === "--include-invalid-only") opts.invalidOnly = true;
  else if (a === "--no-fail") opts.noFail = true;
  else {
    console.error(`Unknown option: ${a}`);
    process.exit(2);
  }
}

if (!existsSync(outputDir)) {
  console.error(`Output dir does not exist: ${outputDir}`);
  process.exit(2);
}

const { path: manifestPath, manifest } = loadManifest(outputDir, opts.manifest);
const sectionsDir = resolve(manifest.sectionsDir || dirname(manifestPath));
const outPath = opts.out || join(sectionsDir, "remaining-agent-tasks.md");
const batchDir = opts.batchDir || join(sectionsDir, "remaining-batches");

const tasks = manifest.tasks
  .filter((task) => !opts.ids || opts.ids.has(task.id))
  .map((task) => {
    const jsonFile = task.jsonFile || join(outputDir, `${task.id}.json`);
    const validation = validateJsonFile(jsonFile);
    let status = "valid";
    if (validation.status === "missing") status = "missing";
    else if (!validation.ok) status = "invalid";
    return { ...task, jsonFile, status, validation };
  });

const remaining = tasks.filter((task) => {
  if (opts.invalidOnly) return task.status === "invalid";
  return task.status !== "valid";
});

const summary = summarize(tasks, remaining);
writeMainReport(outPath, manifest, outputDir, summary, remaining);
const batchFiles = opts.batches ? writeBatches(batchDir, manifest, outputDir, remaining, opts.batchSize) : [];
printSummary(outputDir, outPath, batchFiles, summary);

process.exit(remaining.length > 0 && !opts.noFail ? 1 : 0);

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${label} must be a positive integer`);
    process.exit(2);
  }
  return n;
}

function summarize(tasks, remaining) {
  const summary = {
    total: tasks.length,
    valid: tasks.filter((t) => t.status === "valid").length,
    invalid: tasks.filter((t) => t.status === "invalid").length,
    missing: tasks.filter((t) => t.status === "missing").length,
    remaining: remaining.length,
    chunks: tasks.reduce((sum, t) => sum + (t.validation.chunkCount || 0), 0),
    warnings: tasks.reduce((sum, t) => sum + (t.validation.warnings?.length || 0), 0)
  };
  return summary;
}

function writeMainReport(file, manifest, dir, summary, remainingTasks) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderTaskList({
    title: "SAG remaining extraction tasks",
    source: manifest.source,
    outputDir: dir,
    summary,
    tasks: remainingTasks
  }), "utf8");
}

function writeBatches(dir, manifest, outputDirValue, remainingTasks, batchSize) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < remainingTasks.length; i += batchSize) {
    const batch = remainingTasks.slice(i, i + batchSize);
    const n = String(files.length + 1).padStart(3, "0");
    const file = join(dir, `remaining-batch-${n}.md`);
    writeFileSync(file, renderTaskList({
      title: `SAG remaining extraction batch ${n}`,
      source: manifest.source,
      outputDir: outputDirValue,
      summary: {
        total: batch.length,
        valid: 0,
        invalid: batch.filter((t) => t.status === "invalid").length,
        missing: batch.filter((t) => t.status === "missing").length,
        remaining: batch.length,
        chunks: 0,
        warnings: 0
      },
      tasks: batch
    }), "utf8");
    files.push(file);
  }
  return files;
}

function renderTaskList({ title, source, outputDir: dir, summary, tasks }) {
  const rows = tasks.map((task) => {
    const error = task.validation.errors?.[0] || "";
    return `| ${task.id} | ${task.status} | ${escapePipe(task.headingPath || task.title)} | \`${task.markdownFile}\` | \`${task.jsonFile}\` | ${escapePipe(error)} |`;
  }).join("\n");

  return `# ${title}

Source Markdown:
\`${source || ""}\`

Final JSON output directory:
\`${dir}\`

Progress:
- total: ${summary.total}
- valid: ${summary.valid}
- invalid: ${summary.invalid}
- missing: ${summary.missing}
- remaining: ${summary.remaining}

Instructions for Claude Code workflow:
- Only process rows in the table below.
- Skip any JSON output file that already validates unless it appears here as invalid.
- For each row, read exactly one section markdown file and write exactly the matching JSON output file.
- Use the extraction prompt file from the main task.
- Do not redesign splitting logic, do not edit meta.json, and do not rename files.
- If a section contains visible \`[SAG ...重叠原文]\` blocks, the quoted overlap text is original evidence and may be included in \`chunk.content\`; do not include the generated marker line itself.
- Output JSON shape: \`{ "chunks": [...] }\`.

| ID | status | heading path | section markdown | JSON output | first error |
| --- | --- | --- | --- | --- | --- |
${rows || "| | complete | no remaining tasks | | | |"}
`;
}

function printSummary(dir, outPath, batchFiles, summary) {
  console.log("\n=== SAG Extraction Progress ===");
  console.log(`Output dir: ${dir}`);
  console.log(`Total: ${summary.total}, valid: ${summary.valid}, invalid: ${summary.invalid}, missing: ${summary.missing}`);
  console.log(`Chunks in valid/invalid files: ${summary.chunks}, warnings: ${summary.warnings}`);
  console.log(`Remaining task list: ${outPath}`);
  if (batchFiles.length) {
    console.log(`Batch files: ${batchFiles.length}`);
    for (const file of batchFiles.slice(0, 10)) console.log(`- ${file}`);
    if (batchFiles.length > 10) console.log(`- ... ${batchFiles.length - 10} more`);
  }
}

function escapePipe(value) {
  return String(value || "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}
