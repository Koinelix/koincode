#include "session-request.h"
#include <string.h>

typedef enum {
  K_NONE, K_BYTE_LENGTH, K_CIPHERTEXT_DIGEST, K_KIND, K_LOCALE, K_PLAN_ID, K_INITIALIZATION_DIGEST,
  K_INITIALIZATION_ID, K_REFERENCE, K_EXPECTED_DIGEST, K_NEXT_DIGEST, K_CANDIDATE,
  K_EXPECTED_BINDING_DIGEST, K_PLAN_DIGEST, K_RECOVERY_ID, K_TARGET_REQUEST_ID,
  K_ACTION, K_PROFILE_ID, K_TICKET_ID, K_ORIGIN_ID, K_ORIGIN_DIGEST, K_ORIGIN_KIND, K_WINDOW_ID
} key;
static const char *const names[] = { "", "byteLength", "ciphertextDigest", "kind", "locale", "planId", "initializationDigest",
  "initializationId", "reference", "expectedDigest", "nextDigest", "canonicalCandidate", "expectedBindingDigest",
  "planDigest", "recoveryId", "targetRequestId", "action", "profileId", "ticketId", "originId", "originDigest", "originKind", "windowId" };
typedef enum { S_STRING, S_NULL, S_INTEGER } scalar;
typedef struct { key key; scalar type; size_t start, end; uint64_t number; } item;
typedef struct { item fields[6]; size_t count; } body;
_Static_assert(sizeof(general_session_request) <= 17 * 1024, "The decoded request must stay bounded.");

