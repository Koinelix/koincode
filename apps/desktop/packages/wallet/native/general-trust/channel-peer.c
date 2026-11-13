#include "channel-peer.h"
#include "console-identity.h"
#include "session-code.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

struct general_channel_peer {
  int fd; struct stat identity; bool known, ready, loan, uncertain, checking;
  general_channel_role role; general_session_installation receipt;
  general_console_identity console; audit_token_t token;
  bool (*current)(void *); void *context;
};
typedef struct { general_channel_peer *owner; struct timespec started, last; } operation;
static bool active(void *context) {
  operation *op = context; struct timespec now;
  if (!op->owner->current(op->owner->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now; time_t seconds = now.tv_sec - op->started.tv_sec;
  return seconds >= 0 && (seconds < 30 || (seconds == 30 && now.tv_nsec < op->started.tv_nsec));
}
static bool local_identity(general_channel_peer *owner) {
  uid_t uid = getuid();
  return geteuid() == uid && (owner->role == GENERAL_CHANNEL_ROOT_BROKER ? uid == 0 : uid == owner->console.uid && uid > 0 && uid < UINT32_MAX);
}
static bool connected(int fd, short events) {
  if (events & (POLLHUP | POLLERR | POLLNVAL)) return false;
  if (!(events & POLLIN)) return true;
  unsigned char byte = 0;
  ssize_t count = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
  int error = errno; *(volatile unsigned char *)&byte = 0;
  return count > 0 || (count < 0 && (error == EAGAIN || error == EWOULDBLOCK));
}
static bool descriptor(general_channel_peer *owner) {
  struct stat value; int fd_flags, status; struct sockaddr_un address; socklen_t size = sizeof(address);
  int type; socklen_t type_size = sizeof(type);
  struct pollfd state = { .fd = owner->fd, .events = POLLIN | POLLHUP };
  return owner->known && fstat(owner->fd, &value) == 0 && S_ISSOCK(value.st_mode) && value.st_dev == owner->identity.st_dev && value.st_ino == owner->identity.st_ino &&
    (fd_flags = fcntl(owner->fd, F_GETFD)) >= 0 && (fd_flags & FD_CLOEXEC) && (status = fcntl(owner->fd, F_GETFL)) >= 0 && (status & O_NONBLOCK) &&
    getsockname(owner->fd, (struct sockaddr *)&address, &size) == 0 && size >= 2 && size <= sizeof(address) && address.sun_family == AF_UNIX &&
    getsockopt(owner->fd, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0 && type_size == sizeof(type) && type == SOCK_STREAM &&
    poll(&state, 1, 0) >= 0 && connected(owner->fd, state.revents);
}
static bool peer_identity(general_channel_peer *owner, audit_token_t *token) {
  uid_t uid; gid_t gid; socklen_t size = sizeof(*token);
  uid_t expected = owner->role == GENERAL_CHANNEL_BROKER_ROOT ? 0 : owner->console.uid;
  return getpeereid(owner->fd, &uid, &gid) == 0 && uid == expected &&
    getsockopt(owner->fd, SOL_LOCAL, LOCAL_PEERTOKEN, token, &size) == 0 && size == sizeof(*token) &&
    audit_token_to_euid(*token) == expected && audit_token_to_ruid(*token) == expected && audit_token_to_egid(*token) == gid &&
    audit_token_to_rgid(*token) == gid && audit_token_to_pid(*token) > 0;
}
static bool code_matches(general_channel_peer *owner, const audit_token_t *token) {
  general_session_code_role remote = owner->role == GENERAL_CHANNEL_BROKER_HOST ? GENERAL_CODE_HOST : owner->role == GENERAL_CHANNEL_BROKER_ROOT ? GENERAL_CODE_PROVISIONER :
    owner->role == GENERAL_CHANNEL_BROKER_PAYMENT_OWNER ? GENERAL_CODE_PAYMENT_OWNER : GENERAL_CODE_BROKER;
  general_session_code_role local = owner->role == GENERAL_CHANNEL_ROOT_BROKER ? GENERAL_CODE_PROVISIONER : owner->role == GENERAL_CHANNEL_HOST_BROKER ? GENERAL_CODE_HOST :
    owner->role == GENERAL_CHANNEL_PAYMENT_OWNER_BROKER ? GENERAL_CODE_PAYMENT_OWNER : GENERAL_CODE_BROKER;
  if (!general_session_code_self(local, &owner->receipt)) return false;
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)token, sizeof(*token));
  if (!data) return false;
  const void *keys[] = { kSecGuestAttributeAudit }, *values[] = { data };
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  bool valid = attributes && SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) == errSecSuccess && code && general_session_code_matches(code, remote, &owner->receipt);
  if (code) CFRelease(code);
  if (attributes) CFRelease(attributes);
  CFRelease(data); return valid;
}
bool general_channel_peer_current(general_channel_peer *owner) {
  if (!owner || !owner->ready || owner->uncertain || owner->checking) return false;
  owner->checking = true; operation op = { .owner = owner }; bool valid = false;
  if (clock_gettime(CLOCK_MONOTONIC, &op.started)) goto done;
  op.last = op.started; audit_token_t token, after;
  valid = active(&op) && local_identity(owner) && descriptor(owner) && peer_identity(owner, &token) && !memcmp(&token, &owner->token, sizeof(token)) &&
    general_console_identity_matches(&owner->console, active, &op) && active(&op) && code_matches(owner, &token) && active(&op) &&
    local_identity(owner) && descriptor(owner) && peer_identity(owner, &after) && !memcmp(&after, &owner->token, sizeof(after));
done:
  owner->checking = false; return valid;
}
bool general_channel_peer_role_current(general_channel_peer *owner, general_channel_role role) {
  return owner && owner->role == role && general_channel_peer_current(owner);
}
bool general_channel_peer_open(int socket, general_channel_role role, const general_session_installation *receipt,
  bool (*current)(void *), void *context, general_channel_peer **out) {
  if (socket < 0 || role < GENERAL_CHANNEL_BROKER_HOST || role > GENERAL_CHANNEL_PAYMENT_OWNER_BROKER || !receipt || !current || !out || *out) return false;
  general_channel_peer *owner = calloc(1, sizeof(*owner));
  if (!owner) return false;
  owner->fd = -1; owner->role = role; owner->receipt = *receipt; owner->current = current; owner->context = context;
  operation op = { .owner = owner };
  if (clock_gettime(CLOCK_MONOTONIC, &op.started)) goto fail;
  op.last = op.started;
  if (!active(&op) || !general_console_identity_read(active, &op, &owner->console) || !local_identity(owner)) goto fail;
  owner->fd = fcntl(socket, F_DUPFD_CLOEXEC, 3);
  if (owner->fd < 0) goto fail;
  if (fstat(owner->fd, &owner->identity)) { owner->uncertain = true; goto fail; }
  owner->known = true;
  if (!active(&op) || !descriptor(owner) || !peer_identity(owner, &owner->token)) goto fail;
  owner->ready = true;
  if (!general_channel_peer_current(owner) || !active(&op)) goto fail;
  *out = owner; return true;
fail:
  owner->ready = false;
  if (!general_channel_peer_close(&owner)) *out = owner;
  return false;
}
bool general_channel_peer_token(general_channel_peer *owner, audit_token_t *out) {
  if (!out || !general_channel_peer_current(owner)) return false;
  *out = owner->token; return true;
}
int general_channel_peer_borrow(general_channel_peer *owner) {
  if (!general_channel_peer_current(owner) || owner->loan) return -1;
  owner->loan = true; return owner->fd;
}
bool general_channel_peer_return(general_channel_peer *owner) {
  if (!owner || !owner->loan || owner->checking) return false;
  owner->loan = false; return true;
}
bool general_channel_peer_close(general_channel_peer **pointer) {
  if (!pointer || !*pointer) return true;
  general_channel_peer *owner = *pointer;
  if (owner->uncertain || owner->loan || owner->checking) return false;
  owner->ready = false;
  if (owner->fd >= 0) {
    struct stat value;
    if (!owner->known || fstat(owner->fd, &value) || !S_ISSOCK(value.st_mode) || value.st_dev != owner->identity.st_dev || value.st_ino != owner->identity.st_ino) { owner->uncertain = true; return false; }
    int fd = owner->fd; owner->fd = -1;
    if (close(fd)) { owner->uncertain = true; return false; }
  }
  free(owner); *pointer = NULL; return true;
}
