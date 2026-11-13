import { z } from "zod";
import { canonical } from "./canonical.js";
import { WalletError, requireWallet } from "../domain/errors.js";

export const GENERAL_SESSION_METADATA_MAX = 32768;
export const GENERAL_SESSION_VALUE_MAX = 1048576;
const FRAME_MAX = 8 + GENERAL_SESSION_METADATA_MAX + GENERAL_SESSION_VALUE_MAX;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuid = z.string().regex(new RegExp(`^${uuidPattern}$`));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reference = z.string().max(96).regex(new RegExp(`^(?:general-(?:initialization|domain-binding|state|signing-registry)-v1|(?:source-key|general-intent|general-signed|general-broadcast|general-restore-plan|general-restore-binding):${uuidPattern}|general-domain-binding:[0-9a-f]{64})$`));
const empty = z.strictObject({});
const resourceKind = z.enum(["profiles_root", "profile_directory", "history_directory", "state_repository", "signing_repository"]);
const resourceBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare"), kind: resourceKind, profileId: uuid.nullable(),
    originKind: z.enum(["initialization", "restore"]), originId: uuid, originDigest: hash }),
  ...(["start", "commit", "release"] as const).map((action) => z.strictObject({ action: z.literal(action), ticketId: uuid })),
  z.strictObject({ action: z.literal("inspect"), kind: resourceKind, profileId: uuid.nullable() }),
]).refine((body) => !("kind" in body) || (body.kind === "profiles_root" ? body.profileId === null : body.profileId !== null));
const candidate = z.string().min(1).max(16384).refine((value) => value.length <= 16384 && value.isWellFormed() &&
  !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 16384);
const begin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inspection") }),
  z.strictObject({ kind: z.literal("bootstrap_restore"), byteLength: integer.max(16 * 1024 * 1024),
    ciphertextDigest: hash, locale: z.enum(["en-US", "zh-CN"]) }),
  z.strictObject({ kind: z.literal("operation"), planId: uuid.nullable() }),
  z.strictObject({ kind: z.literal("initialization"), initializationId: uuid, initializationDigest: hash }),
]);
const envelope = { format: z.literal("koincode-general-session-request"), version: z.literal(1),
  sessionId: uuid, sequence: integer, requestId: uuid, operationId: uuid };
const requestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("begin"), body: begin }),
  z.strictObject({ ...envelope, command: z.literal("read"), body: z.strictObject({ reference }) }),
  z.strictObject({ ...envelope, command: z.literal("write"), body: z.strictObject({ reference: reference.refine((value) => value !== "general-domain-binding-v1"),
    expectedDigest: hash.nullable(), nextDigest: hash }) }),
  z.strictObject({ ...envelope, command: z.literal("publish"), body: z.strictObject({ recoveryId: uuid, planDigest: hash,
    expectedBindingDigest: hash.nullable(), canonicalCandidate: candidate }) }),
  z.strictObject({ ...envelope, command: z.literal("inspect"), body: z.strictObject({ reference }) }),
  z.strictObject({ ...envelope, command: z.literal("end"), body: empty }),
  z.strictObject({ ...envelope, command: z.literal("cancel"), body: z.strictObject({ targetRequestId: uuid }) }),
  z.strictObject({ ...envelope, command: z.literal("close"), body: empty }),
  z.strictObject({ ...envelope, command: z.literal("resource"), body: resourceBody }),
  z.strictObject({ ...envelope, command: z.literal("window"), body: z.strictObject({ action: z.literal("ready"), windowId: integer.max(0xffffffff) }) }),
]).refine((request) => request.command !== "window" || request.operationId === request.sessionId);
const helloSchema = z.strictObject({ format: z.literal("koincode-general-session-hello"), version: z.literal(1), sessionId: uuid });
const replyEnvelope = { format: z.literal("koincode-general-session-reply"), version: z.literal(1), sessionId: uuid, sequence: integer, requestId: uuid };
const presence = z.strictObject({ presence: z.enum(["missing", "present"]) });
const stage = z.union([z.strictObject({ stage: z.literal("unregistered") }),
  z.strictObject({ stage: z.enum(["admitted", "write_started", "committed", "uncertain"]), expectedDigest: hash.nullable(), nextDigest: hash })]);
const resourceReply = z.union([
  z.strictObject({ ticketId: uuid, creationId: uuid, mode: z.enum(["create", "open"]) }),
  z.strictObject({ stage: z.literal("created") }),
  z.strictObject({ stage: z.literal("unregistered"), creationId: z.null() }),
  z.strictObject({ stage: z.enum(["admitted", "write_started", "created", "uncertain"]), creationId: uuid }),
]);
const replySchema = z.discriminatedUnion("status", [
  z.strictObject({ ...replyEnvelope, status: z.literal("ok"), code: z.literal("GENERAL_SESSION_OK"), body: z.union([empty, presence, stage, resourceReply]) }),
  z.strictObject({ ...replyEnvelope, status: z.literal("rejected"), code: z.enum(["GENERAL_SESSION_INVALID", "GENERAL_PROTECTION_UNAVAILABLE",
    "GENERAL_OPERATION_BUSY", "GENERAL_AUTH_REJECTED", "GENERAL_AUTH_TIMEOUT", "GENERAL_RECOVERY_RECORD_CONFLICT"]), body: empty }),
  z.strictObject({ ...replyEnvelope, status: z.literal("canceled"), code: z.literal("GENERAL_OPERATION_CANCELED"), body: empty }),
  z.strictObject({ ...replyEnvelope, status: z.literal("uncertain"), code: z.literal("GENERAL_REGISTRATION_UNCERTAIN"), body: empty }),
]);

