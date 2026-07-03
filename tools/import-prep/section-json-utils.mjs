import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function str(v) {
  if (v == null) return "";
  return (typeof v === "string" ? v : String(v)).trim();
}

export function extractJsonText(raw) {
  let text = raw.replace(/^\uFEFF/, "").trim();
  const fence = text.match(/^```(?:json|json5|txt)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  if (fence) text = fence[1].trim();

  const start = text.search(/[{[]/u);
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
  return text.slice(start);
}

export function removeTrailingCommas(text) {
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
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/u.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

export function parseLooseJson(raw, label = "input") {
  const text = extractJsonText(raw);
  try {
    return JSON.parse(text);
  } catch (e1) {
    try {
      return JSON.parse(removeTrailingCommas(text));
    } catch (e2) {
      const pos = Number((/position (\d+)/u.exec(e2.message) || [])[1]);
      let hint = "";
      if (!Number.isNaN(pos)) {
        const s = Math.max(0, pos - 60);
        hint = ` Near: ${text.slice(s, pos + 60).replace(/\n/gu, "\\n")}`;
      }
      throw new Error(`[${label}] JSON parse failed: ${e2.message}${hint}`);
    }
  }
}

export function chunksFrom(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.chunks)) return parsed.chunks;
  if (parsed && Array.isArray(parsed.documents)) {
    return parsed.documents.flatMap((d) => (Array.isArray(d?.chunks) ? d.chunks : []));
  }
  return [];
}

export function validateSectionValue(parsed, label = "input") {
  const errors = [];
  const warnings = [];
  const chunks = chunksFrom(parsed);

  if (chunks.length === 0) {
    errors.push("No chunks found. Expected { \"chunks\": [...] }.");
    return { ok: false, chunkCount: 0, errors, warnings };
  }

  chunks.forEach((chunk, index) => {
    const n = index + 1;
    const ev = chunk && typeof chunk.event === "object" && chunk.event ? chunk.event : {};
    const content = str(chunk?.content) || str(chunk?.rawContent) || str(chunk?.chunkContent);
    const eventTitle = str(ev?.title) || str(ev?.eventTitle);
    const eventContent = str(ev?.content) || str(ev?.eventContent);
    const entities = Array.isArray(ev?.entities) ? ev.entities : [];
    const namedEntities = entities.filter((e) => e && typeof e === "object" && str(e.name || e.entityName));
    const where = `${label} chunk#${n}`;

    if (!content) errors.push(`${where}: missing chunk.content`);
    if (!eventTitle) errors.push(`${where}: missing event.title`);
    if (namedEntities.length === 0) errors.push(`${where}: no entity with name in event.entities`);
    if (content && eventContent && content === eventContent) {
      warnings.push(`${where}: chunk.content and event.content are identical`);
    }
    if (content.length > 400 && namedEntities.length <= 1) {
      warnings.push(`${where}: long content but only ${namedEntities.length} named entity`);
    }
  });

  return {
    ok: errors.length === 0,
    chunkCount: chunks.length,
    errors,
    warnings
  };
}

export function validateJsonFile(filePath) {
  const label = basename(filePath);
  if (!existsSync(filePath)) {
    return { file: filePath, status: "missing", ok: false, chunkCount: 0, errors: ["file does not exist"], warnings: [] };
  }
  try {
    const parsed = parseLooseJson(readFileSync(filePath, "utf8"), label);
    const result = validateSectionValue(parsed, label);
    return { file: filePath, status: result.ok ? "valid" : "invalid", ...result };
  } catch (e) {
    return { file: filePath, status: "invalid", ok: false, chunkCount: 0, errors: [e.message], warnings: [] };
  }
}

export function defaultManifestPath(outputDir) {
  return join(resolve(outputDir), "_sections", "manifest.json");
}

export function loadManifest(outputDir, manifestPath = null) {
  const full = manifestPath ? resolve(manifestPath) : defaultManifestPath(outputDir);
  if (!existsSync(full)) throw new Error(`manifest.json not found: ${full}`);
  const parsed = JSON.parse(readFileSync(full, "utf8"));
  if (!Array.isArray(parsed.tasks)) throw new Error(`manifest has no tasks array: ${full}`);
  return { path: full, manifest: parsed };
}

export function normalizeTaskId(id) {
  const s = String(id || "").trim();
  return /^\d+$/u.test(s) ? s.padStart(2, "0") : s;
}

export function parseIdSet(value) {
  if (!value) return null;
  const ids = new Set();
  for (const part of String(value).split(/[,，\s]+/u).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const width = Math.max(range[1].length, range[2].length, 2);
      for (let n = Math.min(start, end); n <= Math.max(start, end); n += 1) {
        ids.add(String(n).padStart(width, "0"));
      }
    } else {
      ids.add(normalizeTaskId(part));
    }
  }
  return ids;
}
