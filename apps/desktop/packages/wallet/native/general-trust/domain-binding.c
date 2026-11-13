#include "domain-binding.h"
#include <CommonCrypto/CommonDigest.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#define BODY_CAPACITY 2048U
static bool hash(const unsigned char *bytes, size_t size, char out[65]) {
  unsigned char value[CC_SHA256_DIGEST_LENGTH];
  if (!bytes || !size || size > GENERAL_DOMAIN_BINDING_MAX || !CC_SHA256(bytes, (CC_LONG)size, value)) return false;
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(value); i++) { out[2 * i] = hex[value[i] >> 4]; out[2 * i + 1] = hex[value[i] & 15]; }
  out[64] = 0; return true;
}
static bool shape(const general_domain_binding *value) {
  if (!value || !value->uid || value->uid == UINT32_MAX || !value->revision || value->revision > GENERAL_SESSION_SAFE_INTEGER_MAX ||
      !general_session_uuid_valid(value->enrollment_id) || !general_session_uuid_valid(value->installation_id) ||
      !general_session_uuid_valid(value->owner_id) || !general_session_uuid_valid(value->profile_id) ||
      !general_canonical_hash_valid(value->binding_digest) || (value->revision == 1) != !value->has_previous ||
      (value->has_previous && !general_canonical_hash_valid(value->previous_binding_digest))) return false;
  if (value->signing == GENERAL_BINDING_LIVE) {
    if (!general_session_uuid_valid(value->domain_id)) return false;
  } else if (value->signing != GENERAL_BINDING_ARCHIVE_ONLY || value->domain_id[0]) return false;
  if (value->origin == GENERAL_BINDING_NEW) {
    return value->revision == 1 && value->signing == GENERAL_BINDING_LIVE &&
      general_session_uuid_valid(value->source.created.initialization_id) &&
      general_canonical_hash_valid(value->source.created.initialization_digest) &&
      !strcmp(value->profile_id, value->source.created.initialization_id);
  }
  return value->origin == GENERAL_BINDING_RESTORE && (value->revision != 1 || value->signing == GENERAL_BINDING_ARCHIVE_ONLY) &&
    general_session_uuid_valid(value->source.restored.recovery_id) && general_canonical_hash_valid(value->source.restored.plan_digest) &&
    general_canonical_hash_valid(value->source.restored.archive_digest) && general_session_uuid_valid(value->source.restored.artifact_id) &&
    general_canonical_hash_valid(value->source.restored.archive_ciphertext_digest);
}
/* Same key ordering as the already approved canonical.ts v1 body. All strings
 * are fixed ASCII identifiers/digests validated before any formatting. */
