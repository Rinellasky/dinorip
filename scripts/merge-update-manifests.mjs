#!/usr/bin/env node
import fs from "node:fs";

// This intentionally supports electron-builder's updater manifest shape, not
// arbitrary YAML. If electron-builder starts emitting richer YAML, replace this
// with a real YAML parser before changing release output.

function stripSingleQuotes(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("'") && trimmed.endsWith("'")
    ? trimmed.slice(1, -1).replace(/''/g, "'")
    : trimmed;
}

function parseScalar(rawValue) {
  const value = stripSingleQuotes(rawValue);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function scalarEquals(left, right) {
  return left === right;
}

function parseFileRecord(record, sourcePath, lineNumber) {
  if (!record) return null;
  if (
    typeof record.url !== "string" ||
    typeof record.sha512 !== "string" ||
    typeof record.size !== "number"
  ) {
    throw new Error(`Invalid update manifest at ${sourcePath}:${lineNumber}: incomplete file entry.`);
  }
  return record;
}

function parseManifest(sourcePath) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const files = [];
  const extras = {};
  let version = null;
  let releaseDate = null;
  let inFiles = false;
  let currentFile = null;

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) return;

    const fileUrl = line.match(/^  - url:\s*(.+)$/);
    if (fileUrl?.[1]) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = { url: stripSingleQuotes(fileUrl[1]) };
      inFiles = true;
      return;
    }

    const fileProperty = line.match(/^    ([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (fileProperty?.[1]) {
      if (!currentFile) {
        throw new Error(`Invalid update manifest at ${sourcePath}:${lineNumber}: file property without file.`);
      }
      currentFile[fileProperty[1]] = parseScalar(fileProperty[2]);
      return;
    }

    if (line === "files:") {
      inFiles = true;
      return;
    }

    if (inFiles && currentFile) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = null;
    }
    inFiles = false;

    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!topLevel?.[1] || topLevel[2] === undefined) {
      throw new Error(`Invalid update manifest at ${sourcePath}:${lineNumber}: unsupported line '${line}'.`);
    }

    const key = topLevel[1];
    const value = parseScalar(topLevel[2]);
    if (key === "version") version = value;
    else if (key === "releaseDate") releaseDate = value;
    else extras[key] = value;
  });

  const finalized = parseFileRecord(currentFile, sourcePath, raw.split(/\r?\n/).length);
  if (finalized) files.push(finalized);

  if (typeof version !== "string") throw new Error(`Invalid update manifest at ${sourcePath}: missing version.`);
  if (typeof releaseDate !== "string") throw new Error(`Invalid update manifest at ${sourcePath}: missing releaseDate.`);
  if (files.length === 0) throw new Error(`Invalid update manifest at ${sourcePath}: missing files.`);
  return { version, releaseDate, files, extras };
}

function serializeScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sameFileEntry(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!scalarEquals(left[key], right[key])) return false;
  }
  return true;
}

function mergeManifests(primary, secondary) {
  if (primary.version !== secondary.version) {
    throw new Error(`Cannot merge manifests with different versions: ${primary.version} vs ${secondary.version}.`);
  }

  const filesByUrl = new Map(primary.files.map((file) => [file.url, file]));
  for (const file of secondary.files) {
    const existing = filesByUrl.get(file.url);
    if (existing && !sameFileEntry(existing, file)) {
      throw new Error(`Cannot merge conflicting update file entry for ${file.url}.`);
    }
    filesByUrl.set(file.url, file);
  }

  const legacyFileMetadata = new Set(["path", "sha2", "sha512"]);
  const extras = {};
  for (const manifest of [primary, secondary]) {
    for (const [key, value] of Object.entries(manifest.extras)) {
      if (legacyFileMetadata.has(key)) continue;
      if (Object.hasOwn(extras, key) && !scalarEquals(extras[key], value)) {
        throw new Error(`Cannot merge conflicting top-level manifest field '${key}'.`);
      }
      extras[key] = value;
    }
  }

  return {
    version: primary.version,
    releaseDate: primary.releaseDate,
    files: [...filesByUrl.values()],
    extras
  };
}

function serializeManifest(manifest) {
  const lines = [`version: ${serializeScalar(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    lines.push(`  - url: ${serializeScalar(file.url)}`);
    lines.push(`    sha512: ${serializeScalar(file.sha512)}`);
    lines.push(`    size: ${file.size}`);
    for (const [key, value] of Object.entries(file)) {
      if (key === "url" || key === "sha512" || key === "size") continue;
      lines.push(`    ${key}: ${serializeScalar(value)}`);
    }
  }
  for (const [key, value] of Object.entries(manifest.extras)) {
    lines.push(`${key}: ${serializeScalar(value)}`);
  }
  lines.push(`releaseDate: ${serializeScalar(manifest.releaseDate)}`);
  return `${lines.join("\n")}\n`;
}

const [, , primaryPath, secondaryPath] = process.argv;
if (!primaryPath || !secondaryPath) {
  console.error("Usage: node scripts/merge-update-manifests.mjs <primary.yml> <secondary.yml>");
  process.exit(1);
}

const merged = mergeManifests(parseManifest(primaryPath), parseManifest(secondaryPath));
fs.writeFileSync(primaryPath, serializeManifest(merged));
