import { readFile, writeFile } from "node:fs/promises";

const [sourcePath, applicationsPath] = process.argv.slice(2);
if (!sourcePath || !applicationsPath) {
  throw new Error("Usage: node scripts/build-chain-atlas.mjs <source-tree.md> <applications-tree.md>");
}

function node(label, code) {
  return { label, ...(code ? { code } : {}), children: [] };
}

function cleanHeading(value) {
  return value.replace(/\s*\[(?:★+|芯化智数已覆盖)\]/gu, "").replace(/★/gu, "").trim();
}

function version(markdown) {
  const match = markdown.match(/^> \*\*版本\*\*：v([\d.]+)/m);
  if (!match) throw new Error("Missing tree version");
  return "v" + match[1];
}

function addBlock(parent, lines, skipRepeatedHeading = false) {
  const stack = [parent];
  let root = parent;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[│\s]+$/u.test(line)) continue;
    const branch = raw.match(/^([ │]*)(?:├|└)──\s*(.+)$/u);
    if (branch) {
      const [, indent, label] = branch;
      const depth = indent.length / 4 + 1;
      if (!Number.isInteger(depth) || depth > stack.length) {
        throw new Error("Invalid tree indentation: " + raw);
      }
      const coded = label.match(/^(A-\d+(?:-\d+)+)\s+(.*)$/u);
      const child = node(coded ? coded[2] : label, coded?.[1]);
      stack[depth - 1].children.push(child);
      stack[depth] = child;
      stack.length = depth + 1;
      continue;
    }
    const note = line.replace(/^[│\s]+/u, "");
    if (/^(?:注[：:]|来源[：:])/u.test(note)) {
      const level = Math.max(0, Math.floor((raw.length - note.length) / 4));
      const target = stack[Math.min(level, stack.length - 1)];
      (target.notes ??= []).push(note);
    } else if (!skipRepeatedHeading || !line.startsWith(parent.code + " ")) {
      if (root !== parent) throw new Error("Unexpected root label: " + raw);
      root = node(line);
      parent.children.push(root);
      stack[0] = root;
      stack.length = 1;
    }
  }
}

function sourceTree(markdown) {
  const roots = [];
  let group;
  let section;
  let block;
  for (const line of markdown.split(/\r?\n/u)) {
    if (line.startsWith("```") && block) {
      addBlock(section, block);
      block = undefined;
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    const groupMatch = line.match(/^## (S-\d{2}) (.+)$/u);
    const sectionMatch = line.match(/^### (S-\d{2}-\d{2}) (.+)$/u);
    if (groupMatch) {
      group = node(cleanHeading(groupMatch[2]).replace(/（v[\d.]+修订新增）$/u, ""), groupMatch[1]);
      roots.push(group);
      section = undefined;
    } else if (sectionMatch && group) {
      section = node(cleanHeading(sectionMatch[2]).replace(/（原S-[^）]+）$/u, ""), sectionMatch[1]);
      group.children.push(section);
    } else if (line.startsWith("## ")) {
      group = section = undefined;
    } else if (line.startsWith("```") && section) {
      block = [];
    }
  }
  if (block || roots.length === 0) throw new Error("Incomplete source tree");
  return { version: version(markdown), roots };
}

function applicationsTree(markdown) {
  const roots = [];
  let inTree = false;
  let group;
  let section;
  let block;
  for (const line of markdown.split(/\r?\n/u)) {
    if (line.startsWith("## ")) {
      inTree = line.includes("树体正文");
      continue;
    }
    if (!inTree) continue;
    if (line.startsWith("```") && block) {
      addBlock(section, block, true);
      block = undefined;
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    const groupMatch = line.match(/^### [一二三四五六七八九十]+、(.+)（门类([A-Z](?:-\d+)?)）$/u);
    const sectionMatch = line.match(/^#### ([A-Z]-\d+) (.+)$/u);
    if (groupMatch) {
      group = node(groupMatch[1], groupMatch[2]);
      roots.push(group);
      section = undefined;
    } else if (sectionMatch && group) {
      section = node(cleanHeading(sectionMatch[2]), sectionMatch[1]);
      group.children.push(section);
    } else if (line.startsWith("```") && section) {
      block = [];
    }
  }
  if (block || roots.length === 0) throw new Error("Incomplete applications tree");
  return { version: version(markdown), roots };
}

// Keep each leaf on one line so later attachment revisions have readable diffs.
function formatNodes(nodes, indent) {
  const prefix = " ".repeat(indent);
  return nodes.map(({ children, ...fields }) => {
    const inline = JSON.stringify(fields);
    if (!children.length) return prefix + inline;
    return prefix + inline.slice(0, -1) + ', "children": [\n' +
      formatNodes(children, indent + 2) + "\n" + prefix + "]}";
  }).join(",\n");
}

const [source, applications] = await Promise.all([
  readFile(sourcePath, "utf8").then(sourceTree),
  readFile(applicationsPath, "utf8").then(applicationsTree)
]);
const trees = { source, applications };
for (const [name, tree] of Object.entries(trees)) {
  const path = new URL(`../web/src/data/chain-${name}.json`, import.meta.url);
  await writeFile(path, `{\n  "version": ${JSON.stringify(tree.version)},\n  "roots": [\n${formatNodes(tree.roots, 4)}\n  ]\n}\n`);
  console.log(name, tree.version, tree.roots.length, "roots");
}
