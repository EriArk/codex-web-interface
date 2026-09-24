import { createRequire } from "node:module";

const { zipSync, strToU8 } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "fflate",
);
export const zip = (files, opts) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, data]) => [
          path,
          typeof data === "string" ? strToU8(data) : data,
        ]),
      ),
      opts,
    ),
  );
export const picture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==",
  "base64",
);
export const wordFiles = {
  "word/document.xml":
    '<w:document xmlns:w="word" xmlns:a="drawing" xmlns:r="relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>План проекта</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Точный текст &amp; пробелы</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Этап</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Готово</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="external"/></w:drawing></w:r></w:p></w:body></w:document>',
  "word/_rels/document.xml.rels":
    '<Relationships><Relationship Id="image" Target="media/picture.png"/><Relationship Id="external" TargetMode="External" Target="https://bad.invalid/private.png"/></Relationships>',
  "word/media/picture.png": picture,
};
export const sheetFiles = {
  "xl/workbook.xml":
    '<workbook xmlns:r="relationships"><sheets><sheet name="Смета" sheetId="1" r:id="sheet2"/><sheet name="Заметки" sheetId="2" r:id="sheet1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/><Relationship Id="sheet2" Target="worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    "<sst><si><t>Материалы</t></si><si><r><t>Составной </t></r><r><t>текст</t></r></si></sst>",
  "xl/worksheets/sheet1.xml":
    '<worksheet><sheetData><row r="7"><c r="B7" t="inlineStr"><is><t>Второй лист</t></is></c></row></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml":
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>SUM(C2:C3)</f><v>42</v></c></row>' +
    Array.from(
      { length: 105 },
      (_, i) =>
        `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>Позиция ${i + 1}</t></is></c><c r="C${i + 2}"><v>${i + 1}</v></c></row>`,
    ).join("") +
    "</sheetData></worksheet>",
};
export const word = zip(wordFiles),
  sheet = zip(sheetFiles);
export const archive = zip({
  "Документы/план.md": "# План\n\nТекст из архива\n",
  "Документы/смета.xlsx": sheet,
  "картинка.png": picture,
  "../небезопасно.txt": "never writable",
  "empty/": new Uint8Array(),
});
