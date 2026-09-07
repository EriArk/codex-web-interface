import { z } from "zod";
export const resultCategorySchema = z.enum(["all", "images", "demos", "files", "work"]);
export type ResultCategory = z.infer<typeof resultCategorySchema>;
export type ResultCounts = Record<ResultCategory, number>;
export function resultCategory(type: string): Exclude<ResultCategory, "all"> {
  if (type === "image") return "images";
  if (type === "preview") return "demos";
  if (type === "file" || type === "artifact") return "files";
  return "work";
}
export function emptyResultCounts(): ResultCounts {
  return { all: 0, images: 0, demos: 0, files: 0, work: 0 };
}
export interface ResultItem {
  id: string;
  turnId: string | null;
  title: string;
  type: string;
  createdAt: string;
  payload: {
    text?: string;
    url?: string;
    mime?: string;
    width?: number;
    height?: number;
    sourcePath?: string;
    command?: string;
    exitCode?: number;
    status?: string;
    changes?: { path: string; kind: string; diff: string }[];
  };
}
export interface ResultPage {
  sourceRevision?: number;
  items: ResultItem[];
  nextBefore: string | number | null;
  counts: ResultCounts;
}

export function isNativeImageSource(source: string): boolean {
  if (!source || source.length > 12 * 1024 * 1024) return false;
  if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(source))
    return true;
  return (
    /\.(png|jpe?g|webp|gif|avif|tiff?|heic|heif)$/i.test(source) &&
    /^(?:[a-z]:[\\/]|\/)/i.test(source)
  );
}
