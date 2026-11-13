#include "session-frame.h"
#include "session-frame-private.h"
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static void erase(unsigned char *bytes, size_t size) {
  volatile unsigned char *cursor = bytes;
  if (cursor) while (size--) *cursor++ = 0;
}
void general_session_frame_clear(general_session_frame *frame) {
  if (!frame) return;
  erase(frame->metadata, frame->metadata_size); free(frame->metadata);
  erase(frame->value, frame->value_size); free(frame->value);
  memset(frame, 0, sizeof(*frame));
}
void general_session_wire_clear(general_session_wire *wire) {
  if (!wire) return;
  erase(wire->bytes, wire->size); free(wire->bytes); memset(wire, 0, sizeof(*wire));
}
static uint32_t number(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) | bytes[3];
}
static void put_number(unsigned char *bytes, size_t value) {
  bytes[0] = (unsigned char)(value >> 24); bytes[1] = (unsigned char)(value >> 16);
  bytes[2] = (unsigned char)(value >> 8); bytes[3] = (unsigned char)value;
}
static bool utf8(const unsigned char *bytes, size_t size) {
  for (size_t i = 0; i < size;) {
    const unsigned char first = bytes[i++];
    if (first < 0x20) return false;
    if (first < 0x80) continue;
    unsigned tail; uint32_t point, minimum;
    if (first >= 0xc2 && first <= 0xdf) { tail = 1; point = first & 0x1f; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { tail = 2; point = first & 0x0f; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { tail = 3; point = first & 0x07; minimum = 0x10000; }
    else return false;
    if (tail > size - i) return false;
    for (unsigned j = 0; j < tail; j++) {
      const unsigned char next = bytes[i++]; if ((next & 0xc0) != 0x80) return false;
      point = (point << 6) | (next & 0x3f);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return false;
  }
  return true;
}
static bool valid(const unsigned char *bytes, size_t size, general_session_metadata_validator validate, void *context) {
  return bytes && size && size <= GENERAL_SESSION_METADATA_MAX && validate && utf8(bytes, size) && validate(bytes, size, context);
}
static bool empty(const general_session_frame *frame) {
  return frame && !frame->metadata && !frame->metadata_size && !frame->value && !frame->value_size;
}
bool general_session_frame_encode(const unsigned char *metadata, size_t metadata_size,
  const unsigned char *value, size_t value_size, general_session_metadata_validator validate,
  void *context, general_session_wire *output) {
  if (!output || output->bytes || output->size || !metadata || !metadata_size || metadata_size > GENERAL_SESSION_METADATA_MAX ||
      value_size > GENERAL_SESSION_VALUE_MAX || (value_size && !value) || !validate) return false;
  output->size = 8 + metadata_size + value_size; output->bytes = malloc(output->size);
  if (!output->bytes) { output->size = 0; return false; }
  put_number(output->bytes, metadata_size); memcpy(output->bytes + 4, metadata, metadata_size);
  put_number(output->bytes + 4 + metadata_size, value_size);
  if (value_size) memcpy(output->bytes + 8 + metadata_size, value, value_size);
  if (!valid(output->bytes + 4, metadata_size, validate, context)) { general_session_wire_clear(output); return false; }
  return true;
}
bool general_session_frame_decode(const unsigned char *bytes, size_t size,
  general_session_metadata_validator validate, void *context, general_session_frame *output) {
  if (!empty(output) || !bytes || size < 9 || size > GENERAL_SESSION_FRAME_MAX || !validate) return false;
  const size_t metadata_size = number(bytes);
  if (!metadata_size || metadata_size > GENERAL_SESSION_METADATA_MAX || metadata_size > size - 8) return false;
  const size_t value_size = number(bytes + 4 + metadata_size);
  if (value_size > GENERAL_SESSION_VALUE_MAX || value_size != size - metadata_size - 8) return false;
  output->metadata = malloc(metadata_size); if (!output->metadata) return false;
  output->metadata_size = metadata_size; memcpy(output->metadata, bytes + 4, metadata_size);
  if (!valid(output->metadata, metadata_size, validate, context)) { general_session_frame_clear(output); return false; }
  if (value_size) {
    output->value = malloc(value_size); output->value_size = value_size;
    if (!output->value) { general_session_frame_clear(output); return false; }
    memcpy(output->value, bytes + 8 + metadata_size, value_size);
  }
  return true;
}
static double clock_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (double)value.tv_sec * 1000 + (double)value.tv_nsec / 1000000;
}
typedef struct { int fd; double last, deadline; unsigned interrupted;
  general_session_frame_current current; void *context; bool ancillary, invalid_control, truncated_control, forbid_rights; int descriptor; } reader;
static ssize_t read_ancillary(reader *owner, unsigned char *bytes, size_t size) {
  /* XNU uipc_usrreq.c bounds a rights mbuf at 512 fds, expanding storage to
   * pointer slots. A small control buffer can leak unreported installed fds. */
  union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(512 * sizeof(uint64_t))]; } control;
  memset(&control, 0, sizeof(control));
  struct iovec buffer = { .iov_base = bytes, .iov_len = size };
  struct msghdr message = { .msg_iov = &buffer, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
  ssize_t received = recvmsg(owner->fd, &message, MSG_DONTWAIT);
  if (received < 0) return received;
  if (message.msg_controllen > sizeof(control.bytes)) { message.msg_controllen = sizeof(control.bytes); owner->truncated_control = true; }
  if (message.msg_flags & MSG_CTRUNC) owner->truncated_control = true;
  if (message.msg_flags & MSG_TRUNC) owner->invalid_control = true;
  for (struct cmsghdr *item = CMSG_FIRSTHDR(&message); item; item = CMSG_NXTHDR(&message, item)) {
    if (item->cmsg_len < CMSG_LEN(0)) { owner->invalid_control = true; break; }
    if (item->cmsg_len > message.msg_controllen - (size_t)((unsigned char *)item - control.bytes)) { owner->truncated_control = true; break; }
    if (item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS) { owner->invalid_control = true; continue; }
    size_t data_size = item->cmsg_len - CMSG_LEN(0);
    if (!data_size || data_size % sizeof(int)) owner->invalid_control = true;
    for (size_t offset = 0; offset + sizeof(int) <= data_size; offset += sizeof(int)) {
      int passed; memcpy(&passed, (unsigned char *)CMSG_DATA(item) + offset, sizeof(passed));
      if (passed < 0) { owner->invalid_control = true; continue; }
      int flags = fcntl(passed, F_GETFD);
      if (owner->forbid_rights || owner->descriptor >= 0 || flags < 0 || fcntl(passed, F_SETFD, flags | FD_CLOEXEC) < 0) {
        if (close(passed)) owner->truncated_control = true;
        owner->invalid_control = true;
      } else owner->descriptor = passed;
    }
  }
  return received;
}
static general_session_frame_result checkpoint(reader *owner) {
  const double before = clock_ms();
  if (!isfinite(before) || before < owner->last) return GENERAL_SESSION_FRAME_IO_ERROR;
  if (!owner->current(owner->context)) return GENERAL_SESSION_FRAME_CANCELED;
  const double now = clock_ms();
  if (!isfinite(now) || now < before) return GENERAL_SESSION_FRAME_IO_ERROR;
  owner->last = now;
  return now >= owner->deadline ? GENERAL_SESSION_FRAME_TIMEOUT : GENERAL_SESSION_FRAME_COMPLETE;
}
static general_session_frame_result read_exact(reader *owner, unsigned char *bytes, size_t size, bool initial) {
  size_t offset = 0;
  while (offset < size) {
    general_session_frame_result result = checkpoint(owner); if (result != GENERAL_SESSION_FRAME_COMPLETE) return result;
    const double remaining = owner->deadline - owner->last;
    int milliseconds = (int)ceil(remaining); if (milliseconds < 1) milliseconds = 1;
    if (milliseconds > 50) milliseconds = 50;
    struct pollfd state = { .fd = owner->fd, .events = POLLIN | POLLHUP };
    const int polled = poll(&state, 1, milliseconds);
    if (polled < 0 && errno == EINTR && ++owner->interrupted <= 64) continue;
    if (polled < 0 || (state.revents & (POLLERR | POLLNVAL))) return GENERAL_SESSION_FRAME_IO_ERROR;
    if (polled == 0) continue;
    result = checkpoint(owner); if (result != GENERAL_SESSION_FRAME_COMPLETE) return result;
    const ssize_t received = owner->ancillary ? read_ancillary(owner, bytes + offset, size - offset) : recv(owner->fd, bytes + offset, size - offset, MSG_DONTWAIT);
    if (owner->truncated_control) return GENERAL_SESSION_FRAME_CONTROL_TRUNCATED;
    if (owner->invalid_control) return GENERAL_SESSION_FRAME_INVALID;
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (received < 0 && errno == EINTR && ++owner->interrupted <= 64) continue;
    if (received < 0) return GENERAL_SESSION_FRAME_IO_ERROR;
    if (received == 0) return initial && !offset ? GENERAL_SESSION_FRAME_EOF : GENERAL_SESSION_FRAME_INVALID;
    if (owner->forbid_rights && initial && !offset) owner->deadline = fmin(owner->deadline, owner->last + 30000);
    offset += (size_t)received;
  }
  return checkpoint(owner);
}
static general_session_frame_result read_frame(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, size_t (*value_limit)(void *), void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output, int *descriptor, bool forbid_rights) {
  if (!empty(output) || fd < 0 || !timeout_ms || timeout_ms > (forbid_rights ? 360000U : 30000U) || !validate || !current || (descriptor && *descriptor != -1)) return GENERAL_SESSION_FRAME_INVALID;
  const double start = clock_ms(); if (start < 0 || !isfinite(start)) return GENERAL_SESSION_FRAME_IO_ERROR;
  reader owner = { .fd = fd, .last = start, .deadline = start + timeout_ms, .current = current, .context = current_context,
    .ancillary = descriptor != NULL || forbid_rights, .forbid_rights = forbid_rights, .descriptor = -1 };
  unsigned char header[4];
  general_session_frame_result result = read_exact(&owner, header, sizeof(header), true);
  if (result != GENERAL_SESSION_FRAME_COMPLETE) goto failed;
  const size_t metadata_size = number(header);
  if (!metadata_size || metadata_size > GENERAL_SESSION_METADATA_MAX) { result = GENERAL_SESSION_FRAME_INVALID; goto failed; }
  output->metadata = malloc(metadata_size); if (!output->metadata) { result = GENERAL_SESSION_FRAME_IO_ERROR; goto failed; }
  output->metadata_size = metadata_size;
  result = read_exact(&owner, output->metadata, metadata_size, false);
  if (result != GENERAL_SESSION_FRAME_COMPLETE) goto failed;
  if (!valid(output->metadata, metadata_size, validate, validation_context)) { result = GENERAL_SESSION_FRAME_INVALID; goto failed; }
  result = read_exact(&owner, header, sizeof(header), false); if (result != GENERAL_SESSION_FRAME_COMPLETE) goto failed;
  const size_t value_size = number(header);
  const size_t limit = value_limit ? value_limit(validation_context) : GENERAL_SESSION_VALUE_MAX;
  if (limit > GENERAL_SESSION_VALUE_MAX || value_size > limit) { result = GENERAL_SESSION_FRAME_INVALID; goto failed; }
  if (value_size) {
    output->value = malloc(value_size); if (!output->value) { result = GENERAL_SESSION_FRAME_IO_ERROR; goto failed; }
    output->value_size = value_size; result = read_exact(&owner, output->value, value_size, false);
    if (result != GENERAL_SESSION_FRAME_COMPLETE) goto failed;
  }
  result = checkpoint(&owner);
  if (result == GENERAL_SESSION_FRAME_COMPLETE) { if (descriptor) *descriptor = owner.descriptor; return result; }
failed:
  if (owner.descriptor >= 0 && close(owner.descriptor)) result = GENERAL_SESSION_FRAME_CONTROL_TRUNCATED;
  general_session_frame_clear(output); return result;
}
general_session_frame_result general_session_frame_read(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output) {
  return read_frame(fd, timeout_ms, validate, NULL, validation_context, current, current_context, output, NULL, false);
}
general_session_frame_result general_session_frame_read_protected(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output) {
  return read_frame(fd, timeout_ms, validate, NULL, validation_context, current, current_context, output, NULL, true);
}
general_session_frame_result general_session_frame_read_enrollment(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, size_t (*value_limit)(void *), void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output, int *descriptor) {
  if (!descriptor || !value_limit) return GENERAL_SESSION_FRAME_INVALID;
  return read_frame(fd, timeout_ms, validate, value_limit, validation_context, current, current_context, output, descriptor, false);
}

static bool wire_valid(const general_session_wire *wire, general_session_metadata_validator validate, void *context) {
  if (!wire || !wire->bytes || wire->size < 9 || wire->size > GENERAL_SESSION_FRAME_MAX) return false;
  const size_t metadata_size = number(wire->bytes);
  if (!metadata_size || metadata_size > GENERAL_SESSION_METADATA_MAX || metadata_size > wire->size - 8) return false;
  const size_t value_size = number(wire->bytes + 4 + metadata_size);
  return value_size <= GENERAL_SESSION_VALUE_MAX && value_size == wire->size - metadata_size - 8 &&
    valid(wire->bytes + 4, metadata_size, validate, context);
}
static general_session_frame_result write_wire(reader *owner, const general_session_wire *wire, const int *descriptors, size_t descriptor_count) {
  size_t offset = 0;
  while (offset < wire->size) {
    general_session_frame_result result = checkpoint(owner); if (result != GENERAL_SESSION_FRAME_COMPLETE) return result;
    int milliseconds = (int)ceil(owner->deadline - owner->last);
    if (milliseconds < 1) milliseconds = 1;
    if (milliseconds > 50) milliseconds = 50;
    struct pollfd state = { .fd = owner->fd, .events = POLLOUT };
    int polled = poll(&state, 1, milliseconds);
    if (polled < 0 && errno == EINTR && ++owner->interrupted <= 64) continue;
    if (polled < 0 || (state.revents & (POLLERR | POLLNVAL | POLLHUP))) return GENERAL_SESSION_FRAME_IO_ERROR;
    if (!polled) continue;
    if (!(state.revents & POLLOUT)) return GENERAL_SESSION_FRAME_IO_ERROR;
    result = checkpoint(owner); if (result != GENERAL_SESSION_FRAME_COMPLETE) return result;
    int flags = fcntl(owner->fd, F_GETFL);
    if (flags < 0 || !(flags & O_NONBLOCK)) return GENERAL_SESSION_FRAME_IO_ERROR;
    size_t count = wire->size - offset; if (count > 65536) count = 65536;
    ssize_t sent;
    if (!offset && descriptor_count) {
      union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int) * 2)]; } control = {0};
      struct iovec data = { .iov_base = wire->bytes, .iov_len = count };
      struct msghdr message = { .msg_iov = &data, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = CMSG_SPACE(descriptor_count * sizeof(int)) };
      struct cmsghdr *rights = CMSG_FIRSTHDR(&message);
      rights->cmsg_level = SOL_SOCKET; rights->cmsg_type = SCM_RIGHTS; rights->cmsg_len = CMSG_LEN(descriptor_count * sizeof(int));
      memcpy(CMSG_DATA(rights), descriptors, descriptor_count * sizeof(int));
      sent = sendmsg(owner->fd, &message, MSG_DONTWAIT | MSG_NOSIGNAL);
    } else sent = send(owner->fd, wire->bytes + offset, count, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (sent < 0 && errno == EINTR && ++owner->interrupted <= 64) continue;
    if (sent <= 0 || (size_t)sent > count) return GENERAL_SESSION_FRAME_IO_ERROR;
    offset += (size_t)sent;
    result = checkpoint(owner); if (result != GENERAL_SESSION_FRAME_COMPLETE) return result;
  }
  return GENERAL_SESSION_FRAME_COMPLETE;
}
static general_session_frame_result write_frame(int fd, const int *descriptors, size_t descriptor_count, unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context) {
  general_session_frame_result result = GENERAL_SESSION_FRAME_INVALID;
  if (fd < 0 || descriptor_count > 2 || (descriptor_count && !descriptors) || !timeout_ms || timeout_ms > 30000 || !current || !wire_valid(wire, validate, validation_context)) goto done;
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || !(flags & O_NONBLOCK)) goto done;
  double start = clock_ms();
  if (start < 0 || !isfinite(start)) { result = GENERAL_SESSION_FRAME_IO_ERROR; goto done; }
  reader owner = { .fd = fd, .last = start, .deadline = start + timeout_ms, .current = current, .context = current_context };
  result = write_wire(&owner, wire, descriptors, descriptor_count);
done:
  general_session_wire_clear(wire); return result;
}
general_session_frame_result general_session_frame_write(int fd, unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context) {
  return write_frame(fd, NULL, 0, timeout_ms, wire, validate, validation_context, current, current_context);
}
general_session_frame_result general_session_frame_write_enrollment(int fd, int owner_lock, unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context) {
  if (owner_lock < 0 || fcntl(owner_lock, F_GETFD) < 0) { general_session_wire_clear(wire); return GENERAL_SESSION_FRAME_INVALID; }
  return write_frame(fd, &owner_lock, 1, timeout_ms, wire, validate, validation_context, current, current_context);
}
general_session_frame_result general_session_frame_write_pair(int fd, const int descriptors[2], unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context, general_session_frame_current current, void *current_context) {
  if (!descriptors || descriptors[0] < 0 || descriptors[1] < 0 || descriptors[0] == descriptors[1] ||
      fcntl(descriptors[0], F_GETFD) < 0 || fcntl(descriptors[1], F_GETFD) < 0) {
    general_session_wire_clear(wire); return GENERAL_SESSION_FRAME_INVALID;
  }
  return write_frame(fd, descriptors, 2, timeout_ms, wire, validate, validation_context, current, current_context);
}
