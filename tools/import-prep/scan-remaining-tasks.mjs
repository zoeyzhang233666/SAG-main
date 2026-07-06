#!/usr/bin/env node
/**
 * Scan all document directories and list remaining tasks (missing JSON files).
 * Outputs batch files for subagent processing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outputRoot = resolve(process.argv[2] || ".");
const batchSize = parseInt(process.argv[3] || "15", 10);

const docsDir = outputRoot;
const entries = readdirSync(docsDir, { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith("."))
  .sort((a, b) => a.name.localeCompare(b.name));

const remaining = [];

for (const entry of entries) {
  const manifestPath = join(docsDir, entry.name, "_sections", "manifest.json");
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }

  if (!Array.isArray(manifest.tasks)) continue;

  for (const task of manifest.tasks) {
    const jsonFile = task.jsonFile;
    if (!existsSync(jsonFile)) {
      remaining.push({
        document: entry.name,
        id: task.id,
        headingPath: task.headingPath || task.title,
        markdownFile: task.markdownFile,
        jsonFile: task.jsonFile,
        chars: task.chars || 0,
      });
    }
  }
}

console.log(`Total remaining tasks: ${remaining.length}`);

// Write remaining list
const remainingDir = join(outputRoot, "_sections");
if (!existsSync(remainingDir)) mkdirSync(remainingDir, { recursive: true });

writeFileSync(join(remainingDir, "remaining-all.json"), JSON.stringify(remaining, null, 2), "utf8");

// Write batches
const batchesDir = join(remainingDir, "remaining-batches");
if (!existsSync(batchesDir)) mkdirSync(batchesDir, { recursive: true });

// Remove old batches
for (const f of readdirSync(batchesDir)) {
  if (f.startsWith("remaining-batch-") && f.endsWith(".json")) {
    try { writeFileSync(join(batchesDir, f), ""); } catch {}
  }
}

const batchCount = Math.ceil(remaining.length / batchSize);
for (let b = 0; b < batchCount; b++) {
  const batch = remaining.slice(b * batchSize, (b + 1) * batchSize);
  const batchNum = String(b + 1).padStart(3, "0");
  writeFileSync(
    join(batchesDir, `remaining-batch-${batchNum}.json`),
    JSON.stringify(batch, null, 2),
    "utf8"
  );
}

console.log(`Written ${batchCount} batch files (${batchSize} per batch) to ${batchesDir}`);
console.log(`Batch range: 001-${String(batchCount).padStart(3, "0")}`);

// Also print first batch summary
if (remaining.length > 0) {
  console.log("\nFirst batch:");
  const firstBatch = remaining.slice(0, Math.min(5, batchSize));
  for (const t of firstBatch) {
    console.log(`  ${t.document} / ${t.id} - ${t.headingPath} (${t.chars} chars)`);
  }
  if (remaining.length > 5) console.log(`  ... and ${remaining.length - 5} more`);
}