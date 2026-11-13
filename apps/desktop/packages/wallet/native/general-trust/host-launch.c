#include "host-launch.h"
#include "protected-acl.h"
#include "trust.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

typedef struct { int fd; struct stat identity; bool known; } descriptor;
struct general_host_launch {
  general_broker_namespace *space; bool namespace_loan, peer_loan, window_loan;
  general_console_identity console; general_session_installation receipt;
  descriptor parent, directory, listener, accepted, read_pipe, write_pipe;
  struct stat socket_identity; bool socket_known, directory_created, socket_created;
  char temporary[PATH_MAX], name[32], socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  general_channel_peer *peer; audit_token_t token; pid_t child;
  bool (*current)(void *); void *context;
  bool ready, revoked, uncertain, running, spawned, reaped, signaled, exit_known;
  int exit_status;
};
typedef struct { general_host_launch *owner; struct timespec start, last; } operation;
static atomic_flag occupied = ATOMIC_FLAG_INIT;
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino && !((a->st_mode ^ b->st_mode) & S_IFMT); }
static bool capture(general_host_launch *owner, descriptor *item, int fd) {
  item->fd = fd; if (fd < 0) return false;
  if (fstat(fd, &item->identity)) { owner->uncertain = true; return false; }
  item->known = true; return true;
}
static bool held(const descriptor *item) {
  struct stat value; int flags;
  return item->known && item->fd >= 0 && !fstat(item->fd, &value) && same(&value, &item->identity) &&
    (flags = fcntl(item->fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC);
}
static bool release(general_host_launch *owner, descriptor *item) {
  if (item->fd < 0) return true;
  if (!held(item)) { owner->uncertain = true; return false; }
  int fd = item->fd; item->fd = -1;
  if (close(fd)) { owner->uncertain = true; return false; } return true;
}
static bool private_directory(const descriptor *item, uid_t uid) {
  struct stat value; acl_t acl;
  if (!held(item) || fstat(item->fd, &value) || !S_ISDIR(value.st_mode) || value.st_uid != uid || (value.st_mode & 07077) || !value.st_nlink) return false;
  errno = 0; acl = acl_get_fd_np(item->fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  acl_entry_t entry; errno = 0; int found = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), error = errno; acl_free(acl);
  return found == -1 && error == EINVAL;
}
static bool original_child(general_host_launch *owner) {
  if (!owner->spawned || owner->reaped || owner->child <= 1) return false;
  int status = 0; pid_t result = waitpid(owner->child, &status, WNOHANG);
  if (result == owner->child) { owner->exit_status = status; owner->exit_known = owner->reaped = true; return false; }
  if (result < 0) { if (errno != EINTR) owner->uncertain = true; return false; }
  return result == 0;
}
static bool rendezvous_current(general_host_launch *owner) {
  struct stat named; char actual[PATH_MAX];
  if (!held(&owner->parent) || fcntl(owner->parent.fd, F_GETPATH, actual) || strcmp(actual, owner->temporary)) return false;
  if (owner->directory_created && (!private_directory(&owner->directory, owner->console.uid) ||
      fstatat(owner->parent.fd, owner->name, &named, AT_SYMLINK_NOFOLLOW) || !same(&named, &owner->directory.identity))) return false;
  if (owner->socket_created && (!owner->socket_known || !held(&owner->listener) ||
      fstatat(owner->directory.fd, "session", &named, AT_SYMLINK_NOFOLLOW) || !same(&named, &owner->socket_identity) ||
      !S_ISSOCK(named.st_mode) || named.st_uid != owner->console.uid || (named.st_mode & 0777) != 0600)) return false;
  return true;
}
static bool base_current(void *context) {
  general_host_launch *owner = context;
  return !owner->revoked && !owner->uncertain && owner->current(owner->context) && general_broker_namespace_current(owner->space) &&
    rendezvous_current(owner) && (!owner->spawned || original_child(owner));
}
static bool active(void *context) {
  operation *op = context; struct timespec now;
  if (!base_current(op->owner) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now;
  return now.tv_sec - op->start.tv_sec < 30 || (now.tv_sec - op->start.tv_sec == 30 && now.tv_nsec < op->start.tv_nsec);
}
static bool wait_ready(operation *op, int fd, short events) {
  while (active(op)) {
    struct pollfd state = { .fd = fd, .events = events };
    int result = poll(&state, 1, 20);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 || state.revents & (POLLERR | POLLNVAL | POLLHUP)) return false;
    if (result > 0) return (state.revents & events) != 0;
  }
  return false;
}
static bool flags(int fd, bool nonblock) {
  int value = fcntl(fd, F_GETFD);
  if (value < 0 || fcntl(fd, F_SETFD, value | FD_CLOEXEC)) return false;
  value = fcntl(fd, F_GETFL); return value >= 0 && (!nonblock || !fcntl(fd, F_SETFL, value | O_NONBLOCK));
}
static bool rendezvous_open(general_host_launch *owner) {
  char reported[PATH_MAX];
  size_t size = confstr(_CS_DARWIN_USER_TEMP_DIR, reported, sizeof(reported));
  if (!size || size > sizeof(reported) || !realpath(reported, owner->temporary) ||
      !capture(owner, &owner->parent, open(owner->temporary, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)) ||
      !private_directory(&owner->parent, owner->console.uid)) return false;
  unsigned char random[12]; arc4random_buf(random, sizeof(random)); static const char hex[] = "0123456789abcdef";
  memcpy(owner->name, "kcwh-", 5);
  for (unsigned i = 0; i < sizeof(random); i++) { owner->name[5 + i * 2] = hex[random[i] >> 4]; owner->name[6 + i * 2] = hex[random[i] & 15]; }
  if (mkdirat(owner->parent.fd, owner->name, 0700)) return false;
  owner->directory_created = true;
  if (!capture(owner, &owner->directory, openat(owner->parent.fd, owner->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)) ||
      !private_directory(&owner->directory, owner->console.uid)) return false;
  int length = snprintf(owner->socket_path, sizeof(owner->socket_path), "%s/%s/session", owner->temporary, owner->name);
  if (length < 1 || length >= (int)sizeof(owner->socket_path)) return false;
  if (!capture(owner, &owner->listener, socket(AF_UNIX, SOCK_STREAM, 0)) || !flags(owner->listener.fd, true)) return false;
  struct sockaddr_un address = { .sun_family = AF_UNIX }; memcpy(address.sun_path, owner->socket_path, (size_t)length + 1);
  address.sun_len = (unsigned char)(offsetof(struct sockaddr_un, sun_path) + length + 1);
  if (bind(owner->listener.fd, (struct sockaddr *)&address, address.sun_len)) return false;
  owner->socket_created = true;
  if (fstatat(owner->directory.fd, "session", &owner->socket_identity, AT_SYMLINK_NOFOLLOW)) { owner->uncertain = true; return false; }
  owner->socket_known = true;
  /* Private 0700 directory prevents another UID reaching this pre-chmod name. */
  if (!S_ISSOCK(owner->socket_identity.st_mode) || owner->socket_identity.st_uid != owner->console.uid ||
      fchmodat(owner->directory.fd, "session", 0600, AT_SYMLINK_NOFOLLOW) || listen(owner->listener.fd, 1) || !rendezvous_current(owner)) return false;
  return true;
}
static bool spawn_host(operation *op) {
  general_host_launch *owner = op->owner; int pipes[2];
  if (!active(op) || pipe(pipes)) return false;
  if (!capture(owner, &owner->read_pipe, pipes[0]) || !capture(owner, &owner->write_pipe, pipes[1]) || !flags(pipes[0], false) || !flags(pipes[1], true) ||
      fcntl(pipes[1], F_SETNOSIGPIPE, 1)) return false;
  posix_spawn_file_actions_t actions; posix_spawnattr_t attributes; bool actions_ready = false, attributes_ready = false, valid = false;
  if (posix_spawn_file_actions_init(&actions)) goto done; actions_ready = true;
  if (posix_spawnattr_init(&attributes)) goto done; attributes_ready = true;
  /* CLOEXEC_DEFAULT closes all unrelated descriptors. dup2 explicitly inherits
   * only the anonymous bootstrap read end; stdio is fixed /dev/null. */
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) ||
      posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0) ||
      posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0) ||
      posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0) ||
      posix_spawn_file_actions_adddup2(&actions, owner->read_pipe.fd, 3) ||
      posix_spawn_file_actions_addchdir_np(&actions, GENERAL_TRUST_HOST)) goto done;
  char home[PATH_MAX + 6], temporary[PATH_MAX + 8];
  int count = snprintf(home, sizeof(home), "HOME=%s", owner->console.home);
  if (count < 1 || count >= (int)sizeof(home)) goto done;
  count = snprintf(temporary, sizeof(temporary), "TMPDIR=%s/", owner->temporary);
  if (count < 1 || count >= (int)sizeof(temporary) || !active(op)) goto done;
  char *const argv[] = { GENERAL_TRUST_EXECUTABLE, NULL };
  char *const environment[] = { "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", home, temporary, NULL };
  pid_t child = -1;
  int result = posix_spawn(&child, GENERAL_TRUST_EXECUTABLE, &actions, &attributes, argv, environment);
  if (result) goto done;
  owner->child = child; owner->spawned = true;
  valid = child > 1 && release(owner, &owner->read_pipe) && active(op);
