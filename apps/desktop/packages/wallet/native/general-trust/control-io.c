#include "control-io.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
struct general_control_io {
  struct stat input, output; struct proc_bsdinfo parent; pid_t parent_pid;
  int queue, private_descriptor; bool known, closed, partial;
  atomic_bool revoked, uncertain;
  unsigned char header[4], body[GENERAL_CONTROL_INPUT_MAX]; size_t header_used, body_used, length;
  double start, last;
};
static double now(void) { struct timespec value; return clock_gettime(CLOCK_MONOTONIC, &value) ? -1 : (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0; }
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT); }
static bool descriptor(int fd, const struct stat *expected) {
  struct stat actual; int flags;
  return !fstat(fd, &actual) && same(&actual, expected) && (S_ISFIFO(actual.st_mode) || S_ISSOCK(actual.st_mode)) &&
    (flags = fcntl(fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) && (flags = fcntl(fd, F_GETFL)) >= 0 && (flags & O_NONBLOCK);
}
bool general_control_io_current(general_control_io *owner) {
  if (!owner || atomic_load(&owner->revoked) || owner->closed || owner->uncertain || !owner->known || getppid() != owner->parent_pid) return false;
  struct proc_bsdinfo parent;
  return proc_pidinfo(owner->parent_pid, PROC_PIDTBSDINFO, 0, &parent, sizeof(parent)) == sizeof(parent) &&
    parent.pbi_pid == (uint32_t)owner->parent_pid && parent.pbi_uid == owner->parent.pbi_uid && parent.pbi_ruid == owner->parent.pbi_ruid &&
    parent.pbi_start_tvsec == owner->parent.pbi_start_tvsec && parent.pbi_start_tvusec == owner->parent.pbi_start_tvusec &&
    descriptor(STDIN_FILENO, &owner->input) && descriptor(STDOUT_FILENO, &owner->output);
}
general_control_io *general_control_io_open(void) {
  if (!getuid() || getuid() != geteuid() || getppid() <= 1) return NULL;
  general_control_io *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  atomic_init(&owner->revoked, false); atomic_init(&owner->uncertain, false);
  owner->queue = -1; owner->private_descriptor = -1; owner->parent_pid = getppid();
  if (fstat(STDIN_FILENO, &owner->input) || fstat(STDOUT_FILENO, &owner->output) ||
      !(S_ISFIFO(owner->input.st_mode) || S_ISSOCK(owner->input.st_mode)) || !(S_ISFIFO(owner->output.st_mode) || S_ISSOCK(owner->output.st_mode)) ||
      proc_pidinfo(owner->parent_pid, PROC_PIDTBSDINFO, 0, &owner->parent, sizeof(owner->parent)) != sizeof(owner->parent) ||
      owner->parent.pbi_uid != getuid() || owner->parent.pbi_ruid != getuid()) goto failed;
  for (int fd = STDIN_FILENO; fd <= STDOUT_FILENO; fd++) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) || fcntl(fd, F_SETFD, FD_CLOEXEC)) goto failed;
  }
  owner->queue = kqueue();
  if (owner->queue < 0 || fcntl(owner->queue, F_SETFD, FD_CLOEXEC)) goto failed;
  struct kevent changes[3];
  EV_SET(&changes[0], STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
  EV_SET(&changes[1], owner->parent_pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  EV_SET(&changes[2], 1, EVFILT_USER, EV_ADD | EV_CLEAR, 0, 0, NULL);
  if (kevent(owner->queue, changes, 3, NULL, 0, NULL)) goto failed;
  owner->known = true; owner->last = now();
  if (owner->last < 0 || !general_control_io_current(owner)) goto failed;
  signal(SIGPIPE, SIG_IGN); return owner;
failed:
  if (owner->queue >= 0) close(owner->queue);
  free(owner); return NULL;
}
static bool time_current(general_control_io *owner) {
  double value = now();
  if (value < owner->last || !general_control_io_current(owner) || (owner->partial && value - owner->start >= 30)) return false;
  owner->last = value; return true;
}
bool general_control_io_wait(general_control_io *owner, int private_fd, unsigned maximum_ms) {
  if (!owner || private_fd < -1 || maximum_ms > 30000 || !time_current(owner)) return false;
  if (owner->private_descriptor >= 0 && owner->private_descriptor != private_fd) {
    struct kevent change; EV_SET(&change, owner->private_descriptor, EVFILT_READ, EV_DELETE, 0, 0, NULL);
    if (kevent(owner->queue, &change, 1, NULL, 0, NULL) && errno != ENOENT && errno != EBADF) return false;
  }
  owner->private_descriptor = private_fd;
  if (private_fd >= 0) {
    struct kevent change; EV_SET(&change, private_fd, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
    if (kevent(owner->queue, &change, 1, NULL, 0, NULL)) return false;
  }
  struct timespec timeout, *bound = NULL;
  double milliseconds = maximum_ms;
  if (owner->partial) {
    double remaining = (owner->start + 30 - owner->last) * 1000;
    if (remaining <= 0) return false;
    if (!maximum_ms || remaining < milliseconds) milliseconds = remaining;
  }
  if (milliseconds > 0) { timeout.tv_sec = (time_t)(milliseconds / 1000); timeout.tv_nsec = (long)((milliseconds - (double)timeout.tv_sec * 1000) * 1000000); bound = &timeout; }
  struct kevent events[3]; int result = kevent(owner->queue, NULL, 0, events, 3, bound);
  if (result < 0) return errno == EINTR && time_current(owner);
  for (int i = 0; i < result; i++) if (events[i].filter == EVFILT_PROC || events[i].filter == EVFILT_USER || (events[i].flags & EV_ERROR)) return false;
  return time_current(owner);
}
static ssize_t receive_public(general_control_io *owner, void *bytes, size_t size) {
  if (S_ISFIFO(owner->input.st_mode)) return read(STDIN_FILENO, bytes, size);
  union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(128 * sizeof(int))]; } controls;
  memset(&controls, 0, sizeof(controls)); struct iovec vector = { bytes, size };
  struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1, .msg_control = controls.bytes, .msg_controllen = sizeof(controls.bytes) };
  ssize_t count = recvmsg(STDIN_FILENO, &message, MSG_DONTWAIT);
  if (count < 0) return count;
  bool invalid = message.msg_controllen != 0 || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC));
  if ((message.msg_flags & MSG_CTRUNC) || message.msg_controllen > sizeof(controls.bytes)) owner->uncertain = true;
  if (message.msg_controllen > sizeof(controls.bytes)) message.msg_controllen = sizeof(controls.bytes);
  for (struct cmsghdr *item = CMSG_FIRSTHDR(&message); item; item = CMSG_NXTHDR(&message, item)) {
    size_t offset = (size_t)((unsigned char *)item - controls.bytes);
    if (offset > message.msg_controllen || item->cmsg_len < CMSG_LEN(0) || item->cmsg_len > message.msg_controllen - offset) { owner->uncertain = true; break; }
    if (item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS) continue;
    size_t length = item->cmsg_len - CMSG_LEN(0); if (length % sizeof(int)) owner->uncertain = true;
    for (size_t i = 0; i + sizeof(int) <= length; i += sizeof(int)) {
      int fd; memcpy(&fd, (unsigned char *)CMSG_DATA(item) + i, sizeof(fd));
      if (fd < 0 || close(fd)) owner->uncertain = true;
    }
  }
  if (invalid) { errno = EPROTO; return -1; }
  return count;
}
general_control_io_result general_control_io_read(general_control_io *owner, unsigned char output[GENERAL_CONTROL_INPUT_MAX], size_t *size) {
  if (!owner || !output || !size || !time_current(owner)) return GENERAL_CONTROL_IO_INVALID;
  for (unsigned attempts = 0; attempts < 64; attempts++) {
    unsigned char *target = owner->header_used < 4 ? owner->header + owner->header_used : owner->body + owner->body_used;
    size_t wanted = owner->header_used < 4 ? 4 - owner->header_used : owner->length - owner->body_used;
    ssize_t count = receive_public(owner, target, wanted);
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return GENERAL_CONTROL_IO_WAIT;
    if (count < 0 && errno == EINTR) { if (!time_current(owner)) return GENERAL_CONTROL_IO_INVALID; continue; }
    if (count < 0 || (size_t)count > wanted) return owner->uncertain ? GENERAL_CONTROL_IO_UNCERTAIN : GENERAL_CONTROL_IO_INVALID;
    if (!count) return owner->partial ? GENERAL_CONTROL_IO_INVALID : GENERAL_CONTROL_IO_EOF;
    if (!owner->partial) { owner->partial = true; owner->start = owner->last; }
    if (owner->header_used < 4) {
      owner->header_used += (size_t)count;
      if (owner->header_used == 4) {
        const unsigned char *p = owner->header; owner->length = (size_t)p[0] << 24 | (size_t)p[1] << 16 | (size_t)p[2] << 8 | p[3];
        if (!owner->length || owner->length > sizeof(owner->body)) return GENERAL_CONTROL_IO_INVALID;
      }
    } else owner->body_used += (size_t)count;
    if (!time_current(owner)) return GENERAL_CONTROL_IO_INVALID;
    if (owner->header_used == 4 && owner->body_used == owner->length) {
      memcpy(output, owner->body, owner->length); *size = owner->length;
      memset(owner->body, 0, sizeof(owner->body)); memset(owner->header, 0, sizeof(owner->header));
      owner->partial = false; owner->header_used = owner->body_used = owner->length = 0; return GENERAL_CONTROL_IO_FRAME;
    }
  }
  return GENERAL_CONTROL_IO_WAIT;
}
bool general_control_io_write(general_control_io *owner, const unsigned char *bytes, size_t size) {
  if (!bytes || !size || size > (GENERAL_CONTROL_INPUT_MAX > 128 * 1024 ? GENERAL_CONTROL_INPUT_MAX : 128 * 1024) + 4 || !general_control_io_current(owner)) return false;
  // Reader owns its partial-frame clock. An admitted writer has its own
  // bounded clock, allowing actual full-duplex IO without racing that state.
  double last = now(); if (last < 0) return false;
  double deadline = last + 30; size_t used = 0; unsigned interrupted = 0;
  while (used < size) {
    double current = now();
    if (current < last || current >= deadline || !general_control_io_current(owner)) return false;
    last = current;
    ssize_t count = write(STDOUT_FILENO, bytes + used, size - used);
    if (count > 0 && (size_t)count <= size - used) { used += (size_t)count; continue; }
    if (count < 0 && errno == EINTR && ++interrupted <= 64) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd state = { .fd = STDOUT_FILENO, .events = POLLOUT }; int result = poll(&state, 1, 20);
      if (result >= 0 && !(state.revents & (POLLERR | POLLNVAL | POLLHUP))) continue;
    }
    return false;
  }
  double current = now(); return current >= last && current < deadline && general_control_io_current(owner);
}
void general_control_io_interrupt(general_control_io *owner) {
  if (!owner) return;
  atomic_store(&owner->revoked, true);
  if (owner->queue >= 0) { struct kevent event; EV_SET(&event, 1, EVFILT_USER, 0, NOTE_TRIGGER, 0, NULL); (void)kevent(owner->queue, &event, 1, NULL, 0, NULL); }
}
bool general_control_io_close(general_control_io **pointer) {
  if (!pointer || !*pointer) return true;
  general_control_io *owner = *pointer; if (owner->closed || owner->uncertain) return false;
  owner->closed = true; int queue = owner->queue; owner->queue = -1;
  if (close(queue)) { owner->uncertain = true; return false; }
  // Standard descriptors remain with the process; no second owner closes them.
  memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; return true;
}
