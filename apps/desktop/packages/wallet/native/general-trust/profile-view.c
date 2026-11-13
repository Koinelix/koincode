#include "profile-view.h"
#include "native-anchor.h"
#include "native-journal-read.h"
#include "native-record.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct general_profile_view {
  general_broker_namespace *space; general_native_directory *directory; general_native_journal_connection *journal;
  general_native_identity identity; general_assignment assignment; general_session_installation installation;
  general_native_scope_resolver history;
  bool (*current)(void *); void *context;
  bool running, poisoned, journal_loan;
};
typedef struct { general_profile_view *owner; struct timespec start, last; } operation;
static bool same_identity(const general_native_identity *a, const general_native_identity *b) {
  return a->uid == b->uid && !strcmp(a->owner_id, b->owner_id) && !strcmp(a->installation_id, b->installation_id) &&
    !strcmp(a->enrollment_id, b->enrollment_id) && !strcmp(a->initialization_id, b->initialization_id) && !strcmp(a->initialization_digest, b->initialization_digest);
}
static general_native_identity identity_of(const general_assignment *assignment) {
  general_native_identity result = { .uid = assignment->uid };
  strcpy(result.owner_id, assignment->owner_id); strcpy(result.installation_id, assignment->installation_id); strcpy(result.enrollment_id, assignment->enrollment_id);
  strcpy(result.initialization_id, assignment->initialization_id); strcpy(result.initialization_digest, assignment->initialization_digest); return result;
}
static bool installation_same(const general_session_installation *a, const general_session_installation *b) {
  return a->revision == b->revision && !strcmp(a->installation_id, b->installation_id) && !strcmp(a->team_id, b->team_id) &&
    !strcmp(a->keychain_access_group, b->keychain_access_group) && !memcmp(a->host_hash, b->host_hash, 20) && !memcmp(a->broker_hash, b->broker_hash, 20);
}
bool general_profile_view_current(general_profile_view *owner) {
  if (!owner || owner->poisoned || !owner->current(owner->context) || !general_native_directory_matches(owner->directory, &owner->identity) ||
      !general_native_journal_connection_current(owner->journal)) return false;
  general_registration_view registration; general_console_identity console; general_session_installation installation;
  if (!general_broker_namespace_info(owner->space, &console, &installation) || !installation_same(&installation, &owner->installation) ||
      console.uid != owner->identity.uid || !general_broker_namespace_inspect(owner->space, &registration) || !registration.registration_present ||
      !registration.assignment_present || registration.registration.phase != GENERAL_REGISTRATION_ASSIGNED) return false;
  general_native_identity assignment = identity_of(&registration.assignment);
  return same_identity(&assignment, &owner->identity) && same_identity(&registration.registration.identity, &owner->identity) && owner->current(owner->context);
}
bool general_profile_view_uses_journal(general_profile_view *owner, general_native_journal_connection *journal) {
  return owner && journal && owner->journal == journal && general_profile_view_current(owner);
}
static bool history_profile(const general_native_event *event, void *context, char out[37]) {
  general_profile_view *owner = context;
  /* This initial-new historical mapping is immutable Root assignment identity,
   * not cached admission. The original journal reader independently checks its
   * actual lifetime before every row and seals the entire prefix afterward. */
  if (!owner || owner->poisoned || !event || !out || !general_native_reference_profile_scoped(event->reference)) return false;
  general_resource_kind kind; char profile[37];
  if (general_canonical_resource_reference(event->reference, &kind, profile) && strcmp(profile, owner->identity.initialization_id)) return false;
  strcpy(out, owner->identity.initialization_id); return true;
}
static bool active(void *context) {
  operation *op = context; struct timespec now;
  if (!general_profile_view_current(op->owner) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now;
  return now.tv_sec - op->start.tv_sec < 30 || (now.tv_sec - op->start.tv_sec == 30 && now.tv_nsec < op->start.tv_nsec);
}
general_profile_view *general_profile_view_open(general_broker_namespace *space, general_native_directory *directory,
  general_native_journal_connection *journal, bool (*current)(void *), void *context) {
  if (!space || !directory || !journal || !current || !current(context)) return NULL;
  general_registration_view registration; general_console_identity console; general_session_installation installation;
  if (!general_broker_namespace_info(space, &console, &installation) || !general_broker_namespace_inspect(space, &registration) ||
      !registration.registration_present || !registration.assignment_present || registration.registration.phase != GENERAL_REGISTRATION_ASSIGNED) return NULL;
  general_native_identity identity = identity_of(&registration.assignment);
  if (!general_native_identity_valid(&identity) || !same_identity(&identity, &registration.registration.identity) || console.uid != identity.uid ||
      !general_native_directory_matches(directory, &identity) || !general_native_journal_connection_current(journal)) return NULL;
  general_profile_view *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  owner->space = space; owner->directory = directory; owner->journal = journal; owner->current = current; owner->context = context;
  owner->identity = identity; owner->assignment = registration.assignment; owner->installation = installation;
  owner->history = (general_native_scope_resolver){ .profile = history_profile, .context = owner };
  if (!general_profile_view_current(owner)) { free(owner); return NULL; } return owner;
}
bool general_profile_view_identity(general_profile_view *owner, general_native_identity *identity, general_session_installation *installation) {
  if (!identity || !installation || !general_profile_view_current(owner)) return false;
  *identity = owner->identity; *installation = owner->installation; return true;
}
bool general_profile_view_history(general_profile_view *owner, general_native_scope_resolver *out) {
  if (!out || !general_profile_view_current(owner)) return false;
  *out = owner->history; return true;
}
bool general_profile_view_snapshot(general_profile_view *owner, general_profile_snapshot *out, general_native_replay **output) {
  if (!owner || !out || !output || *output || owner->running || owner->poisoned || !general_profile_view_current(owner)) return false;
  owner->running = true; operation op = { .owner = owner }; general_profile_snapshot parsed = {0}; general_native_replay *replay = NULL;
  general_native_record_bytes bytes = {0}; bool valid = false;
  if (clock_gettime(CLOCK_MONOTONIC, &op.start)) goto done;
  op.last = op.start;
  if (!general_native_journal_connection_borrow(owner->journal)) goto done;
  owner->journal_loan = true;
  if (!active(&op) || general_native_anchor_read(&owner->identity, &owner->installation, active, &op, &parsed.head) != GENERAL_NATIVE_ANCHOR_FOUND ||
      !active(&op) || !(replay = general_native_journal_inspect(owner->journal, &parsed.head, &owner->history, active, &op)) ||
      !general_native_replay_matched_head(replay, &parsed.head) || !general_native_head_same_identity(&parsed.head, &owner->identity) ||
      general_native_record_read(&owner->identity, &owner->installation, replay, NULL, "general-initialization-v1", active, &op, &bytes) != GENERAL_NATIVE_RECORD_FOUND ||
      !general_initialization_record_parse(bytes.bytes, bytes.size, &parsed.initialization) || !same_identity(&parsed.initialization.identity, &owner->identity) ||
      parsed.initialization.kind != GENERAL_INITIALIZATION_NEW) goto done;
  general_initialization_plan plan = { .identity = owner->identity, .kind = GENERAL_INITIALIZATION_NEW };
  strcpy(plan.target_state_commitment, parsed.initialization.target_state_commitment); strcpy(plan.initial_signing_domain_id, parsed.initialization.initial_signing_domain_id);
  if (!general_initialization_binding_valid(&parsed.initialization, &plan)) goto done;
  general_native_record_bytes_destroy(&bytes);
  general_native_record_status found = general_native_record_read(&owner->identity, &owner->installation, replay, NULL, "general-domain-binding-v1", active, &op, &bytes);
  if (found == GENERAL_NATIVE_RECORD_FOUND) {
    if (!general_domain_binding_parse(bytes.bytes, bytes.size, &parsed.binding) || !general_domain_binding_new_valid(&parsed.binding, &owner->assignment, &parsed.initialization) ||
        strcmp(parsed.binding.profile_id, owner->identity.initialization_id)) goto done;
    parsed.has_binding = true;
  } else if (found != GENERAL_NATIVE_RECORD_UNREGISTERED || parsed.initialization.phase == GENERAL_INITIALIZATION_READY) goto done;
  valid = active(&op);
done:
  general_native_record_bytes_destroy(&bytes);
  if (owner->journal_loan) {
    if (!general_native_journal_connection_return(owner->journal)) { owner->poisoned = true; valid = false; }
    else owner->journal_loan = false;
  }
  owner->running = false;
  if (valid && general_profile_view_current(owner)) { *out = parsed; *output = replay; return true; }
  general_native_replay_destroy(&replay); return false;
}
bool general_profile_view_close(general_profile_view **pointer) {
  if (!pointer || !*pointer) return true;
  general_profile_view *owner = *pointer;
  if (owner->running || owner->poisoned || owner->journal_loan) return false;
  memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; return true;
}
