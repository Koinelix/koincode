#include "session-ingress.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

typedef enum { METADATA_LENGTH, METADATA, VALUE_LENGTH, VALUE, READY, STOPPED } phase;
struct general_session_rights { int database, writer_lease; bool borrowed, uncertain; };
struct general_session_ingress {
  int fd; struct stat identity; bool (*current)(void *); void *context;
  struct timespec last, started; bool began, running, fatal;
  phase phase; unsigned interrupted; size_t used;
  unsigned char header[4]; general_session_frame frame; general_session_request request;
  general_session_ingress_result result;
  general_session_rights *rights;
};
bool general_session_rights_borrow(general_session_rights *owner, int *database, int *writer_lease) {
  if (!owner || owner->borrowed || owner->uncertain || !database || !writer_lease) return false;
  owner->borrowed = true; *database = owner->database; *writer_lease = owner->writer_lease; return true;
}
bool general_session_rights_return(general_session_rights *owner) {
  if (!owner || !owner->borrowed || owner->uncertain) return false;
  owner->borrowed = false; return true;
}
bool general_session_rights_close(general_session_rights **pointer) {
  if (!pointer || !*pointer) return true;
  general_session_rights *owner = *pointer;
  if (owner->borrowed || owner->uncertain) return false;
  if (close(owner->database)) { owner->uncertain = true; return false; }
  owner->database = -1;
  if (close(owner->writer_lease)) { owner->uncertain = true; return false; }
  free(owner); *pointer = NULL; return true;
}
static bool descriptor(general_session_ingress *owner) {
  struct stat actual; int flags, type; socklen_t size = sizeof(type); struct sockaddr_un address; socklen_t address_size = sizeof(address);
  return !fstat(owner->fd, &actual) && S_ISSOCK(actual.st_mode) && actual.st_dev == owner->identity.st_dev && actual.st_ino == owner->identity.st_ino &&
    (flags = fcntl(owner->fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) && (flags = fcntl(owner->fd, F_GETFL)) >= 0 && (flags & O_NONBLOCK) &&
    !getsockopt(owner->fd, SOL_SOCKET, SO_TYPE, &type, &size) && size == sizeof(type) && type == SOCK_STREAM &&
    !getsockname(owner->fd, (struct sockaddr *)&address, &address_size) && address_size >= 2 && address_size <= sizeof(address) && address.sun_family == AF_UNIX;
}
static bool stamp(struct timespec *out, const struct timespec *before) {
  return !clock_gettime(CLOCK_MONOTONIC, out) && out->tv_sec >= 0 && out->tv_nsec >= 0 && out->tv_nsec < 1000000000 &&
    (!before || out->tv_sec > before->tv_sec || (out->tv_sec == before->tv_sec && out->tv_nsec >= before->tv_nsec));
}
static general_session_ingress_result checkpoint(general_session_ingress *owner) {
  struct timespec before, after;
  if (!stamp(&before, &owner->last)) return GENERAL_INGRESS_IO_ERROR;
  if (!owner->current(owner->context)) return GENERAL_INGRESS_CANCELED;
  if (!descriptor(owner) || !stamp(&after, &before)) return GENERAL_INGRESS_IO_ERROR;
  owner->last = after;
  if (owner->began && (after.tv_sec - owner->started.tv_sec > 30 ||
      (after.tv_sec - owner->started.tv_sec == 30 && after.tv_nsec >= owner->started.tv_nsec))) return GENERAL_INGRESS_TIMEOUT;
  return GENERAL_INGRESS_WAIT;
}
static general_session_ingress_result stop(general_session_ingress *owner, general_session_ingress_result result) {
  if (!general_session_rights_close(&owner->rights)) result = GENERAL_INGRESS_FATAL;
  owner->phase = STOPPED; owner->result = result; owner->fatal = result == GENERAL_INGRESS_FATAL;
  general_session_frame_clear(&owner->frame); general_session_request_clear(&owner->request); memset(owner->header, 0, sizeof(owner->header));
  return result;
}
general_session_ingress *general_session_ingress_create(int fd, bool (*current)(void *), void *context) {
  if (fd < 0 || !current) return NULL;
  general_session_ingress *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  owner->fd = fd; owner->current = current; owner->context = context;
  if (fstat(fd, &owner->identity) || !stamp(&owner->last, NULL) || checkpoint(owner) != GENERAL_INGRESS_WAIT) { free(owner); return NULL; }
  return owner;
}
static uint32_t number(const unsigned char bytes[4]) { return (uint32_t)bytes[0] << 24 | (uint32_t)bytes[1] << 16 | (uint32_t)bytes[2] << 8 | bytes[3]; }
static general_session_ingress_result controls(general_session_ingress *owner, struct msghdr *message, size_t capacity) {
  bool fatal = (message->msg_flags & MSG_CTRUNC) || message->msg_controllen > capacity;
  if (message->msg_controllen > capacity) message->msg_controllen = capacity;
  bool seen = false, invalid = (message->msg_flags & MSG_TRUNC) != 0;
  unsigned items = 0, count = 0; int passed_pair[2] = { -1, -1 };
  for (struct cmsghdr *item = CMSG_FIRSTHDR(message); item; item = CMSG_NXTHDR(message, item)) {
    seen = true;
    items++;
    size_t offset = (size_t)((unsigned char *)item - (unsigned char *)message->msg_control);
    if (item->cmsg_len < CMSG_LEN(0) || offset > message->msg_controllen || item->cmsg_len > message->msg_controllen - offset) { fatal = true; break; }
    if (item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS) { invalid = true; continue; }
    size_t size = item->cmsg_len - CMSG_LEN(0);
    if (!size || size % sizeof(int)) fatal = true;
    for (size_t offset = 0; offset + sizeof(int) <= size; offset += sizeof(int)) {
      int passed; memcpy(&passed, (unsigned char *)CMSG_DATA(item) + offset, sizeof(passed));
      if (passed < 0) { fatal = true; continue; }
      int flags = fcntl(passed, F_GETFD);
      if (flags < 0 || fcntl(passed, F_SETFD, flags | FD_CLOEXEC)) fatal = true;
      if (count < 2) passed_pair[count] = passed;
      else { invalid = true; if (close(passed)) fatal = true; }
      count++;
    }
  }
  if (message->msg_controllen && !seen) fatal = true;
  if (!seen) return fatal ? GENERAL_INGRESS_FATAL : invalid ? GENERAL_INGRESS_INVALID : GENERAL_INGRESS_WAIT;
  bool allowed = !fatal && !invalid && items == 1 && count == 2 && owner->phase == METADATA_LENGTH && !owner->used && !owner->began && !owner->rights;
  if (allowed) {
    owner->rights = calloc(1, sizeof(*owner->rights));
    if (owner->rights) { owner->rights->database = passed_pair[0]; owner->rights->writer_lease = passed_pair[1]; return GENERAL_INGRESS_WAIT; }
  }
  for (unsigned i = 0; i < 2; i++) if (passed_pair[i] >= 0 && close(passed_pair[i])) fatal = true;
  return fatal ? GENERAL_INGRESS_FATAL : GENERAL_INGRESS_INVALID;
}
general_session_ingress_result general_session_ingress_step(general_session_ingress *owner) {
  if (!owner || owner->running) return GENERAL_INGRESS_INVALID;
  if (owner->phase == STOPPED) return owner->result;
  owner->running = true;
  general_session_ingress_result result = checkpoint(owner);
  if (result != GENERAL_INGRESS_WAIT) goto failed;
  if (owner->phase == READY) { result = GENERAL_INGRESS_READY; goto done; }
  unsigned char *target = owner->phase == METADATA ? owner->frame.metadata : owner->phase == VALUE ? owner->frame.value : owner->header;
  size_t size = owner->phase == METADATA ? owner->frame.metadata_size : owner->phase == VALUE ? owner->frame.value_size : 4;
  if (!target || owner->used >= size) { result = GENERAL_INGRESS_INVALID; goto failed; }
  size -= owner->used; if (size > 65536) size = 65536;
  /* Retain every known installed fd, including rejected ancillary records. */
  union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(512 * sizeof(uint64_t))]; } control;
  memset(&control, 0, sizeof(control));
  struct iovec buffer = { .iov_base = target + owner->used, .iov_len = size };
  struct msghdr message = { .msg_iov = &buffer, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
  ssize_t count = recvmsg(owner->fd, &message, MSG_DONTWAIT);
  if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || (errno == EINTR && ++owner->interrupted <= 64))) goto done;
  if (count < 0) { result = GENERAL_INGRESS_IO_ERROR; goto failed; }
  result = controls(owner, &message, sizeof(control.bytes)); if (result != GENERAL_INGRESS_WAIT) goto failed;
  if (!count) { result = !owner->began ? GENERAL_INGRESS_EOF : GENERAL_INGRESS_INVALID; goto failed; }
  if ((size_t)count > size) { result = GENERAL_INGRESS_IO_ERROR; goto failed; }
  if (!owner->began) { owner->started = owner->last; owner->began = true; }
  owner->used += (size_t)count;
  result = checkpoint(owner); if (result != GENERAL_INGRESS_WAIT) goto failed;
  size_t total = owner->phase == METADATA ? owner->frame.metadata_size : owner->phase == VALUE ? owner->frame.value_size : 4;
  if (owner->used != total) goto done;
  owner->used = 0;
  switch (owner->phase) {
    case METADATA_LENGTH:
      owner->frame.metadata_size = number(owner->header);
      if (!owner->frame.metadata_size || owner->frame.metadata_size > GENERAL_SESSION_METADATA_MAX) { result = GENERAL_INGRESS_INVALID; goto failed; }
      owner->frame.metadata = calloc(1, owner->frame.metadata_size);
      if (!owner->frame.metadata) { result = GENERAL_INGRESS_IO_ERROR; goto failed; }
      owner->phase = METADATA; break;
    case METADATA:
      if (!general_session_parse_request(owner->frame.metadata, owner->frame.metadata_size, &owner->request)) { result = GENERAL_INGRESS_INVALID; goto failed; }
      if (owner->rights && (owner->request.command != GENERAL_SESSION_RESOURCE || owner->request.body.resource.action != GENERAL_RESOURCE_COMMIT)) { result = GENERAL_INGRESS_INVALID; goto failed; }
      memset(owner->header, 0, sizeof(owner->header)); owner->phase = VALUE_LENGTH; break;
    case VALUE_LENGTH:
      owner->frame.value_size = number(owner->header);
      if (!general_session_request_accepts_value(&owner->request, owner->frame.value_size)) { result = GENERAL_INGRESS_INVALID; goto failed; }
      if (owner->frame.value_size) {
        owner->frame.value = calloc(1, owner->frame.value_size);
        if (!owner->frame.value) { result = GENERAL_INGRESS_IO_ERROR; goto failed; }
        owner->phase = VALUE; break;
      }
      owner->phase = READY; result = GENERAL_INGRESS_READY; break;
    case VALUE: owner->phase = READY; result = GENERAL_INGRESS_READY; break;
    default: result = GENERAL_INGRESS_INVALID; goto failed;
  }
  goto done;
