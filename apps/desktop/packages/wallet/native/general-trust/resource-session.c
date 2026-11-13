#include "resource-session.h"
#include "native-anchor.h"
#include "native-journal-read.h"
#include "host-launch.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include <sys/acl.h>
#include <time.h>
#include <unistd.h>
#include <uuid/uuid.h>

#define TICKET_LIMIT 16U
typedef struct {
  bool used, create, started, committed;
  char id[37], name[40];
  general_resource_record record;
  int parent, directory, database, lease;
} ticket;
struct general_resource_session {
  general_native_journal_connection *journal;
  general_native_identity identity;
  general_session_installation installation;
  general_native_scope_resolver history;
  general_resource_origin_resolver origin;
  general_channel_peer *host;
  bool (*current)(void *); void *context;
  struct timespec start, last;
  bool running, fenced, read_loan, reaped;
  general_native_resource_writer *writer;
  ticket tickets[TICKET_LIMIT];
};
static atomic_flag registry_guard = ATOMIC_FLAG_INIT;
static general_resource_session *registry[16];
static bool register_owner(general_resource_session *owner) {
  if (atomic_flag_test_and_set(&registry_guard)) return false;
  unsigned available = 16;
  for (unsigned i = 0; i < 16; i++) {
    if (!registry[i]) { if (available == 16) available = i; }
    else if (registry[i]->journal == owner->journal) { available = 16; break; }
  }
  if (available < 16) registry[available] = owner;
  atomic_flag_clear(&registry_guard); return available < 16;
}
static bool unregister_owner(general_resource_session *owner) {
  if (atomic_flag_test_and_set(&registry_guard)) return false;
  bool found = false;
  for (unsigned i = 0; i < 16; i++) if (registry[i] == owner) { registry[i] = NULL; found = true; break; }
  atomic_flag_clear(&registry_guard); return found;
}
static bool active(void *context) {
  general_resource_session *owner = context; struct timespec now;
  if (!owner->current(owner->context) || !general_native_journal_connection_current(owner->journal) ||
      clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < owner->last.tv_sec || (now.tv_sec == owner->last.tv_sec && now.tv_nsec < owner->last.tv_nsec)) return false;
  owner->last = now;
  return now.tv_sec - owner->start.tv_sec < 30 || (now.tv_sec - owner->start.tv_sec == 30 && now.tv_nsec < owner->start.tv_nsec);
}
static bool no_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); if (!acl) return errno == ENOENT;
  acl_entry_t entry; errno = 0; int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), error = errno;
  return acl_free(acl) == 0 && result == -1 && error == EINVAL;
}
static bool private_stat(const struct stat *entry, bool directory) {
  return entry->st_uid == geteuid() && (entry->st_mode & 07777) == (directory ? 0700 : 0600) &&
    (directory ? S_ISDIR(entry->st_mode) && entry->st_nlink >= 1 : S_ISREG(entry->st_mode) && entry->st_nlink == 1 && entry->st_size >= 0);
}
static bool identity(int fd, general_resource_file_identity *out) {
  struct stat actual; int flags;
  return fd >= 0 && !fstat(fd, &actual) && private_stat(&actual, true) && no_acl(fd) &&
    (flags = fcntl(fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) && general_resource_identity_from_stat(&actual, out);
}
static bool same(general_resource_file_identity a, general_resource_file_identity b) { return a.device == b.device && a.inode == b.inode; }
static const char *profile(const general_resource_record *record) { return record->kind == GENERAL_RESOURCE_PROFILES_ROOT ? NULL : record->profile_id; }
static bool repository(general_resource_kind kind) { return kind == GENERAL_RESOURCE_STATE_REPOSITORY || kind == GENERAL_RESOURCE_SIGNING_REPOSITORY; }
static const char *name(general_resource_kind kind, const char *scope) {
  switch (kind) {
    case GENERAL_RESOURCE_PROFILES_ROOT: return "profiles";
    case GENERAL_RESOURCE_PROFILE_DIRECTORY: return scope;
    case GENERAL_RESOURCE_HISTORY_DIRECTORY: return "history";
    case GENERAL_RESOURCE_STATE_REPOSITORY: return "state";
    case GENERAL_RESOURCE_SIGNING_REPOSITORY: return "signing";
    default: return NULL;
  }
}
static general_native_record_status read_record(general_resource_session *owner, general_resource_kind kind, const char *scope, general_resource_record *out) {
  if (owner->fenced || !active(owner) || !general_native_journal_connection_borrow(owner->journal)) return GENERAL_NATIVE_RECORD_UNAVAILABLE;
  owner->read_loan = true; general_native_head head; general_native_replay *replay = NULL;
  general_native_record_status result = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  if (general_native_anchor_read(&owner->identity, &owner->installation, active, owner, &head) == GENERAL_NATIVE_ANCHOR_FOUND && active(owner))
    replay = general_native_journal_inspect(owner->journal, &head, &owner->history, active, owner);
  if (replay && active(owner)) result = general_native_resource_read(&owner->identity, &owner->installation, replay, kind, scope, active, owner, out);
  general_native_replay_destroy(&replay);
  if (!general_native_journal_connection_return(owner->journal)) { owner->fenced = true; return GENERAL_NATIVE_RECORD_UNAVAILABLE; }
  owner->read_loan = false; return result;
}
static bool store(general_resource_session *owner, general_resource_record *record) {
  if (owner->fenced || owner->writer || !general_resource_record_digest(record, record->record_digest) || !active(owner)) return false;
  owner->writer = general_native_resource_writer_create(owner->journal, &owner->identity, &owner->installation, &owner->history, active, owner);
  if (!owner->writer) return false;
  general_resource_write_status result = general_native_resource_writer_write(owner->writer, record);
  if (!general_native_resource_writer_close(&owner->writer)) { owner->fenced = true; return false; }
  bool committed = result == GENERAL_RESOURCE_WRITE_COMMITTED || result == GENERAL_RESOURCE_WRITE_IDENTICAL;
  if (committed && !active(owner)) { owner->fenced = true; return false; }
  return committed;
}
static bool resolve(general_resource_session *owner, general_resource_kind kind, const char *scope, general_resource_origin_view *view) {
  if (!active(owner) || !owner->origin.resolve(kind, scope, view, owner->origin.context) || !active(owner) ||
      (view->origin != GENERAL_RESOURCE_INITIALIZATION && view->origin != GENERAL_RESOURCE_RESTORE) ||
      !general_session_uuid_valid(view->origin_id) || !general_canonical_hash_valid(view->origin_digest) ||
      (view->phase != GENERAL_RESOURCE_ORIGIN_PREPARING && view->phase != GENERAL_RESOURCE_ORIGIN_ACTIVE)) return false;
  general_resource_file_identity parent;
  if (!identity(view->parent, &parent)) return false;
  if (kind == GENERAL_RESOURCE_PROFILES_ROOT) return active(owner);
  general_resource_record registered;
  general_resource_kind parent_kind = kind == GENERAL_RESOURCE_PROFILE_DIRECTORY ? GENERAL_RESOURCE_PROFILES_ROOT : GENERAL_RESOURCE_PROFILE_DIRECTORY;
  return read_record(owner, parent_kind, parent_kind == GENERAL_RESOURCE_PROFILES_ROOT ? NULL : scope, &registered) == GENERAL_NATIVE_RECORD_FOUND &&
    registered.stage == GENERAL_RESOURCE_CREATED && same(parent, registered.directory) && active(owner);
}
static bool original(general_resource_session *owner, ticket *item) {
  general_resource_origin_view view = {0}; general_resource_file_identity parent;
  return resolve(owner, item->record.kind, profile(&item->record), &view) &&
    (!item->create || item->committed || view.phase == GENERAL_RESOURCE_ORIGIN_PREPARING) && identity(item->parent, &parent) && same(parent, item->record.parent) &&
    identity(view.parent, &parent) && same(parent, item->record.parent) &&
    ((item->record.kind == GENERAL_RESOURCE_PROFILES_ROOT && item->record.stage == GENERAL_RESOURCE_CREATED) ||
      (view.origin == item->record.origin && !strcmp(view.origin_id, item->record.origin_id) && !strcmp(view.origin_digest, item->record.origin_digest)));
}
static bool fixed_files(ticket *item) {
  struct stat actual; general_resource_file_identity held;
  if (!identity(item->directory, &held) || !same(held, item->record.directory) ||
      fstatat(item->parent, item->name, &actual, AT_SYMLINK_NOFOLLOW) || !private_stat(&actual, true) ||
      !general_resource_identity_from_stat(&actual, &held) || !same(held, item->record.directory)) return false;
  if (!repository(item->record.kind)) return true;
  const char *names[] = { item->record.kind == GENERAL_RESOURCE_STATE_REPOSITORY ? "general-wallet.sqlite" : "general-signing-journal.sqlite", "writer-lease.sqlite" };
  general_resource_file_identity expected[] = { item->record.database, item->record.writer_lease };
  for (unsigned i = 0; i < 2; i++) if (fstatat(item->directory, names[i], &actual, AT_SYMLINK_NOFOLLOW) || !private_stat(&actual, false) ||
      !general_resource_identity_from_stat(&actual, &held) || !same(held, expected[i])) return false;
  return true;
}
static bool close_ticket(ticket *item) {
  int *fds[] = { &item->database, &item->lease, &item->directory, &item->parent };
  for (unsigned i = 0; i < 4; i++) if (*fds[i] >= 0) { int fd = *fds[i]; *fds[i] = -1; if (close(fd)) return false; }
  memset(item, 0, sizeof(*item)); return true;
}
static ticket *lookup(general_resource_session *owner, const char *id) {
  if (!general_session_uuid_valid(id)) return NULL;
  for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used && !strcmp(owner->tickets[i].id, id)) return &owner->tickets[i];
  return NULL;
}
static bool prepare(general_resource_session *owner, const general_session_request *request, general_session_reply *reply, bool readonly) {
  general_resource_kind kind = request->body.resource.kind;
  const char *scope = request->body.resource.has_profile ? request->body.resource.profile_id : NULL;
  const char *fixed_name = name(kind, scope); char logical[GENERAL_SESSION_REFERENCE_MAX + 1];
  if (!fixed_name || !general_resource_reference(kind, scope, logical, sizeof(logical))) return false;
  general_resource_origin_view view = {0};
  if (!resolve(owner, kind, scope, &view) || request->body.resource.origin != (view.origin == GENERAL_RESOURCE_INITIALIZATION ? GENERAL_SESSION_ORIGIN_INITIALIZATION : GENERAL_SESSION_ORIGIN_RESTORE) ||
      !general_session_uuid_valid(request->body.resource.origin_id) || strcmp(request->body.resource.origin_id, view.origin_id) ||
      !general_canonical_hash_valid(request->body.resource.origin_digest) || strcmp(request->body.resource.origin_digest, view.origin_digest)) return false;
  if (readonly && view.phase != GENERAL_RESOURCE_ORIGIN_ACTIVE) return false;
  ticket *available = NULL;
  for (unsigned i = 0; i < TICKET_LIMIT; i++) {
    ticket *item = &owner->tickets[i];
    if (!item->used) { if (!available) available = item; continue; }
    if (item->started && !item->committed) { reply->code = GENERAL_REPLY_BUSY; return false; }
    if (item->record.kind == kind && !strcmp(item->record.profile_id, scope ? scope : "")) {
      if (!original(owner, item) || (readonly && item->create)) return false;
      reply->kind = GENERAL_REPLY_RESOURCE_PREPARED; strcpy(reply->ticket_id, item->id); strcpy(reply->creation_id, item->record.creation_id); reply->resource_create = item->create; return true;
    }
  }
  if (!available) { reply->code = GENERAL_REPLY_BUSY; return false; }
  ticket pending = { .parent = -1, .directory = -1, .database = -1, .lease = -1 }; general_resource_record *record = &pending.record;
  general_native_record_status found = read_record(owner, kind, scope, record); struct stat entry;
  bool absent = fstatat(view.parent, fixed_name, &entry, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT;
  general_resource_file_identity parent; if (!identity(view.parent, &parent)) return false;
  if (found == GENERAL_NATIVE_RECORD_UNREGISTERED) {
    if (readonly) return false;
    if (!absent || view.phase != GENERAL_RESOURCE_ORIGIN_PREPARING) return false;
    record->uid = owner->identity.uid; strcpy(record->owner_id, owner->identity.owner_id); strcpy(record->installation_id, owner->identity.installation_id);
    strcpy(record->enrollment_id, owner->identity.enrollment_id); if (scope) strcpy(record->profile_id, scope); record->kind = kind;
    record->origin = view.origin; strcpy(record->origin_id, view.origin_id); strcpy(record->origin_digest, view.origin_digest);
    uuid_t generated; uuid_generate_random(generated); uuid_unparse_lower(generated, record->creation_id); record->stage = GENERAL_RESOURCE_ADMITTED; record->parent = parent;
    if (!store(owner, record)) return false;
  } else if (found != GENERAL_NATIVE_RECORD_FOUND || !same(parent, record->parent) ||
      (record->stage != GENERAL_RESOURCE_ADMITTED && record->stage != GENERAL_RESOURCE_CREATED) ||
      (!(kind == GENERAL_RESOURCE_PROFILES_ROOT && record->stage == GENERAL_RESOURCE_CREATED) &&
        (record->origin != view.origin || strcmp(record->origin_id, view.origin_id) || strcmp(record->origin_digest, view.origin_digest)))) return false;
  pending.create = record->stage == GENERAL_RESOURCE_ADMITTED;
  if (readonly && pending.create) return false;
  if (pending.create && (!absent || view.phase != GENERAL_RESOURCE_ORIGIN_PREPARING)) return false;
  pending.parent = fcntl(view.parent, F_DUPFD_CLOEXEC, 3); if (pending.parent < 0) return false;
  strcpy(pending.name, fixed_name);
  if (!pending.create) {
    pending.directory = openat(pending.parent, pending.name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (!fixed_files(&pending)) goto failed;
  }
  if (!active(owner)) goto failed;
  uuid_t generated; uuid_generate_random(generated); uuid_unparse_lower(generated, pending.id); pending.used = true; *available = pending;
  reply->kind = GENERAL_REPLY_RESOURCE_PREPARED; strcpy(reply->ticket_id, pending.id); strcpy(reply->creation_id, record->creation_id); reply->resource_create = pending.create; return true;
failed:
  if (!close_ticket(&pending)) { owner->fenced = true; pending.used = true; *available = pending; }
  return false;
}
static bool commit(general_resource_session *owner, ticket *item, int database, int lease, general_session_reply *reply) {
  if (item->committed || (item->create && !item->started) || !original(owner, item) || (repository(item->record.kind) ? database < 0 || lease < 0 : database >= 0 || lease >= 0)) return false;
  if (item->directory < 0) item->directory = openat(item->parent, item->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  general_resource_record next = item->record;
  if (!identity(item->directory, &next.directory)) return false;
  struct stat named; general_resource_file_identity named_id;
  if (fstatat(item->parent, item->name, &named, AT_SYMLINK_NOFOLLOW) || !private_stat(&named, true) ||
      !general_resource_identity_from_stat(&named, &named_id) || !same(named_id, next.directory)) return false;
  if (repository(item->record.kind)) {
    general_resource_repository_identity files;
    if (!general_resource_repository_verify(item->directory, database, lease, item->record.kind, owner->host, active, owner, &files)) return false;
    next.directory = files.directory; next.database = files.database; next.writer_lease = files.writer_lease;

  }
  next.has_identities = true; next.stage = GENERAL_RESOURCE_CREATED;
  if (!item->create && (!same(next.directory, item->record.directory) || !same(next.database, item->record.database) || !same(next.writer_lease, item->record.writer_lease))) return false;
  if (repository(item->record.kind)) {
    if (item->database < 0) item->database = fcntl(database, F_DUPFD_CLOEXEC, 3);
    if (item->lease < 0) item->lease = fcntl(lease, F_DUPFD_CLOEXEC, 3);
    if (item->database < 0 || item->lease < 0) { owner->fenced = true; return false; }
    struct stat db, lease_stat; general_resource_file_identity id;
    if (fstat(item->database, &db) || !general_resource_identity_from_stat(&db, &id) || !same(id, next.database) ||
        fstat(item->lease, &lease_stat) || !general_resource_identity_from_stat(&lease_stat, &id) || !same(id, next.writer_lease)) { owner->fenced = true; return false; }
  }
  if (item->create && !store(owner, &next)) return false;
  item->record = next; item->committed = true;
  if (!fixed_files(item) || !original(owner, item) || !active(owner)) { owner->fenced = true; return false; }
  reply->kind = GENERAL_REPLY_RESOURCE_CREATED; return true;
}
static bool release(general_resource_session *owner, ticket *item) {
  if (item->started && !item->committed) return false;
  for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used && &owner->tickets[i] != item && owner->tickets[i].parent >= 0 && item->directory >= 0) {
    general_resource_file_identity held;
    if (!identity(owner->tickets[i].parent, &held) || same(held, item->record.directory)) return false;
  }
  if (item->lease >= 0) {
    struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0x40000002, .l_len = 510 };
    if (fcntl(item->lease, F_GETLK, &lock) || lock.l_type != F_UNLCK) return false;
  }
  if (!close_ticket(item)) { owner->fenced = true; return false; }
  return true;
}
general_resource_session *general_resource_session_create(general_native_journal_connection *journal,
    const general_native_identity *identity_value, const general_session_installation *installation, const general_native_scope_resolver *history,
    const general_resource_origin_resolver *origin, general_channel_peer *host, bool (*current)(void *), void *context) {
  if (!journal || !general_native_identity_valid(identity_value) || identity_value->uid != geteuid() || !installation || !history || !history->profile ||
      !origin || !origin->resolve || !host || !current || !general_native_journal_connection_current(journal)) return NULL;
  general_resource_session *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  owner->journal = journal; owner->identity = *identity_value; owner->installation = *installation; owner->history = *history;
  owner->origin = *origin; owner->host = host; owner->current = current; owner->context = context;
  if (!register_owner(owner)) { free(owner); return NULL; }
  return owner;
}
static bool execute(general_resource_session *owner, const general_session_request *request, int database, int writer_lease, general_session_reply *out, bool readonly) {
  if (!owner || owner->running || owner->reaped || !out || !request || request->command != GENERAL_SESSION_RESOURCE) return false;
  const general_session_request original_request = *request;
  if (clock_gettime(CLOCK_MONOTONIC, &owner->start) || owner->start.tv_sec < 0 || owner->start.tv_nsec < 0 || owner->start.tv_nsec >= 1000000000) return false;
  owner->last = owner->start; owner->running = true;
  general_session_reply reply = { .status = GENERAL_REPLY_REJECTED, .code = GENERAL_REPLY_CONFLICT, .kind = GENERAL_REPLY_EMPTY }; bool ok = false;
  const general_session_request *r = &original_request;
  if (owner->fenced || !active(owner) || !general_channel_peer_role_current(owner->host, GENERAL_CHANNEL_BROKER_HOST) || !active(owner) ||
      ((database >= 0 || writer_lease >= 0) && r->body.resource.action != GENERAL_RESOURCE_COMMIT)) goto done;
  if (r->body.resource.action == GENERAL_RESOURCE_PREPARE) ok = prepare(owner, r, &reply, readonly);
  else if (r->body.resource.action == GENERAL_RESOURCE_INSPECT) {
    general_resource_record record;
    general_native_record_status found = read_record(owner, r->body.resource.kind, r->body.resource.has_profile ? r->body.resource.profile_id : NULL, &record);
    if (found == GENERAL_NATIVE_RECORD_UNREGISTERED) { reply.kind = GENERAL_REPLY_RESOURCE_UNREGISTERED; ok = true; }
    else if (found == GENERAL_NATIVE_RECORD_FOUND) { reply.kind = GENERAL_REPLY_RESOURCE_REGISTERED; reply.resource_stage = (general_session_reply_resource_stage)record.stage; strcpy(reply.creation_id, record.creation_id); ok = true; }
  } else {
    ticket *item = lookup(owner, r->body.resource.ticket_id);
    if (!item || (readonly && (item->create || r->body.resource.action == GENERAL_RESOURCE_START))) goto done;
    if (r->body.resource.action == GENERAL_RESOURCE_START) {
      if (!item->create || item->started || item->committed || !original(owner, item)) goto done;
      for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used && owner->tickets[i].started && !owner->tickets[i].committed) goto done;
      struct stat entry;
      if (!fstatat(item->parent, item->name, &entry, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) goto done;
      general_resource_record next = item->record; next.stage = GENERAL_RESOURCE_WRITE_STARTED;
      if (store(owner, &next)) { item->record = next; item->started = true; ok = true; }
    } else if (r->body.resource.action == GENERAL_RESOURCE_COMMIT) ok = commit(owner, item, database, writer_lease, &reply);
    else if (r->body.resource.action == GENERAL_RESOURCE_RELEASE) ok = release(owner, item);
  }
done:
  if (ok && active(owner)) { reply.status = GENERAL_REPLY_OK; reply.code = GENERAL_REPLY_CODE_OK; }
  else {
    general_session_reply_code rejected = reply.code == GENERAL_REPLY_BUSY ? GENERAL_REPLY_BUSY : GENERAL_REPLY_CONFLICT;
    if (ok) owner->fenced = true;
    memset(&reply, 0, sizeof(reply)); reply.kind = GENERAL_REPLY_EMPTY;
    reply.status = owner->fenced ? GENERAL_REPLY_UNCERTAIN : GENERAL_REPLY_REJECTED;
    reply.code = owner->fenced ? GENERAL_REPLY_REGISTRATION_UNCERTAIN : rejected;
  }
  owner->running = false; *out = reply; return true;
}
bool general_resource_session_execute(general_resource_session *owner, const general_session_request *request,
  int database, int writer_lease, general_session_reply *out) {
  return execute(owner, request, database, writer_lease, out, false);
}
bool general_resource_session_execute_readonly(general_resource_session *owner, const general_session_request *request,
  int database, int writer_lease, general_session_reply *out) {
  return execute(owner, request, database, writer_lease, out, true);
}
bool general_resource_session_profile_current(general_resource_session *owner, general_native_journal_connection *journal, const char *profile_id) {
  if (!owner || owner->running || owner->reaped || owner->fenced || owner->writer || owner->read_loan || owner->journal != journal || !general_session_uuid_valid(profile_id) ||
      strcmp(profile_id, owner->identity.initialization_id) || clock_gettime(CLOCK_MONOTONIC, &owner->start) ||
      owner->start.tv_sec < 0 || owner->start.tv_nsec < 0 || owner->start.tv_nsec >= 1000000000) return false;
  owner->last = owner->start; owner->running = true; bool valid = false;
  if (!active(owner) || !general_channel_peer_role_current(owner->host, GENERAL_CHANNEL_BROKER_HOST)) goto done;
  const general_resource_kind kinds[] = { GENERAL_RESOURCE_STATE_REPOSITORY, GENERAL_RESOURCE_SIGNING_REPOSITORY };
  for (unsigned k = 0; k < 2; k++) {
    ticket *found = NULL;
    for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used && owner->tickets[i].record.kind == kinds[k] &&
        !strcmp(owner->tickets[i].record.profile_id, profile_id)) {
      if (found) goto done; found = &owner->tickets[i];
    }
    if (!found || !found->committed || found->record.stage != GENERAL_RESOURCE_CREATED ||
        found->record.origin != GENERAL_RESOURCE_INITIALIZATION || strcmp(found->record.origin_id, owner->identity.initialization_id) ||
        strcmp(found->record.origin_digest, owner->identity.initialization_digest) || !fixed_files(found) || !active(owner)) goto done;
    general_resource_repository_identity actual;
    if (!general_resource_repository_verify(found->directory, found->database, found->lease, found->record.kind, owner->host, active, owner, &actual) ||
        !same(actual.directory, found->record.directory) || !same(actual.database, found->record.database) || !same(actual.writer_lease, found->record.writer_lease)) goto done;
  }
  valid = active(owner);
done:
  owner->running = false; return valid;
}
bool general_resource_session_drain_reaped(general_resource_session *owner, general_host_launch *launch) {
  if (!owner || owner->running || owner->fenced || owner->writer || owner->read_loan || !general_host_launch_reaped_peer(launch, owner->host)) return false;
  for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used) {
    ticket *item = &owner->tickets[i];
    if (item->started && !item->committed) return false;
    if (item->lease >= 0) {
      struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0x40000002, .l_len = 510 };
      if (fcntl(item->lease, F_GETLK, &lock) || lock.l_type != F_UNLCK) return false;
    }
  }
  owner->reaped = true;
  /* No file operation is performed, just closing the original retained FDs.
   * A close with unknown outcome permanently fences this owner. */
  for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used && !close_ticket(&owner->tickets[i])) {
    owner->fenced = true; return false;
  }
  return true;
}
bool general_resource_session_close(general_resource_session **pointer) {
  if (!pointer || !*pointer) return true;
  general_resource_session *owner = *pointer;
  if (owner->running || owner->fenced || owner->writer || owner->read_loan) return false;
  for (unsigned i = 0; i < TICKET_LIMIT; i++) if (owner->tickets[i].used) return false;
  if (!unregister_owner(owner)) return false;
  memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; return true;
}
