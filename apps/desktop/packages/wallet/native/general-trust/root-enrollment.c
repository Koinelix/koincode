#include "root-enrollment.h"
#include "root-namespace.h"
#include "enrollment-listener.h"
#include "channel-peer.h"
#include "enrollment-message.h"
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static atomic_flag occupied = ATOMIC_FLAG_INIT;
static volatile sig_atomic_t canceled;
typedef struct {
  general_root_namespace *space; general_enrollment_listener *listener; general_channel_peer *peer; general_registration_io *records;
  general_session_installation receipt; general_console_identity console; general_root_preparation preparation;
  general_initialization_plan original; struct timespec started, last;
  int accepted, channel, owner_fd; bool directory_loan, peer_loan, idle_required, uncertain;
  char request_ids[3][37]; unsigned used;
} enrollment;
/* A failed cleanup keeps all original owners reachable until process exit. */
static enrollment *retained;
void general_root_enrollment_cancel(void) { canceled = 1; }
static bool base_current(void *context) {
  enrollment *owner = context; struct timespec now;
  if (canceled || owner->uncertain || getuid() != 0 || geteuid() != 0 || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < owner->last.tv_sec || (now.tv_sec == owner->last.tv_sec && now.tv_nsec < owner->last.tv_nsec)) return false;
  owner->last = now; time_t seconds = now.tv_sec - owner->started.tv_sec;
  return seconds >= 0 && (seconds < 360 || (seconds == 360 && now.tv_nsec < owner->started.tv_nsec)) &&
    (!owner->space || general_root_namespace_current(owner->space));
}
static bool idle(int fd) {
  unsigned char byte = 0; ssize_t size = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT); int error = errno;
  *(volatile unsigned char *)&byte = 0;
  return size < 0 && (error == EAGAIN || error == EWOULDBLOCK);
}
static bool current(void *context) {
  enrollment *owner = context;
  return base_current(owner) && owner->peer && general_channel_peer_current(owner->peer) && (!owner->idle_required || idle(owner->channel));
}
static bool close_owned(enrollment *owner, int *descriptor) {
  if (*descriptor < 0) return true;
  int fd = *descriptor; *descriptor = -1;
  if (close(fd)) { owner->uncertain = true; return false; }
  return true;
}
static bool send_hello(enrollment *owner) {
  general_enrollment_hello hello = { .uid = owner->console.uid, .receipt_revision = (uint64_t)owner->receipt.revision,
    .preparation = owner->preparation == GENERAL_ROOT_PREPARATION_FRESH ? GENERAL_ENROLLMENT_FRESH : GENERAL_ENROLLMENT_RESUME };
  strcpy(hello.installation_id, owner->receipt.installation_id);
  general_session_wire wire = {0}; general_enrollment_hello parsed;
  if (!idle(owner->channel) || !current(owner) || !general_enrollment_hello_encode(&hello, &wire)) return false;
  owner->idle_required = false;
  return general_session_frame_write(owner->channel, 30000, &wire, general_enrollment_hello_metadata_valid, &parsed, current, owner) == GENERAL_SESSION_FRAME_COMPLETE;
}
static bool final_reply_current(void *context) {
  enrollment *owner = context;
  if (current(owner)) return true;
  if (!base_current(owner) || owner->used != 3 || owner->idle_required) return false;
  unsigned char byte = 0; ssize_t size = recv(owner->channel, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
  *(volatile unsigned char *)&byte = 0;
  /* After durable assign, only final reply transmission may tolerate an EOF.
   * An early/full close still makes send fail; no IO authority is granted. */
  return size == 0 && base_current(owner);
}
static bool send_reply(enrollment *owner, const general_enrollment_request *request, general_enrollment_status status) {
  general_session_wire wire = {0}; general_enrollment_status parsed;
  general_enrollment_reply_validation validation = { .request = request, .status = &parsed };
  if (!current(owner) || !general_enrollment_reply_encode(request, status, &wire)) return false;
  /* The peer may consume this reply and send the next request before the final
   * local send check runs. Idle is only required during the preceding IO. */
  owner->idle_required = false;
  general_session_frame_current check = request->command == GENERAL_ENROLLMENT_ASSIGN && status == GENERAL_ENROLLMENT_OK ? final_reply_current : current;
  return general_session_frame_write(owner->channel, 30000, &wire, general_enrollment_reply_metadata_valid, &validation, check, owner) == GENERAL_SESSION_FRAME_COMPLETE;
}
static bool readable(enrollment *owner) {
  owner->idle_required = false;
  while (current(owner)) {
    struct pollfd status = { .fd = owner->channel, .events = POLLIN | POLLHUP };
    int result = poll(&status, 1, 50); int error = errno;
    if (!current(owner) || (result < 0 && error != EINTR) || (status.revents & (POLLHUP | POLLERR | POLLNVAL))) return false;
    if (result > 0 && (status.revents & POLLIN)) return true;
  }
  return false;
}
static bool finish_peer(enrollment *owner) {
  struct timespec started, now, last; unsigned interrupted = 0;
  if (clock_gettime(CLOCK_MONOTONIC, &started)) return false;
  last = started;
  while (base_current(owner)) {
    if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < last.tv_sec ||
        (now.tv_sec == last.tv_sec && now.tv_nsec < last.tv_nsec) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
        now.tv_sec - started.tv_sec > 30 || (now.tv_sec - started.tv_sec == 30 && now.tv_nsec >= started.tv_nsec)) return false;
    last = now;
    struct pollfd state = { .fd = owner->channel, .events = POLLIN | POLLHUP };
    int result = poll(&state, 1, 50); int error = errno;
    if (!base_current(owner)) return false;
    if (result < 0 && error == EINTR && ++interrupted <= 64) continue;
    if (result < 0 || (state.revents & (POLLERR | POLLNVAL))) return false;
    if (!result) continue;
    unsigned char byte = 0; ssize_t size = recv(owner->channel, &byte, 1, MSG_PEEK | MSG_DONTWAIT); error = errno;
    *(volatile unsigned char *)&byte = 0;
    if (!base_current(owner)) return false;
    if (!size) return true;
    if (size < 0 && (error == EAGAIN || error == EWOULDBLOCK)) continue;
    if (size < 0 && error == EINTR && ++interrupted <= 64) continue;
    return false;
  }
  return false;
}
static bool registration(enrollment *owner, general_registration_view *view) {
  return general_registration_io_inspect(owner->records, current, owner, view) && view->registration_present && general_registration_binding_valid(&view->registration, &owner->original);
}
static general_registration_io_result reserve(enrollment *owner, const general_enrollment_payload *payload) {
  const general_initialization_plan *plan = &payload->body.reserve;
  if (plan->identity.uid != owner->console.uid || strcmp(plan->identity.installation_id, owner->receipt.installation_id)) return GENERAL_REGISTRATION_IO_REJECTED;
  general_root_namespace_result adopted = general_root_namespace_adopt_owner(owner->space, &owner->owner_fd, current, owner);
  if (adopted == GENERAL_ROOT_NAMESPACE_UNCERTAIN) return GENERAL_REGISTRATION_IO_UNCERTAIN;
  if (adopted != GENERAL_ROOT_NAMESPACE_READY) return GENERAL_REGISTRATION_IO_REJECTED;
  owner->records = general_root_namespace_borrow_records(owner->space);
  if (!owner->records) return GENERAL_REGISTRATION_IO_REJECTED;
  owner->original = *plan; general_registration_view view;
  if (!general_registration_io_inspect(owner->records, current, owner, &view)) return GENERAL_REGISTRATION_IO_REJECTED;
  if (owner->preparation == GENERAL_ROOT_PREPARATION_FRESH) {
    if (view.registration_present || view.assignment_present) return GENERAL_REGISTRATION_IO_REJECTED;
    return general_registration_io_reserve(owner->records, plan, current, owner);
  }
  if (!registration(owner, &view)) return GENERAL_REGISTRATION_IO_REJECTED;
  if (view.registration.phase != GENERAL_REGISTRATION_RESERVED) return GENERAL_REGISTRATION_IO_COMPLETE;
  return general_registration_io_reserve(owner->records, plan, current, owner);
}
static general_registration_io_result perform(enrollment *owner, const general_enrollment_payload *payload) {
  if (payload->command == GENERAL_ENROLLMENT_RESERVE) return reserve(owner, payload);
  general_registration_view view;
  if (!registration(owner, &view)) return GENERAL_REGISTRATION_IO_REJECTED;
  if (payload->command == GENERAL_ENROLLMENT_START_HEAD) {
    if (view.registration.phase != GENERAL_REGISTRATION_RESERVED) return GENERAL_REGISTRATION_IO_COMPLETE;
    return general_registration_io_advance(owner->records, &owner->original, GENERAL_REGISTRATION_RESERVED, GENERAL_REGISTRATION_HEAD_CREATE_STARTED, current, owner);
  }
  if (payload->command != GENERAL_ENROLLMENT_ASSIGN || view.registration.phase == GENERAL_REGISTRATION_RESERVED) return GENERAL_REGISTRATION_IO_REJECTED;
  /* The actual fixed broker must verify its genuine DP head/prefix before this
   * attestation. Root never substitutes a caller-provided proof boolean. */
  general_registration_io_result assigned = general_registration_io_assign(owner->records, &owner->original, payload, current, owner);
  if (assigned != GENERAL_REGISTRATION_IO_COMPLETE) return assigned;
  if (!registration(owner, &view)) return GENERAL_REGISTRATION_IO_UNCERTAIN;
  return general_registration_io_advance(owner->records, &owner->original, view.registration.phase, GENERAL_REGISTRATION_ASSIGNED, current, owner);
}
static bool connect_peer(enrollment *owner) {
  for (unsigned rejected = 0; rejected < 8 && base_current(owner);) {
    int result = general_enrollment_listener_accept(owner->listener, &owner->accepted);
    if (result < 0) return false;
    if (!result) continue;
    bool valid = general_channel_peer_open(owner->accepted, GENERAL_CHANNEL_ROOT_BROKER, &owner->receipt, base_current, owner, &owner->peer);
    if (!close_owned(owner, &owner->accepted)) return false;
    if (valid) {
      owner->channel = general_channel_peer_borrow(owner->peer); owner->peer_loan = owner->channel >= 0;
      return owner->peer_loan && current(owner);
    }
    if (!general_channel_peer_close(&owner->peer)) { owner->uncertain = true; return false; }
    rejected++;
  }
  return false;
}
static bool cleanup(enrollment *owner) {
  if (owner->uncertain || !close_owned(owner, &owner->owner_fd) || !close_owned(owner, &owner->accepted)) return false;
  if (owner->records) { if (!general_root_namespace_return_records(owner->space)) return false; owner->records = NULL; }
  if (owner->peer_loan) { if (!general_channel_peer_return(owner->peer)) return false; owner->peer_loan = false; owner->channel = -1; }
  if (!general_channel_peer_close(&owner->peer) || !general_enrollment_listener_close(&owner->listener)) return false;
  if (owner->directory_loan) { if (!general_root_namespace_return_directory(owner->space)) return false; owner->directory_loan = false; }
  return general_root_namespace_close(&owner->space);
}
general_root_enrollment_result general_root_enrollment_run(void) {
  if (getuid() != 0 || geteuid() != 0) return GENERAL_ROOT_ENROLLMENT_UNAVAILABLE;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_ROOT_ENROLLMENT_BUSY;
  enrollment *owner = calloc(1, sizeof(*owner)); if (!owner) return GENERAL_ROOT_ENROLLMENT_UNAVAILABLE;
  retained = owner; owner->accepted = owner->channel = owner->owner_fd = -1;
  general_root_enrollment_result result = GENERAL_ROOT_ENROLLMENT_UNAVAILABLE;
  if (clock_gettime(CLOCK_MONOTONIC, &owner->started)) goto done;
  owner->last = owner->started;
  general_root_namespace_result preparation = general_root_namespace_prepare(base_current, owner, &owner->space);
  if (preparation != GENERAL_ROOT_NAMESPACE_READY) { result = preparation == GENERAL_ROOT_NAMESPACE_BUSY ? GENERAL_ROOT_ENROLLMENT_BUSY : preparation == GENERAL_ROOT_NAMESPACE_UNCERTAIN ? GENERAL_ROOT_ENROLLMENT_UNCERTAIN : result; goto done; }
  result = GENERAL_ROOT_ENROLLMENT_UNCERTAIN;
  if (!general_root_namespace_info(owner->space, &owner->console, &owner->receipt, &owner->preparation)) goto done;
  int directory = general_root_namespace_borrow_directory(owner->space);
  if (directory < 0) goto done; owner->directory_loan = true;
  general_listener_result listener = general_enrollment_listener_open(directory, owner->console.uid, owner->console.gid, base_current, owner, &owner->listener);
  if (listener != GENERAL_LISTENER_READY) { if (listener == GENERAL_LISTENER_BUSY && owner->preparation == GENERAL_ROOT_PREPARATION_RESUME) result = GENERAL_ROOT_ENROLLMENT_BUSY; goto done; }
  if (!connect_peer(owner) || !send_hello(owner)) goto done;
  for (unsigned step = 0; step < 3; step++) {
    general_session_frame frame = {0}; general_enrollment_request request = {0}; general_enrollment_payload payload;
    if (!readable(owner)) goto done;
    general_session_frame_result received = general_enrollment_request_read(owner->channel, 30000, current, owner, &frame, &request, &owner->owner_fd);
    if (received == GENERAL_SESSION_FRAME_CONTROL_TRUNCATED) _exit(74);
    if (received != GENERAL_SESSION_FRAME_COMPLETE) { general_session_frame_clear(&frame); goto done; }
    owner->idle_required = true;
    bool valid = request.command == (general_enrollment_command)(step + 1) && current(owner);
    for (unsigned i = 0; i < owner->used; i++) if (!strcmp(request.request_id, owner->request_ids[i])) valid = false;
    if (valid) valid = general_enrollment_payload_parse(&request, frame.value, frame.value_size, step ? &owner->original : NULL, &payload);
    general_session_frame_clear(&frame);
    if (!valid) { (void)send_reply(owner, &request, GENERAL_ENROLLMENT_REJECTED); goto done; }
    strcpy(owner->request_ids[owner->used++], request.request_id);
    general_registration_io_result performed = perform(owner, &payload);
    general_enrollment_status status = performed == GENERAL_REGISTRATION_IO_COMPLETE ? GENERAL_ENROLLMENT_OK : performed == GENERAL_REGISTRATION_IO_UNCERTAIN ? GENERAL_ENROLLMENT_UNCERTAIN : GENERAL_ENROLLMENT_REJECTED;
    bool sent = send_reply(owner, &request, status);
    if (performed == GENERAL_REGISTRATION_IO_UNCERTAIN) owner->uncertain = true;
    if (!sent || performed != GENERAL_REGISTRATION_IO_COMPLETE) goto done;
  }
  /* Let the broker consume the final reply under a live peer check before it
   * closes. No new command or durable effect is admitted during this drain. */
  if (finish_peer(owner)) result = GENERAL_ROOT_ENROLLMENT_COMPLETE;
done:
  if (!cleanup(owner)) return GENERAL_ROOT_ENROLLMENT_UNCERTAIN;
  free(owner); retained = NULL; return result;
}
