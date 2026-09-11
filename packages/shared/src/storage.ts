import { z } from "zod";

const bytes = z
  .number()
  .int()
  .min(1)
  .max(1024 ** 4);
export const storagePolicySchema = z
  .object({
    artifactBytes: bytes.default(8 * 1024 ** 3),
    attachmentBytes: bytes.default(2 * 1024 ** 3),
    gptUploadBytes: bytes.default(2 * 1024 ** 3),
    databaseWarningBytes: bytes.default(512 * 1024 ** 2),
    transientDays: z.number().int().min(7).max(365).default(30),
    orphanDays: z.number().int().min(7).max(365).default(30),
    batchSize: z.number().int().min(1).max(10000).default(1000),
  })
  .prefault({});
export type StoragePolicy = z.infer<typeof storagePolicySchema>;
export const defaultStoragePolicy = storagePolicySchema.parse({});
export interface StorageReport {
  buckets: { id: string; bytes: number; limit?: number; warning: boolean; estimated?: boolean }[];
  partial: boolean;
  missingFiles: number;
  metadataGaps?: number;
  orphanFiles: number;
  reclaimableBytes: number;
  transientEvents: number;
  blocked: boolean;
  policy: StoragePolicy;
}
