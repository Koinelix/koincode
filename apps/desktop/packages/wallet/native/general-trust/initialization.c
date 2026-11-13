#include "initialization.h"
#include <CommonCrypto/CommonDigest.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char *const kinds[] = { "", "new", "restore" };
static const char *const phases[] = { "", "prepared", "state_published", "journal_published", "ready" };
static bool hash(const unsigned char *bytes, size_t size, char out[65]) {
  if (!bytes || !size || size > GENERAL_NATIVE_INITIALIZATION_MAX) return false;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (!CC_SHA256(bytes, (CC_LONG)size, digest)) return false;
  static const char digits[] = "0123456789abcdef";
  for (unsigned i = 0; i < sizeof(digest); i++) { out[2 * i] = digits[digest[i] >> 4]; out[2 * i + 1] = digits[digest[i] & 15]; }
  out[64] = 0; return true;
}
static bool uuid(general_canonical_reader *reader, char out[37]) {
  return general_canonical_string(reader, out, 37) && general_session_uuid_valid(out);
}
static bool digest(general_canonical_reader *reader, char out[65]) {
  return general_canonical_string(reader, out, 65) && general_canonical_hash_valid(out);
}
/* Preserve canonical.ts localeCompare("en"), including mixed-case key order. */
static bool prefix(general_canonical_reader *reader, bool plan, general_native_identity *identity, char domain[37], general_initialization_kind *kind) {
  char name[8];
  if (!general_canonical_take(reader, "{\"enrollmentId\":") || !uuid(reader, identity->enrollment_id) ||
      !general_canonical_take(reader, plan ? ",\"format\":\"koincode-general-initialization-plan\",\"initializationId\":" :
        ",\"format\":\"koincode-general-initialization\",\"initializationId\":") || !uuid(reader, identity->initialization_id) ||
      !general_canonical_take(reader, ",\"initialSigningDomainId\":") || !uuid(reader, domain) ||
      !general_canonical_take(reader, ",\"installationId\":") || !uuid(reader, identity->installation_id) ||
      !general_canonical_take(reader, ",\"kind\":") || !general_canonical_string(reader, name, sizeof(name)) ||
      !general_canonical_take(reader, ",\"ownerId\":") || !uuid(reader, identity->owner_id)) return false;
  for (unsigned i = 1; i < sizeof(kinds) / sizeof(*kinds); i++) if (!strcmp(name, kinds[i])) *kind = (general_initialization_kind)i;
  return *kind != GENERAL_INITIALIZATION_KIND_NONE;
}
static bool suffix(general_canonical_reader *reader, char commitment[65], uint32_t *uid) {
  uint64_t number;
  if (!general_canonical_take(reader, ",\"targetStateCommitment\":") || !digest(reader, commitment) ||
      !general_canonical_take(reader, ",\"uid\":") || !general_canonical_integer(reader, &number) || !number || number >= UINT32_MAX ||
      !general_canonical_take(reader, ",\"version\":1}") || reader->position != reader->size) return false;
  *uid = (uint32_t)number; return true;
}
static bool common(const general_native_identity *identity, general_initialization_kind kind, const char *commitment, const char *domain) {
  return general_native_identity_valid(identity) && kind >= GENERAL_INITIALIZATION_NEW && kind <= GENERAL_INITIALIZATION_RESTORE &&
    general_canonical_hash_valid(commitment) && general_session_uuid_valid(domain);
}
static int plan_format(const general_initialization_plan *plan, char out[2048]) {
  const general_native_identity *id = &plan->identity;
  char recovery[68];
  if (plan->has_recovery) snprintf(recovery, sizeof(recovery), "\"%s\"", plan->recovery_plan_digest);
  else strcpy(recovery, "null");
  return snprintf(out, 2048, "{\"enrollmentId\":\"%s\",\"format\":\"koincode-general-initialization-plan\",\"initializationId\":\"%s\","
    "\"initialSigningDomainId\":\"%s\",\"installationId\":\"%s\",\"kind\":\"%s\",\"ownerId\":\"%s\",\"recoveryPlanDigest\":%s,"
    "\"targetStateCommitment\":\"%s\",\"uid\":%" PRIu32 ",\"version\":1}",
    id->enrollment_id, id->initialization_id, plan->initial_signing_domain_id, id->installation_id, kinds[plan->kind], id->owner_id,
    recovery, plan->target_state_commitment, id->uid);
}
bool general_initialization_plan_valid(const general_initialization_plan *plan) {
  if (!plan || !common(&plan->identity, plan->kind, plan->target_state_commitment, plan->initial_signing_domain_id) ||
      plan->has_recovery != (plan->kind == GENERAL_INITIALIZATION_RESTORE) || (plan->has_recovery && !general_canonical_hash_valid(plan->recovery_plan_digest))) return false;
  char bytes[2048], computed[65]; int size = plan_format(plan, bytes);
  return size > 0 && size < (int)sizeof(bytes) && hash((const unsigned char *)bytes, (size_t)size, computed) && !strcmp(computed, plan->identity.initialization_digest);
}
bool general_initialization_record_valid(const general_initialization_record *record) {
  return record && common(&record->identity, record->kind, record->target_state_commitment, record->initial_signing_domain_id) &&
    record->phase >= GENERAL_INITIALIZATION_PREPARED && record->phase <= GENERAL_INITIALIZATION_READY;
}
bool general_initialization_plan_parse(const unsigned char *bytes, size_t size, general_initialization_plan *out) {
  if (!bytes || !size || size > GENERAL_NATIVE_INITIALIZATION_MAX || !out) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size }; general_initialization_plan parsed = {0};
  if (!prefix(&reader, true, &parsed.identity, parsed.initial_signing_domain_id, &parsed.kind) || !general_canonical_take(&reader, ",\"recoveryPlanDigest\":")) return false;
  if (!general_canonical_take(&reader, "null")) { parsed.has_recovery = true; if (!digest(&reader, parsed.recovery_plan_digest)) return false; }
  if (!suffix(&reader, parsed.target_state_commitment, &parsed.identity.uid) || !hash(bytes, size, parsed.identity.initialization_digest) || !general_initialization_plan_valid(&parsed)) return false;
  *out = parsed; return true;
}
bool general_initialization_record_parse(const unsigned char *bytes, size_t size, general_initialization_record *out) {
  if (!bytes || !size || size > GENERAL_NATIVE_INITIALIZATION_MAX || !out) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size }; general_initialization_record parsed = {0}; char phase[24];
  if (!prefix(&reader, false, &parsed.identity, parsed.initial_signing_domain_id, &parsed.kind) || !general_canonical_take(&reader, ",\"phase\":") ||
      !general_canonical_string(&reader, phase, sizeof(phase)) || !general_canonical_take(&reader, ",\"planDigest\":") || !digest(&reader, parsed.identity.initialization_digest) ||
      !suffix(&reader, parsed.target_state_commitment, &parsed.identity.uid)) return false;
  for (unsigned i = 1; i < sizeof(phases) / sizeof(*phases); i++) if (!strcmp(phase, phases[i])) parsed.phase = (general_initialization_phase)i;
  if (!general_initialization_record_valid(&parsed)) return false;
  *out = parsed; return true;
}
static bool same_identity(const general_native_identity *left, const general_native_identity *right) {
  return left->uid == right->uid && !strcmp(left->enrollment_id, right->enrollment_id) && !strcmp(left->installation_id, right->installation_id) &&
    !strcmp(left->initialization_id, right->initialization_id) && !strcmp(left->owner_id, right->owner_id) && !strcmp(left->initialization_digest, right->initialization_digest);
}
bool general_initialization_binding_valid(const general_initialization_record *record, const general_initialization_plan *plan) {
  return general_initialization_record_valid(record) && general_initialization_plan_valid(plan) && same_identity(&record->identity, &plan->identity) &&
    record->kind == plan->kind && !strcmp(record->target_state_commitment, plan->target_state_commitment) && !strcmp(record->initial_signing_domain_id, plan->initial_signing_domain_id);
}
bool general_initialization_advance_valid(const general_initialization_record *before, const general_initialization_record *after, const general_initialization_plan *plan) {
  return general_initialization_binding_valid(before, plan) && general_initialization_binding_valid(after, plan) &&
    (after->phase == before->phase || after->phase == before->phase + 1);
}
static bool copy(const char *bytes, int length, unsigned char *out, size_t capacity, size_t *size) {
  if (!out || !size || length <= 0 || length >= 2048 || (size_t)length > capacity) return false;
  memcpy(out, bytes, (size_t)length); *size = (size_t)length; return true;
}
bool general_initialization_plan_encode(const general_initialization_plan *plan, unsigned char *out, size_t capacity, size_t *size) {
  if (!general_initialization_plan_valid(plan)) return false;
  char bytes[2048]; int length = plan_format(plan, bytes); return copy(bytes, length, out, capacity, size);
}
bool general_initialization_record_encode(const general_initialization_record *record, unsigned char *out, size_t capacity, size_t *size) {
  if (!general_initialization_record_valid(record)) return false;
  const general_native_identity *id = &record->identity; char bytes[2048];
  int length = snprintf(bytes, sizeof(bytes), "{\"enrollmentId\":\"%s\",\"format\":\"koincode-general-initialization\",\"initializationId\":\"%s\","
    "\"initialSigningDomainId\":\"%s\",\"installationId\":\"%s\",\"kind\":\"%s\",\"ownerId\":\"%s\",\"phase\":\"%s\",\"planDigest\":\"%s\","
    "\"targetStateCommitment\":\"%s\",\"uid\":%" PRIu32 ",\"version\":1}", id->enrollment_id, id->initialization_id, record->initial_signing_domain_id,
    id->installation_id, kinds[record->kind], id->owner_id, phases[record->phase], id->initialization_digest, record->target_state_commitment, id->uid);
  return copy(bytes, length, out, capacity, size);
}
