#include "session-reply.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char *const statuses[] = { "", "ok", "rejected", "canceled", "uncertain" };
static const char *const codes[] = { "", "GENERAL_SESSION_OK", "GENERAL_SESSION_INVALID", "GENERAL_PROTECTION_UNAVAILABLE",
  "GENERAL_OPERATION_BUSY", "GENERAL_AUTH_REJECTED", "GENERAL_AUTH_TIMEOUT", "GENERAL_RECOVERY_RECORD_CONFLICT",
  "GENERAL_OPERATION_CANCELED", "GENERAL_REGISTRATION_UNCERTAIN" };
static const char *const stages[] = { "", "admitted", "write_started", "committed", "uncertain" };
static const char *const resource_stages[] = { "", "admitted", "write_started", "created", "uncertain" };
static bool request_valid(const general_session_request *request) {
  return request && general_session_uuid_valid(request->session_id) && general_session_uuid_valid(request->request_id) &&
    general_session_uuid_valid(request->operation_id) && request->sequence && request->sequence <= GENERAL_SESSION_SAFE_INTEGER_MAX &&
    request->command >= GENERAL_SESSION_BEGIN && request->command <= GENERAL_SESSION_WINDOW;
}
static bool shape(const general_session_request *request, const general_session_reply *reply) {
  if (!request_valid(request) || !reply || reply->status < GENERAL_REPLY_OK || reply->status > GENERAL_REPLY_UNCERTAIN ||
      reply->code < GENERAL_REPLY_CODE_OK || reply->code > GENERAL_REPLY_REGISTRATION_UNCERTAIN) return false;
  bool matching = reply->status == GENERAL_REPLY_OK ? reply->code == GENERAL_REPLY_CODE_OK :
    reply->status == GENERAL_REPLY_REJECTED ? reply->code >= GENERAL_REPLY_INVALID && reply->code <= GENERAL_REPLY_CONFLICT :
    reply->status == GENERAL_REPLY_CANCELED ? reply->code == GENERAL_REPLY_CODE_CANCELED : reply->code == GENERAL_REPLY_REGISTRATION_UNCERTAIN;
  if (!matching) return false;
  if (reply->status != GENERAL_REPLY_OK) return reply->kind == GENERAL_REPLY_EMPTY;
  if (request->command == GENERAL_SESSION_RESOURCE) {
    switch (request->body.resource.action) {
      case GENERAL_RESOURCE_PREPARE: return reply->kind == GENERAL_REPLY_RESOURCE_PREPARED && general_session_uuid_valid(reply->ticket_id) && general_session_uuid_valid(reply->creation_id);
      case GENERAL_RESOURCE_COMMIT: return reply->kind == GENERAL_REPLY_RESOURCE_CREATED;
      case GENERAL_RESOURCE_INSPECT: return reply->kind == GENERAL_REPLY_RESOURCE_UNREGISTERED ||
        (reply->kind == GENERAL_REPLY_RESOURCE_REGISTERED && general_session_uuid_valid(reply->creation_id) &&
          reply->resource_stage >= GENERAL_REPLY_RESOURCE_ADMITTED && reply->resource_stage <= GENERAL_REPLY_RESOURCE_UNCERTAIN);
      case GENERAL_RESOURCE_START: case GENERAL_RESOURCE_RELEASE: return reply->kind == GENERAL_REPLY_EMPTY;
      default: return false;
    }
  }
  if (request->command == GENERAL_SESSION_READ) return reply->kind == GENERAL_REPLY_READ_MISSING || reply->kind == GENERAL_REPLY_READ_PRESENT;
  if (request->command != GENERAL_SESSION_INSPECT) return reply->kind == GENERAL_REPLY_EMPTY;
  return reply->kind == GENERAL_REPLY_INSPECT_UNREGISTERED || (reply->kind == GENERAL_REPLY_INSPECT_REGISTERED &&
    reply->stage >= GENERAL_REPLY_ADMITTED && reply->stage <= GENERAL_REPLY_STAGE_UNCERTAIN &&
    general_canonical_hash_valid(reply->next_digest) && (!reply->has_expected || general_canonical_hash_valid(reply->expected_digest)));
}
bool general_session_reply_accepts_value(const general_session_request *request, const general_session_reply *reply, size_t size) {
  return size <= GENERAL_SESSION_VALUE_MAX && shape(request, reply) && (reply->kind == GENERAL_REPLY_READ_PRESENT || size == 0);
}
static bool body_parse(general_canonical_reader *reader, general_session_reply *reply) {
  if (general_canonical_take(reader, "{}")) { reply->kind = GENERAL_REPLY_EMPTY; return true; }
  if (general_canonical_take(reader, "{\"presence\":\"missing\"}")) { reply->kind = GENERAL_REPLY_READ_MISSING; return true; }
  if (general_canonical_take(reader, "{\"presence\":\"present\"}")) { reply->kind = GENERAL_REPLY_READ_PRESENT; return true; }
  if (general_canonical_take(reader, "{\"stage\":\"unregistered\"}")) { reply->kind = GENERAL_REPLY_INSPECT_UNREGISTERED; return true; }
  if (general_canonical_take(reader, "{\"stage\":\"created\"}")) { reply->kind = GENERAL_REPLY_RESOURCE_CREATED; return true; }
  if (general_canonical_take(reader, "{\"creationId\":")) {
    if (general_canonical_take(reader, "null,\"stage\":\"unregistered\"}")) { reply->kind = GENERAL_REPLY_RESOURCE_UNREGISTERED; return true; }
    if (!general_canonical_string(reader, reply->creation_id, sizeof(reply->creation_id))) return false;
    if (general_canonical_take(reader, ",\"mode\":")) {
      char mode[8]; reply->kind = GENERAL_REPLY_RESOURCE_PREPARED;
      if (!general_canonical_string(reader, mode, sizeof(mode)) || (strcmp(mode, "create") && strcmp(mode, "open")) ||
          !general_canonical_take(reader, ",\"ticketId\":") || !general_canonical_string(reader, reply->ticket_id, sizeof(reply->ticket_id)) || !general_canonical_take(reader, "}")) return false;
      reply->resource_create = !strcmp(mode, "create"); return true;
    }
    char stage[16]; reply->kind = GENERAL_REPLY_RESOURCE_REGISTERED;
    if (!general_canonical_take(reader, ",\"stage\":") || !general_canonical_string(reader, stage, sizeof(stage)) || !general_canonical_take(reader, "}")) return false;
    for (unsigned i = 1; i < sizeof(resource_stages) / sizeof(*resource_stages); i++) if (!strcmp(stage, resource_stages[i])) reply->resource_stage = (general_session_reply_resource_stage)i;
    return true;
  }
  if (!general_canonical_take(reader, "{\"expectedDigest\":")) return false;
  reply->kind = GENERAL_REPLY_INSPECT_REGISTERED;
  if (!general_canonical_take(reader, "null")) {
    reply->has_expected = true;
    if (!general_canonical_string(reader, reply->expected_digest, sizeof(reply->expected_digest))) return false;
  }
  char stage[16];
  if (!general_canonical_take(reader, ",\"nextDigest\":") || !general_canonical_string(reader, reply->next_digest, sizeof(reply->next_digest)) ||
      !general_canonical_take(reader, ",\"stage\":") || !general_canonical_string(reader, stage, sizeof(stage)) || !general_canonical_take(reader, "}")) return false;
  for (unsigned i = 1; i < sizeof(stages) / sizeof(*stages); i++) if (!strcmp(stage, stages[i])) reply->stage = (general_session_reply_stage)i;
  return true;
}
bool general_session_reply_parse(const unsigned char *bytes, size_t size, const general_session_request *request, general_session_reply *out) {
  if (!bytes || !size || size > GENERAL_SESSION_METADATA_MAX || !out || !request_valid(request)) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size };
  general_session_reply parsed = {0}; char code[48], status[16], request_id[37], session_id[37]; uint64_t sequence;
  if (!general_canonical_take(&reader, "{\"body\":") || !body_parse(&reader, &parsed) ||
      !general_canonical_take(&reader, ",\"code\":") || !general_canonical_string(&reader, code, sizeof(code)) ||
      !general_canonical_take(&reader, ",\"format\":\"koincode-general-session-reply\",\"requestId\":") ||
      !general_canonical_string(&reader, request_id, sizeof(request_id)) || !general_canonical_take(&reader, ",\"sequence\":") ||
      !general_canonical_integer(&reader, &sequence) || !general_canonical_take(&reader, ",\"sessionId\":") ||
      !general_canonical_string(&reader, session_id, sizeof(session_id)) || !general_canonical_take(&reader, ",\"status\":") ||
      !general_canonical_string(&reader, status, sizeof(status)) || !general_canonical_take(&reader, ",\"version\":1}") || reader.position != size ||
      strcmp(request_id, request->request_id) || strcmp(session_id, request->session_id) || sequence != request->sequence) return false;
  for (unsigned i = 1; i < sizeof(statuses) / sizeof(*statuses); i++) if (!strcmp(status, statuses[i])) parsed.status = (general_session_reply_status)i;
  for (unsigned i = 1; i < sizeof(codes) / sizeof(*codes); i++) if (!strcmp(code, codes[i])) parsed.code = (general_session_reply_code)i;
  if (!shape(request, &parsed)) return false;
  *out = parsed; return true;
}
bool general_session_reply_metadata_valid(const unsigned char *bytes, size_t size, void *context) {
  general_session_reply_validation *validation = context;
  return validation && general_session_reply_parse(bytes, size, validation->request, validation->reply);
}
static bool body_encode(const general_session_reply *reply, char out[256]) {
  int size;
  switch (reply->kind) {
    case GENERAL_REPLY_EMPTY: strcpy(out, "{}"); return true;
    case GENERAL_REPLY_READ_MISSING: strcpy(out, "{\"presence\":\"missing\"}"); return true;
    case GENERAL_REPLY_READ_PRESENT: strcpy(out, "{\"presence\":\"present\"}"); return true;
    case GENERAL_REPLY_INSPECT_UNREGISTERED: strcpy(out, "{\"stage\":\"unregistered\"}"); return true;
    case GENERAL_REPLY_INSPECT_REGISTERED:
      size = reply->has_expected ? snprintf(out, 256, "{\"expectedDigest\":\"%s\",\"nextDigest\":\"%s\",\"stage\":\"%s\"}", reply->expected_digest, reply->next_digest, stages[reply->stage]) :
        snprintf(out, 256, "{\"expectedDigest\":null,\"nextDigest\":\"%s\",\"stage\":\"%s\"}", reply->next_digest, stages[reply->stage]);
      return size > 0 && size < 256;
    case GENERAL_REPLY_RESOURCE_PREPARED:
      size = snprintf(out, 256, "{\"creationId\":\"%s\",\"mode\":\"%s\",\"ticketId\":\"%s\"}", reply->creation_id, reply->resource_create ? "create" : "open", reply->ticket_id);
      return size > 0 && size < 256;
    case GENERAL_REPLY_RESOURCE_CREATED: strcpy(out, "{\"stage\":\"created\"}"); return true;
    case GENERAL_REPLY_RESOURCE_UNREGISTERED: strcpy(out, "{\"creationId\":null,\"stage\":\"unregistered\"}"); return true;
    case GENERAL_REPLY_RESOURCE_REGISTERED:
      size = snprintf(out, 256, "{\"creationId\":\"%s\",\"stage\":\"%s\"}", reply->creation_id, resource_stages[reply->resource_stage]);
      return size > 0 && size < 256;
    default: return false;
  }
}
bool general_session_reply_encode(const general_session_request *request, const general_session_reply *reply,
  const unsigned char *value, size_t value_size, general_session_wire *out) {
  if (!out || out->bytes || out->size || !general_session_reply_accepts_value(request, reply, value_size) || (value_size && !value)) return false;
  char body[256], metadata[768];
  if (!body_encode(reply, body)) return false;
  int size = snprintf(metadata, sizeof(metadata), "{\"body\":%s,\"code\":\"%s\",\"format\":\"koincode-general-session-reply\",\"requestId\":\"%s\",\"sequence\":%" PRIu64
    ",\"sessionId\":\"%s\",\"status\":\"%s\",\"version\":1}", body, codes[reply->code], request->request_id, request->sequence, request->session_id, statuses[reply->status]);
  if (size <= 0 || size >= (int)sizeof(metadata)) return false;
  general_session_reply parsed; general_session_reply_validation validation = { request, &parsed };
  return general_session_frame_encode((const unsigned char *)metadata, (size_t)size, value, value_size,
    general_session_reply_metadata_valid, &validation, out);
}
static bool hello_valid(const unsigned char *bytes, size_t size, void *context) { return general_session_parse_hello(bytes, size, context); }
bool general_session_hello_encode(const char session_id[37], general_session_wire *out) {
  if (!out || out->bytes || out->size || !general_session_uuid_valid(session_id)) return false;
  char metadata[128], parsed[37];
  int size = snprintf(metadata, sizeof(metadata), "{\"format\":\"koincode-general-session-hello\",\"sessionId\":\"%s\",\"version\":1}", session_id);
  return size > 0 && size < (int)sizeof(metadata) && general_session_frame_encode((const unsigned char *)metadata, (size_t)size, NULL, 0, hello_valid, parsed, out);
}
