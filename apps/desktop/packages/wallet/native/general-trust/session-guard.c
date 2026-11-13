#include "session-guard.h"
#include <stdlib.h>
#include <string.h>

typedef struct { char request_id[37]; general_session_command command; bool canceled; } slot;
struct general_session_guard {
  char session_id[37], operation_id[37];
  uint64_t next_sequence;
  size_t remembered;
  unsigned char *ids;
  general_session_begin_kind scope;
  bool operation_open, revoked, frozen, closing, window_attempted;
  slot business, control;
  general_session_request begin, business_request;
  struct timespec begin_started;
};
static void erase(void *value, size_t length) {
  volatile unsigned char *bytes = value;
  if (bytes) while (length--) *bytes++ = 0;
}
general_session_guard *general_session_guard_create(const char *session_id) {
  if (!general_session_uuid_valid(session_id)) return NULL;
  general_session_guard *guard = calloc(1, sizeof(*guard)); if (!guard) return NULL;
  guard->ids = malloc(16 * GENERAL_SESSION_REQUEST_LIMIT);
  if (!guard->ids) { erase(guard, sizeof(*guard)); free(guard); return NULL; }
  memcpy(guard->session_id, session_id, 37); guard->next_sequence = 1; return guard;
}
static unsigned nibble(char c) { return c <= '9' ? (unsigned)(c - '0') : (unsigned)(c - 'a' + 10); }
static void uuid_bytes(const char *value, unsigned char out[16]) {
  unsigned used = 0, first = 0;
  for (size_t i = 0; i < 36; i++) if (value[i] != '-') {
    if ((used & 1) == 0) first = nibble(value[i]);
    else out[used / 2] = (unsigned char)(first * 16 + nibble(value[i]));
    used++;
  }
}
static bool remember(general_session_guard *guard, const char *request_id) {
  unsigned char id[16]; uuid_bytes(request_id, id); size_t low = 0, high = guard->remembered;
  while (low < high) {
    size_t middle = low + (high - low) / 2; int compared = memcmp(guard->ids + middle * 16, id, 16);
    if (compared == 0) return false;
    if (compared < 0) low = middle + 1; else high = middle;
  }
  if (low < guard->remembered) memmove(guard->ids + (low + 1) * 16, guard->ids + low * 16, (guard->remembered - low) * 16);
  memcpy(guard->ids + low * 16, id, 16); guard->remembered++; return true;
}
void general_session_guard_invalidate(general_session_guard *guard) {
  if (!guard) return;
  guard->closing = true; guard->revoked = true; guard->business.canceled = true;
}
static general_session_admission invalid(general_session_guard *guard) {
  general_session_guard_invalidate(guard); return GENERAL_SESSION_ADMIT_INVALID;
}
static bool same_operation(const general_session_guard *guard, const general_session_request *request) {
  return strcmp(guard->operation_id, request->operation_id) == 0;
}
static bool material(const char *reference) {
  return strncmp(reference, "source-key:", 11) == 0 || strncmp(reference, "general-signed:", 15) == 0;
}
static void assign(slot *slot, const general_session_request *request) {
  memcpy(slot->request_id, request->request_id, 37); slot->command = request->command; slot->canceled = false;
}
general_session_admission general_session_guard_admit(general_session_guard *guard, const general_session_request *request, size_t value_size) {
  if (!guard) return GENERAL_SESSION_ADMIT_INVALID;
  if (guard->closing) return GENERAL_SESSION_ADMIT_CLOSING;
  if (!request || !general_session_uuid_valid(request->session_id) || strcmp(guard->session_id, request->session_id) != 0 ||
      !general_session_uuid_valid(request->request_id) || !general_session_uuid_valid(request->operation_id) ||
      !request->sequence || request->sequence != guard->next_sequence || request->sequence > GENERAL_SESSION_SAFE_INTEGER_MAX ||
      !general_session_request_accepts_value(request, value_size) || guard->remembered >= GENERAL_SESSION_REQUEST_LIMIT || !remember(guard, request->request_id)) return invalid(guard);
  guard->next_sequence++;
  if (request->command == GENERAL_SESSION_CANCEL) {
    if (guard->control.command != GENERAL_SESSION_COMMAND_NONE) return GENERAL_SESSION_ADMIT_BUSY;
    if (guard->business.command == GENERAL_SESSION_COMMAND_NONE ||
        (guard->business.command == GENERAL_SESSION_WINDOW ? strcmp(guard->session_id, request->operation_id) != 0 : !same_operation(guard, request)) ||
        !general_session_uuid_valid(request->body.cancel.target_request_id) || strcmp(guard->business.request_id, request->body.cancel.target_request_id) != 0) return GENERAL_SESSION_ADMIT_REJECTED;
    assign(&guard->control, request); guard->business.canceled = true; guard->revoked = true; return GENERAL_SESSION_ADMIT_CONTROL;
  }
  if (request->command == GENERAL_SESSION_CLOSE) {
    if (guard->control.command != GENERAL_SESSION_COMMAND_NONE) return GENERAL_SESSION_ADMIT_BUSY;
    if (guard->scope != GENERAL_SESSION_SCOPE_NONE && !same_operation(guard, request)) return GENERAL_SESSION_ADMIT_REJECTED;
    assign(&guard->control, request); general_session_guard_invalidate(guard); return GENERAL_SESSION_ADMIT_CONTROL;
  }
  if (guard->business.command != GENERAL_SESSION_COMMAND_NONE || guard->control.command != GENERAL_SESSION_COMMAND_NONE) return GENERAL_SESSION_ADMIT_BUSY;
  if (request->command == GENERAL_SESSION_WINDOW) {
    if (guard->window_attempted || guard->scope != GENERAL_SESSION_SCOPE_NONE || strcmp(guard->session_id, request->operation_id) || !request->body.window.window_id)
      return GENERAL_SESSION_ADMIT_REJECTED;
    /* Anti-replay transport state only. The actual broker still proves the
     * original Host's WindowServer identity before completing this request. */
    guard->window_attempted = true; guard->business_request = *request; assign(&guard->business, request); return GENERAL_SESSION_ADMIT_BUSINESS;
  }
  if (request->command == GENERAL_SESSION_BEGIN) {
    if (guard->scope != GENERAL_SESSION_SCOPE_NONE) return GENERAL_SESSION_ADMIT_BUSY;
    if (clock_gettime(CLOCK_MONOTONIC, &guard->begin_started) || guard->begin_started.tv_sec < 0 ||
        guard->begin_started.tv_nsec < 0 || guard->begin_started.tv_nsec >= 1000000000) return invalid(guard);
    guard->begin.sequence = request->sequence; guard->begin.command = GENERAL_SESSION_BEGIN;
    memcpy(guard->begin.session_id, request->session_id, 37); memcpy(guard->begin.operation_id, request->operation_id, 37);
    memcpy(guard->begin.request_id, request->request_id, 37); guard->begin.body.begin = request->body.begin;
    memcpy(guard->operation_id, request->operation_id, 37); guard->scope = request->body.begin.kind;
    guard->operation_open = false; guard->revoked = false; guard->frozen = false;
  } else {
    if (!guard->operation_open || !same_operation(guard, request)) return GENERAL_SESSION_ADMIT_REJECTED;
    if (request->command != GENERAL_SESSION_END) {
      bool resource_inspection = request->command == GENERAL_SESSION_RESOURCE && request->body.resource.action == GENERAL_RESOURCE_INSPECT;
      bool resource_openonly = request->command == GENERAL_SESSION_RESOURCE &&
        (request->body.resource.action == GENERAL_RESOURCE_PREPARE || request->body.resource.action == GENERAL_RESOURCE_COMMIT ||
         request->body.resource.action == GENERAL_RESOURCE_RELEASE || request->body.resource.action == GENERAL_RESOURCE_INSPECT);
      if (guard->revoked || (guard->frozen && request->command != GENERAL_SESSION_INSPECT && !resource_inspection) || guard->scope == GENERAL_SESSION_BOOTSTRAP_RESTORE) return GENERAL_SESSION_ADMIT_REJECTED;
      if (guard->scope == GENERAL_SESSION_INSPECTION && request->command != GENERAL_SESSION_READ && request->command != GENERAL_SESSION_INSPECT && !resource_openonly) return GENERAL_SESSION_ADMIT_REJECTED;
      if ((guard->scope == GENERAL_SESSION_INSPECTION || guard->scope == GENERAL_SESSION_INITIALIZATION) && request->command != GENERAL_SESSION_RESOURCE) {
        if (request->command == GENERAL_SESSION_PUBLISH) return GENERAL_SESSION_ADMIT_REJECTED;
        const char *reference = request->command == GENERAL_SESSION_WRITE ? request->body.write.reference : request->body.reference.reference;
        if (material(reference)) return GENERAL_SESSION_ADMIT_REJECTED;
      }
    }
  }
  guard->business_request = *request; assign(&guard->business, request); return GENERAL_SESSION_ADMIT_BUSINESS;
}
bool general_session_guard_business_current(const general_session_guard *guard, const char *request_id) {
  return guard && !guard->closing && guard->business.command != GENERAL_SESSION_COMMAND_NONE && !guard->business.canceled &&
    (!guard->revoked || guard->business.command == GENERAL_SESSION_END) && general_session_uuid_valid(request_id) && strcmp(guard->business.request_id, request_id) == 0;
}
static bool begin_matches(const general_session_guard *guard, const general_session_request *request) {
  if (!guard || !request || guard->scope == GENERAL_SESSION_SCOPE_NONE || request->command != GENERAL_SESSION_BEGIN ||
      !general_session_uuid_valid(request->session_id) || strcmp(guard->begin.session_id, request->session_id) ||
      !general_session_uuid_valid(request->operation_id) || strcmp(guard->begin.operation_id, request->operation_id) ||
      !general_session_uuid_valid(request->request_id) || strcmp(guard->begin.request_id, request->request_id) ||
      guard->begin.sequence != request->sequence || guard->begin.body.begin.kind != request->body.begin.kind) return false;
  const general_session_request *original = &guard->begin;
  switch (request->body.begin.kind) {
    case GENERAL_SESSION_INSPECTION: return true;
    case GENERAL_SESSION_OPERATION:
      return original->body.begin.data.operation.has_plan == request->body.begin.data.operation.has_plan &&
        (!request->body.begin.data.operation.has_plan || (general_session_uuid_valid(request->body.begin.data.operation.plan_id) &&
        !strcmp(original->body.begin.data.operation.plan_id, request->body.begin.data.operation.plan_id)));
    case GENERAL_SESSION_INITIALIZATION:
      return general_session_uuid_valid(request->body.begin.data.initialization.initialization_id) &&
        general_canonical_hash_valid(request->body.begin.data.initialization.initialization_digest) &&
        !strcmp(original->body.begin.data.initialization.initialization_id, request->body.begin.data.initialization.initialization_id) &&
        !strcmp(original->body.begin.data.initialization.initialization_digest, request->body.begin.data.initialization.initialization_digest);
    case GENERAL_SESSION_BOOTSTRAP_RESTORE:
      return original->body.begin.data.bootstrap.byte_length == request->body.begin.data.bootstrap.byte_length &&
        original->body.begin.data.bootstrap.locale == request->body.begin.data.bootstrap.locale &&
        general_canonical_hash_valid(request->body.begin.data.bootstrap.ciphertext_digest) &&
        !strcmp(original->body.begin.data.bootstrap.ciphertext_digest, request->body.begin.data.bootstrap.ciphertext_digest);
    default: return false;
  }
}
bool general_session_guard_begin_current(const general_session_guard *guard, const general_session_request *request) {
  return begin_matches(guard, request) && guard->business.command == GENERAL_SESSION_BEGIN && general_session_guard_business_current(guard, request->request_id);
}
bool general_session_guard_command_current(const general_session_guard *guard, const general_session_request *request) {
  if (!request || !general_session_guard_business_current(guard, request->request_id)) return false;
  const general_session_request *original = &guard->business_request;
  if (request->command != original->command || request->sequence != original->sequence ||
      strncmp(request->session_id, original->session_id, 37) || strncmp(request->operation_id, original->operation_id, 37)) return false;
  /* Compare fields, not padding or inactive union bytes. Both inputs are parsed
   * fixed-schema requests; no caller-provided struct becomes authority. */
  switch (request->command) {
    case GENERAL_SESSION_BEGIN: return begin_matches(guard, request);
    case GENERAL_SESSION_READ: case GENERAL_SESSION_INSPECT:
      return !strncmp(request->body.reference.reference, original->body.reference.reference, sizeof(request->body.reference.reference));
    case GENERAL_SESSION_WRITE:
      return request->body.write.has_expected == original->body.write.has_expected &&
        (!request->body.write.has_expected || !strncmp(request->body.write.expected_digest, original->body.write.expected_digest, 65)) &&
        !strncmp(request->body.write.next_digest, original->body.write.next_digest, 65) &&
        !strncmp(request->body.write.reference, original->body.write.reference, sizeof(request->body.write.reference));
    case GENERAL_SESSION_PUBLISH:
      return request->body.publish.has_expected == original->body.publish.has_expected &&
        (!request->body.publish.has_expected || !strncmp(request->body.publish.expected_binding_digest, original->body.publish.expected_binding_digest, 65)) &&
        !strncmp(request->body.publish.recovery_id, original->body.publish.recovery_id, 37) &&
        !strncmp(request->body.publish.plan_digest, original->body.publish.plan_digest, 65) &&
        !strncmp(request->body.publish.canonical_candidate, original->body.publish.canonical_candidate, sizeof(request->body.publish.canonical_candidate));
    case GENERAL_SESSION_RESOURCE:
      return request->body.resource.action == original->body.resource.action && request->body.resource.kind == original->body.resource.kind &&
        request->body.resource.has_profile == original->body.resource.has_profile &&
        (!request->body.resource.has_profile || !strncmp(request->body.resource.profile_id, original->body.resource.profile_id, 37)) &&
        !strncmp(request->body.resource.ticket_id, original->body.resource.ticket_id, 37) &&
        request->body.resource.origin == original->body.resource.origin &&
        !strncmp(request->body.resource.origin_id, original->body.resource.origin_id, 37) &&
        !strncmp(request->body.resource.origin_digest, original->body.resource.origin_digest, 65);
    case GENERAL_SESSION_WINDOW: return request->body.window.window_id == original->body.window.window_id;
    case GENERAL_SESSION_END: return true;
    default: return false;
  }
}
bool general_session_guard_operation_current(const general_session_guard *guard, const general_session_request *request) {
  return begin_matches(guard, request) && guard->operation_open && !guard->closing && !guard->revoked && !guard->frozen;
}
bool general_session_guard_begin_started(const general_session_guard *guard, const general_session_request *request, struct timespec *out) {
  if (!out || !begin_matches(guard, request)) return false;
  *out = guard->begin_started; return true;
}
static void clear_scope(general_session_guard *guard) {
  erase(guard->operation_id, sizeof(guard->operation_id)); guard->scope = GENERAL_SESSION_SCOPE_NONE;
  guard->operation_open = false; guard->revoked = false; guard->frozen = false;
  erase(&guard->begin, sizeof(guard->begin)); erase(&guard->begin_started, sizeof(guard->begin_started));
}
general_session_drain general_session_guard_finish_business(general_session_guard *guard, const char *request_id, general_session_completion completion) {
  if (!guard || guard->business.command == GENERAL_SESSION_COMMAND_NONE || !general_session_uuid_valid(request_id) ||
      strcmp(guard->business.request_id, request_id) != 0 || (unsigned)completion > GENERAL_SESSION_FINISH_UNCERTAIN) return GENERAL_SESSION_DRAIN_REFUSED;
  bool current = general_session_guard_business_current(guard, request_id);
  if (guard->business.command == GENERAL_SESSION_BEGIN) {
    if (completion == GENERAL_SESSION_FINISH_UNCERTAIN) general_session_guard_invalidate(guard);
    if (completion == GENERAL_SESSION_FINISH_OK && current) guard->operation_open = true;
    else clear_scope(guard);
  } else if (guard->business.command == GENERAL_SESSION_WINDOW && completion == GENERAL_SESSION_FINISH_UNCERTAIN) {
    general_session_guard_invalidate(guard);
  } else if (guard->business.command == GENERAL_SESSION_END) {
    if (completion == GENERAL_SESSION_FINISH_OK) clear_scope(guard);
    else if (completion == GENERAL_SESSION_FINISH_UNCERTAIN) general_session_guard_invalidate(guard);
    else if (completion == GENERAL_SESSION_FINISH_CANCELED) guard->revoked = true;
  } else {
    if (completion == GENERAL_SESSION_FINISH_UNCERTAIN) guard->frozen = true;
    else if (completion == GENERAL_SESSION_FINISH_CANCELED) guard->revoked = true;
  }
  erase(&guard->business, sizeof(guard->business)); erase(&guard->business_request, sizeof(guard->business_request));
  return current ? GENERAL_SESSION_DRAIN_CURRENT : GENERAL_SESSION_DRAIN_REVOKED;
}
bool general_session_guard_finish_control(general_session_guard *guard, const char *request_id) {
  if (!guard || guard->control.command == GENERAL_SESSION_COMMAND_NONE || guard->business.command != GENERAL_SESSION_COMMAND_NONE ||
      !general_session_uuid_valid(request_id) || strcmp(guard->control.request_id, request_id) != 0 ||
      (guard->control.command == GENERAL_SESSION_CLOSE && guard->scope != GENERAL_SESSION_SCOPE_NONE)) return false;
  erase(&guard->control, sizeof(guard->control)); return true;
}
bool general_session_guard_scope_drained(general_session_guard *guard, const char *operation_id) {
  if (!guard || !guard->closing || guard->business.command != GENERAL_SESSION_COMMAND_NONE || guard->scope == GENERAL_SESSION_SCOPE_NONE ||
      !general_session_uuid_valid(operation_id) || strcmp(guard->operation_id, operation_id) != 0) return false;
  clear_scope(guard); return true;
}
bool general_session_guard_destroy(general_session_guard **owner) {
  if (!owner) return false;
  general_session_guard *guard = *owner; if (!guard) return true;
  if (!guard->closing || guard->business.command != GENERAL_SESSION_COMMAND_NONE || guard->control.command != GENERAL_SESSION_COMMAND_NONE || guard->scope != GENERAL_SESSION_SCOPE_NONE) return false;
  erase(guard->ids, 16 * GENERAL_SESSION_REQUEST_LIMIT); free(guard->ids); erase(guard, sizeof(*guard)); free(guard); *owner = NULL; return true;
}
