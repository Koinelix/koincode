#include "enrollment-payload.h"

/* Locate one fixed scalar-field object without allocating a generic JSON tree.
 * The record parser separately verifies all syntax, canonical bytes and fields. */
static bool object(general_canonical_reader *reader, const unsigned char **bytes, size_t *size) {
  size_t start = reader->position;
  if (start >= reader->size || reader->bytes[start] != '{') return false;
  bool quoted = false, escaped = false;
  for (size_t i = start + 1; i < reader->size; i++) {
    unsigned char value = reader->bytes[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (value == '\\') escaped = true;
      else if (value == '"') quoted = false;
    } else if (value == '"') quoted = true;
    else if (value == '{' || value == '[' || value == ']') return false;
    else if (value == '}') { *bytes = reader->bytes + start; *size = i - start + 1; reader->position = i + 1; return true; }
  }
  return false;
}
bool general_enrollment_payload_parse(const general_enrollment_request *request, const unsigned char *bytes, size_t size,
  const general_initialization_plan *original, general_enrollment_payload *out) {
  if (!request || !out || !general_session_uuid_valid(request->request_id)) return false;
  general_enrollment_payload parsed = { .command = request->command };
  switch (request->command) {
    case GENERAL_ENROLLMENT_RESERVE:
      if (!general_initialization_plan_parse(bytes, size, &parsed.body.reserve)) return false;
      break;
    case GENERAL_ENROLLMENT_START_HEAD:
      if (size) return false;
      break;
    case GENERAL_ENROLLMENT_ASSIGN: {
      if (!bytes || !size || size > 32768 || !general_initialization_plan_valid(original)) return false;
      general_canonical_reader reader = { .bytes = bytes, .size = size }; const unsigned char *value; size_t length;
      if (!general_canonical_take(&reader, "{\"head\":") || !object(&reader, &value, &length) ||
          !general_native_head_parse(value, length, &parsed.body.assign.head) ||
          !general_canonical_take(&reader, ",\"initialization\":") || !object(&reader, &value, &length) ||
          !general_initialization_record_parse(value, length, &parsed.body.assign.initialization) ||
          !general_canonical_take(&reader, "}") || reader.position != reader.size ||
          parsed.body.assign.initialization.phase != GENERAL_INITIALIZATION_PREPARED ||
          !general_initialization_binding_valid(&parsed.body.assign.initialization, original) ||
          !general_native_head_same_identity(&parsed.body.assign.head, &original->identity)) return false;
      break;
    }
    default: return false;
  }
  *out = parsed; return true;
}
