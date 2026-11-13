#include "native-head.h"
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <string.h>

static const char *const stages[] = { "", "admitted", "write_started", "committed", "uncertain" };
static bool digest(const unsigned char *bytes, size_t size, char out[65]) {
  if (!bytes || !out || size > GENERAL_NATIVE_HEAD_MAX) return false;
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; if (!CC_SHA256(bytes, (CC_LONG)size, hash)) return false;
  const char *hex = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(hash); i++) { out[i * 2] = hex[hash[i] >> 4]; out[i * 2 + 1] = hex[hash[i] & 15]; }
  out[64] = 0; return true;
}
bool general_native_identity_valid(const general_native_identity *identity) {
  return identity && identity->uid && identity->uid != UINT32_MAX && general_session_uuid_valid(identity->owner_id) &&
    general_session_uuid_valid(identity->installation_id) && general_session_uuid_valid(identity->enrollment_id) &&
    general_session_uuid_valid(identity->initialization_id) && general_canonical_hash_valid(identity->initialization_digest);
}
bool general_native_genesis_digest(const general_native_identity *identity, char out[65]) {
  if (!general_native_identity_valid(identity) || !out) return false;
  unsigned char bytes[GENERAL_NATIVE_HEAD_MAX];
  int size = snprintf((char *)bytes, sizeof(bytes), "{\"enrollmentId\":\"%s\",\"format\":\"koincode-general-native-genesis\",\"initializationDigest\":\"%s\",\"initializationId\":\"%s\",\"installationId\":\"%s\",\"ownerId\":\"%s\",\"uid\":%u,\"version\":1}",
    identity->enrollment_id, identity->initialization_digest, identity->initialization_id, identity->installation_id, identity->owner_id, identity->uid);
  return size > 0 && (size_t)size < sizeof(bytes) && digest(bytes, (size_t)size, out);
}
bool general_native_head_valid(const general_native_head *head) {
  if (!head || !general_native_identity_valid(&head->identity) || head->sequence > GENERAL_SESSION_SAFE_INTEGER_MAX || !general_canonical_hash_valid(head->head_digest)) return false;
  char genesis[65]; return head->sequence || (general_native_genesis_digest(&head->identity, genesis) && !strcmp(genesis, head->head_digest));
}
bool general_native_event_valid(const general_native_event *event) {
  return event && event->sequence && event->sequence <= GENERAL_SESSION_SAFE_INTEGER_MAX &&
    general_canonical_hash_valid(event->previous_digest) && general_session_uuid_valid(event->operation_id) &&
    general_canonical_hash_valid(event->operation_digest) && general_canonical_native_reference_valid(event->reference) &&
    event->stage >= GENERAL_NATIVE_ADMITTED && event->stage <= GENERAL_NATIVE_UNCERTAIN &&
    (!event->has_expected || general_canonical_hash_valid(event->expected_digest)) && general_canonical_hash_valid(event->next_digest);
}
bool general_native_head_same_identity(const general_native_head *head, const general_native_identity *identity) {
  return general_native_head_valid(head) && general_native_identity_valid(identity) && head->identity.uid == identity->uid &&
    !strcmp(head->identity.owner_id, identity->owner_id) && !strcmp(head->identity.installation_id, identity->installation_id) &&
    !strcmp(head->identity.enrollment_id, identity->enrollment_id) && !strcmp(head->identity.initialization_id, identity->initialization_id) &&
    !strcmp(head->identity.initialization_digest, identity->initialization_digest);
}
static bool copy_result(const unsigned char *bytes, int length, size_t maximum, unsigned char *out, size_t capacity, size_t *size) {
  if (!out || !size || length <= 0 || (size_t)length >= maximum || (size_t)length > capacity) return false;
  memcpy(out, bytes, (size_t)length); *size = (size_t)length; return true;
}
bool general_native_head_encode(const general_native_head *head, unsigned char *out, size_t capacity, size_t *size) {
  if (!general_native_head_valid(head)) return false;
  const general_native_identity *id = &head->identity; unsigned char bytes[GENERAL_NATIVE_HEAD_MAX];
  int length = snprintf((char *)bytes, sizeof(bytes), "{\"enrollmentId\":\"%s\",\"format\":\"koincode-general-native-head\",\"headDigest\":\"%s\",\"initializationDigest\":\"%s\",\"initializationId\":\"%s\",\"installationId\":\"%s\",\"ownerId\":\"%s\",\"sequence\":%llu,\"uid\":%u,\"version\":1}",
    id->enrollment_id, head->head_digest, id->initialization_digest, id->initialization_id, id->installation_id, id->owner_id, (unsigned long long)head->sequence, id->uid);
  return copy_result(bytes, length, sizeof(bytes), out, capacity, size);
}
bool general_native_event_encode(const general_native_event *event, unsigned char *out, size_t capacity, size_t *size) {
  if (!general_native_event_valid(event)) return false;
  unsigned char bytes[GENERAL_NATIVE_EVENT_MAX]; char expected[67];
  if (event->has_expected) snprintf(expected, sizeof(expected), "\"%s\"", event->expected_digest); else strcpy(expected, "null");
  int length = snprintf((char *)bytes, sizeof(bytes), "{\"expectedDigest\":%s,\"format\":\"koincode-general-native-event\",\"nextDigest\":\"%s\",\"operationDigest\":\"%s\",\"operationId\":\"%s\",\"previousDigest\":\"%s\",\"reference\":\"%s\",\"sequence\":%llu,\"stage\":\"%s\",\"version\":1}",
    expected, event->next_digest, event->operation_digest, event->operation_id, event->previous_digest, event->reference, (unsigned long long)event->sequence, stages[event->stage]);
  return copy_result(bytes, length, sizeof(bytes), out, capacity, size);
}
bool general_native_event_digest(const general_native_event *event, char out[65]) {
  unsigned char bytes[GENERAL_NATIVE_EVENT_MAX]; size_t size;
  return out && general_native_event_encode(event, bytes, sizeof(bytes), &size) && digest(bytes, size, out);
}
static bool uuid(general_canonical_reader *r, char out[37]) { return general_canonical_string(r, out, 37) && general_session_uuid_valid(out); }
static bool hash(general_canonical_reader *r, char out[65]) { return general_canonical_string(r, out, 65) && general_canonical_hash_valid(out); }
bool general_native_head_parse(const unsigned char *bytes, size_t size, general_native_head *out) {
  if (!bytes || !size || size > GENERAL_NATIVE_HEAD_MAX || !out) return false;
  general_canonical_reader r = { .bytes = bytes, .size = size }; general_native_head parsed = {0}; uint64_t uid;
  general_native_identity *id = &parsed.identity;
  if (!general_canonical_take(&r, "{\"enrollmentId\":") || !uuid(&r, id->enrollment_id) ||
      !general_canonical_take(&r, ",\"format\":\"koincode-general-native-head\",\"headDigest\":") || !hash(&r, parsed.head_digest) ||
      !general_canonical_take(&r, ",\"initializationDigest\":") || !hash(&r, id->initialization_digest) ||
      !general_canonical_take(&r, ",\"initializationId\":") || !uuid(&r, id->initialization_id) ||
      !general_canonical_take(&r, ",\"installationId\":") || !uuid(&r, id->installation_id) ||
      !general_canonical_take(&r, ",\"ownerId\":") || !uuid(&r, id->owner_id) ||
      !general_canonical_take(&r, ",\"sequence\":") || !general_canonical_integer(&r, &parsed.sequence) ||
      !general_canonical_take(&r, ",\"uid\":") || !general_canonical_integer(&r, &uid) || !uid || uid >= UINT32_MAX ||
      !general_canonical_take(&r, ",\"version\":1}") || r.position != size) return false;
  id->uid = (uint32_t)uid; if (!general_native_head_valid(&parsed)) return false;
  *out = parsed; return true;
}
bool general_native_event_parse(const unsigned char *bytes, size_t size, general_native_event *out) {
  if (!bytes || !size || size > GENERAL_NATIVE_EVENT_MAX || !out) return false;
  general_canonical_reader r = { .bytes = bytes, .size = size }; general_native_event parsed = {0}; char stage[16];
  if (!general_canonical_take(&r, "{\"expectedDigest\":")) return false;
  if (!general_canonical_take(&r, "null")) { parsed.has_expected = true; if (!hash(&r, parsed.expected_digest)) return false; }
  if (!general_canonical_take(&r, ",\"format\":\"koincode-general-native-event\",\"nextDigest\":") || !hash(&r, parsed.next_digest) ||
      !general_canonical_take(&r, ",\"operationDigest\":") || !hash(&r, parsed.operation_digest) ||
      !general_canonical_take(&r, ",\"operationId\":") || !uuid(&r, parsed.operation_id) ||
      !general_canonical_take(&r, ",\"previousDigest\":") || !hash(&r, parsed.previous_digest) ||
      !general_canonical_take(&r, ",\"reference\":") || !general_canonical_string(&r, parsed.reference, sizeof(parsed.reference)) ||
      !general_canonical_take(&r, ",\"sequence\":") || !general_canonical_integer(&r, &parsed.sequence) ||
      !general_canonical_take(&r, ",\"stage\":") || !general_canonical_string(&r, stage, sizeof(stage)) ||
      !general_canonical_take(&r, ",\"version\":1}") || r.position != size) return false;
  for (size_t i = 1; i < sizeof(stages) / sizeof(*stages); i++) if (!strcmp(stage, stages[i])) parsed.stage = (general_native_stage)i;
  if (!general_native_event_valid(&parsed)) return false;
  *out = parsed; return true;
}
