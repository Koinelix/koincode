import { z } from "zod";

export const sessionImportSourceSchema = z.enum(["claude", "codex", "antigravity"]);
export const sessionImportScanParamsSchema = z
  .object({
    source: sessionImportSourceSchema,
    workspacePath: z.string().min(1).optional(),
    workspaceIdentity: z.string().min(1).optional(),
    modifiedSince: z.number().finite().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export const sessionImportParamsSchema = sessionImportScanParamsSchema
  .omit({
    modifiedSince: true,
    limit: true,
  })
  .extend({
    sessionIds: z.array(z.string().trim().min(1).max(512)),
    targetWorkspacePaths: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
export type SessionImportScanParams = z.infer<typeof sessionImportScanParamsSchema>;
export type SessionImportParams = z.infer<typeof sessionImportParamsSchema>;
