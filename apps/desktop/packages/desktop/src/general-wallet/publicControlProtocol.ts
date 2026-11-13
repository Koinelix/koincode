import { z } from "zod";

export const GENERAL_CONTROL_REQUEST_MAX = 8192;
export const GENERAL_CONTROL_REPLY_MAX = 128 * 1024;
export const GENERAL_CONTROL_EVENT_MAX = 1024;
export const GENERAL_CONTROL_ID_LIMIT = 65536;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const empty = z.strictObject({});
function utc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === (value.length === 20 ? value.slice(0, -1) + ".000Z" : value);
}
const account = z.strictObject({ sourceId: uuid, address: z.string().regex(/^0x[0-9a-f]{40}$/),
  sourceType: z.enum(["mnemonic", "private_key"]), backupVerified: z.boolean() });
const snapshot = z.strictObject({ format: z.literal("koincode-general-wallet-view"), version: z.literal(1), viewId: uuid, generation: positive,
  state: z.enum(["ready", "needs_initialization", "locked", "recovery_required", "unavailable"]), sourceRevision: integer.nullable(),
  observedAt: z.string().refine(utc).nullable(), accounts: z.array(account).max(256) }).refine((value) =>
  new Set(value.accounts.map((entry) => entry.sourceId)).size === value.accounts.length &&
  (value.state === "ready" ? value.sourceRevision !== null && value.observedAt !== null : value.sourceRevision === null && value.observedAt === null && !value.accounts.length));
const hello = z.strictObject({ format: z.literal("koincode-general-control-hello"), version: z.literal(1), controlId: uuid });
const base = { format: z.literal("koincode-general-control-request"), version: z.literal(1), controlId: uuid, sequence: positive, requestId: uuid, windowId: uuid };
const request = z.discriminatedUnion("command", [
  z.strictObject({ ...base, command: z.literal("snapshot"), body: empty }),
  z.strictObject({ ...base, command: z.literal("open_manager"), body: empty }),
  z.strictObject({ ...base, command: z.literal("cancel"), body: z.strictObject({ targetRequestId: uuid }) }),
  z.strictObject({ ...base, command: z.literal("close"), body: empty }),
]);
const reply = z.strictObject({ format: z.literal("koincode-general-control-reply"), version: z.literal(1), controlId: uuid, sequence: positive,
  requestId: uuid, windowId: uuid, deliverySequence: positive, status: z.enum(["ok", "unavailable", "busy", "canceled"]),
  code: z.enum(["GENERAL_CONTROL_OK", "GENERAL_CONTROL_UNAVAILABLE", "GENERAL_OPERATION_BUSY", "GENERAL_OPERATION_CANCELED"]),
  body: z.union([snapshot, z.strictObject({ opened: z.literal(true) }), empty]) }).refine((value) =>
  value.code === ({ ok: "GENERAL_CONTROL_OK", unavailable: "GENERAL_CONTROL_UNAVAILABLE", busy: "GENERAL_OPERATION_BUSY", canceled: "GENERAL_OPERATION_CANCELED" } as const)[value.status] &&
  (value.status === "ok" || Object.keys(value.body).length === 0));
const event = z.strictObject({ format: z.literal("koincode-general-control-event"), version: z.literal(1), controlId: uuid, deliverySequence: positive,
  viewId: uuid, generation: positive, event: z.enum(["invalidated", "manager_closed"]) });
export type GeneralControlSnapshot = z.infer<typeof snapshot>;
export type GeneralControlHello = z.infer<typeof hello>;
export type GeneralControlRequest = z.infer<typeof request>;
export type GeneralControlReply = z.infer<typeof reply>;
export type GeneralControlEvent = z.infer<typeof event>;
export type GeneralControlMessage = GeneralControlHello | GeneralControlReply | GeneralControlEvent;
export type GeneralControlCommand = GeneralControlRequest["command"];
const failure = () => new Error("GENERAL_CONTROL_PROTOCOL_INVALID");
export function generalControlCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(generalControlCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${generalControlCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value); if (typeof encoded !== "string") throw failure(); return encoded;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
export function validateGeneralControlSnapshot(value: unknown): GeneralControlSnapshot {
  const parsed = snapshot.safeParse(value); if (!parsed.success) throw failure(); return freeze(parsed.data);
}
function parse<T>(bytes: Uint8Array, schema: z.ZodType<T>, maximum: number): T {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer || bytes.byteLength < 1 || bytes.byteLength > maximum) throw failure();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success || generalControlCanonical(parsed.data) !== text) throw failure(); return freeze(parsed.data);
  } catch { throw failure(); }
}
function encode<T>(value: unknown, schema: z.ZodType<T>, maximum: number): Buffer {
  const parsed = schema.safeParse(value); if (!parsed.success) throw failure();
  const body = Buffer.from(generalControlCanonical(parsed.data)); if (!body.length || body.length > maximum) throw failure();
  const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame;
}
export function encodeGeneralControlRequest(value: unknown): Buffer { return encode(value, request, GENERAL_CONTROL_REQUEST_MAX); }
export function parseGeneralControlRequest(bytes: Uint8Array): GeneralControlRequest { return parse(bytes, request, GENERAL_CONTROL_REQUEST_MAX); }
export function encodeGeneralControlMessage(value: unknown): Buffer {
  const parsed = z.union([hello, reply, event]).safeParse(value); if (!parsed.success) throw failure(); const row = parsed.data;
  return encode(row, z.union([hello, reply, event]), row.format === "koincode-general-control-reply" ? GENERAL_CONTROL_REPLY_MAX : GENERAL_CONTROL_EVENT_MAX);
}
export function parseGeneralControlMessage(bytes: Uint8Array): GeneralControlMessage {
  const value = parse(bytes, z.union([hello, reply, event]), GENERAL_CONTROL_REPLY_MAX);
  if (value.format !== "koincode-general-control-reply" && bytes.byteLength > GENERAL_CONTROL_EVENT_MAX) throw failure(); return value;
}
export function assertGeneralControlReply(command: GeneralControlCommand, value: GeneralControlReply): void {
  if (value.status !== "ok") return;
  if (command === "snapshot" ? !("format" in value.body) : command === "open_manager" ? !("opened" in value.body) : Object.keys(value.body).length !== 0) throw failure();
}
