#include "profile-origin.h"
#include "native-resource-read.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <unistd.h>

typedef struct { int fd; struct stat identity; bool known; } parent;
struct general_profile_origin {
  general_profile_view *view; general_native_directory *directory;
  general_native_identity identity; general_session_installation installation;
  int enrollment; bool enrollment_loan, running, poisoned;
  parent profiles, profile;
  bool (*current)(void *); void *context;
};
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino && !((a->st_mode ^ b->st_mode) & S_IFMT); }
static bool record_identity(const struct stat *actual, general_resource_file_identity expected) {
  general_resource_file_identity value; return general_resource_identity_from_stat(actual, &value) && value.device == expected.device && value.inode == expected.inode;
}
static bool private_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  bool valid = false; acl_entry_t entry;
  for (unsigned i = 0; i <= ACL_MAX_ENTRIES; i++) {
    errno = 0; int found = acl_get_entry(acl, i ? ACL_NEXT_ENTRY : ACL_FIRST_ENTRY, &entry);
    if (found == -1) { valid = errno == EINVAL; break; }
    acl_tag_t tag; if (found || i == ACL_MAX_ENTRIES || acl_get_tag_type(entry, &tag) || tag != ACL_EXTENDED_DENY) break;
  }
  acl_free(acl); return valid;
}
static bool active(void *context) {
  general_profile_origin *owner = context;
  return !owner->poisoned && owner->current(owner->context) && general_profile_view_current(owner->view) &&
    general_native_directory_matches(owner->directory, &owner->identity);
}
static bool directory_shape(general_profile_origin *owner, int fd, struct stat *out) {
  int flags;
  return !fstat(fd, out) && S_ISDIR(out->st_mode) && out->st_uid == owner->identity.uid && (out->st_mode & 07777) == 0700 && out->st_nlink > 0 &&
    (flags = fcntl(fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) && private_acl(fd);
}
static bool ensure_parent(general_profile_origin *owner, parent *held, int directory, const char *name, const general_resource_record *record) {
  struct stat before, actual, named;
  if (record->stage != GENERAL_RESOURCE_CREATED || !record->has_identities || !active(owner) || !directory_shape(owner, directory, &before) ||
      !record_identity(&before, record->parent)) return false;
  if (held->fd < 0) {
    held->fd = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (held->fd < 0) return false;
    if (fstat(held->fd, &held->identity)) { owner->poisoned = true; return false; }
    held->known = true;
  }
  return held->known && directory_shape(owner, held->fd, &actual) && same(&actual, &held->identity) && record_identity(&actual, record->directory) &&
    !fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) && same(&actual, &named) && active(owner);
}
static bool resolve(general_resource_kind kind, const char *profile, general_resource_origin_view *out, void *context) {
  general_profile_origin *owner = context;
  if (!owner || owner->running || !out || kind < GENERAL_RESOURCE_PROFILES_ROOT || kind > GENERAL_RESOURCE_SIGNING_REPOSITORY ||
      (kind == GENERAL_RESOURCE_PROFILES_ROOT ? profile != NULL : !profile || !general_session_uuid_valid(profile) || strcmp(profile, owner->identity.initialization_id)) || !active(owner)) return false;
  owner->running = true; bool valid = false;
  general_profile_snapshot snapshot; general_native_replay *replay = NULL; general_resource_origin_view view = {0};
  if (!general_profile_view_snapshot(owner->view, &snapshot, &replay) || snapshot.initialization.kind != GENERAL_INITIALIZATION_NEW) goto done;
  view.parent = owner->enrollment; view.origin = GENERAL_RESOURCE_INITIALIZATION;
  strcpy(view.origin_id, snapshot.initialization.identity.initialization_id); strcpy(view.origin_digest, snapshot.initialization.identity.initialization_digest);
  view.phase = snapshot.initialization.phase == GENERAL_INITIALIZATION_READY && snapshot.has_binding ? GENERAL_RESOURCE_ORIGIN_ACTIVE : GENERAL_RESOURCE_ORIGIN_PREPARING;
  if (kind != GENERAL_RESOURCE_PROFILES_ROOT) {
    general_resource_record record;
    if (general_native_resource_read(&owner->identity, &owner->installation, replay, GENERAL_RESOURCE_PROFILES_ROOT, NULL, active, owner, &record) != GENERAL_NATIVE_RECORD_FOUND ||
        !ensure_parent(owner, &owner->profiles, owner->enrollment, "profiles", &record)) goto done;
    view.parent = owner->profiles.fd;
    if (kind != GENERAL_RESOURCE_PROFILE_DIRECTORY) {
      if (general_native_resource_read(&owner->identity, &owner->installation, replay, GENERAL_RESOURCE_PROFILE_DIRECTORY, owner->identity.initialization_id, active, owner, &record) != GENERAL_NATIVE_RECORD_FOUND ||
          !ensure_parent(owner, &owner->profile, owner->profiles.fd, owner->identity.initialization_id, &record)) goto done;
      view.parent = owner->profile.fd;
    }
  }
  valid = active(owner);
done:
  general_native_replay_destroy(&replay); owner->running = false;
  if (valid) *out = view; return valid;
}
general_profile_origin_result general_profile_origin_open(general_profile_view *view, general_native_directory *directory,
  bool (*current)(void *), void *context, general_profile_origin **out) {
  if (!view || !directory || !current || !out || *out || !current(context)) return GENERAL_PROFILE_ORIGIN_REJECTED;
  general_profile_origin *owner = calloc(1, sizeof(*owner)); if (!owner) return GENERAL_PROFILE_ORIGIN_REJECTED;
  owner->view = view; owner->directory = directory; owner->current = current; owner->context = context;
  owner->enrollment = owner->profiles.fd = owner->profile.fd = -1;
  if (!general_profile_view_identity(view, &owner->identity, &owner->installation) || !general_native_directory_matches(directory, &owner->identity) ||
      !general_native_directory_enrollment_borrow(directory, &owner->enrollment)) { free(owner); return GENERAL_PROFILE_ORIGIN_REJECTED; }
  owner->enrollment_loan = true;
  if (!active(owner)) {
    if (!general_profile_origin_close(&owner)) { *out = owner; return GENERAL_PROFILE_ORIGIN_UNCERTAIN; }
    return GENERAL_PROFILE_ORIGIN_REJECTED;
  }
  *out = owner; return GENERAL_PROFILE_ORIGIN_READY;
}
bool general_profile_origin_resolver(general_profile_origin *owner, general_resource_origin_resolver *out) {
  if (!owner || !out || owner->running || !active(owner)) return false;
  *out = (general_resource_origin_resolver){ .resolve = resolve, .context = owner }; return true;
}
static bool release(general_profile_origin *owner, parent *held) {
  if (held->fd < 0) return true;
  struct stat actual;
  if (!held->known || fstat(held->fd, &actual) || !same(&actual, &held->identity)) { owner->poisoned = true; return false; }
  int fd = held->fd; held->fd = -1;
  if (close(fd)) { owner->poisoned = true; return false; } return true;
}
bool general_profile_origin_close(general_profile_origin **pointer) {
  if (!pointer || !*pointer) return true;
  general_profile_origin *owner = *pointer;
  if (owner->running || owner->poisoned || !release(owner, &owner->profile) || !release(owner, &owner->profiles)) return false;
  if (owner->enrollment_loan && !general_native_directory_enrollment_return(owner->directory)) { owner->poisoned = true; return false; }
  memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; return true;
}
