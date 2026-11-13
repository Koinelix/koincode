#include "enrollment-message.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char *const preparations[] = { "", "fresh", "resume" };
static const char *const commands[] = { "", "reserve", "start_head", "assign" };
static const char *const statuses[] = { "", "ok", "rejected", "uncertain" };
static bool hello_valid(const general_enrollment_hello *hello) {
  return hello && hello->uid && hello->uid < UINT32_MAX && general_session_uuid_valid(hello->installation_id) &&
    hello->receipt_revision && hello->receipt_revision <= GENERAL_SESSION_SAFE_INTEGER_MAX &&
    hello->preparation >= GENERAL_ENROLLMENT_FRESH && hello->preparation <= GENERAL_ENROLLMENT_RESUME;
}
static bool request_valid(const general_enrollment_request *request) {
  return request && general_session_uuid_valid(request->request_id) && request->command >= GENERAL_ENROLLMENT_RESERVE && request->command <= GENERAL_ENROLLMENT_ASSIGN;
}
bool general_enrollment_hello_parse(const unsigned char *bytes, size_t size, general_enrollment_hello *out) {
  if (!bytes || !size || size > 4096 || !out) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size };
  general_enrollment_hello parsed = {0}; char preparation[8]; uint64_t uid;
  if (!general_canonical_take(&reader, "{\"format\":\"koincode-general-enrollment-hello\",\"installationId\":") ||
      !general_canonical_string(&reader, parsed.installation_id, sizeof(parsed.installation_id)) ||
      !general_canonical_take(&reader, ",\"preparation\":") || !general_canonical_string(&reader, preparation, sizeof(preparation)) ||
      !general_canonical_take(&reader, ",\"receiptRevision\":") || !general_canonical_integer(&reader, &parsed.receipt_revision) ||
      !general_canonical_take(&reader, ",\"uid\":") || !general_canonical_integer(&reader, &uid) || !uid || uid >= UINT32_MAX ||
      !general_canonical_take(&reader, ",\"version\":1}") || reader.position != size) return false;
  parsed.uid = (uint32_t)uid;
  for (unsigned i = 1; i < sizeof(preparations) / sizeof(*preparations); i++) if (!strcmp(preparation, preparations[i])) parsed.preparation = (general_enrollment_preparation)i;
  if (!hello_valid(&parsed)) return false;
  *out = parsed; return true;
}
bool general_enrollment_hello_metadata_valid(const unsigned char *bytes, size_t size, void *out) { return general_enrollment_hello_parse(bytes, size, out); }
bool general_enrollment_hello_encode(const general_enrollment_hello *hello, general_session_wire *out) {
  if (!hello_valid(hello) || !out || out->bytes || out->size) return false;
  char metadata[256];
  int size = snprintf(metadata, sizeof(metadata), "{\"format\":\"koincode-general-enrollment-hello\",\"installationId\":\"%s\",\"preparation\":\"%s\",\"receiptRevision\":%" PRIu64
    ",\"uid\":%" PRIu32 ",\"version\":1}", hello->installation_id, preparations[hello->preparation], hello->receipt_revision, hello->uid);
  general_enrollment_hello parsed;
  return size > 0 && size < (int)sizeof(metadata) && general_session_frame_encode((const unsigned char *)metadata, (size_t)size, NULL, 0,
    general_enrollment_hello_metadata_valid, &parsed, out);
}
bool general_enrollment_reply_parse(const unsigned char *bytes, size_t size, const general_enrollment_request *request, general_enrollment_status *out) {
  if (!bytes || !size || size > GENERAL_SESSION_METADATA_MAX || !out || !request_valid(request)) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size }; char command[12], request_id[37], status[12];
  if (!general_canonical_take(&reader, "{\"command\":") || !general_canonical_string(&reader, command, sizeof(command)) ||
      !general_canonical_take(&reader, ",\"format\":\"koincode-general-enrollment-reply\",\"requestId\":") ||
      !general_canonical_string(&reader, request_id, sizeof(request_id)) || !general_canonical_take(&reader, ",\"status\":") ||
      !general_canonical_string(&reader, status, sizeof(status)) || !general_canonical_take(&reader, ",\"version\":1}") || reader.position != size ||
      strcmp(command, commands[request->command]) || strcmp(request_id, request->request_id)) return false;
  for (unsigned i = 1; i < sizeof(statuses) / sizeof(*statuses); i++) if (!strcmp(status, statuses[i])) { *out = (general_enrollment_status)i; return true; }
  return false;
}
bool general_enrollment_reply_metadata_valid(const unsigned char *bytes, size_t size, void *context) {
  general_enrollment_reply_validation *validation = context;
  return validation && general_enrollment_reply_parse(bytes, size, validation->request, validation->status);
}
bool general_enrollment_reply_encode(const general_enrollment_request *request, general_enrollment_status status, general_session_wire *out) {
  if (!request_valid(request) || status < GENERAL_ENROLLMENT_OK || status > GENERAL_ENROLLMENT_UNCERTAIN || !out || out->bytes || out->size) return false;
  char metadata[256];
  int size = snprintf(metadata, sizeof(metadata), "{\"command\":\"%s\",\"format\":\"koincode-general-enrollment-reply\",\"requestId\":\"%s\",\"status\":\"%s\",\"version\":1}",
    commands[request->command], request->request_id, statuses[status]);
  general_enrollment_status parsed; general_enrollment_reply_validation validation = { request, &parsed };
  return size > 0 && size < (int)sizeof(metadata) && general_session_frame_encode((const unsigned char *)metadata, (size_t)size, NULL, 0,
    general_enrollment_reply_metadata_valid, &validation, out);
}