failed: result = stop(owner, result);
done: owner->running = false; return result;
}
bool general_session_ingress_take_with_rights(general_session_ingress *owner, general_session_request *request, general_session_frame *frame, general_session_rights **rights) {
  if (!owner || owner->running || owner->phase != READY || !request || !frame || frame->metadata || frame->metadata_size || frame->value || frame->value_size ||
      (rights && *rights) || (owner->rights && !rights)) return false;
  owner->running = true; general_session_ingress_result result = checkpoint(owner);
  if (result != GENERAL_INGRESS_WAIT) { stop(owner, result); owner->running = false; return false; }
  *request = owner->request; *frame = owner->frame; memset(&owner->frame, 0, sizeof(owner->frame));
  if (rights) { *rights = owner->rights; owner->rights = NULL; }
  general_session_request_clear(&owner->request); memset(owner->header, 0, sizeof(owner->header));
  owner->phase = METADATA_LENGTH; owner->began = false; owner->interrupted = 0; owner->used = 0; owner->running = false; return true;
}
bool general_session_ingress_take(general_session_ingress *owner, general_session_request *request, general_session_frame *frame) {
  return general_session_ingress_take_with_rights(owner, request, frame, NULL);
}
bool general_session_ingress_close(general_session_ingress **pointer) {
  if (!pointer || !*pointer) return true;
  general_session_ingress *owner = *pointer; if (owner->running || owner->fatal) return false;
  if (!general_session_rights_close(&owner->rights)) { owner->fatal = true; return false; }
  general_session_frame_clear(&owner->frame); general_session_request_clear(&owner->request); memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; return true;
}
