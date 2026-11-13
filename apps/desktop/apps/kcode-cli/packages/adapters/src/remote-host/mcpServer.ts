import { z } from "zod";
import { REMOTE_HOST_LIMITS, REMOTE_HOST_TOOLS, remoteHostToolSchemas, remoteHostFailure,
  remoteInvocationIdentitySchema, type RemoteHostToolName } from "@fcode/shared";
import { invokeRemoteHost } from "./client.js";

const descriptions: Record<RemoteHostToolName, string> = {
  get_remote_context: "Start with null hostCursor and null sourceCursor (or omit them); never use 0. Get this human message's fixed remote-host selection and frozen upload-source summaries. Does not connect to SSH.",
  list_directory: "List a bounded remote directory page after the desktop user's permission. Use only selected host IDs.",
  read_file: "Read a bounded remote UTF-8 text page with SHA-256 evidence after the desktop user's permission.",
  write_file: "Conditionally write UTF-8 text on a selected Linux host. Requires exact user approval and verifies final SHA-256.",
  upload: "Upload a frozen source_id or an approved workspace_path to selected Linux hosts. Requires exact approval and verifies all file hashes. Never read upload attachments with another tool.",
  exec: "Execute /bin/sh commands on selected Linux x64 hosts with explicit cwd and exact user approval. Poll executions for actual exit and optional verification results.",
  get_execution: "Poll owned executions and bounded events. Success requires verified terminal state; unknown is never success or automatically retried.",
  cancel_execution: "Request cancellation of owned executions. Observe their actual terminal state; cancellation cannot undo remote effects.",
};
const requestSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.unknown().optional() }).strict();

/** Bundled stdio MCP server; all SSH and file bytes remain in the desktop utility broker. */
export async function runRemoteHostMcpServer(): Promise<void> {
  let buffer = Buffer.alloc(0);
  const active = new Map<string | number, AbortController>();
  const send = (value: unknown) => { process.stdout.write(JSON.stringify(value) + "\n"); };
  process.stdin.on("data", (chunk: Buffer) => {
    if (buffer.length + chunk.length > REMOTE_HOST_LIMITS.ipcBytes) { process.stdin.destroy(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let request: z.infer<typeof requestSchema>;
      try { request = requestSchema.parse(JSON.parse(frame.toString())); }
      catch { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request" } }); continue; }
      if (request.method === "notifications/cancelled") {
        const cancellation = z.object({ requestId: z.union([z.string(), z.number()]) }).passthrough().safeParse(request.params);
        if (cancellation.success) active.get(cancellation.data.requestId)?.abort(); continue;
      }
      if (request.id === undefined) continue;
      const id = request.id;
      if (active.has(id) || active.size >= 64) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP request budget exceeded" } }); continue; }
      const controller = new AbortController(); active.set(id, controller);
      void handle(request.method, request.params, controller.signal).then(
        (result) => send({ jsonrpc: "2.0", id, result }),
        (error: unknown) => send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Remote Host request failed", data: remoteHostFailure(error) } }),
      ).finally(() => active.delete(id));
    }
  });
  process.stdin.once("end", () => { for (const controller of active.values()) controller.abort(); });
  process.stdin.resume();
}

async function handle(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  if (method === "initialize") {
    const input = z.object({ protocolVersion: z.string() }).passthrough().parse(params);
    return { protocolVersion: input.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "koincode-remote-host", version: "1.0.0" } };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: REMOTE_HOST_TOOLS.map((name) => ({ name, description: descriptions[name],
    inputSchema: z.toJSONSchema(remoteHostToolSchemas[name], { io: "input" }),
    annotations: { readOnlyHint: ["get_remote_context", "list_directory", "read_file", "get_execution"].includes(name), destructiveHint: ["exec", "write_file", "upload"].includes(name) } })) };
  if (method !== "tools/call") throw new Error("Unsupported Remote Host MCP method.");
  const input = z.object({ name: z.enum(REMOTE_HOST_TOOLS), arguments: z.unknown(), _meta: z.record(z.string(), z.unknown()) }).strict().parse(params);
  const meta = input._meta;
  const identity = remoteInvocationIdentitySchema.parse({ sessionId: meta.session_id, turnId: meta.turn_id, toolCallId: meta.tool_call_id });
  if (meta.runtime_scope !== "main" || meta.workspace_identity || meta.remote_session_id || meta.client_mode !== "desktop-continuous") throw new Error("Remote Host requires a trusted main desktop invocation.");
  try {
    const result = await invokeRemoteHost(input.name, remoteHostToolSchemas[input.name].parse(input.arguments), identity, signal);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(remoteHostFailure(error)) }] }; }
}
