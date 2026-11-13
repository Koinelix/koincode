#include "host-bootstrap.h"
#include "bundle-resources.h"
#include "console-identity.h"
#include "protected-acl.h"
#include "session-code.h"
#include "trust.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef struct { int fd; struct stat identity; bool known; } descriptor;
struct general_host_bootstrap {
  descriptor nodes[4], receipt_file, installation_lock, pipe, socket;
  unsigned char receipt_bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t receipt_size;
  general_session_installation receipt; general_console_identity console;
  general_channel_peer *peer; pid_t parent; audit_token_t token;
  general_host_mode mode; bool ready, revoked, uncertain, running, loan, locked, code_checked;
  bool payment_owner; struct proc_bsdinfo parent_identity;
};
typedef struct { general_host_bootstrap *owner; struct timespec start, last; } operation;
static atomic_flag occupied = ATOMIC_FLAG_INIT;
static const char *const paths[] = { "/", "/Library", "/Library/KoinCodeProtectedWallet", "/Library/KoinCodeProtectedWallet/WalletHost.app" };
static const char *const names[] = { "", "Library", "KoinCodeProtectedWallet", "WalletHost.app" };
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino && !((a->st_mode ^ b->st_mode) & S_IFMT); }
static bool capture(descriptor *item, int fd) {
  item->fd = fd; if (fd < 0) return false;
  if (fstat(fd, &item->identity)) return false;
  item->known = true; return true;
}
static bool descriptor_current(const descriptor *item) {
  struct stat value; int flags;
  return item->fd >= 0 && item->known && !fstat(item->fd, &value) && same(&value, &item->identity) &&
    (flags = fcntl(item->fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC);
}
static bool protected(const descriptor *item, bool directory) {
  struct stat value;
  return descriptor_current(item) && !fstat(item->fd, &value) && value.st_uid == 0 && !(value.st_mode & 07022) &&
    (directory ? S_ISDIR(value.st_mode) && value.st_nlink > 0 : S_ISREG(value.st_mode) && value.st_nlink == 1) && general_protected_acl_readonly(item->fd);
}
static bool named(const descriptor *parent, const char *name, const descriptor *item, bool directory) {
  struct stat value;
  return protected(parent, true) && protected(item, directory) && !fstatat(parent->fd, name, &value, AT_SYMLINK_NOFOLLOW) && same(&value, &item->identity);
}
static bool release(general_host_bootstrap *owner, descriptor *item) {
  if (item->fd < 0) return true;
  if (!descriptor_current(item)) { owner->uncertain = true; return false; }
  int fd = item->fd; item->fd = -1;
  if (close(fd)) { owner->uncertain = true; return false; } return true;
}
static bool active(void *context) {
  operation *op = context; struct timespec now; general_host_bootstrap *owner = op->owner;
  if (owner->revoked || owner->uncertain || getuid() == 0 || geteuid() != getuid() || getppid() != owner->parent ||
      clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 || now.tv_sec < op->last.tv_sec ||
      (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  if (owner->payment_owner) {
    struct proc_bsdinfo actual;
    if (proc_pidinfo(owner->parent, PROC_PIDTBSDINFO, 0, &actual, sizeof(actual)) != sizeof(actual) || actual.pbi_uid != getuid() || actual.pbi_ruid != getuid() ||
        actual.pbi_start_tvsec != owner->parent_identity.pbi_start_tvsec || actual.pbi_start_tvusec != owner->parent_identity.pbi_start_tvusec) return false;
  }
  op->last = now;
  return now.tv_sec - op->start.tv_sec < 30 || (now.tv_sec - op->start.tv_sec == 30 && now.tv_nsec < op->start.tv_nsec);
}
static bool begin(general_host_bootstrap *owner, operation *op) {
  *op = (operation){ .owner = owner }; if (clock_gettime(CLOCK_MONOTONIC, &op->start)) return false;
  op->last = op->start; return active(op);
}
static bool wait_ready(operation *op, int fd, short events) {
  while (active(op)) {
    struct pollfd state = { .fd = fd, .events = events };
    int result = poll(&state, 1, 20);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 || state.revents & (POLLERR | POLLNVAL)) return false;
    if (result > 0) return (state.revents & (events | POLLHUP)) != 0;
  }
  return false;
}
static bool receive_bootstrap(operation *op, general_host_bootstrap_message *message) {
  general_host_bootstrap *owner = op->owner; int flags;
  /* Mark the inherited pipe before any later spawn can inherit it. A FIFO
   * descriptor is rendezvous input, not evidence about its original writer. */
  if (!capture(&owner->pipe, 3)) { if (owner->pipe.fd >= 0) owner->uncertain = true; return false; }
  if (!S_ISFIFO(owner->pipe.identity.st_mode) || owner->pipe.identity.st_uid != getuid() || owner->pipe.identity.st_nlink != 0 ||
      (flags = fcntl(3, F_GETFD)) < 0 || fcntl(3, F_SETFD, flags | FD_CLOEXEC) || (flags = fcntl(3, F_GETFL)) < 0 ||
      (flags & O_ACCMODE) != O_RDONLY || fcntl(3, F_SETFL, flags | O_NONBLOCK)) return false;
  unsigned char bytes[GENERAL_HOST_BOOTSTRAP_MAX + 1]; size_t used = 0; bool complete = false;
  while (used < sizeof(bytes) && wait_ready(op, 3, POLLIN)) {
    ssize_t count = read(3, bytes + used, sizeof(bytes) - used);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (!count) { complete = active(op) && general_host_bootstrap_parse(bytes, used, message); break; }
    if (count < 0) break;
    used += (size_t)count;
  }
  bool closed = release(owner, &owner->pipe); return complete && closed && active(op);
}
static bool read_receipt(operation *op, unsigned char *out, size_t *size) {
  general_host_bootstrap *owner = op->owner; struct stat value, after;
  if (!named(&owner->nodes[2], "installation.plist", &owner->receipt_file, false) || fstat(owner->receipt_file.fd, &value) ||
      value.st_size < 8 || value.st_size > GENERAL_SESSION_RECEIPT_MAX) return false;
  size_t length = (size_t)value.st_size, used = 0;
  while (used < length && active(op)) {
    ssize_t count = pread(owner->receipt_file.fd, out + used, length - used, (off_t)used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || (size_t)count > length - used) return false; used += (size_t)count;
  }
  if (used != length || !active(op) || fstat(owner->receipt_file.fd, &after) || !same(&after, &value) || after.st_size != value.st_size ||
      !named(&owner->nodes[2], "installation.plist", &owner->receipt_file, false)) return false;
  *size = length; return true;
}
static bool namespace_current(void *context) {
  general_host_bootstrap *owner = context; operation op;
  if (!begin(owner, &op)) return false;
  for (unsigned i = 0; i < 4; i++) {
    char actual[PATH_MAX];
    if (!protected(&owner->nodes[i], true) || fcntl(owner->nodes[i].fd, F_GETPATH, actual) || strcmp(actual, paths[i]) ||
        (i && !named(&owner->nodes[i - 1], names[i], &owner->nodes[i], true))) return false;
  }
  unsigned char bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t size;
  struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0, .l_pid = -1 };
  return owner->locked && named(&owner->nodes[2], "installation.lock", &owner->installation_lock, false) &&
    !fcntl(owner->installation_lock.fd, F_OFD_GETLK, &lock) && lock.l_type == F_RDLCK && lock.l_start == 0 && lock.l_len == 0 && lock.l_pid == -1 &&
    read_receipt(&op, bytes, &size) && size == owner->receipt_size && !memcmp(bytes, owner->receipt_bytes, size) &&
    general_console_identity_matches(&owner->console, active, &op) &&
    (!owner->code_checked || general_session_code_self(owner->payment_owner ? GENERAL_CODE_PAYMENT_OWNER : GENERAL_CODE_HOST, &owner->receipt)) && active(&op);
}
static bool connect_peer(operation *op, const general_host_bootstrap_message *message) {
  general_host_bootstrap *owner = op->owner; struct sockaddr_un address = { .sun_family = AF_UNIX };
  size_t length = strlen(message->path); address.sun_len = (unsigned char)(offsetof(struct sockaddr_un, sun_path) + length + 1);
  memcpy(address.sun_path, message->path, length + 1);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0), flags;
  if (!capture(&owner->socket, fd)) { if (fd >= 0) owner->uncertain = true; return false; }
  if ((flags = fcntl(fd, F_GETFD)) < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) || (flags = fcntl(fd, F_GETFL)) < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK)) return false;
  int result = connect(fd, (struct sockaddr *)&address, address.sun_len);
  if (result && errno != EINPROGRESS) return false;
  if (result) {
    int error = -1; socklen_t size = sizeof(error);
    if (!wait_ready(op, fd, POLLOUT) || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) || size != sizeof(error) || error) return false;
  }
  if (!active(op) || !general_channel_peer_open(fd, GENERAL_CHANNEL_HOST_BROKER, &owner->receipt, namespace_current, owner, &owner->peer) ||
      !general_channel_peer_token(owner->peer, &owner->token) || audit_token_to_pid(owner->token) != owner->parent || !namespace_current(owner)) return false;
  unsigned char greeting[GENERAL_HOST_GREETING_SIZE]; size_t used = 0;
  if (!general_host_greeting_encode(message->nonce, greeting)) return false;
  while (used < sizeof(greeting) && active(op) && general_channel_peer_current(owner->peer) && wait_ready(op, fd, POLLOUT)) {
    ssize_t count = send(fd, greeting + used, sizeof(greeting) - used, MSG_NOSIGNAL);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count <= 0 || (size_t)count > sizeof(greeting) - used) return false; used += (size_t)count;
  }
  return used == sizeof(greeting) && active(op) && general_channel_peer_current(owner->peer) && release(owner, &owner->socket);
}
static general_host_bootstrap_result bootstrap_open(general_host_bootstrap **out, bool payment_owner) {
  if (!out || *out || !getuid() || geteuid() != getuid() || getppid() <= 1 || atomic_flag_test_and_set(&occupied)) return GENERAL_HOST_BOOTSTRAP_UNAVAILABLE;
  general_host_bootstrap *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return GENERAL_HOST_BOOTSTRAP_UNAVAILABLE; }
  for (unsigned i = 0; i < 4; i++) owner->nodes[i].fd = -1;
  owner->receipt_file.fd = owner->installation_lock.fd = owner->pipe.fd = owner->socket.fd = -1; owner->parent = getppid();
  owner->payment_owner = payment_owner;
  if (payment_owner && (proc_pidinfo(owner->parent, PROC_PIDTBSDINFO, 0, &owner->parent_identity, sizeof(owner->parent_identity)) != sizeof(owner->parent_identity) ||
      owner->parent_identity.pbi_uid != getuid() || owner->parent_identity.pbi_ruid != getuid())) goto fail;
  operation op; general_host_bootstrap_message message = {0};
  if (!begin(owner, &op) || (!payment_owner && !receive_bootstrap(&op, &message))) goto fail;
  char executable[PROC_PIDPATHINFO_MAXSIZE];
  const char *expected = payment_owner ? GENERAL_TRUST_HOST "/Contents/Helpers/GeneralPaymentOwner.app/Contents/MacOS/GeneralPaymentOwner" : GENERAL_TRUST_EXECUTABLE;
  if (proc_pidpath(getpid(), executable, sizeof(executable)) <= 0 || strcmp(executable, expected) ||
      !general_console_identity_read(active, &op, &owner->console) || owner->console.uid != getuid()) goto fail;
  for (unsigned i = 0; i < 4; i++) {
    int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
    int fd = i ? openat(owner->nodes[i - 1].fd, names[i], flags) : open("/", flags);
    if (!capture(&owner->nodes[i], fd)) { if (fd >= 0) owner->uncertain = true; goto fail; }
    if (!active(&op) || !protected(&owner->nodes[i], true) || (i && !named(&owner->nodes[i - 1], names[i], &owner->nodes[i], true))) goto fail;
  }
  if (!capture(&owner->receipt_file, openat(owner->nodes[2].fd, "installation.plist", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))) {
    if (owner->receipt_file.fd >= 0) owner->uncertain = true; goto fail;
  }
  if (!read_receipt(&op, owner->receipt_bytes, &owner->receipt_size) || !general_parse_session_installation(owner->receipt_bytes, owner->receipt_size, &owner->receipt)) goto fail;
  if (!capture(&owner->installation_lock, openat(owner->nodes[2].fd, "installation.lock", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))) {
    if (owner->installation_lock.fd >= 0) owner->uncertain = true; goto fail;
  }
  if (!named(&owner->nodes[2], "installation.lock", &owner->installation_lock, false) || !active(&op) || flock(owner->installation_lock.fd, LOCK_SH | LOCK_NB)) goto fail;
  owner->locked = true;
  if (!namespace_current(owner) || !general_session_code_self(payment_owner ? GENERAL_CODE_PAYMENT_OWNER : GENERAL_CODE_HOST, &owner->receipt)) goto fail;
  owner->code_checked = true;
  general_bundle_resource_result checked = general_bundle_resources_check(&owner->receipt, namespace_current, owner);
  if (checked == GENERAL_BUNDLE_RESOURCE_UNCERTAIN) { owner->uncertain = true; goto fail; }
  if (checked != GENERAL_BUNDLE_RESOURCE_CHECKED || !active(&op) || (!payment_owner && !connect_peer(&op, &message))) goto fail;
  owner->mode = message.mode; owner->ready = true;
  if (!general_host_bootstrap_current(owner) || !active(&op)) goto fail;
  *out = owner; return GENERAL_HOST_BOOTSTRAP_READY;