/** Private wire data only. Parsing establishes no peer, native scope or secret admission. */
export type GeneralSessionRequest = z.infer<typeof requestSchema>;
export type GeneralSessionReply = z.infer<typeof replySchema>;
export type GeneralSessionHello = z.infer<typeof helloSchema>;
function check(condition: unknown): asserts condition { requireWallet(condition, "GENERAL_SESSION_INVALID", "The protected wallet session message is invalid."); }
function invalid(): never { throw new WalletError("GENERAL_SESSION_INVALID", "The protected wallet session message is invalid."); }
function bytes(value: Uint8Array, maximum: number): void {
  check(value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer) && value.byteLength <= maximum);
}
function metadataValue(input: Uint8Array): unknown {
  bytes(input, GENERAL_SESSION_METADATA_MAX); check(input.byteLength > 0);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  const value: unknown = JSON.parse(text); check(canonical(value) === text); return value;
}
function metadataBytes(value: unknown): Uint8Array {
  const output = Buffer.from(canonical(value), "utf8");
  check(output.byteLength > 0 && output.byteLength <= GENERAL_SESSION_METADATA_MAX); return output;
}
function valueSize(request: GeneralSessionRequest, size: number): void {
  check(Number.isSafeInteger(size) && size >= 0 && size <= GENERAL_SESSION_VALUE_MAX);
  if (request.command === "write") { check(size > 0); return; }
  if (request.command === "begin" && request.body.kind === "operation") { check(size > 0 && size <= 32768); return; }
  if (request.command === "begin" && request.body.kind === "initialization") { check(size > 0 && size <= 65536); return; }
  check(size === 0);
}

/** Validates/clones metadata, without command replay, record semantics or IO authorization. */
export function validateGeneralSessionRequest(input: unknown): GeneralSessionRequest {
  try { const request = requestSchema.parse(input); metadataBytes(request); return request; } catch { return invalid(); }
}
export function parseGeneralSessionRequest(input: Uint8Array, rawValueSize: number): GeneralSessionRequest {
  try { const request = requestSchema.parse(metadataValue(input)); valueSize(request, rawValueSize); return request; } catch { return invalid(); }
}
export function parseGeneralSessionReply(input: Uint8Array, original: GeneralSessionRequest, rawValueSize: number): GeneralSessionReply {
  try {
    const request = validateGeneralSessionRequest(original), reply = replySchema.parse(metadataValue(input));
    check(reply.sessionId === request.sessionId && reply.sequence === request.sequence && reply.requestId === request.requestId);
    check(Number.isSafeInteger(rawValueSize) && rawValueSize >= 0 && rawValueSize <= GENERAL_SESSION_VALUE_MAX);
    if (reply.status === "ok" && request.command === "read") {
      check("presence" in reply.body); check(reply.body.presence === "present" || rawValueSize === 0);
    } else {
      check(rawValueSize === 0);
      if (reply.status === "ok" && request.command === "resource") {
        const body = reply.body, action = request.body.action;
        if (action === "prepare") check("ticketId" in body && "creationId" in body && "mode" in body);
        else if (action === "commit") check(Object.keys(body).length === 1 && "stage" in body && body.stage === "created");
        else if (action === "inspect") check(Object.keys(body).length === 2 && "stage" in body && "creationId" in body);
        else check(Object.keys(body).length === 0);
      } else if (reply.status === "ok" && request.command === "inspect") {
        check("stage" in reply.body && !("creationId" in reply.body) &&
          (reply.body.stage === "unregistered" || "expectedDigest" in reply.body));
      }
      else check(Object.keys(reply.body).length === 0);
    }
    return reply;
  } catch { return invalid(); }
}
function frameParts(input: Uint8Array): { metadata: Uint8Array; value: Uint8Array } {
  bytes(input, FRAME_MAX); check(input.byteLength >= 8);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength), metadataSize = view.getUint32(0, false);
  check(metadataSize > 0 && metadataSize <= GENERAL_SESSION_METADATA_MAX && input.byteLength >= metadataSize + 8);
  const size = view.getUint32(metadataSize + 4, false);
  check(size <= GENERAL_SESSION_VALUE_MAX && input.byteLength === metadataSize + size + 8);
  return { metadata: input.subarray(4, metadataSize + 4), value: input.subarray(metadataSize + 8) };
}
/** Returns independent owned bytes. The original private IO owner must wipe them after actual drainage. */
export function encodeGeneralSessionRequest(input: GeneralSessionRequest, value: Uint8Array = new Uint8Array()): Uint8Array {
  try {
    const request = validateGeneralSessionRequest(input); bytes(value, GENERAL_SESSION_VALUE_MAX); valueSize(request, value.byteLength);
    const metadata = metadataBytes(request), wire = Buffer.alloc(8 + metadata.byteLength + value.byteLength);
    wire.writeUInt32BE(metadata.byteLength, 0); wire.set(metadata, 4);
    wire.writeUInt32BE(value.byteLength, 4 + metadata.byteLength); wire.set(value, 8 + metadata.byteLength); return wire;
  } catch { return invalid(); }
}
/** Empty raw value is distinct from missing; record-specific validation remains mandatory. */
export function decodeGeneralSessionReply(input: Uint8Array, request: GeneralSessionRequest): { reply: GeneralSessionReply; value: Uint8Array } {
  try {
    const parts = frameParts(input), reply = parseGeneralSessionReply(parts.metadata, request, parts.value.byteLength);
    return { reply, value: Uint8Array.from(parts.value) };
  } catch { return invalid(); }
}
export function decodeGeneralSessionHello(input: Uint8Array): GeneralSessionHello {
  try { const parts = frameParts(input); check(parts.value.byteLength === 0); return helloSchema.parse(metadataValue(parts.metadata)); }
  catch { return invalid(); }
}
