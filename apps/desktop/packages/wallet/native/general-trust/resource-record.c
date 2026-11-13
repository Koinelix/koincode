#include "resource-record.h"
#include <CommonCrypto/CommonDigest.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#define ENCODED_CAPACITY 2048U
static const char *stages[] = { NULL, "admitted", "write_started", "created", "uncertain" };
static bool repository(general_resource_kind kind) { return kind == GENERAL_RESOURCE_STATE_REPOSITORY || kind == GENERAL_RESOURCE_SIGNING_REPOSITORY; }
static bool profile_valid(general_resource_kind kind, const char *profile) {
  return general_resource_kind_name(kind) && (kind == GENERAL_RESOURCE_PROFILES_ROOT ? !profile : general_session_uuid_valid(profile));
}
static bool same_file(general_resource_file_identity a, general_resource_file_identity b) { return a.device == b.device && a.inode == b.inode; }
static bool empty_file(general_resource_file_identity value) { return !value.device && !value.inode; }
static bool shape(const general_resource_record *record) {
  if (!record || !record->uid || record->uid == UINT32_MAX || !general_session_uuid_valid(record->owner_id) ||
      !general_session_uuid_valid(record->installation_id) || !general_session_uuid_valid(record->enrollment_id) ||
      !general_session_uuid_valid(record->creation_id) || !general_session_uuid_valid(record->origin_id) || !general_canonical_hash_valid(record->origin_digest) ||
      !profile_valid(record->kind, record->kind == GENERAL_RESOURCE_PROFILES_ROOT ? NULL : record->profile_id) ||
      (record->kind == GENERAL_RESOURCE_PROFILES_ROOT && record->profile_id[0]) ||
      (record->origin != GENERAL_RESOURCE_INITIALIZATION && record->origin != GENERAL_RESOURCE_RESTORE) ||
      record->stage < GENERAL_RESOURCE_ADMITTED || record->stage > GENERAL_RESOURCE_UNCERTAIN ||
      ((record->stage == GENERAL_RESOURCE_ADMITTED || record->stage == GENERAL_RESOURCE_WRITE_STARTED) && record->has_identities) ||
      (record->stage == GENERAL_RESOURCE_CREATED && !record->has_identities)) return false;
  if (!record->has_identities && (!empty_file(record->directory) || !empty_file(record->database) || !empty_file(record->writer_lease))) return false;
  return repository(record->kind) || (empty_file(record->database) && empty_file(record->writer_lease));
}
static int file_body(general_resource_file_identity value, char out[96]) {
  return snprintf(out, 96, "{\"device\":\"%" PRIu64 "\",\"inode\":\"%" PRIu64 "\"}", value.device, value.inode);
}
static int encode(const general_resource_record *record, bool with_digest, char out[ENCODED_CAPACITY]) {
  char parent[96], directory[96], database[96], lease[96], identities[384], profile[40], digest[96] = {0};
  file_body(record->parent, parent); file_body(record->directory, directory); file_body(record->database, database); file_body(record->writer_lease, lease);
  if (!record->has_identities) strcpy(identities, "null");
  else if (repository(record->kind)) snprintf(identities, sizeof(identities), "{\"database\":%s,\"directory\":%s,\"writerLease\":%s}", database, directory, lease);
  else snprintf(identities, sizeof(identities), "{\"directory\":%s}", directory);
  if (record->kind == GENERAL_RESOURCE_PROFILES_ROOT) strcpy(profile, "null"); else snprintf(profile, sizeof(profile), "\"%s\"", record->profile_id);
  if (with_digest) snprintf(digest, sizeof(digest), "\"recordDigest\":\"%s\",", record->record_digest);
  return snprintf(out, ENCODED_CAPACITY,
    "{\"creationId\":\"%s\",\"enrollmentId\":\"%s\",\"format\":\"koincode-general-native-resource\",\"identities\":%s,\"installationId\":\"%s\",\"kind\":\"%s\","
    "\"originDigest\":\"%s\",\"originId\":\"%s\",\"originKind\":\"%s\",\"ownerId\":\"%s\",\"parentIdentity\":%s,\"profileId\":%s,%s\"stage\":\"%s\",\"uid\":%" PRIu32 ",\"version\":1}",
    record->creation_id, record->enrollment_id, identities, record->installation_id, general_resource_kind_name(record->kind), record->origin_digest,
    record->origin_id, record->origin == GENERAL_RESOURCE_INITIALIZATION ? "initialization" : "restore", record->owner_id, parent, profile, digest, stages[record->stage], record->uid);
}
bool general_resource_record_digest(const general_resource_record *record, char out[65]) {
  if (!out || !shape(record)) return false;
  char body[ENCODED_CAPACITY], result[65]; unsigned char digest[CC_SHA256_DIGEST_LENGTH]; int size = encode(record, false, body);
  if (size < 1 || size >= (int)sizeof(body) || !CC_SHA256(body, (CC_LONG)size, digest)) return false;
  static const char hex[] = "0123456789abcdef";
  for (unsigned i = 0; i < sizeof(digest); i++) { result[i * 2] = hex[digest[i] >> 4]; result[i * 2 + 1] = hex[digest[i] & 15]; }
  result[64] = 0; memcpy(out, result, sizeof(result)); return true;
}
bool general_resource_record_valid(const general_resource_record *record) {
  char digest[65]; return record && general_canonical_hash_valid(record->record_digest) && general_resource_record_digest(record, digest) && !strcmp(record->record_digest, digest);
}
bool general_resource_record_encode(const general_resource_record *record, unsigned char *out, size_t capacity, size_t *size) {
  if (!out || !size || !general_resource_record_valid(record)) return false;
  char bytes[ENCODED_CAPACITY]; int count = encode(record, true, bytes);
  if (count < 1 || count >= (int)sizeof(bytes) || (size_t)count > capacity) return false;
  memcpy(out, bytes, (size_t)count); *size = (size_t)count; return true;
}
static bool decimal(general_canonical_reader *reader, uint64_t *out) {
  char bytes[21];
  if (!general_canonical_string(reader, bytes, sizeof(bytes)) || !bytes[0] || (bytes[0] == '0' && bytes[1])) return false;
  uint64_t value = 0;
  for (unsigned i = 0; bytes[i]; i++) { if (bytes[i] < '0' || bytes[i] > '9') return false; unsigned digit = (unsigned)(bytes[i] - '0'); if (value > (UINT64_MAX - digit) / 10) return false; value = value * 10 + digit; }
  *out = value; return true;
}
static bool file_parse(general_canonical_reader *reader, general_resource_file_identity *out) {
  return general_canonical_take(reader, "{\"device\":") && decimal(reader, &out->device) && general_canonical_take(reader, ",\"inode\":") &&
    decimal(reader, &out->inode) && general_canonical_take(reader, "}");
}
static bool uuid(general_canonical_reader *reader, char out[37]) { return general_canonical_string(reader, out, 37) && general_session_uuid_valid(out); }
static bool hash(general_canonical_reader *reader, char out[65]) { return general_canonical_string(reader, out, 65) && general_canonical_hash_valid(out); }
bool general_resource_record_parse(const unsigned char *bytes, size_t size, general_resource_record *out) {
  if (!bytes || !size || size > GENERAL_RESOURCE_RECORD_MAX || !out) return false;
  general_resource_record record = {0}; general_canonical_reader r = { .bytes = bytes, .size = size }; char kind[32], origin[32], stage[32]; uint64_t uid;
  if (!general_canonical_take(&r, "{\"creationId\":") || !uuid(&r, record.creation_id) || !general_canonical_take(&r, ",\"enrollmentId\":") || !uuid(&r, record.enrollment_id) ||
      !general_canonical_take(&r, ",\"format\":\"koincode-general-native-resource\",\"identities\":")) return false;
  if (!general_canonical_take(&r, "null")) {
    record.has_identities = true;
    if (!general_canonical_take(&r, "{")) return false;
    if (general_canonical_take(&r, "\"database\":")) {
      if (!file_parse(&r, &record.database) || !general_canonical_take(&r, ",\"directory\":") || !file_parse(&r, &record.directory) ||
          !general_canonical_take(&r, ",\"writerLease\":") || !file_parse(&r, &record.writer_lease)) return false;
      /* Preserve the branch independently of zero numeric identities. */
      kind[0] = 1;
    } else {
      if (!general_canonical_take(&r, "\"directory\":") || !file_parse(&r, &record.directory)) return false;
      kind[0] = 0;
    }
    if (!general_canonical_take(&r, "}")) return false;
  } else kind[0] = 0;
  bool triple = kind[0] != 0;
  if (!general_canonical_take(&r, ",\"installationId\":") || !uuid(&r, record.installation_id) || !general_canonical_take(&r, ",\"kind\":") ||
      !general_canonical_string(&r, kind, sizeof(kind)) || !(record.kind = general_resource_kind_parse(kind)) ||
      (record.has_identities && triple != repository(record.kind)) || !general_canonical_take(&r, ",\"originDigest\":") || !hash(&r, record.origin_digest) ||
      !general_canonical_take(&r, ",\"originId\":") || !uuid(&r, record.origin_id) || !general_canonical_take(&r, ",\"originKind\":") ||
      !general_canonical_string(&r, origin, sizeof(origin))) return false;
  record.origin = !strcmp(origin, "initialization") ? GENERAL_RESOURCE_INITIALIZATION : !strcmp(origin, "restore") ? GENERAL_RESOURCE_RESTORE : GENERAL_RESOURCE_ORIGIN_NONE;
  if (!general_canonical_take(&r, ",\"ownerId\":") || !uuid(&r, record.owner_id) || !general_canonical_take(&r, ",\"parentIdentity\":") ||
      !file_parse(&r, &record.parent) || !general_canonical_take(&r, ",\"profileId\":")) return false;
  if (record.kind == GENERAL_RESOURCE_PROFILES_ROOT) { if (!general_canonical_take(&r, "null")) return false; }
  else if (!uuid(&r, record.profile_id)) return false;
  if (!general_canonical_take(&r, ",\"recordDigest\":") || !hash(&r, record.record_digest) || !general_canonical_take(&r, ",\"stage\":") ||
      !general_canonical_string(&r, stage, sizeof(stage)) || !general_canonical_take(&r, ",\"uid\":") || !general_canonical_integer(&r, &uid) || uid >= UINT32_MAX ||
      !general_canonical_take(&r, ",\"version\":1}") || r.position != r.size) return false;
  for (general_resource_stage s = GENERAL_RESOURCE_ADMITTED; s <= GENERAL_RESOURCE_UNCERTAIN; s++) if (!strcmp(stage, stages[s])) record.stage = s;
  record.uid = (uint32_t)uid; if (!general_resource_record_valid(&record)) return false;
  *out = record; return true;
}
bool general_resource_record_transition_valid(const general_resource_record *a, const general_resource_record *b) {
  if (!general_resource_record_valid(a) || !general_resource_record_valid(b) || a->uid != b->uid || a->kind != b->kind || a->origin != b->origin ||
      strcmp(a->owner_id, b->owner_id) || strcmp(a->installation_id, b->installation_id) || strcmp(a->enrollment_id, b->enrollment_id) || strcmp(a->profile_id, b->profile_id) ||
      strcmp(a->creation_id, b->creation_id) || strcmp(a->origin_id, b->origin_id) || strcmp(a->origin_digest, b->origin_digest) || !same_file(a->parent, b->parent)) return false;
  if (a->stage == b->stage) {
    char first[ENCODED_CAPACITY], second[ENCODED_CAPACITY]; int first_size = encode(a, true, first), second_size = encode(b, true, second);
    return first_size > 0 && first_size == second_size && !memcmp(first, second, (size_t)first_size);
  }
  return (a->stage == GENERAL_RESOURCE_ADMITTED && b->stage == GENERAL_RESOURCE_WRITE_STARTED) ||
    (a->stage == GENERAL_RESOURCE_WRITE_STARTED && (b->stage == GENERAL_RESOURCE_CREATED || b->stage == GENERAL_RESOURCE_UNCERTAIN));
}
bool general_resource_reference(general_resource_kind kind, const char *profile, char *out, size_t capacity) {
  if (!out || !profile_valid(kind, profile)) return false;
  char text[GENERAL_SESSION_REFERENCE_MAX + 1]; int count = kind == GENERAL_RESOURCE_PROFILES_ROOT ? snprintf(text, sizeof(text), "native-resource:profiles-root") :
    snprintf(text, sizeof(text), "native-resource:%s:%s", profile, general_resource_kind_name(kind));
  if (count < 1 || count >= (int)sizeof(text) || (size_t)count >= capacity) return false;
  memcpy(out, text, (size_t)count + 1); return true;
}
bool general_resource_account(const char *enrollment, general_resource_kind kind, const char *profile, char *out, size_t capacity) {
  if (!out || !general_session_uuid_valid(enrollment) || !profile_valid(kind, profile)) return false;
  char text[192]; int count = kind == GENERAL_RESOURCE_PROFILES_ROOT ? snprintf(text, sizeof(text), "e:%s:native-resource:profiles-root", enrollment) :
    snprintf(text, sizeof(text), "e:%s:p:%s:native-resource:%s", enrollment, profile, general_resource_kind_name(kind));
  if (count < 1 || count >= (int)sizeof(text) || (size_t)count >= capacity) return false;
  memcpy(out, text, (size_t)count + 1); return true;
}
bool general_resource_identity_from_stat(const struct stat *entry, general_resource_file_identity *out) {
  _Static_assert(sizeof(dev_t) == 4 && sizeof(ino_t) == 8, "Pinned Darwin identity widths");
  if (!entry || !out) return false;
  *out = (general_resource_file_identity){ .device = (uint32_t)entry->st_dev, .inode = (uint64_t)entry->st_ino }; return true;
}