fail:
  if (!general_host_bootstrap_close(&owner)) { *out = owner; return GENERAL_HOST_BOOTSTRAP_UNCERTAIN; }
  return GENERAL_HOST_BOOTSTRAP_UNAVAILABLE;
}
general_host_bootstrap_result general_host_bootstrap_open(general_host_bootstrap **out) { return bootstrap_open(out, false); }
general_host_bootstrap_result general_payment_owner_bootstrap_open(general_host_bootstrap **out) { return bootstrap_open(out, true); }
bool general_host_bootstrap_current(general_host_bootstrap *owner) {
  if (!owner || !owner->ready || owner->running || owner->revoked || owner->uncertain) return false;
  owner->running = true; audit_token_t token;
  bool valid = namespace_current(owner) && (owner->payment_owner || (general_channel_peer_token(owner->peer, &token) && !memcmp(&token, &owner->token, sizeof(token)))) && getppid() == owner->parent;
  owner->running = false; if (!valid) owner->revoked = true; return valid;
}
bool general_host_bootstrap_info(general_host_bootstrap *owner, general_host_mode *mode, general_session_installation *receipt) {
  if (!mode || !receipt || !general_host_bootstrap_current(owner) || owner->payment_owner) return false;
  *mode = owner->mode; *receipt = owner->receipt; return true;
}
bool general_payment_owner_bootstrap_info(general_host_bootstrap *owner, general_session_installation *receipt) {
  if (!receipt || !general_host_bootstrap_current(owner) || !owner->payment_owner) return false;
  *receipt = owner->receipt; return true;
}
int general_host_bootstrap_borrow(general_host_bootstrap *owner) {
  if (!general_host_bootstrap_current(owner) || owner->payment_owner || owner->loan) return -1;
  int fd = general_channel_peer_borrow(owner->peer); if (fd >= 0) owner->loan = true; return fd;
}
bool general_host_bootstrap_return(general_host_bootstrap *owner) {
  if (!owner || !owner->loan || owner->running || owner->uncertain || !general_channel_peer_return(owner->peer)) return false;
  owner->loan = false; return true;
}
void general_host_bootstrap_invalidate(general_host_bootstrap *owner) { if (owner) owner->revoked = true; }
bool general_host_bootstrap_close(general_host_bootstrap **pointer) {
  if (!pointer || !*pointer) return true;
  general_host_bootstrap *owner = *pointer;
  if (owner->uncertain || owner->running || owner->loan) return false;
  owner->revoked = true; owner->ready = false;
  if (!general_channel_peer_close(&owner->peer) || !release(owner, &owner->socket) || !release(owner, &owner->pipe) ||
      !release(owner, &owner->receipt_file) || !release(owner, &owner->installation_lock)) return false;
  for (unsigned step = 0; step < 4; step++) if (!release(owner, &owner->nodes[3 - step])) return false;
  free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
