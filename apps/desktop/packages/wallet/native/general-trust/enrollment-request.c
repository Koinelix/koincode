#include "enrollment-request.h"
#include <string.h>
#include <unistd.h>

bool general_enrollment_request_parse(const unsigned char *bytes, size_t size, general_enrollment_request *out) {
  if (!bytes || !size || size > GENERAL_SESSION_METADATA_MAX || !out) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size };
  general_enrollment_request parsed = {0}; char command[11]; uint64_t version;
  if (!general_canonical_take(&reader, "{\"command\":") || !general_canonical_string(&reader, command, sizeof(command)) ||
      !general_canonical_take(&reader, ",\"format\":\"koincode-general-enrollment-request\",\"requestId\":") ||
      !general_canonical_string(&reader, parsed.request_id, sizeof(parsed.request_id)) || !general_session_uuid_valid(parsed.request_id) ||
      !general_canonical_take(&reader, ",\"version\":") || !general_canonical_integer(&reader, &version) || version != 1 ||
      !general_canonical_take(&reader, "}") || reader.position != size) return false;
  if (!strcmp(command, "reserve")) parsed.command = GENERAL_ENROLLMENT_RESERVE;
  else if (!strcmp(command, "start_head")) parsed.command = GENERAL_ENROLLMENT_START_HEAD;
  else if (!strcmp(command, "assign")) parsed.command = GENERAL_ENROLLMENT_ASSIGN;
  else return false;
  *out = parsed; return true;
}
static bool metadata(const unsigned char *bytes, size_t size, void *context) { return general_enrollment_request_parse(bytes, size, context); }
static size_t value_limit(void *context) {
  switch (((general_enrollment_request *)context)->command) {
    case GENERAL_ENROLLMENT_RESERVE: return 16384;
    case GENERAL_ENROLLMENT_ASSIGN: return 32768;
    default: return 0;
  }
}
general_session_frame_result general_enrollment_request_read(int fd, unsigned timeout_ms, general_session_frame_current current,
  void *context, general_session_frame *frame, general_enrollment_request *request, int *owner_lock) {
  if (!request || !owner_lock || *owner_lock != -1) return GENERAL_SESSION_FRAME_INVALID;
  general_enrollment_request parsed = {0}; int received = -1;
  general_session_frame_result result = general_session_frame_read_enrollment(fd, timeout_ms, metadata, value_limit, &parsed, current, context, frame, &received);
  if (result != GENERAL_SESSION_FRAME_COMPLETE) return result;
  bool reserve = parsed.command == GENERAL_ENROLLMENT_RESERVE, start = parsed.command == GENERAL_ENROLLMENT_START_HEAD;
  if ((reserve != (received >= 0)) || (!start && !frame->value_size)) {
    if (received >= 0) close(received); general_session_frame_clear(frame);
    return GENERAL_SESSION_FRAME_INVALID;
  }
  *request = parsed; *owner_lock = received; return GENERAL_SESSION_FRAME_COMPLETE;
}
