#include "enrollment-client.h"
#include "channel-peer.h"
#include "console-identity.h"
#include "protected-acl.h"
#include "session-code.h"
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

struct general_enrollment_client {
  int directory, connecting, channel; struct stat directory_id, entry_id, socket_id;
  bool directory_known, entry_known, socket_known, peer_loan, lock_loan, ready, failed, poisoned, borrowed;
  general_channel_peer *peer; general_session_locks *locks;
  general_session_installation receipt; general_console_identity console;
  general_enrollment_hello hello; general_initialization_plan original;
  char path[sizeof(((struct sockaddr_un *)0)->sun_path)], directory_path[PATH_MAX], request_ids[3][37];
  unsigned used; struct timespec started, last;
  bool (*current)(void *); void *context;
};
typedef struct { general_enrollment_client *owner; struct timespec started, last; bool (*additional)(void *); void *context; } io;
static bool same(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino && !((left->st_mode ^ right->st_mode) & S_IFMT);
}
static bool elapsed(struct timespec *last, const struct timespec *start, unsigned seconds) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 || now.tv_sec < last->tv_sec ||
      (now.tv_sec == last->tv_sec && now.tv_nsec < last->tv_nsec) || now.tv_sec < start->tv_sec ||
      now.tv_sec - start->tv_sec > seconds || (now.tv_sec - start->tv_sec == seconds && now.tv_nsec >= start->tv_nsec)) return false;
  *last = now; return true;
}
static bool directory_current(general_enrollment_client *owner) {
  struct stat actual; char path[PATH_MAX]; int flags = fcntl(owner->directory, F_GETFD);
  return owner->directory_known && flags >= 0 && (flags & FD_CLOEXEC) && !fstat(owner->directory, &actual) && same(&actual, &owner->directory_id) &&
    S_ISDIR(actual.st_mode) && actual.st_uid == 0 && actual.st_nlink > 0 && !(actual.st_mode & 07022) &&
    !fcntl(owner->directory, F_GETPATH, path) && !strcmp(path, owner->directory_path) && general_protected_acl_readonly(owner->directory);
}
static bool entry_current(general_enrollment_client *owner) {
  struct stat actual;
  if (!owner->entry_known || fstatat(owner->directory, "enrollment.sock", &actual, AT_SYMLINK_NOFOLLOW) ||
      !same(&actual, &owner->entry_id) || !S_ISSOCK(actual.st_mode) || actual.st_nlink != 1 || actual.st_uid != owner->console.uid ||
      actual.st_gid != owner->console.gid || (actual.st_mode & 07777) != 0600) return false;
  errno = 0;
  return general_protected_acl_consume_readonly(acl_get_link_np(owner->path, ACL_TYPE_EXTENDED)) &&
    !fstatat(owner->directory, "enrollment.sock", &actual, AT_SYMLINK_NOFOLLOW) && same(&actual, &owner->entry_id) &&
    actual.st_nlink == 1 && actual.st_uid == owner->console.uid && actual.st_gid == owner->console.gid && (actual.st_mode & 07777) == 0600;
}
static bool opening_current(void *context) {
  general_enrollment_client *owner = context;
  return elapsed(&owner->last, &owner->started, 30) && getuid() > 0 && geteuid() == getuid() &&
    owner->current(owner->context) && general_session_locks_current(owner->locks) && elapsed(&owner->last, &owner->started, 30);
}
static bool base_current(void *context) {
  general_enrollment_client *owner = context;
  return !owner->failed && !owner->poisoned && getuid() > 0 && getuid() == owner->console.uid && geteuid() == owner->console.uid &&
    elapsed(&owner->last, &owner->started, 360) && owner->current(owner->context) && general_session_locks_current(owner->locks) &&
    general_session_code_self(GENERAL_CODE_BROKER, &owner->receipt) && directory_current(owner) && entry_current(owner) && elapsed(&owner->last, &owner->started, 360);
}
static bool io_base(void *context) {
  io *op = context;
  return elapsed(&op->last, &op->started, 30) && (!op->additional || op->additional(op->context)) &&
    base_current(op->owner) && (!op->additional || op->additional(op->context)) && elapsed(&op->last, &op->started, 30);
}
static bool io_current(void *context) {
  io *op = context;
  return io_base(op) && general_channel_peer_current(op->owner->peer) && io_base(op);
}
static bool begin_io(general_enrollment_client *owner, io *op) {
  *op = (io){ .owner = owner };
  if (clock_gettime(CLOCK_MONOTONIC, &op->started)) return false;
  op->last = op->started;
  return io_base(op) && general_console_identity_matches(&owner->console, io_base, op);
}
static bool nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFD), status = fcntl(fd, F_GETFL);
  return flags >= 0 && status >= 0 && !fcntl(fd, F_SETFD, flags | FD_CLOEXEC) && !fcntl(fd, F_SETFL, status | O_NONBLOCK);
}
static bool close_connecting(general_enrollment_client *owner) {
  if (owner->connecting < 0) return true;
  struct stat actual;
  if (!owner->socket_known || fstat(owner->connecting, &actual) || !same(&actual, &owner->socket_id)) { owner->poisoned = true; return false; }
  int fd = owner->connecting; owner->connecting = -1;
  if (close(fd)) { owner->poisoned = true; return false; }
  return true;
}
static bool connect_root(general_enrollment_client *owner, io *op) {
  owner->connecting = socket(AF_UNIX, SOCK_STREAM, 0);
  if (owner->connecting < 0) return false;
  if (fstat(owner->connecting, &owner->socket_id)) { owner->poisoned = true; return false; }
  owner->socket_known = true;
  if (!nonblocking(owner->connecting) || !io_base(op)) return false;
  struct sockaddr_un address = { .sun_family = AF_UNIX }; strcpy(address.sun_path, owner->path);
  int result = connect(owner->connecting, (struct sockaddr *)&address, sizeof(address)), error = errno;
  if (result && error != EINPROGRESS) return false;
  unsigned interrupted = 0;
  while (result && io_base(op)) {
    struct pollfd state = { .fd = owner->connecting, .events = POLLOUT };
    int ready = poll(&state, 1, 50); error = errno;
    if (!io_base(op)) return false;
    if (ready < 0 && error == EINTR && ++interrupted <= 64) continue;
    if (ready < 0 || (state.revents & (POLLERR | POLLHUP | POLLNVAL))) return false;
    if (!ready) continue;
    if (!(state.revents & POLLOUT)) return false;
    socklen_t size = sizeof(error);
    if (getsockopt(owner->connecting, SOL_SOCKET, SO_ERROR, &error, &size) || size != sizeof(error) || error) return false;
    result = 0;
  }
  return !result && io_base(op) && general_channel_peer_open(owner->connecting, GENERAL_CHANNEL_BROKER_ROOT,
    &owner->receipt, base_current, owner, &owner->peer) && close_connecting(owner);
}
general_enrollment_client_result general_enrollment_client_open(int directory, general_session_locks *locks,
  const general_session_installation *receipt, bool (*current)(void *), void *context, general_enrollment_client **out) {
  if (directory < 0 || !locks || !receipt || !current || !out || *out || !getuid() || geteuid() != getuid()) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  general_enrollment_client *owner = calloc(1, sizeof(*owner)); if (!owner) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  owner->directory = owner->connecting = owner->channel = -1; owner->locks = locks; owner->receipt = *receipt; owner->current = current; owner->context = context;
  if (clock_gettime(CLOCK_MONOTONIC, &owner->started)) goto fail;
  owner->last = owner->started;
  if (!opening_current(owner) || !general_console_identity_read(opening_current, owner, &owner->console) || getuid() != owner->console.uid) goto fail;
  int length = snprintf(owner->directory_path, sizeof(owner->directory_path), "/Library/KoinCodeProtectedWallet/users/%u", owner->console.uid);
  if (length < 1 || length >= (int)sizeof(owner->directory_path)) goto fail;
  length = snprintf(owner->path, sizeof(owner->path), "%s/enrollment.sock", owner->directory_path);
  if (length < 1 || length >= (int)sizeof(owner->path)) goto fail;
  owner->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3); if (owner->directory < 0) goto fail;
  if (fstat(owner->directory, &owner->directory_id)) { owner->poisoned = true; goto fail; } owner->directory_known = true;
  if (!directory_current(owner) || fstatat(owner->directory, "enrollment.sock", &owner->entry_id, AT_SYMLINK_NOFOLLOW)) goto fail;
  owner->entry_known = true; io op;
  if (!begin_io(owner, &op)) goto fail;
  op.started = owner->started;
  if (!connect_root(owner, &op)) goto fail;
  owner->channel = general_channel_peer_borrow(owner->peer); owner->peer_loan = owner->channel >= 0;
  if (!owner->peer_loan) goto fail;
  general_session_frame frame = {0};
  general_session_frame_result read = general_session_frame_read(owner->channel, 30000, general_enrollment_hello_metadata_valid,
    &owner->hello, io_current, &op, &frame);
  bool valid = read == GENERAL_SESSION_FRAME_COMPLETE && !frame.value_size && owner->hello.uid == owner->console.uid &&
    !strcmp(owner->hello.installation_id, receipt->installation_id) && owner->hello.receipt_revision == (uint64_t)receipt->revision && io_current(&op);
  general_session_frame_clear(&frame);
  if (!valid) goto fail;
  owner->ready = true; *out = owner; return GENERAL_ENROLLMENT_CLIENT_READY;
