#!/usr/bin/env node
/**
 * Validate per-section JSON files before running the final merge.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  loadManifest,
  parseIdSet,
  validateJsonFile
} from "./section-json-utils.mjs";

const argv = process.argv.slice(2);

function usage() {
  console.error(`Usage:
  node tools/import-prep/validate-section-jsons.mjs <json-output-dir> [options]

Options:
  --manifest <file>    Use a specific _sections/manifest.json
  --ids <list>         Validate only IDs, e.g. 01,02,10-20
  --all-json           Validate all top-level *.json files except meta.json and *-simple-import.json
  --report <file>      Write a markdown validation report
  --json-report <file> Write a machine-readable JSON report
  --no-fail            Always exit 0 even when invalid/missing files exist
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
  allJson: false,
  report: null,
  jsonReport: null,
  noFail: false
};

for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--manifest") opts.manifest = argv[++i];
  else if (a === "--ids") opts.ids = parseIdSet(argv[++i]);
  else if (a === "--all-json") opts.allJson = true;
  else if (a === "--report") opts.report = argv[++i];
  else if (a === "--json-report") opts.jsonReport = argv[++i];
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

const targets = opts.allJson ? targetsFromJsonDir(outputDir, opts.ids) : targetsFromManifest(outputDir, opts);
const results = targets.map((target) => ({
  ...target,
  validation: validateJsonFile(target.jsonFile)
}));

const summary = summarize(results);
printSummary(outputDir, summary, results);

if (opts.report) writeFileSync(resolve(opts.report), renderMarkdownReport(outputDir, summary, results), "utf8");
if (opts.jsonReport) writeFileSync(resolve(opts.jsonReport), JSON.stringify({ outputDir, summary, results }, null, 2), "utf8");

process.exit(summary.invalid + summary.missing > 0 && !opts.noFail ? 1 : 0);

function targetsFromManifest(dir, options) {
  const { manifest } = loadManifest(dir, options.manifest);
  return manifest.tasks
    .filter((task) => !options.ids || options.ids.has(task.id))
    .map((task) => ({
      id: task.id,
      title: task.title || "",
      headingPath: task.headingPath || "",
      markdownFile: task.markdownFile || "",
      jsonFile: task.jsonFile || join(dir, `${task.id}.json`)
    }));
}

function targetsFromJsonDir(dir, ids) {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .filter((name) => name.toLowerCase() !== "meta.json")
    .filter((name) => !name.toLowerCase().endsWith("-simple-import.json"))
    .filter((name) => !ids || ids.has(name.replace(/\.json$/iu, "")))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }))
    .map((name) => ({
      id: name.replace(/\.json$/iu, ""),
      title: "",
      headingPath: "",
      markdownFile: "",
      jsonFile: join(dir, name)
    }));
}

function summarize(results) {
  const summary = { total: results.length, valid: 0, invalid: 0, missing: 0, chunks: 0, warnings: 0 };
  for (const r of results) {
    const v = r.validation;
    if (v.status === "missing") summary.missing += 1;
    else if (v.ok) summary.valid += 1;
    else summary.invalid += 1;
    summary.chunks += v.chunkCount || 0;
    summary.warnings += v.warnings?.length || 0;
  }
  return summary;
}

function printSummary(dir, summary, results) {
  console.log("\n=== Section JSON Validation ===");
  console.log(`Output dir: ${dir}`);
  console.log(`Tasks: ${summary.total}, valid: ${summary.valid}, invalid: ${summary.invalid}, missing: ${summary.missing}`);
  console.log(`Chunks: ${summary.chunks}, warnings: ${summary.warnings}`);

  const bad = results.filter((r) => !r.validation.ok);
  if (bad.length) {
    console.log("\nProblems:");
    for (const r of bad.slice(0, 80)) {
      console.log(`- ${r.id} ${basename(r.jsonFile)}: ${r.validation.status}`);
      for (const e of r.validation.errors.slice(0, 6)) console.log(`  - ${e}`);
      if (r.validation.errors.length > 6) console.log(`  - ... ${r.validation.errors.length - 6} more`);
    }
    if (bad.length > 80) console.log(`... ${bad.length - 80} more bad files`);
  }
}

function renderMarkdownReport(dir, summary, results) {
  const rows = results
    .map((r) => {
      const v = r.validation;
      const status = v.status === "valid" ? "valid" : v.status;
      const errors = v.errors.join("<br>");
      return `| ${r.id} | ${status} | ${v.chunkCount || 0} | ${v.warnings.length} | ${escapePipe(r.headingPath || r.title)} | ${escapePipe(errors)} |`;
    })
    .join("\n");

  return `# Section JSON validation report

Output dir:
\`${dir}\`

Summary: ${summary.valid}/${summary.total} valid, ${summary.invalid} invalid, ${summary.missing} missing, ${summary.chunks} chunks.

| ID | status | chunks | warnings | heading | errors |
| --- | --- | ---: | ---: | --- | --- |
${rows}
`;
}

function escapePipe(value) {
  return String(value || "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}
