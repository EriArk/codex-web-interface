import { Inflate } from "fflate";

export const PACKAGE_LIMIT = 32 * 1024 * 1024;
export type ArchiveEntry = {
  name: string;
  size: number;
  compressed: number;
  directory: boolean;
  blocked?: string;
  offset: number;
  method: number;
  flags: number;
  crc: number;
};
const cp437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid(): never {
  throw Error("Архив повреждён или его формат не поддерживается.");
}
export function archiveIndex(bytes: Uint8Array): ArchiveEntry[] {
  if (bytes.length > PACKAGE_LIMIT)
    throw Error("Архив слишком велик для встроенного просмотра. Скачивание оригинала доступно.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) invalid();
  const count = view.getUint16(end + 10, true),
    start = view.getUint32(end + 16, true),
    length = view.getUint32(end + 12, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    start + length !== end ||
    count === 65535
  )
    invalid();
  if (count > 5000) throw Error("Слишком много файлов для встроенного просмотра архива.");
  const entries: ArchiveEntry[] = [],
    names = new Set<string>();
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) invalid();
    const flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true),
      n = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true);
    const next = at + 46 + n + extra + comment;
    if (next > end || view.getUint16(at + 34, true)) invalid();
    const rawName = bytes.subarray(at + 46, at + 46 + n);
    let name =
      flags & 2048
        ? new TextDecoder("utf-8", { fatal: true }).decode(rawName)
        : Array.from(rawName, (b) => (b < 128 ? String.fromCharCode(b) : cp437[b - 128])).join("");
    for (let p = at + 46 + n; p < at + 46 + n + extra; ) {
      if (p + 4 > at + 46 + n + extra) invalid();
      const id = view.getUint16(p, true),
        size = view.getUint16(p + 2, true);
      if (p + 4 + size > at + 46 + n + extra) invalid();
      if (
        id === 0x7075 &&
        size >= 5 &&
        bytes[p + 4] === 1 &&
        view.getUint32(p + 5, true) === crc32(rawName)
      )
        name = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(p + 9, p + 4 + size),
        );
      if (id === 1) throw Error("ZIP64 пока доступен только для скачивания.");
      p += 4 + size;
    }
    const size = view.getUint32(at + 24, true),
      compressed = view.getUint32(at + 20, true),
      offset = view.getUint32(at + 42, true);
    if (
      !name ||
      name.length > 2048 ||
      names.has(name) ||
      offset + 30 > start ||
      view.getUint32(offset, true) !== 0x04034b50
    )
      invalid();
    names.add(name);
    const localN = view.getUint16(offset + 26, true),
      data = offset + 30 + localN + view.getUint16(offset + 28, true);
    if (
      data + compressed > start ||
      localN !== n ||
      view.getUint16(offset + 6, true) !== flags ||
      view.getUint16(offset + 8, true) !== method ||
      rawName.some((b, j) => bytes[offset + 30 + j] !== b)
    )
      invalid();
    const unsafe =
      name.startsWith("/") ||
      /[\\:]/.test(name) ||
      [...name].some((c) => c.charCodeAt(0) < 32) ||
      name.split("/").some((p) => p === ".." || p === ".");
    const symlink = ((view.getUint32(at + 38, true) >>> 16) & 0xf000) === 0xa000;
    const blocked =
      unsafe || symlink
        ? "Небезопасный путь или ссылка"
        : flags & 1
          ? "Зашифрованный файл"
          : ![0, 8].includes(method)
            ? "Неподдерживаемое сжатие"
            : size > PACKAGE_LIMIT
              ? "Слишком велик для просмотра вложения"
              : undefined;
    entries.push({
      name,
      size,
      compressed,
      offset: data,
      method,
      flags,
      crc: view.getUint32(at + 16, true),
      directory: name.endsWith("/"),
      blocked,
    });
    at = next;
  }
  if (at !== end) invalid();
  return entries;
}
export function readArchiveEntry(
  bytes: Uint8Array,
  entry: ArchiveEntry,
  limit = PACKAGE_LIMIT,
): Uint8Array<ArrayBuffer> {
  if (entry.blocked) throw Error(entry.blocked);
  if (entry.size > limit) throw Error("Содержимое превышает бюджет просмотра.");
  const input = bytes.subarray(entry.offset, entry.offset + entry.compressed);
  let result: Uint8Array<ArrayBuffer>;
  if (entry.method === 0) result = new Uint8Array(input);
  else {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const stream = new Inflate((chunk) => {
      length += chunk.length;
      if (length > limit || length > entry.size)
        throw Error("Содержимое превышает заявленный размер.");
      chunks.push(chunk);
    });
    // Bounded compressed chunks prevent a single inflate call from allocating the whole expansion.
    for (let p = 0; p < input.length; p += 1024)
      stream.push(input.subarray(p, p + 1024), p + 1024 >= input.length);
    result = new Uint8Array(length);
    let p = 0;
    for (const chunk of chunks) {
      result.set(chunk, p);
      p += chunk.length;
    }
  }
  if (result.length !== entry.size || result.length > limit || crc32(result) !== entry.crc)
    invalid();
  return result;
}
