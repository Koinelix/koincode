#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include "native-resource-keychain-private.h"
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct { bool (*current)(void *); void *context; struct timespec start, last; } resource_read;
static bool active(resource_read *operation) {
  struct timespec now;
  if (!operation->current(operation->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < operation->last.tv_sec || (now.tv_sec == operation->last.tv_sec && now.tv_nsec < operation->last.tv_nsec)) return false;
  operation->last = now;
  return now.tv_sec - operation->start.tv_sec < 30 || (now.tv_sec - operation->start.tv_sec == 30 && now.tv_nsec < operation->start.tv_nsec);
}
general_native_record_status general_native_resource_read(const general_native_identity *identity,
    const general_session_installation *installation, const general_native_replay *replay, general_resource_kind kind, const char *profile,
    bool (*current)(void *), void *context, general_resource_record *out) {
  @autoreleasepool {
    general_native_head anchor; general_native_ref_state state; char logical[GENERAL_SESSION_REFERENCE_MAX + 1], account[192], bound_profile[37] = {0};
    if (!out || !current || !installation_valid(identity, installation) || !general_resource_reference(kind, profile, logical, sizeof(logical)) ||
        !general_resource_account(identity->enrollment_id, kind, profile, account, sizeof(account)) ||
        !general_native_replay_matched_head(replay, &anchor) || !general_native_head_same_identity(&anchor, identity)) return GENERAL_NATIVE_RECORD_INVALID;
    const general_native_identity bound = *identity; const general_session_installation receipt = *installation;
    if (profile) strcpy(bound_profile, profile);
    general_native_ref_presence presence = general_native_replay_lookup(replay, profile ? bound_profile : NULL, logical, &state);
    if (presence == GENERAL_NATIVE_REF_ERROR) return GENERAL_NATIVE_RECORD_INVALID;
    resource_read operation = { .current = current, .context = context };
    if (clock_gettime(CLOCK_MONOTONIC, &operation.start) || operation.start.tv_sec < 0 || operation.start.tv_nsec < 0 || operation.start.tv_nsec >= 1000000000) return GENERAL_NATIVE_RECORD_UNAVAILABLE;
    operation.last = operation.start; if (!active(&operation)) return GENERAL_NATIVE_RECORD_UNAVAILABLE;
    if (presence == GENERAL_NATIVE_REF_UNREGISTERED) return GENERAL_NATIVE_RECORD_UNREGISTERED;
    if (state.event.stage != GENERAL_NATIVE_COMMITTED) return GENERAL_NATIVE_RECORD_UNSETTLED;
    LAContext *auth = [LAContext new]; auth.interactionNotAllowed = YES;
    CFMutableDictionaryRef match = auth ? query(account, &receipt, auth) : NULL;
    if (!match) { [auth invalidate]; return GENERAL_NATIVE_RECORD_UNAVAILABLE; }
    CFTypeRef result = NULL; general_resource_record record = {0}; general_native_record_status outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE;
    OSStatus status = active(&operation) ? SecItemCopyMatching(match, &result) : errSecInteractionNotAllowed;
    [auth invalidate];
    if (active(&operation)) {
      if (status == errSecItemNotFound && !result) outcome = GENERAL_NATIVE_RECORD_CONFLICT;
      else if (status == errSecSuccess) {
        CFDataRef bytes = body(result, match, state.event.next_digest); outcome = GENERAL_NATIVE_RECORD_CONFLICT;
        if (bytes && general_resource_record_parse(CFDataGetBytePtr(bytes), (size_t)CFDataGetLength(bytes), &record) &&
            record.uid == bound.uid && !strcmp(record.owner_id, bound.owner_id) && !strcmp(record.installation_id, bound.installation_id) &&
            !strcmp(record.enrollment_id, bound.enrollment_id) && record.kind == kind && !strcmp(record.profile_id, bound_profile)) outcome = GENERAL_NATIVE_RECORD_FOUND;
      }
    }
    if (result) CFRelease(result); CFRelease(match);
    if (!active(&operation)) outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE;
    if (outcome == GENERAL_NATIVE_RECORD_FOUND) *out = record;
    return outcome;
  }
}
