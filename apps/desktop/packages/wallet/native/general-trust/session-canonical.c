#include "session-canonical.h"
#include <string.h>

bool general_canonical_take(general_canonical_reader *r, const char *value) {
  if (!r || !r->bytes || r->position > r->size || !value) return false;
  size_t length = strlen(value);
  if (length > r->size - r->position || memcmp(r->bytes + r->position, value, length) != 0) return false;
  r->position += length; return true;
}
static bool emit(char *out, size_t capacity, size_t *used, const unsigned char *bytes, size_t length) {
  if (!capacity || *used >= capacity || length > capacity - 1 - *used) return false;
  if (out) memcpy(out + *used, bytes, length);
  *used += length; return true;
}
static int hexadecimal(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0';
  return c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
/* Exact JSON.stringify string spelling for the valid fixed-schema metadata values. */
bool general_canonical_string(general_canonical_reader *r, char *out, size_t capacity) {
  if (!capacity || !general_canonical_take(r, "\"")) return false;
  size_t used = 0;
  while (r->position < r->size) {
    unsigned char first = r->bytes[r->position++];
    if (first == '"') { if (out) out[used] = 0; return true; }
    if (first < 0x20) return false;
    if (first == '\\') {
      if (r->position == r->size) return false;
      unsigned char escaped = r->bytes[r->position++], decoded;
      switch (escaped) {
        case '"': decoded = '"'; break; case '\\': decoded = '\\'; break;
        case 'b': decoded = 8; break; case 't': decoded = 9; break; case 'n': decoded = 10; break;
        case 'f': decoded = 12; break; case 'r': decoded = 13; break;
        case 'u': {
          if (r->size - r->position < 4 || r->bytes[r->position] != '0' || r->bytes[r->position + 1] != '0') return false;
          int high = hexadecimal(r->bytes[r->position + 2]), low = hexadecimal(r->bytes[r->position + 3]);
          if (high < 0 || low < 0) return false;
          decoded = (unsigned char)(high * 16 + low); r->position += 4;
          if (!decoded || decoded > 0x1f || decoded == 8 || decoded == 9 || decoded == 10 || decoded == 12 || decoded == 13) return false;
          break;
        }
        default: return false;
      }
      if (!emit(out, capacity, &used, &decoded, 1)) return false;
    } else if (first < 0x80) {
      if (!emit(out, capacity, &used, &first, 1)) return false;
    } else {
      size_t start = r->position - 1; unsigned tail; uint32_t point, minimum;
      if (first >= 0xc2 && first <= 0xdf) { tail = 1; point = first & 0x1f; minimum = 0x80; }
      else if (first >= 0xe0 && first <= 0xef) { tail = 2; point = first & 0x0f; minimum = 0x800; }
      else if (first >= 0xf0 && first <= 0xf4) { tail = 3; point = first & 0x07; minimum = 0x10000; }
      else return false;
      if (tail > r->size - r->position) return false;
      for (unsigned i = 0; i < tail; i++) {
        unsigned char next = r->bytes[r->position++]; if ((next & 0xc0) != 0x80) return false;
        point = (point << 6) | (next & 0x3f);
      }
      if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ||
          !emit(out, capacity, &used, r->bytes + start, tail + 1)) return false;
    }
  }
  return false;
}
bool general_canonical_integer(general_canonical_reader *r, uint64_t *out) {
  if (!r || !r->bytes || !out || r->position >= r->size || r->bytes[r->position] < '0' || r->bytes[r->position] > '9') return false;
  uint64_t value = 0; size_t start = r->position;
  while (r->position < r->size && r->bytes[r->position] >= '0' && r->bytes[r->position] <= '9') {
    unsigned digit = r->bytes[r->position++] - '0';
    if ((r->position - start > 1 && r->bytes[start] == '0') || value > (GENERAL_SESSION_SAFE_INTEGER_MAX - digit) / 10) return false;
    value = value * 10 + digit;
  }
  *out = value; return true;
}
bool general_session_uuid_valid(const char *value) {
  if (!value || strnlen(value, 37) != 36) return false;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
    else if (hexadecimal((unsigned char)value[i]) < 0) return false;
  }
  return true;
}
bool general_canonical_hash_valid(const char *value) {
  if (!value || strnlen(value, 65) != 64) return false;
  for (size_t i = 0; i < 64; i++) if (hexadecimal((unsigned char)value[i]) < 0) return false;
  return true;
}
bool general_canonical_reference_valid(const char *value) {
  if (!value || strnlen(value, GENERAL_SESSION_REFERENCE_MAX + 1) > GENERAL_SESSION_REFERENCE_MAX) return false;
  const char *const fixed[] = { "general-initialization-v1", "general-domain-binding-v1", "general-state-v1", "general-signing-registry-v1" };
  for (size_t i = 0; i < sizeof(fixed) / sizeof(*fixed); i++) if (!strcmp(value, fixed[i])) return true;
  const char *const ids[] = { "source-key:", "general-intent:", "general-signed:", "general-broadcast:", "general-restore-plan:", "general-restore-binding:" };
  for (size_t i = 0; i < sizeof(ids) / sizeof(*ids); i++) {
    size_t length = strlen(ids[i]); if (!strncmp(value, ids[i], length)) return general_session_uuid_valid(value + length);
  }
  const char *prefix = "general-domain-binding:"; size_t length = strlen(prefix);
  return !strncmp(value, prefix, length) && general_canonical_hash_valid(value + length);
}

const char *general_resource_kind_name(general_resource_kind kind) {
  static const char *names[] = { NULL, "profiles_root", "profile_directory", "history_directory", "state_repository", "signing_repository" };
  return kind >= GENERAL_RESOURCE_PROFILES_ROOT && kind <= GENERAL_RESOURCE_SIGNING_REPOSITORY ? names[kind] : NULL;
}
general_resource_kind general_resource_kind_parse(const char *name) {
  for (general_resource_kind kind = GENERAL_RESOURCE_PROFILES_ROOT; kind <= GENERAL_RESOURCE_SIGNING_REPOSITORY; kind++)
    if (name && !strcmp(name, general_resource_kind_name(kind))) return kind;
  return GENERAL_RESOURCE_KIND_NONE;
}
bool general_canonical_resource_reference(const char *value, general_resource_kind *kind, char profile[37]) {
  if (!value || !kind || !profile || strnlen(value, GENERAL_SESSION_REFERENCE_MAX + 1) > GENERAL_SESSION_REFERENCE_MAX) return false;
  general_resource_kind parsed; char bound[37] = {0}; const char *prefix = "native-resource:"; size_t length = strlen(prefix);
  if (!strcmp(value, "native-resource:profiles-root")) parsed = GENERAL_RESOURCE_PROFILES_ROOT;
  else {
    if (strncmp(value, prefix, length) || strlen(value) <= length + 37 || value[length + 36] != ':') return false;
    memcpy(bound, value + length, 36);
    parsed = general_resource_kind_parse(value + length + 37);
    if (!general_session_uuid_valid(bound) || parsed <= GENERAL_RESOURCE_PROFILES_ROOT) return false;
  }
  *kind = parsed; memcpy(profile, bound, sizeof(bound)); return true;
}
bool general_canonical_native_reference_valid(const char *value) {
  general_resource_kind kind; char profile[37];
  return general_canonical_reference_valid(value) || general_canonical_resource_reference(value, &kind, profile);
}
