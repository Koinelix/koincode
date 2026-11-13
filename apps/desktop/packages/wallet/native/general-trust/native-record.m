#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include "native-record.h"
#include "native-store-private.h"
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct { bool (*current)(void *); void *context; struct timespec started, last; } read_operation;
static bool active(read_operation *op) {
  struct timespec now;
  if (!op->current(op->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now;
  return now.tv_sec - op->started.tv_sec < 30 || (now.tv_sec - op->started.tv_sec == 30 && now.tv_nsec < op->started.tv_nsec);
}
static bool metadata_reference(const char *reference) {
  if (!general_canonical_reference_valid(reference)) return false;
  const char *const fixed[] = { "general-initialization-v1", "general-domain-binding-v1", "general-state-v1", "general-signing-registry-v1" };
  for (size_t i = 0; i < sizeof(fixed) / sizeof(fixed[0]); i++) if (!strcmp(reference, fixed[i])) return true;
  const char *const prefixes[] = { "general-intent:", "general-broadcast:", "general-restore-plan:", "general-restore-binding:", "general-domain-binding:" };
  for (size_t i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) if (!strncmp(reference, prefixes[i], strlen(prefixes[i]))) return true;
  return false;
}
void general_native_record_bytes_destroy(general_native_record_bytes *owned) {
  if (!owned) return;
  if (owned->bytes) { volatile unsigned char *bytes = owned->bytes; for (size_t i = 0; i < owned->size; i++) bytes[i] = 0; free(owned->bytes); }
  owned->bytes = NULL; owned->size = 0;
}
general_native_record_status general_native_record_read(const general_native_identity *identity,
    const general_session_installation *installation, const general_native_replay *replay, const char *profile_id, const char *reference,
    bool (*current)(void *), void *context, general_native_record_bytes *out) {
  @autoreleasepool {
    general_native_head anchor; general_native_ref_state state;
    if (!current || !out || out->bytes || out->size || !general_store_installation_valid(identity, installation) || !metadata_reference(reference) ||
        !general_native_replay_matched_head(replay, &anchor) || !general_native_head_same_identity(&anchor, identity)) return GENERAL_NATIVE_RECORD_INVALID;
    /* Copy validated binding inputs before any lifetime callback or OS call. */
    const general_native_identity bound = *identity; const general_session_installation receipt = *installation;
    char logical[GENERAL_SESSION_REFERENCE_MAX + 1], profile[37]; strcpy(logical, reference);
    if (profile_id) { if (!general_session_uuid_valid(profile_id)) return GENERAL_NATIVE_RECORD_INVALID; strcpy(profile, profile_id); }
    general_native_ref_presence presence = general_native_replay_lookup(replay, profile_id ? profile : NULL, logical, &state);
    if (presence == GENERAL_NATIVE_REF_ERROR) return GENERAL_NATIVE_RECORD_INVALID;
    read_operation op = { .current = current, .context = context };
    if (clock_gettime(CLOCK_MONOTONIC, &op.started) || op.started.tv_sec < 0 || op.started.tv_nsec < 0 || op.started.tv_nsec >= 1000000000) return GENERAL_NATIVE_RECORD_UNAVAILABLE;
    op.last = op.started; if (!active(&op)) return GENERAL_NATIVE_RECORD_UNAVAILABLE;
    if (presence == GENERAL_NATIVE_REF_UNREGISTERED) return GENERAL_NATIVE_RECORD_UNREGISTERED;
    if (state.event.stage != GENERAL_NATIVE_COMMITTED) return GENERAL_NATIVE_RECORD_UNSETTLED;
    LAContext *auth = [LAContext new]; auth.interactionNotAllowed = YES;
    CFMutableDictionaryRef match = auth ? general_store_query(&bound, &receipt, profile_id ? profile : NULL, logical, auth) : NULL;
    if (!match) { [auth invalidate]; return GENERAL_NATIVE_RECORD_UNAVAILABLE; }
    CFTypeRef result = NULL; general_native_record_bytes owned = {0};
    OSStatus status = active(&op) ? SecItemCopyMatching(match, &result) : errSecInteractionNotAllowed;
    [auth invalidate]; general_native_record_status outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE;
    if (active(&op)) {
      if (status == errSecItemNotFound) outcome = GENERAL_NATIVE_RECORD_CONFLICT;
      else if (status == errSecSuccess) {
        CFDataRef data = general_store_body(result, match, state.event.next_digest);
        outcome = GENERAL_NATIVE_RECORD_CONFLICT;
        if (data && active(&op)) {
          owned.size = (size_t)CFDataGetLength(data); owned.bytes = malloc(owned.size);
          if (owned.bytes) { memcpy(owned.bytes, CFDataGetBytePtr(data), owned.size); outcome = GENERAL_NATIVE_RECORD_FOUND; }
          else { owned.size = 0; outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE; }
        }
      }
    }
    if (result) CFRelease(result); CFRelease(match);
    if (!active(&op)) outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE;
    if (outcome == GENERAL_NATIVE_RECORD_FOUND) { *out = owned; return outcome; }
    general_native_record_bytes_destroy(&owned); return outcome;
  }
}
