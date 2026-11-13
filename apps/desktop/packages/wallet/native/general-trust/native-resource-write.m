#include "native-resource-write.h"
#include "native-resource-keychain-private.h"
#include "native-journal-append.h"
#include <stdlib.h>
#include <time.h>
#include <uuid/uuid.h>

struct general_native_resource_writer {
  general_native_journal_connection *journal;
  general_native_identity identity;
  general_session_installation installation;
  general_native_scope_resolver resolver;
  bool (*current)(void *);
  void *context;
  struct timespec start, last;
  bool attempted, running, timed;
  general_resource_write_status result;
};
static bool active(void *context) {
  general_native_resource_writer *owner = context;
  if (!owner->current(owner->context) || !general_native_journal_connection_current(owner->journal)) return false;
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000) return false;
  if (!owner->timed) { owner->start = now; owner->last = now; owner->timed = true; }
  if (now.tv_sec < owner->last.tv_sec || (now.tv_sec == owner->last.tv_sec && now.tv_nsec < owner->last.tv_nsec)) return false;
  owner->last = now;
  return now.tv_sec - owner->start.tv_sec < 30 || (now.tv_sec - owner->start.tv_sec == 30 && now.tv_nsec < owner->start.tv_nsec);
}
general_native_resource_writer *general_native_resource_writer_create(general_native_journal_connection *journal,
    const general_native_identity *identity, const general_session_installation *installation,
    const general_native_scope_resolver *resolver, bool (*current)(void *), void *context) {
  if (!journal || !current || !installation_valid(identity, installation)) return NULL;
  general_native_resource_writer *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  owner->journal = journal; owner->identity = *identity; owner->installation = *installation;
  owner->current = current; owner->context = context; if (resolver) owner->resolver = *resolver;
  if (!general_native_journal_connection_borrow(journal)) { free(owner); return NULL; }
  return owner;
}
static bool same_record(const general_resource_record *a, const general_resource_record *b) {
  unsigned char first[GENERAL_RESOURCE_RECORD_MAX], second[GENERAL_RESOURCE_RECORD_MAX]; size_t x, y;
  return general_resource_record_encode(a, first, sizeof(first), &x) && general_resource_record_encode(b, second, sizeof(second), &y) &&
    x == y && !memcmp(first, second, x);
}
static bool belongs(const general_native_resource_writer *owner, const general_resource_record *record) {
  const general_native_identity *id = &owner->identity;
  return record->uid == id->uid && !strcmp(record->owner_id, id->owner_id) &&
    !strcmp(record->installation_id, id->installation_id) && !strcmp(record->enrollment_id, id->enrollment_id);
}
static bool append(general_native_resource_writer *owner, general_native_head *head, general_native_event *event, general_native_stage stage) {
  event->stage = stage; event->sequence = head->sequence + 1; strcpy(event->previous_digest, head->head_digest);
  /* Even a rejected later append cannot undo an earlier admitted target. */
  general_native_append_status status = general_native_journal_append(general_native_journal_connection_database(owner->journal), head,
    event, &owner->installation, &owner->resolver, active, owner);
  if (status != GENERAL_NATIVE_APPEND_REJECTED) owner->result = GENERAL_RESOURCE_WRITE_UNCERTAIN;
  if (status != GENERAL_NATIVE_APPEND_ANCHORED) return false;
  head->sequence = event->sequence; return general_native_event_digest(event, head->head_digest) && active(owner);
}
static bool missing(general_native_resource_writer *owner, const char *account) {
  LAContext *auth = [LAContext new]; auth.interactionNotAllowed = YES;
  CFMutableDictionaryRef match = auth ? query(account, &owner->installation, auth) : NULL;
  CFTypeRef result = NULL; OSStatus status = match && active(owner) ? SecItemCopyMatching(match, &result) : errSecNotAvailable;
  bool absent = status == errSecItemNotFound && !result;
  if (result) CFRelease(result); if (match) CFRelease(match); [auth invalidate];
  return absent && active(owner);
}
static bool mutate(general_native_resource_writer *owner, const char *account, const unsigned char *bytes, size_t size, bool exists, const char *digest) {
  LAContext *auth = [LAContext new]; auth.interactionNotAllowed = YES;
  CFMutableDictionaryRef match = auth ? query(account, &owner->installation, auth) : NULL;
  CFDataRef value = CFDataCreate(NULL, bytes, (CFIndex)size);
  CFMutableDictionaryRef target = match ? CFDictionaryCreateMutableCopy(NULL, 0, match) : NULL;
  CFDictionaryRef changes = value ? CFDictionaryCreate(NULL, (const void *[]){ kSecValueData }, (const void *[]){ value }, 1,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  bool ok = false;
  if (target && changes && active(owner)) {
    CFDictionaryRemoveValue(target, kSecReturnAttributes); CFDictionaryRemoveValue(target, kSecReturnData); CFDictionaryRemoveValue(target, kSecMatchLimit);
    OSStatus status;
    if (exists) status = SecItemUpdate(target, changes);
    else { CFDictionarySetValue(target, kSecValueData, value); status = SecItemAdd(target, NULL); }
    if (status == errSecSuccess && active(owner)) {
      CFTypeRef result = NULL;
      status = SecItemCopyMatching(match, &result);
      CFDataRef actual = status == errSecSuccess && active(owner) ? body(result, match, digest) : NULL;
      ok = actual && CFDataGetLength(actual) == (CFIndex)size && !memcmp(CFDataGetBytePtr(actual), bytes, size);
      if (result) CFRelease(result);
    }
  }
  if (changes) CFRelease(changes); if (target) CFRelease(target); if (value) CFRelease(value); if (match) CFRelease(match); [auth invalidate];
  return ok && active(owner);
}
general_resource_write_status general_native_resource_writer_write(general_native_resource_writer *owner, const general_resource_record *next) {
  @autoreleasepool {
    if (!owner || owner->attempted || owner->running) return GENERAL_RESOURCE_WRITE_REJECTED;
    owner->attempted = true; owner->running = true;
    general_resource_record record = {0}, previous = {0}; general_native_replay *replay = NULL;
    general_native_head head; general_native_event event = {0}; char account[192];
    unsigned char bytes[GENERAL_RESOURCE_RECORD_MAX]; size_t size; bool exists = false;
    if (!general_resource_record_valid(next)) goto finished;
    record = *next;
    const char *profile = record.kind == GENERAL_RESOURCE_PROFILES_ROOT ? NULL : record.profile_id;
    if (!belongs(owner, &record) || !general_resource_reference(record.kind, profile, event.reference, sizeof(event.reference)) ||
        !general_resource_account(owner->identity.enrollment_id, record.kind, profile, account, sizeof(account)) ||
        !general_resource_record_encode(&record, bytes, sizeof(bytes), &size) || !active(owner) ||
        general_native_anchor_read(&owner->identity, &owner->installation, active, owner, &head) != GENERAL_NATIVE_ANCHOR_FOUND || !active(owner)) goto finished;
    replay = general_native_journal_inspect(owner->journal, &head, &owner->resolver, active, owner);
    if (!replay || !general_native_replay_matched_head(replay, &head) || !active(owner)) goto finished;
    general_native_record_status status = general_native_resource_read(&owner->identity, &owner->installation, replay, record.kind, profile, active, owner, &previous);
    if (status == GENERAL_NATIVE_RECORD_FOUND) {
      exists = true;
      if (!general_resource_record_transition_valid(&previous, &record) || !active(owner)) goto finished;
      if (same_record(&previous, &record)) { owner->result = GENERAL_RESOURCE_WRITE_IDENTICAL; goto finished; }
      general_native_ref_state state;
      if (general_native_replay_lookup(replay, profile, event.reference, &state) != GENERAL_NATIVE_REF_REGISTERED) goto finished;
      event.has_expected = true; strcpy(event.expected_digest, state.event.next_digest);
    } else if (status != GENERAL_NATIVE_RECORD_UNREGISTERED || record.stage != GENERAL_RESOURCE_ADMITTED || !missing(owner, account)) goto finished;
    general_native_replay_destroy(&replay);
    if (head.sequence > GENERAL_NATIVE_EVENT_LIMIT - 3) goto finished;
    uuid_t uuid; uuid_generate_random(uuid); uuid_unparse_lower(uuid, event.operation_id);
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; static const char hex[] = "0123456789abcdef";
    if (!CC_SHA256(bytes, (CC_LONG)size, digest)) goto finished;
    for (unsigned i = 0; i < sizeof(digest); i++) { event.next_digest[i * 2] = hex[digest[i] >> 4]; event.next_digest[i * 2 + 1] = hex[digest[i] & 15]; }
    strcpy(event.operation_digest, event.next_digest);
    if (!active(owner) || !append(owner, &head, &event, GENERAL_NATIVE_ADMITTED) || !append(owner, &head, &event, GENERAL_NATIVE_WRITE_STARTED) ||
        !mutate(owner, account, bytes, size, exists, event.next_digest) || !append(owner, &head, &event, GENERAL_NATIVE_COMMITTED)) goto finished;
    owner->result = GENERAL_RESOURCE_WRITE_COMMITTED;
finished:
    general_native_replay_destroy(&replay); owner->running = false; return owner->result;
  }
}
bool general_native_resource_writer_close(general_native_resource_writer **address) {
  if (!address || !*address) return true;
  general_native_resource_writer *owner = *address;
  if (owner->running || owner->result == GENERAL_RESOURCE_WRITE_UNCERTAIN || !general_native_journal_connection_return(owner->journal)) return false;
  volatile unsigned char *bytes = (volatile unsigned char *)owner;
  for (size_t i = 0; i < sizeof(*owner); i++) bytes[i] = 0;
  free(owner); *address = NULL; return true;
}
