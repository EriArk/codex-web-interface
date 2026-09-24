import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { archive, sheet, sheetFiles, word, wordFiles, zip } from "./package-fixtures.mjs";

const dir = await mkdtemp(join(tmpdir(), "package-parser-"));
await build({
  configFile: false,
  logLevel: "error",
  build: {
    outDir: dir,
    target: "esnext",
    lib: {
      entry: {
        archive: resolve("apps/web/src/packageArchive.ts"),
        office: resolve("apps/web/src/officePackage.ts"),
        registry: resolve("apps/web/src/filePreviewRegistry.ts"),
      },
      formats: ["es"],
      fileName: (_, name) => name + ".mjs",
    },
  },
});
const { archiveIndex, readArchiveEntry } = await import(pathToFileURL(join(dir, "archive.mjs")));
const { readOffice } = await import(pathToFileURL(join(dir, "office.mjs")));
const { previewKind } = await import(pathToFileURL(join(dir, "registry.mjs")));
test.after(() => rm(dir, { recursive: true, force: true }));
test("ZIP lists Unicode paths, preserves bytes and blocks traversal without hiding the entry", () => {
  const entries = archiveIndex(archive);
  assert.equal(entries.length, 5);
  const entry = entries.find((e) => e.name === "Документы/план.md");
  assert.equal(
    new TextDecoder().decode(readArchiveEntry(archive, entry)),
    "# План\n\nТекст из архива\n",
  );
  assert.throws(() =>
    readArchiveEntry(
      archive,
      entries.find((e) => e.name.startsWith("../")),
    ),
  );
});
test("ZIP verifies CRC, exact local names and bounded expansion instead of trusting the header", () => {
  const original = zip({ "test.txt": "A".repeat(10000) });
  const entry = archiveIndex(original)[0];
  assert.throws(() => readArchiveEntry(original, { ...entry, size: 1 }));
  assert.throws(() => readArchiveEntry(original, { ...entry, crc: 0 }));
  assert.throws(() => readArchiveEntry(original, entry, 100));
  const changed = Buffer.from(original);
  changed[30] ^= 1;
  assert.throws(() => archiveIndex(changed));
  assert.throws(() => archiveIndex(original.subarray(0, original.length - 1)));
});
test("ZIP rejects duplicate paths, too many entries, encryption and unsupported codecs", () => {
  const original = zip({ a: "1", b: "2" }, { level: 0 });
  const offsets = [];
  for (let i = 0; i < original.length - 4; i++)
    if (original.readUInt32LE(i) === 0x02014b50) offsets.push(i);
  const duplicate = Buffer.from(original),
    second = offsets[1];
  duplicate[second + 46] = 97;
  duplicate[duplicate.readUInt32LE(second + 42) + 30] = 97;
  assert.throws(() => archiveIndex(duplicate));
  const encrypted = Buffer.from(original);
  encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt16LE(1, offsets[0] + 8);
  assert.match(archiveIndex(encrypted)[0].blocked, /Зашифрованный/);
  const odd = Buffer.from(original);
  odd.writeUInt16LE(99, 8);
  odd.writeUInt16LE(99, offsets[0] + 10);
  assert.match(archiveIndex(odd)[0].blocked, /сжатие/);
  assert.throws(() =>
    archiveIndex(zip(Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [String(i), ""])))),
  );
});
test("DOCX retains heading, runs, tables and embedded images without following external resources", () => {
  const doc = readOffice(word, "docx");
  assert.equal(doc.pages[0].blocks[0].heading, true);
  assert.deepEqual(doc.pages[0].blocks[1].runs, [
    { text: "Точный текст & пробелы", bold: true, italic: true },
  ]);
  assert.deepEqual(doc.pages[0].blocks[2].rows, [["Этап", "Готово"]]);
  assert.equal(doc.media.length, 1);
  assert.equal(doc.media[0].type, "image/png");
});
test("XLSX follows workbook relationship order, sparse coordinates and cached formulas", () => {
  const doc = readOffice(sheet, "xlsx");
  assert.deepEqual(
    doc.pages.map((p) => p.name),
    ["Смета", "Заметки"],
  );
  assert.equal(doc.pages[0].rows.length, 106);
  assert.deepEqual(doc.pages[0].rows[0].cells, [
    { column: 1, value: "Материалы", formula: undefined },
    { column: 3, value: "42", formula: "SUM(C2:C3)" },
  ]);
  assert.equal(doc.pages[1].rows[0].number, 7);
  assert.equal(doc.pages[1].rows[0].cells[0].column, 2);
});
test("Office rejects entities, invalid XML and unsafe/missing relationship targets", () => {
  for (const value of [
    '<!DOCTYPE w [<!ENTITY x "boom">]><w>&x;</w>',
    "<a><b></a>",
    "<a>".repeat(90) + "</a>".repeat(90),
  ])
    assert.throws(() => readOffice(zip({ ...wordFiles, "word/document.xml": value }), "docx"));
  assert.throws(() =>
    readOffice(
      zip({
        ...sheetFiles,
        "xl/_rels/workbook.xml.rels":
          '<Relationships><Relationship Id="sheet2" Target="../../secret"/></Relationships>',
      }),
      "xlsx",
    ),
  );
});
test("Registry enables ZIP/DOCX/XLSX only within preview budget; excludes PowerPoint and legacy formats", () => {
  for (const name of ["a.zip", "a.docx", "a.xlsx"]) {
    assert.equal(previewKind({ name, type: "", size: 1 }), "package");
    assert.equal(previewKind({ name, type: "", size: 33 * 1024 * 1024 }), "card");
  }
  for (const name of ["a.pptx", "a.doc", "a.xls", "a.rar", "a.exe"])
    assert.equal(previewKind({ name, type: "", size: 1 }), "card");
});
