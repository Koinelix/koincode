#include "session-dispatch.h"
#include "session-ingress.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <uuid/uuid.h>

typedef struct {
  bool occupied, borrowed, complete;
  general_session_request request; general_session_frame frame; general_session_wire reply;
  general_session_rights *rights; bool rights_borrowed;
} slot;
struct general_session_dispatch {
  int fd; general_session_guard *guard; general_session_ingress *ingress;
  char session_id[37]; bool (*current)(void *); void *context;
  bool started, attempted, stopped, running, guard_loan;
  slot business, control;
};
static bool connection_current(void *context) {
  general_session_dispatch *owner = context;
  return !owner->stopped && owner->current(owner->context) && !owner->stopped;
}
static bool hello_valid(const unsigned char *bytes, size_t size, void *context) { return general_session_parse_hello(bytes, size, context); }
static bool clear_slot(slot *item) {
  if (item->rights_borrowed || !general_session_rights_close(&item->rights)) return false;
  general_session_frame_clear(&item->frame); general_session_wire_clear(&item->reply);
  general_session_request_clear(&item->request); memset(item, 0, sizeof(*item)); return true;
}
void general_session_dispatch_stop(general_session_dispatch *owner) {
  if (!owner) return;
  owner->stopped = true; general_session_guard_invalidate(owner->guard);
  /* Only already-completed, unborrowed transport state may be discarded. */
  if (!owner->running) {
    if (owner->business.complete && !owner->business.borrowed) clear_slot(&owner->business);
    if (owner->control.complete && !owner->control.borrowed) clear_slot(&owner->control);
  }
}
general_session_dispatch *general_session_dispatch_create(int fd, bool (*current)(void *), void *context) {
  if (fd < 0 || !current || !current(context)) return NULL;
  general_session_dispatch *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  owner->fd = fd; owner->current = current; owner->context = context;
  uuid_t identifier; uuid_generate_random(identifier); uuid_unparse_lower(identifier, owner->session_id);
  owner->guard = general_session_guard_create(owner->session_id);
  owner->ingress = general_session_ingress_create(fd, connection_current, owner);
  if (!owner->guard || !owner->ingress || !connection_current(owner)) {
    general_session_dispatch_stop(owner);
    if (!general_session_dispatch_close(&owner)) return NULL;
    return NULL;
  }
  return owner;
}
bool general_session_dispatch_start(general_session_dispatch *owner) {
  if (!owner || owner->attempted || owner->running || owner->stopped) return false;
  owner->attempted = owner->running = true;
  general_session_wire wire = {0}; char parsed[37];
  bool ok = general_session_hello_encode(owner->session_id, &wire) &&
    general_session_frame_write(owner->fd, 30000, &wire, hello_valid, parsed, connection_current, owner) == GENERAL_SESSION_FRAME_COMPLETE;
  general_session_wire_clear(&wire); owner->running = false;
  if (!ok) general_session_dispatch_stop(owner); else owner->started = true;
  return ok;
}
static bool reject(general_session_dispatch *owner, const general_session_request *request, general_session_reply_code code) {
  general_session_reply reply = { .status = GENERAL_REPLY_REJECTED, .code = code, .kind = GENERAL_REPLY_EMPTY }, parsed;
  general_session_reply_validation validation = { request, &parsed }; general_session_wire wire = {0};
  bool ok = general_session_reply_encode(request, &reply, NULL, 0, &wire) &&
    general_session_frame_write(owner->fd, 30000, &wire, general_session_reply_metadata_valid, &validation, connection_current, owner) == GENERAL_SESSION_FRAME_COMPLETE;
  general_session_wire_clear(&wire); return ok;
}
general_session_dispatch_result general_session_dispatch_poll(general_session_dispatch *owner) {
  if (!owner || owner->stopped || !owner->started) return GENERAL_DISPATCH_BROKEN;
  if (owner->running || owner->business.complete || owner->control.complete) return GENERAL_DISPATCH_WAIT;
  owner->running = true; general_session_dispatch_result result = GENERAL_DISPATCH_BROKEN;
  general_session_request request = {0}; general_session_frame frame = {0};
  general_session_rights *rights = NULL;
  general_session_ingress_result received = general_session_ingress_step(owner->ingress);
  /* Darwin may have installed descriptors absent from a truncated result. */
  if (received == GENERAL_INGRESS_FATAL) _exit(74);
  if (received == GENERAL_INGRESS_WAIT) { result = GENERAL_DISPATCH_WAIT; goto done; }
  if (received != GENERAL_INGRESS_READY || !general_session_ingress_take_with_rights(owner->ingress, &request, &frame, &rights)) goto done;
  general_session_admission admitted = general_session_guard_admit(owner->guard, &request, frame.value_size);
  if (admitted == GENERAL_SESSION_ADMIT_BUSINESS || admitted == GENERAL_SESSION_ADMIT_CONTROL) {
    slot *target = admitted == GENERAL_SESSION_ADMIT_BUSINESS ? &owner->business : &owner->control;
    if (target->occupied) goto done;
    target->occupied = true; target->request = request; target->frame = frame; memset(&frame, 0, sizeof(frame));
    target->rights = rights; rights = NULL;
    result = admitted == GENERAL_SESSION_ADMIT_BUSINESS ? GENERAL_DISPATCH_BUSINESS : GENERAL_DISPATCH_CONTROL;
  } else if (admitted == GENERAL_SESSION_ADMIT_BUSY || admitted == GENERAL_SESSION_ADMIT_REJECTED) {
    if (reject(owner, &request, admitted == GENERAL_SESSION_ADMIT_BUSY ? GENERAL_REPLY_BUSY : GENERAL_REPLY_UNAVAILABLE)) result = GENERAL_DISPATCH_REJECTED;
  }
done:
  if (!general_session_rights_close(&rights)) _exit(74);
  general_session_request_clear(&request); general_session_frame_clear(&frame); owner->running = false;
  if (result == GENERAL_DISPATCH_BROKEN) general_session_dispatch_stop(owner);
  return result;
}
bool general_session_dispatch_borrow(general_session_dispatch *owner, bool control,
    const general_session_request **request, const unsigned char **value, size_t *size) {
  if (!owner || owner->running || owner->stopped || !request || !value || !size) return false;
  slot *item = control ? &owner->control : &owner->business;
  if (!item->occupied || item->complete || item->borrowed) return false;
  item->borrowed = true; *request = &item->request; *value = item->frame.value; *size = item->frame.value_size; return true;
}
bool general_session_dispatch_return(general_session_dispatch *owner, bool control) {
  if (!owner || owner->running) return false;
  slot *item = control ? &owner->control : &owner->business;
  if (!item->occupied || !item->borrowed || item->rights_borrowed) return false;
  item->borrowed = false; return true;
}
bool general_session_dispatch_resource_descriptors_borrow(general_session_dispatch *owner, int *database, int *writer_lease) {
  if (!owner || owner->running || owner->stopped) return false;
  slot *item = &owner->business;
  if (!item->occupied || !item->borrowed || item->complete || item->rights_borrowed ||
      item->request.command != GENERAL_SESSION_RESOURCE || item->request.body.resource.action != GENERAL_RESOURCE_COMMIT ||
      !general_session_rights_borrow(item->rights, database, writer_lease)) return false;
  item->rights_borrowed = true; return true;
}
bool general_session_dispatch_resource_descriptors_return(general_session_dispatch *owner) {
  if (!owner || owner->running || !owner->business.rights_borrowed || !general_session_rights_return(owner->business.rights)) return false;
  owner->business.rights_borrowed = false; return true;
}
general_session_guard *general_session_dispatch_guard_borrow(general_session_dispatch *owner) {
  if (!owner || owner->running || owner->stopped || owner->guard_loan) return NULL;
  owner->guard_loan = true; return owner->guard;
}
bool general_session_dispatch_guard_return(general_session_dispatch *owner) {
  if (!owner || owner->running || !owner->guard_loan) return false;
  owner->guard_loan = false; return true;
}
bool general_session_dispatch_complete(general_session_dispatch *owner, bool control,
    const general_session_reply *reply, const unsigned char *value, size_t size) {
  if (!owner || owner->running || !reply) return false;
  slot *item = control ? &owner->control : &owner->business;
  if (!item->occupied || item->borrowed || item->complete || (size && (control || owner->stopped ||
      !general_session_guard_business_current(owner->guard, item->request.request_id)))) return false;
  if (!control && item->request.command == GENERAL_SESSION_BEGIN && reply->status == GENERAL_REPLY_OK &&
      !general_session_guard_business_current(owner->guard, item->request.request_id)) return false;
  general_session_wire wire = {0};
  if (!general_session_reply_encode(&item->request, reply, value, size, &wire)) return false;
  if (!general_session_rights_close(&item->rights)) {
    general_session_wire_clear(&wire); general_session_dispatch_stop(owner); return false;
  }
  bool drained;
  if (control) drained = general_session_guard_finish_control(owner->guard, item->request.request_id);
  else {
    general_session_completion completion = reply->status == GENERAL_REPLY_OK ? GENERAL_SESSION_FINISH_OK : reply->status == GENERAL_REPLY_REJECTED ?
      GENERAL_SESSION_FINISH_REJECTED : reply->status == GENERAL_REPLY_CANCELED ? GENERAL_SESSION_FINISH_CANCELED : GENERAL_SESSION_FINISH_UNCERTAIN;
    drained = general_session_guard_finish_business(owner->guard, item->request.request_id, completion) != GENERAL_SESSION_DRAIN_REFUSED;
  }
  if (!drained) { general_session_wire_clear(&wire); return false; }
  item->complete = true; item->reply = wire;
  if (owner->stopped) clear_slot(item);
  return true;
}
bool general_session_dispatch_flush(general_session_dispatch *owner, bool control) {
  if (!owner || owner->running) return false;
  slot *item = control ? &owner->control : &owner->business;
  if (!item->occupied || item->borrowed || !item->complete) return false;
  if (owner->stopped) { clear_slot(item); return false; }
  owner->running = true;
  general_session_reply parsed; general_session_reply_validation validation = { &item->request, &parsed };
  bool ok = general_session_frame_write(owner->fd, 30000, &item->reply, general_session_reply_metadata_valid, &validation,
    connection_current, owner) == GENERAL_SESSION_FRAME_COMPLETE;
  if (!clear_slot(item)) ok = false;
  owner->running = false; if (!ok) general_session_dispatch_stop(owner); return ok;
}
bool general_session_dispatch_scope_drained(general_session_dispatch *owner, const char *operation_id) {
  if (!owner || owner->running || owner->guard_loan || owner->business.occupied) return false;
  return general_session_guard_scope_drained(owner->guard, operation_id);
}
bool general_session_dispatch_close(general_session_dispatch **pointer) {
  if (!pointer || !*pointer) return true;
  general_session_dispatch *owner = *pointer;
  if (owner->running || owner->guard_loan || owner->business.occupied || owner->control.occupied) return false;
  general_session_dispatch_stop(owner);
  if (!general_session_guard_destroy(&owner->guard) || !general_session_ingress_close(&owner->ingress)) return false;
  memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; return true;
}