static key read_key(general_canonical_reader *r) {
  if (!general_canonical_take(r, "\"")) return K_NONE;
  for (size_t i = 1; i < sizeof(names) / sizeof(*names); i++) {
    size_t length = strlen(names[i]);
    if (length + 2 <= r->size - r->position && !memcmp(r->bytes + r->position, names[i], length) &&
        r->bytes[r->position + length] == '"' && r->bytes[r->position + length + 1] == ':') {
      r->position += length + 2; return (key)i;
    }
  }
  return K_NONE;
}
static size_t text_capacity(key key) {
  switch (key) {
    case K_CANDIDATE: return GENERAL_SESSION_CANDIDATE_MAX + 1;
    case K_REFERENCE: return GENERAL_SESSION_REFERENCE_MAX + 1;
    case K_KIND: case K_ACTION: case K_ORIGIN_KIND: return 33; case K_LOCALE: return 6;
    case K_PLAN_ID: case K_INITIALIZATION_ID: case K_RECOVERY_ID: case K_TARGET_REQUEST_ID:
    case K_PROFILE_ID: case K_TICKET_ID: case K_ORIGIN_ID: return 37;
    default: return 65;
  }
}
static bool read_body(general_canonical_reader *r, body *out) {
  if (!general_canonical_take(r, "{")) return false;
  if (general_canonical_take(r, "}")) return true;
  do {
    if (out->count == 6) return false;
    item *value = &out->fields[out->count]; value->key = read_key(r); if (value->key == K_NONE) return false;
    for (size_t i = 0; i < out->count; i++) if (out->fields[i].key == value->key) return false;
    value->start = r->position;
    if (r->position < r->size && r->bytes[r->position] == '"') {
      value->type = S_STRING; if (!general_canonical_string(r, NULL, text_capacity(value->key))) return false;
    } else if (general_canonical_take(r, "null")) value->type = S_NULL;
    else { value->type = S_INTEGER; if (!general_canonical_integer(r, &value->number)) return false; }
    value->end = r->position; out->count++;
    if (general_canonical_take(r, "}")) return true;
  } while (general_canonical_take(r, ","));
  return false;
}
static bool keys(const body *b, const key *expected, size_t count) {
  if (b->count != count) return false;
  for (size_t i = 0; i < count; i++) if (b->fields[i].key != expected[i]) return false;
  return true;
}
static const item *field(const body *b, key wanted) {
  for (size_t i = 0; i < b->count; i++) if (b->fields[i].key == wanted) return &b->fields[i];
  return NULL;
}
static bool text(const general_canonical_reader *r, const body *b, key wanted, char *out, size_t capacity) {
  const item *value = field(b, wanted); if (!value || value->type != S_STRING) return false;
  general_canonical_reader copy = *r; copy.position = value->start;
  return general_canonical_string(&copy, out, capacity) && copy.position == value->end;
}
static bool nullable(const general_canonical_reader *r, const body *b, key wanted, bool *present, char *out, size_t capacity, bool uuid) {
  const item *value = field(b, wanted); if (!value) return false;
  *present = value->type != S_NULL;
  return !*present || (text(r, b, wanted, out, capacity) && (uuid ? general_session_uuid_valid(out) : general_canonical_hash_valid(out)));
}
static bool parse_begin(const general_canonical_reader *r, const body *b, general_session_request *out) {
  char kind[33]; if (!text(r, b, K_KIND, kind, sizeof(kind))) return false;
  if (!strcmp(kind, "inspection")) {
    const key expected[] = {K_KIND}; out->body.begin.kind = GENERAL_SESSION_INSPECTION;
    return keys(b, expected, 1);
  }
  if (!strcmp(kind, "bootstrap_restore")) {
    const key expected[] = {K_BYTE_LENGTH, K_CIPHERTEXT_DIGEST, K_KIND, K_LOCALE}; char locale[6];
    if (!keys(b, expected, 4) || b->fields[0].type != S_INTEGER || !b->fields[0].number || b->fields[0].number > 16 * 1024 * 1024 ||
        !text(r, b, K_CIPHERTEXT_DIGEST, out->body.begin.data.bootstrap.ciphertext_digest, 65) ||
        !general_canonical_hash_valid(out->body.begin.data.bootstrap.ciphertext_digest) || !text(r, b, K_LOCALE, locale, sizeof(locale))) return false;
    out->body.begin.kind = GENERAL_SESSION_BOOTSTRAP_RESTORE;
    out->body.begin.data.bootstrap.byte_length = (uint32_t)b->fields[0].number;
    out->body.begin.data.bootstrap.locale = !strcmp(locale, "en-US") ? GENERAL_SESSION_EN_US : !strcmp(locale, "zh-CN") ? GENERAL_SESSION_ZH_CN : GENERAL_SESSION_LOCALE_NONE;
    return out->body.begin.data.bootstrap.locale != GENERAL_SESSION_LOCALE_NONE;
  }
  if (!strcmp(kind, "operation")) {
    const key expected[] = {K_KIND, K_PLAN_ID}; out->body.begin.kind = GENERAL_SESSION_OPERATION;
    return keys(b, expected, 2) && nullable(r, b, K_PLAN_ID, &out->body.begin.data.operation.has_plan, out->body.begin.data.operation.plan_id, 37, true);
  }
  if (!strcmp(kind, "initialization")) {
    const key expected[] = {K_INITIALIZATION_DIGEST, K_INITIALIZATION_ID, K_KIND}; out->body.begin.kind = GENERAL_SESSION_INITIALIZATION;
    return keys(b, expected, 3) && text(r, b, K_INITIALIZATION_DIGEST, out->body.begin.data.initialization.initialization_digest, 65) &&
      general_canonical_hash_valid(out->body.begin.data.initialization.initialization_digest) && text(r, b, K_INITIALIZATION_ID, out->body.begin.data.initialization.initialization_id, 37) &&
      general_session_uuid_valid(out->body.begin.data.initialization.initialization_id);
  }
  return false;
}
static bool parse_resource(const general_canonical_reader *r, const body *b, general_session_request *out) {
  char action[33], kind[33], origin[33];
  if (!text(r, b, K_ACTION, action, sizeof(action))) return false;
  const char *const actions[] = { "", "prepare", "start", "commit", "inspect", "release" };
  for (unsigned i = 1; i < sizeof(actions) / sizeof(*actions); i++) if (!strcmp(action, actions[i])) out->body.resource.action = (general_resource_action)i;
  general_resource_action selected = out->body.resource.action;
  if (selected == GENERAL_RESOURCE_START || selected == GENERAL_RESOURCE_COMMIT || selected == GENERAL_RESOURCE_RELEASE) {
    const key expected[] = { K_ACTION, K_TICKET_ID };
    return keys(b, expected, 2) && text(r, b, K_TICKET_ID, out->body.resource.ticket_id, 37) && general_session_uuid_valid(out->body.resource.ticket_id);
  }
  const key prepare[] = { K_ACTION, K_KIND, K_ORIGIN_DIGEST, K_ORIGIN_ID, K_ORIGIN_KIND, K_PROFILE_ID };
  const key inspect[] = { K_ACTION, K_KIND, K_PROFILE_ID };
  if (!(selected == GENERAL_RESOURCE_PREPARE ? keys(b, prepare, 6) : selected == GENERAL_RESOURCE_INSPECT && keys(b, inspect, 3)) ||
      !text(r, b, K_KIND, kind, sizeof(kind)) || !(out->body.resource.kind = general_resource_kind_parse(kind)) ||
      !nullable(r, b, K_PROFILE_ID, &out->body.resource.has_profile, out->body.resource.profile_id, 37, true) ||
      (out->body.resource.kind == GENERAL_RESOURCE_PROFILES_ROOT ? out->body.resource.has_profile : !out->body.resource.has_profile)) return false;
  if (selected == GENERAL_RESOURCE_INSPECT) return true;
  if (!text(r, b, K_ORIGIN_ID, out->body.resource.origin_id, 37) || !general_session_uuid_valid(out->body.resource.origin_id) ||
      !text(r, b, K_ORIGIN_DIGEST, out->body.resource.origin_digest, 65) || !general_canonical_hash_valid(out->body.resource.origin_digest) ||
      !text(r, b, K_ORIGIN_KIND, origin, sizeof(origin))) return false;
  out->body.resource.origin = !strcmp(origin, "initialization") ? GENERAL_SESSION_ORIGIN_INITIALIZATION :
    !strcmp(origin, "restore") ? GENERAL_SESSION_ORIGIN_RESTORE : GENERAL_SESSION_ORIGIN_NONE;
  return out->body.resource.origin != GENERAL_SESSION_ORIGIN_NONE;
}
static bool parse_body(const general_canonical_reader *r, const body *b, general_session_request *out) {
  switch (out->command) {
    case GENERAL_SESSION_BEGIN: return parse_begin(r, b, out);
    case GENERAL_SESSION_RESOURCE: return parse_resource(r, b, out);
    case GENERAL_SESSION_WINDOW: {
      const key expected[] = { K_ACTION, K_WINDOW_ID }; char action[33];
      if (!keys(b, expected, 2) || !text(r, b, K_ACTION, action, sizeof(action)) || strcmp(action, "ready") ||
          b->fields[1].type != S_INTEGER || !b->fields[1].number || b->fields[1].number > UINT32_MAX || strcmp(out->operation_id, out->session_id)) return false;
      out->body.window.window_id = (uint32_t)b->fields[1].number; return true;
    }
    case GENERAL_SESSION_READ: case GENERAL_SESSION_INSPECT: {
      const key expected[] = {K_REFERENCE};
      return keys(b, expected, 1) && text(r, b, K_REFERENCE, out->body.reference.reference, sizeof(out->body.reference.reference)) && general_canonical_reference_valid(out->body.reference.reference);
    }
    case GENERAL_SESSION_WRITE: {
      const key expected[] = {K_EXPECTED_DIGEST, K_NEXT_DIGEST, K_REFERENCE};
      return keys(b, expected, 3) && nullable(r, b, K_EXPECTED_DIGEST, &out->body.write.has_expected, out->body.write.expected_digest, 65, false) &&
        text(r, b, K_NEXT_DIGEST, out->body.write.next_digest, 65) && general_canonical_hash_valid(out->body.write.next_digest) &&
        text(r, b, K_REFERENCE, out->body.write.reference, sizeof(out->body.write.reference)) && general_canonical_reference_valid(out->body.write.reference) &&
        strcmp(out->body.write.reference, "general-domain-binding-v1") != 0;
    }
    case GENERAL_SESSION_PUBLISH: {
      const key expected[] = {K_CANDIDATE, K_EXPECTED_BINDING_DIGEST, K_PLAN_DIGEST, K_RECOVERY_ID};
      return keys(b, expected, 4) && text(r, b, K_CANDIDATE, out->body.publish.canonical_candidate, sizeof(out->body.publish.canonical_candidate)) &&
        out->body.publish.canonical_candidate[0] && nullable(r, b, K_EXPECTED_BINDING_DIGEST, &out->body.publish.has_expected, out->body.publish.expected_binding_digest, 65, false) &&
        text(r, b, K_PLAN_DIGEST, out->body.publish.plan_digest, 65) && general_canonical_hash_valid(out->body.publish.plan_digest) &&
        text(r, b, K_RECOVERY_ID, out->body.publish.recovery_id, 37) && general_session_uuid_valid(out->body.publish.recovery_id);
    }
    case GENERAL_SESSION_CANCEL: {
      const key expected[] = {K_TARGET_REQUEST_ID};
      return keys(b, expected, 1) && text(r, b, K_TARGET_REQUEST_ID, out->body.cancel.target_request_id, 37) && general_session_uuid_valid(out->body.cancel.target_request_id);
    }
    case GENERAL_SESSION_END: case GENERAL_SESSION_CLOSE: return b->count == 0;
    default: return false;
  }
}
void general_session_request_clear(general_session_request *request) {
  if (!request) return;
  volatile unsigned char *bytes = (volatile unsigned char *)request;
  for (size_t i = 0; i < sizeof(*request); i++) bytes[i] = 0;
}
bool general_session_parse_request(const unsigned char *bytes, size_t size, general_session_request *output) {
  if (!bytes || !size || size > GENERAL_SESSION_METADATA_MAX || !output) return false;
  general_canonical_reader r = { .bytes = bytes, .size = size }; body b = {0}; general_session_request parsed = {0}; bool ok = false; char command[17];
  const char *const commands[] = { "", "begin", "read", "write", "publish", "inspect", "end", "cancel", "close", "resource", "window" };
  if (!general_canonical_take(&r, "{\"body\":") || !read_body(&r, &b) || !general_canonical_take(&r, ",\"command\":") || !general_canonical_string(&r, command, sizeof(command))) goto done;
  for (size_t i = 1; i < sizeof(commands) / sizeof(*commands); i++) if (!strcmp(command, commands[i])) parsed.command = (general_session_command)i;
  if (parsed.command == GENERAL_SESSION_COMMAND_NONE || !general_canonical_take(&r, ",\"format\":\"koincode-general-session-request\",\"operationId\":") ||
      !general_canonical_string(&r, parsed.operation_id, 37) || !general_session_uuid_valid(parsed.operation_id) || !general_canonical_take(&r, ",\"requestId\":") ||
      !general_canonical_string(&r, parsed.request_id, 37) || !general_session_uuid_valid(parsed.request_id) || !general_canonical_take(&r, ",\"sequence\":") ||
      !general_canonical_integer(&r, &parsed.sequence) || !parsed.sequence || !general_canonical_take(&r, ",\"sessionId\":") || !general_canonical_string(&r, parsed.session_id, 37) ||
      !general_session_uuid_valid(parsed.session_id) || !general_canonical_take(&r, ",\"version\":1}") || r.position != r.size || !parse_body(&r, &b, &parsed)) goto done;
  *output = parsed; ok = true;
done:
  general_session_request_clear(&parsed); return ok;
}
bool general_session_request_metadata_valid(const unsigned char *bytes, size_t size, void *output) {
  return general_session_parse_request(bytes, size, output);
}
bool general_session_request_accepts_value(const general_session_request *request, size_t size) {
  if (!request || size > GENERAL_SESSION_VALUE_MAX) return false;
  switch (request->command) {
    case GENERAL_SESSION_BEGIN:
      switch (request->body.begin.kind) {
        case GENERAL_SESSION_INSPECTION: case GENERAL_SESSION_BOOTSTRAP_RESTORE: return size == 0;
        case GENERAL_SESSION_OPERATION: return size > 0 && size <= 32768;
        case GENERAL_SESSION_INITIALIZATION: return size > 0 && size <= 65536;
        default: return false;
      }
    case GENERAL_SESSION_WRITE: return size > 0;
    case GENERAL_SESSION_READ: case GENERAL_SESSION_PUBLISH: case GENERAL_SESSION_INSPECT:
    case GENERAL_SESSION_END: case GENERAL_SESSION_CANCEL: case GENERAL_SESSION_CLOSE: case GENERAL_SESSION_RESOURCE: case GENERAL_SESSION_WINDOW: return size == 0;
    default: return false;
  }
}
bool general_session_parse_hello(const unsigned char *bytes, size_t size, char session_id[37]) {
  if (!bytes || !size || size > GENERAL_SESSION_METADATA_MAX || !session_id) return false;
  general_canonical_reader r = { .bytes = bytes, .size = size }; char parsed[37];
  if (!general_canonical_take(&r, "{\"format\":\"koincode-general-session-hello\",\"sessionId\":") || !general_canonical_string(&r, parsed, sizeof(parsed)) ||
      !general_session_uuid_valid(parsed) || !general_canonical_take(&r, ",\"version\":1}") || r.position != r.size) return false;
  memcpy(session_id, parsed, sizeof(parsed)); return true;
}
