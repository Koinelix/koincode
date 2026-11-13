#include "host-resources.h"
#include "../general-trust/native-directory.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <time.h>
#include <unistd.h>

typedef struct {
  struct general_host_resources *owner;
  general_resource_kind kind;
  char id[37], creation[37], name[40];
  bool used, create, started, attempted, materialized, committing, committed, sql_closed;
  int parent, directory;
  struct stat parent_identity, directory_identity;
  general_repository_pair *pair;
  general_repository_sql *sql;
} resource;
struct general_host_resources {
  general_host_bootstrap *bootstrap;
  general_initialization_record initialization;
  general_native_directory *native;
  int enrollment; bool enrollment_loan;
  bool (*current)(void *); void *context;
  resource resources[5];
  bool running, closing, draining, poisoned, readonly;
  struct timespec started, last;
};
static bool base_current(void *context) {
  general_host_resources *owner = context;
  return (!owner->closing || owner->draining) && !owner->poisoned && owner->current(owner->context) && general_host_bootstrap_current(owner->bootstrap);
}
static bool no_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); if (!acl) return errno == ENOENT;
  acl_entry_t entry; errno = 0; int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), error = errno;
  return acl_free(acl) == 0 && result == -1 && error == EINVAL;
}
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static bool directory(int fd, struct stat *out) {
  int flags;
  return fd >= 0 && !fstat(fd, out) && S_ISDIR(out->st_mode) && out->st_uid == geteuid() && (out->st_mode & 07777) == 0700 &&
    out->st_nlink >= 1 && (flags = fcntl(fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) && no_acl(fd);
}
static resource *by_kind(general_host_resources *owner, general_resource_kind kind) {
  if (!owner || kind < GENERAL_RESOURCE_PROFILES_ROOT || kind > GENERAL_RESOURCE_SIGNING_REPOSITORY) return NULL;
  return &owner->resources[(unsigned)kind - 1];
}
static resource *by_id(general_host_resources *owner, const char *id) {
  if (!general_session_uuid_valid(id)) return NULL;
  for (unsigned i = 0; i < 5; i++) if (owner->resources[i].used && !strcmp(owner->resources[i].id, id)) return &owner->resources[i];
  return NULL;
}
static bool resource_current(void *context) {
  resource *item = context; general_host_resources *owner = item->owner; struct stat actual, named;
  return base_current(owner) && owner->native && general_native_directory_current(owner->native) &&
    item->used && item->parent >= 0 && directory(item->parent, &actual) && same(&actual, &item->parent_identity) &&
    (!item->materialized || (directory(item->directory, &actual) && same(&actual, &item->directory_identity) &&
      !fstatat(item->parent, item->name, &named, AT_SYMLINK_NOFOLLOW) && same(&actual, &named)));
}
bool general_host_resources_current(general_host_resources *owner) {
  if (!owner || !base_current(owner) || !owner->native || !general_native_directory_current(owner->native)) return false;
  for (unsigned i = 0; i < 5; i++) if (owner->resources[i].used && owner->resources[i].attempted && !resource_current(&owner->resources[i])) return false;
  return base_current(owner);
}
bool general_host_resources_matches(general_host_resources *owner, const general_initialization_record *initialization) {
  if (!general_host_resources_current(owner) || !general_initialization_record_valid(initialization)) return false;
  general_initialization_plan plan = { .identity = owner->initialization.identity, .kind = GENERAL_INITIALIZATION_NEW };
  strcpy(plan.target_state_commitment, owner->initialization.target_state_commitment); strcpy(plan.initial_signing_domain_id, owner->initialization.initial_signing_domain_id);
  return general_initialization_binding_valid(initialization, &plan);
}
bool general_host_resources_repository_ready(general_host_resources *owner, general_repository_kind kind) {
  if ((kind != GENERAL_REPOSITORY_STATE && kind != GENERAL_REPOSITORY_SIGNING) || !general_host_resources_current(owner)) return false;
  resource *item = by_kind(owner, kind == GENERAL_REPOSITORY_STATE ? GENERAL_RESOURCE_STATE_REPOSITORY : GENERAL_RESOURCE_SIGNING_REPOSITORY);
  return item->committed && !item->committing && !item->sql_closed && (item->sql || (item->pair && general_repository_pair_current(item->pair))) && resource_current(item);
}
static bool active(general_host_resources *owner) {
  struct timespec now;
  if (!general_host_resources_current(owner) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < owner->last.tv_sec ||
      now.tv_nsec < 0 || now.tv_nsec >= 1000000000 || (now.tv_sec == owner->last.tv_sec && now.tv_nsec < owner->last.tv_nsec)) return false;
  owner->last = now;
  return now.tv_sec - owner->started.tv_sec < 30 || (now.tv_sec - owner->started.tv_sec == 30 && now.tv_nsec < owner->started.tv_nsec);
}
static bool begin(general_host_resources *owner) {
  if (!owner || owner->running || owner->closing || owner->poisoned || clock_gettime(CLOCK_MONOTONIC, &owner->started) ||
      owner->started.tv_sec < 0 || owner->started.tv_nsec < 0 || owner->started.tv_nsec >= 1000000000) return false;
  owner->last = owner->started; owner->running = true;
  if (!active(owner)) { owner->running = false; return false; } return true;
}
general_host_resources *general_host_resources_open(general_host_bootstrap *bootstrap,
    const general_initialization_record *initialization, bool (*current)(void *), void *context) {
  if (!bootstrap || !current || !general_initialization_record_valid(initialization) || initialization->kind != GENERAL_INITIALIZATION_NEW) return NULL;
  const general_initialization_record frozen = *initialization;
  general_host_mode mode; general_session_installation receipt;
  if (!general_host_bootstrap_info(bootstrap, &mode, &receipt) || (mode != GENERAL_HOST_MANAGER && mode != GENERAL_HOST_INSPECT) ||
      (mode == GENERAL_HOST_INSPECT && frozen.phase != GENERAL_INITIALIZATION_READY) ||
      strcmp(receipt.installation_id, frozen.identity.installation_id) || frozen.identity.uid != geteuid() || !current(context)) return NULL;
  general_host_resources *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  owner->readonly = mode == GENERAL_HOST_INSPECT;
  owner->bootstrap = bootstrap; owner->initialization = frozen; owner->current = current; owner->context = context; owner->enrollment = -1;
  for (unsigned i = 0; i < 5; i++) { owner->resources[i].owner = owner; owner->resources[i].parent = owner->resources[i].directory = -1; }
  general_native_directory_result opened = general_native_directory_open(&owner->initialization.identity, false, base_current, owner, &owner->native);
  if (opened != GENERAL_NATIVE_DIRECTORY_READY || !general_native_directory_enrollment_borrow(owner->native, &owner->enrollment)) {
    if (opened == GENERAL_NATIVE_DIRECTORY_UNCERTAIN || (owner->native && !general_native_directory_close(&owner->native))) {
      owner->poisoned = true; return owner;
    }
    free(owner); return NULL;
  }
  owner->enrollment_loan = true; return owner;
}
static bool prepare(general_host_resources *owner, const general_session_request *request, const general_session_reply *reply) {
  if (owner->readonly && reply->resource_create) return false;
  const general_native_identity *id = &owner->initialization.identity;
  resource *item = by_kind(owner, request->body.resource.kind);
  if (!item || reply->kind != GENERAL_REPLY_RESOURCE_PREPARED || !general_session_uuid_valid(reply->ticket_id) || !general_session_uuid_valid(reply->creation_id) ||
      request->body.resource.origin != GENERAL_SESSION_ORIGIN_INITIALIZATION || strcmp(request->body.resource.origin_id, id->initialization_id) ||
      strcmp(request->body.resource.origin_digest, id->initialization_digest) ||
      (item == &owner->resources[0] ? request->body.resource.has_profile : !request->body.resource.has_profile || strcmp(request->body.resource.profile_id, id->initialization_id))) return false;
  if (item->used) return !strcmp(item->id, reply->ticket_id) && !strcmp(item->creation, reply->creation_id) && item->create == reply->resource_create;
  item->kind = request->body.resource.kind; strcpy(item->id, reply->ticket_id); strcpy(item->creation, reply->creation_id);
  item->create = reply->resource_create; item->used = true;
  const char *name = item->kind == GENERAL_RESOURCE_PROFILES_ROOT ? "profiles" : item->kind == GENERAL_RESOURCE_PROFILE_DIRECTORY ? id->initialization_id :
    item->kind == GENERAL_RESOURCE_HISTORY_DIRECTORY ? "history" : item->kind == GENERAL_RESOURCE_STATE_REPOSITORY ? "state" : "signing";
  strcpy(item->name, name); return true;
}
bool general_host_resources_observe(general_host_resources *owner, const general_session_request *request, const general_session_reply *reply) {
  if (!owner || !request || !reply || request->command != GENERAL_SESSION_RESOURCE || !begin(owner)) return false;
  bool ok = false; resource *item = NULL;
  if (request->body.resource.action != GENERAL_RESOURCE_PREPARE && request->body.resource.action != GENERAL_RESOURCE_INSPECT)
    item = by_id(owner, request->body.resource.ticket_id);
  if (reply->status != GENERAL_REPLY_OK) {
    if (item && item->committing) owner->poisoned = true;
    ok = !owner->poisoned; goto done;
  }
  if (reply->code != GENERAL_REPLY_CODE_OK) goto done;
  if (request->body.resource.action == GENERAL_RESOURCE_PREPARE) ok = prepare(owner, request, reply);
  else if (request->body.resource.action == GENERAL_RESOURCE_INSPECT) ok = true;
  else if (item && request->body.resource.action == GENERAL_RESOURCE_START && item->create && !item->started && !item->attempted) { item->started = true; ok = true; }
  else if (item && request->body.resource.action == GENERAL_RESOURCE_COMMIT && item->materialized && item->committing && reply->kind == GENERAL_REPLY_RESOURCE_CREATED) {
    if (item->pair && !general_repository_pair_return(item->pair)) { owner->poisoned = true; goto done; }
    item->committing = false; item->committed = true; ok = resource_current(item);
  }
done:
  if (ok && !active(owner)) ok = false;
  if (!ok) owner->poisoned = true;
  owner->running = false; return ok;
}
bool general_host_resources_materialize(general_host_resources *owner, general_resource_kind kind) {
  resource *item = by_kind(owner, kind);
  if (!item || !item->used || item->attempted || item->committed || (owner->readonly && item->create) || (item->create && !item->started) || !begin(owner)) return false;
  bool ok = false; int parent = owner->enrollment;
  if (kind != GENERAL_RESOURCE_PROFILES_ROOT) {
    resource *ancestor = by_kind(owner, kind == GENERAL_RESOURCE_PROFILE_DIRECTORY ? GENERAL_RESOURCE_PROFILES_ROOT : GENERAL_RESOURCE_PROFILE_DIRECTORY);
    if (!ancestor->committed || !resource_current(ancestor)) goto done;
    parent = ancestor->directory;
  }
  item->attempted = true; item->parent = fcntl(parent, F_DUPFD_CLOEXEC, 3);
  if (!directory(item->parent, &item->parent_identity) || !active(owner)) goto done;
  if (item->create && mkdirat(item->parent, item->name, 0700)) goto done;
  item->directory = openat(item->parent, item->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (!directory(item->directory, &item->directory_identity)) goto done;
  item->materialized = true;
  if (!resource_current(item) || (item->create && (fsync(item->directory) || fsync(item->parent))) || !active(owner)) goto done;
  if (kind == GENERAL_RESOURCE_STATE_REPOSITORY || kind == GENERAL_RESOURCE_SIGNING_REPOSITORY) {
    general_repository_kind repository = kind == GENERAL_RESOURCE_STATE_REPOSITORY ? GENERAL_REPOSITORY_STATE : GENERAL_REPOSITORY_SIGNING;
    if (general_repository_pair_open(item->directory, repository, item->create, resource_current, item, &item->pair) != GENERAL_REPOSITORY_READY || !item->pair || !active(owner)) goto done;
  }
  ok = active(owner);
done:
  if (!ok && item->attempted) owner->poisoned = true;
  owner->running = false; return ok;
}
bool general_host_resources_commit_borrow(general_host_resources *owner, const general_session_request *request, int descriptors[2], unsigned *count) {
  if (!request || !descriptors || !count || request->command != GENERAL_SESSION_RESOURCE || request->body.resource.action != GENERAL_RESOURCE_COMMIT || !begin(owner)) return false;
  resource *item = by_id(owner, request->body.resource.ticket_id); bool ok = false; unsigned quantity = 0; int fds[2] = {-1, -1};
  if (!item || !item->materialized || item->committing || item->committed || !resource_current(item)) goto done;
  if (item->pair) {
    if (!general_repository_pair_commit_borrow(item->pair, &fds[0], &fds[1])) goto done;
    quantity = 2;
  }
  item->committing = true;
  if (!active(owner)) { owner->poisoned = true; goto done; }
  descriptors[0] = fds[0]; descriptors[1] = fds[1]; *count = quantity; ok = true;
done:
  owner->running = false; return ok;
}
general_sql_status general_host_resources_execute(general_host_resources *owner, general_repository_kind kind,
    general_sql_recipe recipe, const general_sql_parameter *parameters, size_t count, general_sql_result **out) {
  if (!owner || (owner->readonly && (recipe == GENERAL_SQL_BEGIN || recipe == GENERAL_SQL_COMMIT || recipe == GENERAL_SQL_ROLLBACK ||
      recipe == GENERAL_SQL_STATE_WRITE || recipe == GENERAL_SQL_APPEND)) ||
      (kind != GENERAL_REPOSITORY_STATE && kind != GENERAL_REPOSITORY_SIGNING)) return GENERAL_SQL_REJECTED;
  resource *item = by_kind(owner, kind == GENERAL_REPOSITORY_STATE ? GENERAL_RESOURCE_STATE_REPOSITORY : GENERAL_RESOURCE_SIGNING_REPOSITORY);
  if (!item || !item->committed || item->committing || item->sql_closed || !begin(owner)) return GENERAL_SQL_REJECTED;
  if (!item->sql && item->pair) item->sql = general_repository_sql_take(&item->pair);
  general_sql_status result = item->sql ? general_repository_sql_execute(item->sql, recipe, parameters, count, out) : GENERAL_SQL_REJECTED;
  if (result == GENERAL_SQL_OK && !active(owner)) { general_repository_sql_result_free(out); result = GENERAL_SQL_UNCERTAIN; }
  if (result == GENERAL_SQL_UNCERTAIN) owner->poisoned = true;
  owner->running = false; return result;
}
general_repository_close_result general_host_resources_close_repository(general_host_resources *owner, general_repository_kind kind) {
  if (!owner || owner->running || owner->poisoned || (kind != GENERAL_REPOSITORY_STATE && kind != GENERAL_REPOSITORY_SIGNING)) return GENERAL_PAIR_CLOSE_UNCERTAIN;
  resource *item = by_kind(owner, kind == GENERAL_REPOSITORY_STATE ? GENERAL_RESOURCE_STATE_REPOSITORY : GENERAL_RESOURCE_SIGNING_REPOSITORY);
  if (item->committing) return GENERAL_PAIR_BUSY;
  general_repository_close_result result = item->sql ? general_repository_sql_close(&item->sql) : general_repository_pair_close(&item->pair);
  if (result == GENERAL_PAIR_CLOSED) item->sql_closed = true;
  if (result == GENERAL_PAIR_CLOSE_UNCERTAIN) owner->poisoned = true;
  return result;
}
static bool release_fd(int *address) { if (*address < 0) return true; int fd = *address; *address = -1; return close(fd) == 0; }
general_host_resources_close_result general_host_resources_close(general_host_resources **address) {
  if (!address || !*address) return GENERAL_HOST_RESOURCES_CLOSED;
  general_host_resources *owner = *address;
  if (owner->running) return GENERAL_HOST_RESOURCES_BUSY;
  if (owner->poisoned) return GENERAL_HOST_RESOURCES_UNCERTAIN;
  for (unsigned i = 0; i < 5; i++) if (owner->resources[i].committing ||
      (owner->resources[i].started && !owner->resources[i].committed)) return GENERAL_HOST_RESOURCES_BUSY;
  owner->closing = owner->draining = true;
  for (unsigned i = 0; i < 5; i++) {
    resource *item = &owner->resources[i];
    general_repository_close_result result = item->sql ? general_repository_sql_close(&item->sql) : general_repository_pair_close(&item->pair);
    if (result == GENERAL_PAIR_BUSY) return GENERAL_HOST_RESOURCES_BUSY;
    if (result != GENERAL_PAIR_CLOSED || !release_fd(&item->directory) || !release_fd(&item->parent)) { owner->poisoned = true; return GENERAL_HOST_RESOURCES_UNCERTAIN; }
  }
  if ((owner->enrollment_loan && !general_native_directory_enrollment_return(owner->native)) || !general_native_directory_close(&owner->native)) {
    owner->poisoned = true; return GENERAL_HOST_RESOURCES_UNCERTAIN;
  }
  memset(owner, 0, sizeof(*owner)); free(owner); *address = NULL; return GENERAL_HOST_RESOURCES_CLOSED;
}
