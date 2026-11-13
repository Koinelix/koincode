#define NAPI_VERSION 10
#include <node_api.h>
#import <Foundation/Foundation.h>
#include "../general-trust/host-bootstrap.h"
#include "../general-trust/control-io.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  general_host_bootstrap *installation; general_control_io *io;
  atomic_bool revoked; bool reading, writing, closed, uncertain; unsigned pending;
} owner;
typedef struct { owner *original; napi_async_work work; napi_deferred deferred; bool read, ok; unsigned char *bytes; size_t size; } operation;
static owner *supervisor;
static const napi_type_tag tag = { UINT64_C(0x41be2a22f7494655), UINT64_C(0x8800ac7470daf288) };
static napi_value fail(napi_env env) { napi_throw_error(env, "GENERAL_PAYMENT_OWNER_UNAVAILABLE", "The fixed payment owner is unavailable."); return NULL; }
static bool current(owner *value) {
  return NSThread.isMainThread && value && value == supervisor && !value->closed && !value->uncertain &&
    !atomic_load(&value->revoked) && general_control_io_current(value->io) && general_host_bootstrap_current(value->installation);
}
static owner *receiver(napi_env env, napi_callback_info info, size_t *count, napi_value *args) {
  napi_value self; void *pointer = NULL; bool tagged = false;
  if (napi_get_cb_info(env, info, count, args, &self, NULL) != napi_ok || napi_check_object_type_tag(env, self, &tag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, self, &pointer) != napi_ok || pointer != supervisor) return NULL;
  return pointer;
}
static void revoke_owner(owner *value) {
  if (!value) return;
  atomic_store(&value->revoked, true); general_control_io_interrupt(value->io);
  // Bootstrap state is confined to the main owner thread. Actual async IO sees
  // only the atomic revocation and its retained original control queue.
  if (NSThread.isMainThread) general_host_bootstrap_invalidate(value->installation);
}
static napi_value assert_current(napi_env env, napi_callback_info info) {
  size_t count = 0; owner *value = receiver(env, info, &count, NULL); napi_value result;
  if (count || !current(value)) return fail(env);
  return napi_get_undefined(env, &result) == napi_ok ? result : fail(env);
}
static void execute(napi_env env, void *context) {
  (void)env; operation *op = context; owner *value = op->original;
  if (atomic_load(&value->revoked)) return;
  if (!op->read) { op->ok = general_control_io_write(value->io, op->bytes, op->size); return; }
  while (!atomic_load(&value->revoked)) {
    general_control_io_result result = general_control_io_read(value->io, op->bytes, &op->size);
    if (result == GENERAL_CONTROL_IO_FRAME) { op->ok = true; return; }
    if (result != GENERAL_CONTROL_IO_WAIT || !general_control_io_wait(value->io, -1, 0)) return;
  }
}
static void complete(napi_env env, napi_status status, void *context) {
  operation *op = context; owner *value = op->original; napi_value result = NULL;
  if (op->read) value->reading = false; else value->writing = false;
  if (value->pending) value->pending--;
  bool ok = status == napi_ok && op->ok && current(value);
  if (ok) ok = (op->read ? napi_create_buffer_copy(env, op->size, op->bytes, NULL, &result) : napi_get_undefined(env, &result)) == napi_ok;
  if (ok) napi_resolve_deferred(env, op->deferred, result);
  else {
    revoke_owner(value); napi_value message, error;
    if (napi_create_string_utf8(env, "GENERAL_PAYMENT_OWNER_UNAVAILABLE", NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, NULL, message, &error) == napi_ok) napi_reject_deferred(env, op->deferred, error);
  }
  if (op->bytes) { memset(op->bytes, 0, op->read ? GENERAL_CONTROL_INPUT_MAX : op->size); free(op->bytes); }
  napi_delete_async_work(env, op->work); free(op);
}
static napi_value packet(napi_env env, napi_callback_info info, bool read) {
  size_t count = 1; napi_value args[1], promise, name; owner *value = receiver(env, info, &count, args);
  if (!current(value) || (read ? count != 0 || value->reading : count != 1 || value->writing)) return fail(env);
  operation *op = calloc(1, sizeof(*op)); if (!op) return fail(env);
  op->original = value; op->read = read;
  if (read) { op->bytes = malloc(GENERAL_CONTROL_INPUT_MAX); if (!op->bytes) goto failed; }
  else {
    bool buffer = false; void *bytes = NULL; size_t size = 0;
    if (napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || size < 5 || size > GENERAL_CONTROL_INPUT_MAX + 4) goto failed;
    unsigned char *p = bytes; size_t length = (size_t)p[0] << 24 | (size_t)p[1] << 16 | (size_t)p[2] << 8 | p[3];
    if (!length || length > GENERAL_CONTROL_INPUT_MAX || length + 4 != size) goto failed;
    op->bytes = malloc(size); if (!op->bytes) goto failed; memcpy(op->bytes, bytes, size); op->size = size;
  }
  if (napi_create_promise(env, &op->deferred, &promise) != napi_ok || napi_create_string_utf8(env, "fixed-wallet-owner-io", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute, complete, op, &op->work) != napi_ok) goto failed;
  value->pending++; if (read) value->reading = true; else value->writing = true;
  if (napi_queue_async_work(env, op->work) == napi_ok) return promise;
  value->pending--; if (read) value->reading = false; else value->writing = false;
failed:
  if (op->work) napi_delete_async_work(env, op->work);
  if (op->bytes) { memset(op->bytes, 0, read ? GENERAL_CONTROL_INPUT_MAX : op->size); free(op->bytes); } free(op); revoke_owner(value); return fail(env);
}
static napi_value read_packet(napi_env env, napi_callback_info info) { return packet(env, info, true); }
static napi_value write_packet(napi_env env, napi_callback_info info) { return packet(env, info, false); }
static napi_value invalidate(napi_env env, napi_callback_info info) {
  size_t count = 0; owner *value = receiver(env, info, &count, NULL); napi_value result;
  if (!value || count) return fail(env); revoke_owner(value); return napi_get_undefined(env, &result) == napi_ok ? result : fail(env);
}
static napi_value close_owner(napi_env env, napi_callback_info info) {
  size_t count = 0; owner *value = receiver(env, info, &count, NULL); napi_value result; const char *state = "uncertain";
  if (!value || count || !NSThread.isMainThread) return fail(env);
  revoke_owner(value);
  if (value->pending) state = "busy";
  else if (value->closed) state = "closed";
  else if (!value->uncertain && general_control_io_close(&value->io) && general_host_bootstrap_close(&value->installation)) { value->closed = true; state = "closed"; }
  else value->uncertain = true;
  return napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &result) == napi_ok ? result : fail(env);
}
static void finalize(napi_env env, void *context, void *hint) { (void)env; (void)hint; revoke_owner(context); }
static void cleanup(void *context) { revoke_owner(context); }
static napi_value initialize(napi_env env, napi_value exports) {
  uint32_t version; napi_value object, identity, installation, uid, revision;
  if (!NSThread.isMainThread || supervisor || napi_get_version(env, &version) != napi_ok || version < 10) return fail(env);
  owner *value = calloc(1, sizeof(*value)); if (!value) return fail(env);
  atomic_init(&value->revoked, false); supervisor = value;
  general_session_installation receipt;
  if (general_payment_owner_bootstrap_open(&value->installation) != GENERAL_HOST_BOOTSTRAP_READY ||
      !general_payment_owner_bootstrap_info(value->installation, &receipt) || !(value->io = general_control_io_open()) || !current(value)) { revoke_owner(value); return fail(env); }
  napi_property_descriptor methods[] = {
    {"assertCurrent",NULL,assert_current,NULL,NULL,NULL,napi_default,NULL}, {"readPacket",NULL,read_packet,NULL,NULL,NULL,napi_default,NULL},
    {"writePacket",NULL,write_packet,NULL,NULL,NULL,napi_default,NULL}, {"invalidate",NULL,invalidate,NULL,NULL,NULL,napi_default,NULL}, {"close",NULL,close_owner,NULL,NULL,NULL,napi_default,NULL}
  };
  if (napi_create_object(env, &object) != napi_ok || napi_type_tag_object(env, object, &tag) != napi_ok || napi_wrap(env, object, value, finalize, NULL, NULL) != napi_ok ||
      napi_define_properties(env, object, sizeof(methods) / sizeof(*methods), methods) != napi_ok || napi_create_object(env, &identity) != napi_ok ||
      napi_create_string_utf8(env, receipt.installation_id, NAPI_AUTO_LENGTH, &installation) != napi_ok || napi_create_uint32(env, (uint32_t)geteuid(), &uid) != napi_ok ||
      napi_create_double(env, (double)receipt.revision, &revision) != napi_ok || napi_set_named_property(env, identity, "installationId", installation) != napi_ok ||
      napi_set_named_property(env, identity, "uid", uid) != napi_ok || napi_set_named_property(env, identity, "installationRevision", revision) != napi_ok ||
      napi_object_freeze(env, identity) != napi_ok || napi_set_named_property(env, object, "identity", identity) != napi_ok || napi_object_freeze(env, object) != napi_ok ||
      napi_set_named_property(env, exports, "owner", object) != napi_ok || napi_add_env_cleanup_hook(env, cleanup, value) != napi_ok) { revoke_owner(value); return fail(env); }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