fail:
  owner->failed = true;
  if (!general_enrollment_client_close(&owner)) { *out = owner; return GENERAL_ENROLLMENT_CLIENT_UNCERTAIN; }
  return GENERAL_ENROLLMENT_CLIENT_INVALID;
}
bool general_enrollment_client_hello(general_enrollment_client *owner, general_enrollment_hello *out) {
  if (!owner || !out || !owner->ready || !base_current(owner) || !general_channel_peer_current(owner->peer)) return false;
  *out = owner->hello; return true;
}
bool general_enrollment_client_borrow(general_enrollment_client *owner) {
  if (!owner || owner->borrowed || !owner->ready || !base_current(owner) || !general_channel_peer_current(owner->peer)) return false;
  owner->borrowed = true; return true;
}
bool general_enrollment_client_return(general_enrollment_client *owner) {
  if (!owner || !owner->borrowed) return false;
  owner->borrowed = false; return true;
}
static bool request_metadata(const unsigned char *bytes, size_t size, void *out) { return general_enrollment_request_parse(bytes, size, out); }
static bool idle(int fd) {
  unsigned char byte = 0; ssize_t size = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT); int error = errno;
  *(volatile unsigned char *)&byte = 0;
  return size < 0 && (error == EAGAIN || error == EWOULDBLOCK);
}
static general_enrollment_client_result request_frame(general_enrollment_client *owner,
  const general_enrollment_request *request, const unsigned char *value, size_t size, bool (*additional)(void *), void *context) {
  if (!owner || !owner->ready || owner->failed || owner->poisoned || !request || owner->used >= 3 || request->command != (general_enrollment_command)(owner->used + 1) ||
      !memchr(request->request_id, 0, sizeof(request->request_id)) || !general_session_uuid_valid(request->request_id)) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  for (unsigned i = 0; i < owner->used; i++) if (!strcmp(request->request_id, owner->request_ids[i])) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  general_enrollment_payload payload;
  if (!general_enrollment_payload_parse(request, value, size, owner->used ? &owner->original : NULL, &payload)) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  if (!owner->used && (payload.body.reserve.identity.uid != owner->console.uid || strcmp(payload.body.reserve.identity.installation_id, owner->receipt.installation_id))) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  const char *commands[] = { "reserve", "start_head", "assign" }; char metadata[256];
  int length = snprintf(metadata, sizeof(metadata), "{\"command\":\"%s\",\"format\":\"koincode-general-enrollment-request\",\"requestId\":\"%s\",\"version\":1}", commands[owner->used], request->request_id);
  general_enrollment_request parsed; general_session_wire wire = {0}; io op;
  if (length < 1 || length >= (int)sizeof(metadata) || !general_session_frame_encode((const unsigned char *)metadata, (size_t)length, value, size, request_metadata, &parsed, &wire)) return GENERAL_ENROLLMENT_CLIENT_INVALID;
  bool began = begin_io(owner, &op); op.additional = additional; op.context = context;
  if (!began || !io_current(&op) || !idle(owner->channel)) { general_session_wire_clear(&wire); owner->failed = true; return GENERAL_ENROLLMENT_CLIENT_UNCERTAIN; }
  int fd = -1;
  if (!owner->used) {
    fd = general_session_locks_borrow_owner(owner->locks); owner->lock_loan = fd >= 0;
    if (!owner->lock_loan) { general_session_wire_clear(&wire); owner->failed = true; return GENERAL_ENROLLMENT_CLIENT_UNCERTAIN; }
    owner->original = payload.body.reserve;
  }
  strcpy(owner->request_ids[owner->used++], request->request_id);
  general_session_frame_result sent = fd >= 0 ? general_session_frame_write_enrollment(owner->channel, fd, 30000, &wire, request_metadata, &parsed, io_current, &op) :
    general_session_frame_write(owner->channel, 30000, &wire, request_metadata, &parsed, io_current, &op);
  if (owner->lock_loan) { if (!general_session_locks_return_owner(owner->locks)) { owner->poisoned = true; return GENERAL_ENROLLMENT_CLIENT_UNCERTAIN; } owner->lock_loan = false; }
  if (sent != GENERAL_SESSION_FRAME_COMPLETE) { owner->failed = true; return GENERAL_ENROLLMENT_CLIENT_UNCERTAIN; }
  general_session_frame frame = {0}; general_enrollment_status status = GENERAL_ENROLLMENT_STATUS_NONE;
  general_enrollment_reply_validation validation = { .request = request, .status = &status };
  general_session_frame_result received = general_session_frame_read(owner->channel, 30000, general_enrollment_reply_metadata_valid, &validation, io_current, &op, &frame);
  bool valid = received == GENERAL_SESSION_FRAME_COMPLETE && !frame.value_size && status == GENERAL_ENROLLMENT_OK && io_current(&op) && idle(owner->channel);
  general_session_frame_clear(&frame);
  if (!valid) { owner->failed = true; return GENERAL_ENROLLMENT_CLIENT_UNCERTAIN; }
  return GENERAL_ENROLLMENT_CLIENT_READY;
}
general_enrollment_client_result general_enrollment_client_request(general_enrollment_client *owner,
  const general_enrollment_request *request, const unsigned char *value, size_t size) {
  return request_frame(owner, request, value, size, NULL, NULL);
}
general_enrollment_client_result general_enrollment_client_request_scoped(general_enrollment_client *owner,
  const general_enrollment_request *request, const unsigned char *value, size_t size, bool (*current)(void *), void *context) {
  return current ? request_frame(owner, request, value, size, current, context) : GENERAL_ENROLLMENT_CLIENT_INVALID;
}
bool general_enrollment_client_close(general_enrollment_client **pointer) {
  if (!pointer || !*pointer) return true;
  general_enrollment_client *owner = *pointer;
  if (owner->poisoned || owner->lock_loan || owner->borrowed) return false;
  owner->ready = false;
  if (owner->peer_loan) { if (!general_channel_peer_return(owner->peer)) { owner->poisoned = true; return false; } owner->peer_loan = false; owner->channel = -1; }
  if (!general_channel_peer_close(&owner->peer) || !close_connecting(owner)) { owner->poisoned = true; return false; }
  if (owner->directory >= 0) {
    struct stat actual;
    if (!owner->directory_known || fstat(owner->directory, &actual) || !same(&actual, &owner->directory_id)) { owner->poisoned = true; return false; }
    int fd = owner->directory; owner->directory = -1;
    if (close(fd)) { owner->poisoned = true; return false; }
  }
  free(owner); *pointer = NULL; return true;
}