done:
  if (attributes_ready && posix_spawnattr_destroy(&attributes)) { owner->uncertain = true; valid = false; }
  if (actions_ready && posix_spawn_file_actions_destroy(&actions)) { owner->uncertain = true; valid = false; }
  return valid;
}
static bool send_bootstrap(operation *op, const general_host_bootstrap_message *message) {
  general_host_launch *owner = op->owner; unsigned char bytes[GENERAL_HOST_BOOTSTRAP_MAX]; size_t size, used = 0;
  if (!general_host_bootstrap_encode(message, bytes, sizeof(bytes), &size)) return false;
  /* The entire bounded message fits PIPE_BUF; do not queue a second message. */
  while (used < size && wait_ready(op, owner->write_pipe.fd, POLLOUT)) {
    ssize_t count = write(owner->write_pipe.fd, bytes + used, size - used);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count <= 0 || (size_t)count > size - used) return false; used += (size_t)count;
  }
  return used == size && release(owner, &owner->write_pipe) && active(op);
}
static bool accept_host(operation *op, const unsigned char *nonce) {
  general_host_launch *owner = op->owner;
  if (!wait_ready(op, owner->listener.fd, POLLIN) || !capture(owner, &owner->accepted, accept(owner->listener.fd, NULL, NULL)) || !flags(owner->accepted.fd, true) ||
      !active(op) || !general_channel_peer_open(owner->accepted.fd, GENERAL_CHANNEL_BROKER_HOST, &owner->receipt, base_current, owner, &owner->peer) ||
      !general_channel_peer_token(owner->peer, &owner->token) || audit_token_to_pid(owner->token) != owner->child || !original_child(owner)) return false;
  unsigned char bytes[GENERAL_HOST_GREETING_SIZE]; size_t used = 0;
  while (used < sizeof(bytes) && general_channel_peer_current(owner->peer) && wait_ready(op, owner->accepted.fd, POLLIN)) {
    union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int) * 16)]; } control = {0};
    struct iovec data = { .iov_base = bytes + used, .iov_len = sizeof(bytes) - used };
    struct msghdr message = { .msg_iov = &data, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
    ssize_t count = recvmsg(owner->accepted.fd, &message, MSG_DONTWAIT);
    if (count >= 0 && (message.msg_controllen || message.msg_flags & (MSG_CTRUNC | MSG_TRUNC))) {
      /* Unknown ancillary descriptors require process reaping, not partial
       * guessed close or reuse of this original connection. */
      owner->uncertain = true; return false;
    }
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count <= 0 || (size_t)count > sizeof(bytes) - used) return false; used += (size_t)count;
  }
  return used == sizeof(bytes) && general_host_greeting_matches(bytes, used, nonce) && active(op) &&
    general_channel_peer_current(owner->peer) && release(owner, &owner->accepted);
}
general_host_launch_result general_host_launch_open(general_broker_namespace *space, general_host_mode mode,
  bool (*current)(void *), void *context, general_host_launch **out) {
  if (!space || !current || !out || *out || (mode != GENERAL_HOST_INSPECT && mode != GENERAL_HOST_MANAGER)) return GENERAL_HOST_LAUNCH_UNAVAILABLE;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_HOST_LAUNCH_BUSY;
  general_host_launch *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return GENERAL_HOST_LAUNCH_UNAVAILABLE; }
  owner->parent.fd = owner->directory.fd = owner->listener.fd = owner->accepted.fd = owner->read_pipe.fd = owner->write_pipe.fd = -1;
  owner->space = space; owner->current = current; owner->context = context;
  operation op = { .owner = owner };
  if (clock_gettime(CLOCK_MONOTONIC, &op.start)) goto fail;
  op.last = op.start;
  if (!current(context) || !general_broker_namespace_info(space, &owner->console, &owner->receipt) ||
      !general_broker_namespace_borrow_child(space)) goto fail;
  owner->namespace_loan = true;
  if (!rendezvous_open(owner)) goto fail;
  general_host_bootstrap_message message = { .mode = mode };
  strcpy(message.path, owner->socket_path); arc4random_buf(message.nonce, sizeof(message.nonce));
  if (!active(&op) || !spawn_host(&op) || !send_bootstrap(&op, &message) || !accept_host(&op, message.nonce)) goto fail;
  owner->ready = true;
  if (!general_host_launch_current(owner) || !active(&op)) goto fail;
  *out = owner; return GENERAL_HOST_LAUNCH_READY;