static int body(const general_domain_binding *value, char out[BODY_CAPACITY]) {
  char origin[768], previous[68], domain[40]; int count;
  if (value->origin == GENERAL_BINDING_NEW) count = snprintf(origin, sizeof(origin),
    "{\"initializationDigest\":\"%s\",\"initializationId\":\"%s\",\"kind\":\"new\"}",
    value->source.created.initialization_digest, value->source.created.initialization_id);
  else count = snprintf(origin, sizeof(origin),
    "{\"archiveCiphertextDigest\":\"%s\",\"archiveDigest\":\"%s\",\"artifactId\":\"%s\",\"kind\":\"restore\",\"planDigest\":\"%s\",\"recoveryId\":\"%s\"}",
    value->source.restored.archive_ciphertext_digest, value->source.restored.archive_digest, value->source.restored.artifact_id,
    value->source.restored.plan_digest, value->source.restored.recovery_id);
  if (count < 1 || count >= (int)sizeof(origin)) return -1;
  if (value->has_previous) snprintf(previous, sizeof(previous), "\"%s\"", value->previous_binding_digest); else strcpy(previous, "null");
  if (value->signing == GENERAL_BINDING_LIVE) snprintf(domain, sizeof(domain), "\"%s\"", value->domain_id); else strcpy(domain, "null");
  return snprintf(out, BODY_CAPACITY,
    "{\"enrollmentId\":\"%s\",\"format\":\"koincode-general-domain-binding\",\"installationId\":\"%s\",\"origin\":%s,\"ownerId\":\"%s\","
    "\"previousBindingDigest\":%s,\"profileId\":\"%s\",\"revision\":%" PRIu64 ",\"signing\":{\"domainId\":%s,\"mode\":\"%s\"},\"uid\":%" PRIu32 ",\"version\":1}",
    value->enrollment_id, value->installation_id, origin, value->owner_id, previous, value->profile_id, value->revision,
    domain, value->signing == GENERAL_BINDING_LIVE ? "live" : "archive_only", value->uid);
}
bool general_domain_binding_valid(const general_domain_binding *value) {
  if (!shape(value)) return false;
  char bytes[BODY_CAPACITY], digest[65]; int size = body(value, bytes);
  return size > 0 && size < (int)sizeof(bytes) && hash((const unsigned char *)bytes, (size_t)size, digest) && !strcmp(digest, value->binding_digest);
}
bool general_domain_binding_initial(const general_initialization_record *initialization, general_domain_binding *out) {
  if (!out || !general_initialization_record_valid(initialization) || initialization->kind != GENERAL_INITIALIZATION_NEW) return false;
  const general_native_identity *id = &initialization->identity;
  general_domain_binding result = { .uid = id->uid, .revision = 1, .origin = GENERAL_BINDING_NEW, .signing = GENERAL_BINDING_LIVE };
  strcpy(result.enrollment_id, id->enrollment_id); strcpy(result.installation_id, id->installation_id); strcpy(result.owner_id, id->owner_id);
  strcpy(result.profile_id, id->initialization_id); strcpy(result.source.created.initialization_id, id->initialization_id);
  strcpy(result.source.created.initialization_digest, id->initialization_digest); strcpy(result.domain_id, initialization->initial_signing_domain_id);
  char bytes[BODY_CAPACITY]; int size = body(&result, bytes);
  if (size < 1 || size >= (int)sizeof(bytes) || !hash((const unsigned char *)bytes, (size_t)size, result.binding_digest) || !general_domain_binding_valid(&result)) return false;
  *out = result; return true;
}
static bool uuid(general_canonical_reader *reader, char out[37]) {
  return general_canonical_string(reader, out, 37) && general_session_uuid_valid(out);
}
static bool digest(general_canonical_reader *reader, char out[65]) {
  return general_canonical_string(reader, out, 65) && general_canonical_hash_valid(out);
}
bool general_domain_binding_parse(const unsigned char *bytes, size_t size, general_domain_binding *out) {
  if (!bytes || !size || size > GENERAL_DOMAIN_BINDING_MAX || !out) return false;
  general_canonical_reader reader = { .bytes = bytes, .size = size }; general_domain_binding parsed = {0}; uint64_t uid;
  if (!general_canonical_take(&reader, "{\"bindingDigest\":") || !digest(&reader, parsed.binding_digest) ||
      !general_canonical_take(&reader, ",\"enrollmentId\":") || !uuid(&reader, parsed.enrollment_id) ||
      !general_canonical_take(&reader, ",\"format\":\"koincode-general-domain-binding\",\"installationId\":") || !uuid(&reader, parsed.installation_id) ||
      !general_canonical_take(&reader, ",\"origin\":{")) return false;
  if (general_canonical_take(&reader, "\"initializationDigest\":")) {
    parsed.origin = GENERAL_BINDING_NEW;
    if (!digest(&reader, parsed.source.created.initialization_digest) || !general_canonical_take(&reader, ",\"initializationId\":") ||
        !uuid(&reader, parsed.source.created.initialization_id) || !general_canonical_take(&reader, ",\"kind\":\"new\"}")) return false;
  } else {
    parsed.origin = GENERAL_BINDING_RESTORE;
    if (!general_canonical_take(&reader, "\"archiveCiphertextDigest\":") || !digest(&reader, parsed.source.restored.archive_ciphertext_digest) ||
        !general_canonical_take(&reader, ",\"archiveDigest\":") || !digest(&reader, parsed.source.restored.archive_digest) ||
        !general_canonical_take(&reader, ",\"artifactId\":") || !uuid(&reader, parsed.source.restored.artifact_id) ||
        !general_canonical_take(&reader, ",\"kind\":\"restore\",\"planDigest\":") || !digest(&reader, parsed.source.restored.plan_digest) ||
        !general_canonical_take(&reader, ",\"recoveryId\":") || !uuid(&reader, parsed.source.restored.recovery_id) || !general_canonical_take(&reader, "}")) return false;
  }
  if (!general_canonical_take(&reader, ",\"ownerId\":") || !uuid(&reader, parsed.owner_id) || !general_canonical_take(&reader, ",\"previousBindingDigest\":")) return false;
  if (!general_canonical_take(&reader, "null")) { parsed.has_previous = true; if (!digest(&reader, parsed.previous_binding_digest)) return false; }
  if (!general_canonical_take(&reader, ",\"profileId\":") || !uuid(&reader, parsed.profile_id) ||
      !general_canonical_take(&reader, ",\"revision\":") || !general_canonical_integer(&reader, &parsed.revision) ||
      !general_canonical_take(&reader, ",\"signing\":{\"domainId\":")) return false;
  if (general_canonical_take(&reader, "null")) {
    parsed.signing = GENERAL_BINDING_ARCHIVE_ONLY;
    if (!general_canonical_take(&reader, ",\"mode\":\"archive_only\"}")) return false;
  } else {
    parsed.signing = GENERAL_BINDING_LIVE;
    if (!uuid(&reader, parsed.domain_id) || !general_canonical_take(&reader, ",\"mode\":\"live\"}")) return false;
  }
  if (!general_canonical_take(&reader, ",\"uid\":") || !general_canonical_integer(&reader, &uid) || !uid || uid >= UINT32_MAX ||
      !general_canonical_take(&reader, ",\"version\":1}") || reader.position != reader.size) return false;
  parsed.uid = (uint32_t)uid;
  if (!general_domain_binding_valid(&parsed)) return false;
  *out = parsed; return true;
}
bool general_domain_binding_encode(const general_domain_binding *value, unsigned char *out, size_t capacity, size_t *size) {
  if (!out || !size || !general_domain_binding_valid(value)) return false;
  char bytes[BODY_CAPACITY], encoded[BODY_CAPACITY + 96]; int length = body(value, bytes);
  if (length < 1 || length >= (int)sizeof(bytes)) return false;
  int count = snprintf(encoded, sizeof(encoded), "{\"bindingDigest\":\"%s\",%s", value->binding_digest, bytes + 1);
  if (count < 1 || count >= (int)sizeof(encoded) || (size_t)count > capacity) return false;
  memcpy(out, encoded, (size_t)count); *size = (size_t)count; return true;
}
bool general_domain_binding_new_valid(const general_domain_binding *binding, const general_assignment *assignment,
    const general_initialization_record *initialization) {
  if (!general_domain_binding_valid(binding) || binding->origin != GENERAL_BINDING_NEW || !assignment ||
      !general_initialization_record_valid(initialization) || initialization->kind != GENERAL_INITIALIZATION_NEW) return false;
  const general_native_identity *id = &initialization->identity;
  /* Validate every provided string before comparing; no supplied struct is an
   * actual root assignment, ready fact or active-binding publication proof. */
  if (!assignment->uid || assignment->uid == UINT32_MAX || !general_session_uuid_valid(assignment->enrollment_id) ||
      !general_session_uuid_valid(assignment->installation_id) || !general_session_uuid_valid(assignment->owner_id) ||
      !general_session_uuid_valid(assignment->initialization_id) || !general_canonical_hash_valid(assignment->initialization_digest)) return false;
  general_initialization_plan plan = { .identity = *id, .kind = GENERAL_INITIALIZATION_NEW };
  memcpy(plan.target_state_commitment, initialization->target_state_commitment, 65);
  memcpy(plan.initial_signing_domain_id, initialization->initial_signing_domain_id, 37);
  return general_initialization_binding_valid(initialization, &plan) && assignment->uid == id->uid && binding->uid == id->uid &&
    !strcmp(assignment->enrollment_id, id->enrollment_id) && !strcmp(binding->enrollment_id, id->enrollment_id) &&
    !strcmp(assignment->installation_id, id->installation_id) && !strcmp(binding->installation_id, id->installation_id) &&
    !strcmp(assignment->owner_id, id->owner_id) && !strcmp(binding->owner_id, id->owner_id) &&
    !strcmp(assignment->initialization_id, id->initialization_id) && !strcmp(binding->source.created.initialization_id, id->initialization_id) &&
    !strcmp(assignment->initialization_digest, id->initialization_digest) && !strcmp(binding->source.created.initialization_digest, id->initialization_digest) &&
    binding->signing == GENERAL_BINDING_LIVE && !strcmp(binding->domain_id, initialization->initial_signing_domain_id);
}
