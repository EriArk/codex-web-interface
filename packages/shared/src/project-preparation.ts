import { z } from "zod";

// Preparation creates documentation and reference material, never executable project policy.
export const preparationPathSchema = z
  .string()
  .max(240)
  .refine(
    (value) =>
      /^(?:[A-Za-z0-9_-]+\.(?:md|txt)|(?:docs|references)\/[A-Za-z0-9_./ -]+\.(?:md|txt|json|csv|svg|png|jpg|jpeg|webp|pdf))$/i.test(
        value,
      ) &&
      value
        .split("/")
        .every(
          (p) =>
            p &&
            p !== "." &&
            p !== ".." &&
            !p.startsWith(".") &&
            !/[. ]$/.test(p) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
        ) &&
      !/(?:^|\/)(?:AGENTS|CODEXWEB)\.md$/i.test(value),
    "Выбери документ в корне, docs/ или references/; AGENTS.md и CODEXWEB.md сохраняются.",
  );
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const preparationBranchSchema = z.string().regex(/^codexweb\/prepare\/[a-f0-9-]{36}$/);
export const preparationFileSchema = z
  .object({
    path: preparationPathSchema,
    content: z.string().max(131072),
    previous: sha.nullable(),
  })
  .strict();
export const preparationFilesSchema = z
  .array(preparationFileSchema)
  .min(1)
  .max(16)
  .refine(
    (files) =>
      new Set(files.map((f) => f.path.toLowerCase())).size === files.length &&
      files.reduce((n, f) => n + f.content.length, 0) <= 131072 &&
      files.every(
        (f) => !files.some((g) => g.path.toLowerCase().startsWith(f.path.toLowerCase() + "/")),
      ),
  );
export const preparationBranchInput = z
  .object({ kind: z.literal("preparation-branch"), branch: preparationBranchSchema, head: sha })
  .strict();
export const preparationFilesInput = z
  .object({
    kind: z.literal("preparation-files"),
    branch: z.string().min(1).max(240),
    head: sha,
    files: preparationFilesSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export const preparationSeedInput = z
  .object({
    kind: z.literal("preparation-seed"),
    branch: z.string().min(1).max(240),
    file: preparationFileSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export const preparationPrInput = z
  .object({
    kind: z.literal("preparation-pr"),
    branch: preparationBranchSchema,
    head: sha,
    base: z.string().min(1).max(240),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(16000),
  })
  .strict();
export interface PreparationRepository {
  branch: string;
  head: string | null;
  files: { path: string; sha: string | null; content: string | null; bytes: number }[];
}
export const preparationProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    files: z
      .array(z.object({ path: preparationPathSchema, text: z.string().max(32768) }).strict())
      .min(1)
      .max(16),
    issues: z
      .array(
        z
          .object({ title: z.string().trim().min(1).max(200), body: z.string().min(1).max(12000) })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type PreparationProposal = z.infer<typeof preparationProposalSchema>;
export interface ProjectPreparation {
  id: string;
  projectId: string;
  revision: number;
  state:
    | "generating"
    | "draft"
    | "review"
    | "running"
    | "paused"
    | "complete"
    | "failed"
    | "cancelled";
  jobId: string;
  createdAt: number;
  repository: string;
  repositoryId: number;
  identity: import("./github-work.js").GitHubIdentity;
  base: PreparationRepository;
  title: string;
  files: {
    path: string;
    content: string;
    previous: string | null;
    oldText: string | null;
    choice: "ask" | "replace" | "skip" | "create";
  }[];
  issues: PreparationProposal["issues"];
  error: string;
  fingerprint?: string;
  result?: { branch: string; sha: string; pr?: number; url?: string };
  issueBatchId?: string;
  issueResults?: { title: string; state: string; url?: string }[];
}