fail:
  general_host_launch_cancel(owner);
  if (!general_host_launch_close(&owner)) { *out = owner; return GENERAL_HOST_LAUNCH_UNCERTAIN; }
  return GENERAL_HOST_LAUNCH_UNAVAILABLE;
}
bool general_host_launch_current(general_host_launch *owner) {
  if (!owner || !owner->ready || owner->running || owner->revoked || owner->uncertain) return false;
  owner->running = true; audit_token_t token;
  bool valid = base_current(owner) && general_channel_peer_token(owner->peer, &token) && !memcmp(&token, &owner->token, sizeof(token));
  owner->running = false; if (!valid) general_host_launch_cancel(owner); return valid;
}
general_channel_peer *general_host_launch_borrow(general_host_launch *owner) {
  if (!general_host_launch_current(owner) || owner->peer_loan) return NULL;
  owner->peer_loan = true; return owner->peer;
}
bool general_host_launch_return(general_host_launch *owner) {
  if (!owner || !owner->peer_loan || owner->running || owner->uncertain) return false;
  owner->peer_loan = false; return true;
}
general_channel_peer *general_host_launch_borrow_window(general_host_launch *owner) {
  if (!general_host_launch_current(owner) || owner->window_loan) return NULL;
  owner->window_loan = true; return owner->peer;
}
bool general_host_launch_return_window(general_host_launch *owner) {
  if (!owner || !owner->window_loan || owner->running || owner->uncertain) return false;
  owner->window_loan = false; return true;
}
void general_host_launch_cancel(general_host_launch *owner) {
  if (!owner) return;
  owner->revoked = true; owner->ready = false;
  if (!owner->signaled && original_child(owner)) {
    owner->signaled = true;
    if (kill(owner->child, SIGTERM) && errno != ESRCH) owner->uncertain = true;
  }
}
bool general_host_launch_reaped(general_host_launch *owner) {
  if (!owner) return true;
  if (!owner->spawned || owner->reaped) return true;
  (void)original_child(owner); return owner->reaped;
}
bool general_host_launch_reaped_peer(general_host_launch *owner, general_channel_peer *peer) {
  return owner && peer && owner->peer == peer && owner->spawned && owner->child > 1 &&
    audit_token_to_pid(owner->token) == owner->child && general_host_launch_reaped(owner);
}
bool general_host_launch_exit_success(general_host_launch *owner) {
  return owner && owner->spawned && owner->reaped && owner->exit_known && !owner->uncertain &&
    WIFEXITED(owner->exit_status) && WEXITSTATUS(owner->exit_status) == 0;
}
bool general_host_launch_close(general_host_launch **pointer) {
  if (!pointer || !*pointer) return true;
  general_host_launch *owner = *pointer;
  if (owner->running || owner->uncertain || owner->peer_loan || owner->window_loan || !general_host_launch_reaped(owner)) return false;
  owner->revoked = true; owner->ready = false;
  if (!general_channel_peer_close(&owner->peer) || !release(owner, &owner->accepted) || !release(owner, &owner->read_pipe) || !release(owner, &owner->write_pipe)) return false;
  if (owner->socket_created) {
    struct stat value;
    if (!owner->socket_known || !held(&owner->directory) || fstatat(owner->directory.fd, "session", &value, AT_SYMLINK_NOFOLLOW) ||
        !same(&value, &owner->socket_identity) || unlinkat(owner->directory.fd, "session", 0)) { owner->uncertain = true; return false; }
    owner->socket_created = false;
  }
  if (!release(owner, &owner->listener)) return false;
  if (owner->directory_created) {
    struct stat value;
    if (!held(&owner->parent) || !held(&owner->directory) || fstatat(owner->parent.fd, owner->name, &value, AT_SYMLINK_NOFOLLOW) ||
        !same(&value, &owner->directory.identity) || unlinkat(owner->parent.fd, owner->name, AT_REMOVEDIR)) { owner->uncertain = true; return false; }
    owner->directory_created = false;
  }
  if (!release(owner, &owner->directory) || !release(owner, &owner->parent)) return false;
  if (owner->namespace_loan && !general_broker_namespace_return_child(owner->space)) { owner->uncertain = true; return false; }
  free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
