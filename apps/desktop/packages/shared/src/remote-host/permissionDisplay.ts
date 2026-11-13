import { z } from "zod";
export const remoteHostPermissionDisplaySchema = z.strictObject({ kind: z.literal("remote_host_approval"),
  phase: z.enum(["preflight", "operation"]), details: z.record(z.string(), z.unknown()) });
