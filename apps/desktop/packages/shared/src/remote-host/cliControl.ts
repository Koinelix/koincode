import { z } from "zod";
import { remoteHostControlCommandSchema, type RemoteHostScopedControl } from "./controlProtocol.js";

const PRIVATE_CLIENT_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
const CLI_COMMANDS = new Set(["set-plugin", "start-turn", "register-call", "rewrite-call", "start-call", "close-call", "close-turn",
  "read-request", "read-decision", "prepare", "final-decision", "approve-scoped-read", "approve-session-operation"]);
export const remoteHostCliControlSchema = z.unknown().transform((raw, context): RemoteHostScopedControl => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || "clientInstanceId" in raw) {
    context.addIssue({ code: "custom", message: "An Agent cannot choose its private client identity." }); return z.NEVER;
  }
  const parsed = remoteHostControlCommandSchema.safeParse({ ...raw, clientInstanceId: PRIVATE_CLIENT_PLACEHOLDER });
  if (!parsed.success || !CLI_COMMANDS.has(parsed.data.kind) || parsed.data.kind === "open-agent" || !("clientInstanceId" in parsed.data)) {
    context.addIssue({ code: "custom", message: "This private Agent control command is invalid." }); return z.NEVER;
  }
  const { clientInstanceId: _client, ...command } = parsed.data;
  return command;
});
