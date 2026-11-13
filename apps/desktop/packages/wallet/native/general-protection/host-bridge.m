#define NAPI_VERSION 10
#include <node_api.h>
#include <node_version.h>
#include "sqlite/3.54.1/sqlite3.h"
#import <AppKit/AppKit.h>
#include "../general-trust/host-bootstrap.h"
#include "../general-trust/host-window.h"
#include "../general-trust/session-reply.h"
#include "../general-trust/resource-commit-send.h"
#include "host-resources.h"
#include <dispatch/dispatch.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct bridge bridge;
typedef struct { bridge *owner; general_repository_kind kind; } repository_context;
struct bridge {
  general_host_bootstrap *bootstrap; general_host_window *window; general_host_mode mode;
  int socket; bool loan, closed, uncertain, reading, writing, greeted;
  atomic_bool revoked; unsigned jobs; uint32_t window_id;
  pthread_mutex_t mutex; general_session_request pending[2]; char session_id[37];
  bool pending_initialization[2]; general_initialization_record pending_records[2];
  general_host_resources *resources; repository_context repositories[2]; napi_ref repository_refs[2];
  napi_ref window_ref, contents_ref, session_ref;
};
typedef struct {
  bridge *owner; napi_async_work work; napi_deferred deferred; napi_ref self;
  bool writing, hello; unsigned timeout; double deadline;
  int matched; general_session_request original; general_session_reply reply;
  bool has_initialization, resource_commit; general_initialization_record initialization;
  int descriptors[2]; unsigned descriptor_count;
  general_session_wire wire; general_session_frame frame; general_session_frame_result result;
} job;
_Static_assert(NODE_MAJOR_VERSION == 24 && NODE_MINOR_VERSION == 14 && NODE_PATCH_VERSION == 0 && NAPI_VERSION == 10, "Pinned Electron 41.0.3 SDK");
static const napi_type_tag owner_tag = { UINT64_C(0xb97a846a30f4449c), UINT64_C(0x8f56dc0cf0b701a1) };
static const napi_type_tag repository_tag = { UINT64_C(0x1f57930cdf864aff), UINT64_C(0xa100fa83a1264b37) };
/* One bounded native supervisor per sealed Host. It intentionally survives GC
 * until process reaping; finalizers never assert broker/worker scope drainage. */
static bridge *supervisor;
static double monotonic(void) {
  struct timespec now; return clock_gettime(CLOCK_MONOTONIC, &now) ? -1 : (double)now.tv_sec * 1000 + (double)now.tv_nsec / 1000000;
}
static napi_value unavailable(napi_env env) { napi_throw_error(env, "GENERAL_PROTECTION_UNAVAILABLE", "The protected wallet host is unavailable."); return NULL; }
static napi_value busy(napi_env env) { napi_throw_error(env, "GENERAL_OPERATION_BUSY", "The original native operation has not drained."); return NULL; }
static napi_value undefined(napi_env env) { napi_value value; return napi_get_undefined(env, &value) == napi_ok ? value : NULL; }
static bridge *receiver(napi_env env, napi_callback_info info, napi_value *self, napi_value *args, size_t *count) {
  bool tagged = false; void *pointer = NULL;
  if (!NSThread.isMainThread || napi_get_cb_info(env, info, count, args, self, NULL) != napi_ok ||
      napi_check_object_type_tag(env, *self, &owner_tag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, *self, &pointer) != napi_ok || pointer != supervisor || !pointer) return NULL;
  return pointer;
}
static bool physical(bridge *owner) {
  return NSThread.isMainThread && !owner->closed && !owner->uncertain && !atomic_load(&owner->revoked) && general_host_bootstrap_current(owner->bootstrap);
}
static bool resources_current(void *context) {
  bridge *owner = context; return physical(owner) && (owner->mode == GENERAL_HOST_INSPECT || (owner->window && general_host_window_current(owner->window)));
}
static bool accept_initialization(bridge *owner, const general_initialization_record *record) {
  if (!resources_current(owner)) return false;
  if (owner->resources) return general_host_resources_matches(owner->resources, record);
  owner->resources = general_host_resources_open(owner->bootstrap, record, resources_current, owner);
  return owner->resources && general_host_resources_current(owner->resources);
}
/* Original BEGIN bytes are only a candidate. The actual matching broker OK is
 * required before they can construct the native fixed resource owner. */
static bool initialization_candidate(job *work, const general_session_frame *frame) {
  if (work->original.command != GENERAL_SESSION_BEGIN || work->original.body.begin.kind != GENERAL_SESSION_INITIALIZATION) return true;
  NSData *bytes = [NSData dataWithBytes:frame->value length:frame->value_size];
  id wrapper = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
  if (![wrapper isKindOfClass:NSDictionary.class] || ![wrapper[@"record"] isKindOfClass:NSDictionary.class]) return false;
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:wrapper[@"record"] options:NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes error:NULL];
  if (!encoded || !general_initialization_record_parse(encoded.bytes, encoded.length, &work->initialization) ||
      strcmp(work->original.body.begin.data.initialization.initialization_id, work->initialization.identity.initialization_id) ||
      strcmp(work->original.body.begin.data.initialization.initialization_digest, work->initialization.identity.initialization_digest)) return false;
  work->has_initialization = true; return true;
}
static void revoke_owner(bridge *owner) {
  atomic_store(&owner->revoked, true);
  if (NSThread.isMainThread) { general_host_window_invalidate(owner->window); general_host_bootstrap_invalidate(owner->bootstrap); }
}
static bool material_command(const general_session_request *request) {
  if (!request || (request->command != GENERAL_SESSION_READ && request->command != GENERAL_SESSION_WRITE)) return false;
  const char *reference = request->command == GENERAL_SESSION_READ ? request->body.reference.reference : request->body.write.reference;
  return !strncmp(reference, "source-key:", 11) || !strncmp(reference, "general-signed:", 15);
}
static bool worker_current(void *context) {
  job *work = context; bridge *owner = work->owner; double now = monotonic();
  if (now < 0 || now >= work->deadline || atomic_load(&owner->revoked)) return false;
  __block bool valid = false;
  dispatch_sync(dispatch_get_main_queue(), ^{
    valid = physical(owner) && (!owner->window || general_host_window_current(owner->window)) &&
      (!material_command(&work->original) || general_host_window_sensitive_current(owner->window));
  });
  return valid && monotonic() < work->deadline && !atomic_load(&owner->revoked);
}
static bool request_metadata(const unsigned char *bytes, size_t size, void *context) {
  general_session_request parsed = {0}; job *work = context;
  bool valid = general_session_parse_request(bytes, size, &parsed) && !strcmp(parsed.request_id, work->original.request_id) && parsed.sequence == work->original.sequence;
  general_session_request_clear(&parsed); return valid;
}
static bool reply_metadata(const unsigned char *bytes, size_t size, void *context) {
  job *work = context; bridge *owner = work->owner; bool valid = false;
  pthread_mutex_lock(&owner->mutex);
  if (!owner->greeted) {
    char session[37]; valid = general_session_parse_hello(bytes, size, session);
    if (valid) { work->hello = true; strcpy(work->original.session_id, session); }
  } else for (unsigned i = 0; i < 2; i++) if (owner->pending[i].command &&
      general_session_reply_parse(bytes, size, &owner->pending[i], &work->reply)) {
    work->matched = (int)i; work->original = owner->pending[i]; work->has_initialization = owner->pending_initialization[i];
    if (work->has_initialization) work->initialization = owner->pending_records[i];
    valid = true; break;
  }
  pthread_mutex_unlock(&owner->mutex); return valid;
}
static void execute(napi_env env, void *context) {
  (void)env; job *work = context;
  double now = monotonic();
  if (now < 0 || now >= work->deadline || !worker_current(work)) { work->result = GENERAL_SESSION_FRAME_CANCELED; return; }
  unsigned remaining = (unsigned)fmax(1, floor(work->deadline - now));
  if (work->writing) {
    if (work->resource_commit && work->descriptor_count == 2)
      work->result = general_resource_commit_send(work->owner->socket, work->descriptors[0], work->descriptors[1], remaining > 30000 ? 30000 : remaining,
        &work->wire, worker_current, work);
    else work->result = general_session_frame_write(work->owner->socket, remaining > 30000 ? 30000 : remaining,
      &work->wire, request_metadata, work, worker_current, work);
  }
  else {
    work->result = general_session_frame_read_protected(work->owner->socket, remaining, reply_metadata, work, worker_current, work, &work->frame);
    if (work->result == GENERAL_SESSION_FRAME_COMPLETE && (work->hello ? work->frame.value_size != 0 :
        !general_session_reply_accepts_value(&work->original, &work->reply, work->frame.value_size))) work->result = GENERAL_SESSION_FRAME_INVALID;
  }
}
static void number(unsigned char *out, size_t value) { out[0] = value >> 24; out[1] = value >> 16; out[2] = value >> 8; out[3] = value; }
static void complete(napi_env env, napi_status status, void *context) {
  job *work = context; bridge *owner = work->owner;
  bool valid = status == napi_ok && work->result == GENERAL_SESSION_FRAME_COMPLETE && physical(owner) &&
    (!material_command(&work->original) || general_host_window_sensitive_current(owner->window));
  if (work->writing) owner->writing = false; else owner->reading = false;
  owner->jobs--;
  napi_value result = NULL;
  if (valid && !work->writing && !work->hello) {
    if (work->has_initialization && work->reply.status == GENERAL_REPLY_OK) valid = accept_initialization(owner, &work->initialization);
    else if (work->original.command == GENERAL_SESSION_READ && !strcmp(work->original.body.reference.reference, "general-initialization-v1") &&
        work->reply.status == GENERAL_REPLY_OK && work->reply.kind == GENERAL_REPLY_READ_PRESENT) {
      general_initialization_record record;
      valid = general_initialization_record_parse(work->frame.value, work->frame.value_size, &record) && accept_initialization(owner, &record);
    }
    if (valid && work->original.command == GENERAL_SESSION_RESOURCE)
      valid = owner->resources && general_host_resources_observe(owner->resources, &work->original, &work->reply);
  }
  if (valid && !work->writing) {
    size_t size = 8 + work->frame.metadata_size + work->frame.value_size; void *data = NULL;
    valid = napi_create_buffer(env, size, &data, &result) == napi_ok;
    if (valid) {
      unsigned char *bytes = data; number(bytes, work->frame.metadata_size); memcpy(bytes + 4, work->frame.metadata, work->frame.metadata_size);
      number(bytes + 4 + work->frame.metadata_size, work->frame.value_size);
      if (work->frame.value_size) memcpy(bytes + 8 + work->frame.metadata_size, work->frame.value, work->frame.value_size);
      pthread_mutex_lock(&owner->mutex);
      if (work->hello) { owner->greeted = true; strcpy(owner->session_id, work->original.session_id); }
      else if (work->matched >= 0 && !strcmp(owner->pending[work->matched].request_id, work->original.request_id)) {
        general_session_request_clear(&owner->pending[work->matched]); owner->pending_initialization[work->matched] = false;
        memset(&owner->pending_records[work->matched], 0, sizeof(owner->pending_records[work->matched]));
      }
      else valid = false;
      pthread_mutex_unlock(&owner->mutex);
      if (!valid) memset(data, 0, size);
    }
  } else if (valid) result = undefined(env);
  if (!valid) {
    /* There is no transport retry, even if the original command was rejected
     * locally after an attempted write. Broker facts remain with that actor. */
    if (work->result == GENERAL_SESSION_FRAME_CONTROL_TRUNCATED) owner->uncertain = true;
    revoke_owner(owner);
    napi_value message, error;
    if (napi_create_string_utf8(env, "The original protected transport is unavailable.", NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, NULL, message, &error) == napi_ok) napi_reject_deferred(env, work->deferred, error);
  } else napi_resolve_deferred(env, work->deferred, result);
  general_session_wire_clear(&work->wire); general_session_frame_clear(&work->frame); general_session_request_clear(&work->original);
  napi_delete_reference(env, work->self); napi_delete_async_work(env, work->work); memset(work, 0, sizeof(*work)); free(work);
}
static napi_value queue(napi_env env, napi_value self, job *work) {
  napi_value promise, name; bridge *owner = work->owner;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok || napi_create_reference(env, self, 1, &work->self) != napi_ok ||
      napi_create_string_utf8(env, "protected-wallet-transport", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute, complete, work, &work->work) != napi_ok || napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->self) napi_delete_reference(env, work->self);
    if (work->work) napi_delete_async_work(env, work->work);
    general_session_wire_clear(&work->wire); general_session_frame_clear(&work->frame); free(work); revoke_owner(owner); return unavailable(env);
  }
  owner->jobs++; if (work->writing) owner->writing = true; else owner->reading = true; return promise;
}
static napi_value read_frame(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], self; bridge *owner = receiver(env, info, &self, args, &count); double timeout;
  if (!owner || count != 1 || !physical(owner) || napi_get_value_double(env, args[0], &timeout) != napi_ok || !isfinite(timeout) ||
      timeout < 1 || timeout > 360000 || floor(timeout) != timeout) return unavailable(env);
  if (owner->reading) return busy(env);
  pthread_mutex_lock(&owner->mutex);
  bool expected = !owner->greeted || owner->pending[0].command || owner->pending[1].command;
  pthread_mutex_unlock(&owner->mutex);
  if (!expected) return unavailable(env);
  job *work = calloc(1, sizeof(*work)); if (!work) return unavailable(env);
  work->owner = owner; work->matched = -1; work->timeout = (unsigned)timeout; work->deadline = monotonic() + timeout;
  return queue(env, self, work);
}
static napi_value write_frame(napi_env env, napi_callback_info info) {
  size_t count = 1, size = 0; napi_value args[1], self; void *bytes = NULL; bool buffer = false;
  bridge *owner = receiver(env, info, &self, args, &count);
  if (!owner || count != 1 || !physical(owner) || napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || size < 9 || size > GENERAL_SESSION_FRAME_MAX) return unavailable(env);
  if (owner->writing) return busy(env);
  job *work = calloc(1, sizeof(*work)); if (!work) return unavailable(env);
  work->owner = owner; work->writing = true; work->matched = -1; work->deadline = monotonic() + 30000;
  work->wire.bytes = malloc(size); work->wire.size = size;
  if (!work->wire.bytes) { free(work); return unavailable(env); }
  memcpy(work->wire.bytes, bytes, size); general_session_frame parsed = {0};
  bool valid = general_session_frame_decode(work->wire.bytes, size, general_session_request_metadata_valid, &work->original, &parsed) &&
    general_session_request_accepts_value(&work->original, parsed.value_size) && owner->greeted && !strcmp(owner->session_id, work->original.session_id) &&
    initialization_candidate(work, &parsed);
  general_session_frame_clear(&parsed);
  if (valid && owner->mode == GENERAL_HOST_MANAGER && work->original.command != GENERAL_SESSION_CLOSE && work->original.command != GENERAL_SESSION_CANCEL)
    valid = owner->window && general_host_window_current(owner->window) &&
      (work->original.command != GENERAL_SESSION_WINDOW || owner->window_id == work->original.body.window.window_id);
  if (valid && owner->mode == GENERAL_HOST_INSPECT) {
    general_session_request *request = &work->original;
    valid = (request->command == GENERAL_SESSION_BEGIN && request->body.begin.kind == GENERAL_SESSION_INSPECTION) || request->command == GENERAL_SESSION_READ ||
      request->command == GENERAL_SESSION_INSPECT || request->command == GENERAL_SESSION_END || request->command == GENERAL_SESSION_CANCEL || request->command == GENERAL_SESSION_CLOSE ||
      (request->command == GENERAL_SESSION_RESOURCE && request->body.resource.action != GENERAL_RESOURCE_START);
  }
  if (valid && material_command(&work->original)) valid = general_host_window_sensitive_current(owner->window);
  if (valid && work->original.command == GENERAL_SESSION_RESOURCE && work->original.body.resource.action == GENERAL_RESOURCE_COMMIT) {
    work->resource_commit = true;
    valid = owner->resources && general_host_resources_commit_borrow(owner->resources, &work->original, work->descriptors, &work->descriptor_count);
  }
  if (valid) {
    pthread_mutex_lock(&owner->mutex); int slot = -1;
    for (unsigned i = 0; i < 2; i++) if (!owner->pending[i].command) { slot = (int)i; break; }
    if (slot >= 0) {
      owner->pending[slot] = work->original; owner->pending_initialization[slot] = work->has_initialization;
      if (work->has_initialization) owner->pending_records[slot] = work->initialization;
    } else valid = false;
    pthread_mutex_unlock(&owner->mutex);
  }
  if (!valid) { general_session_wire_clear(&work->wire); general_session_request_clear(&work->original); free(work); return unavailable(env); }
  return queue(env, self, work);
}
static napi_value assert_current(napi_env env, napi_callback_info info) {
  size_t count = 0; napi_value self; bridge *owner = receiver(env, info, &self, NULL, &count);
  if (!owner || !physical(owner) || (owner->window && !general_host_window_current(owner->window))) return unavailable(env);
  return undefined(env);
}
static napi_value bind_window(napi_env env, napi_callback_info info) {
  size_t count = 5, size = 0; napi_value args[5], self; void *bytes = NULL; bool buffer = false; double id;
  bridge *owner = receiver(env, info, &self, args, &count);
  if (!owner || count != 5 || !physical(owner) || owner->window || owner->mode != GENERAL_HOST_MANAGER ||
      napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || size != sizeof(uintptr_t) ||
      napi_get_value_double(env, args[1], &id) != napi_ok || !isfinite(id) || id < 1 || id > UINT32_MAX || floor(id) != id) return unavailable(env);
  for (unsigned i = 2; i < 5; i++) { napi_valuetype type; if (napi_typeof(env, args[i], &type) != napi_ok || type != napi_object) return unavailable(env); }
  uintptr_t pointer; memcpy(&pointer, bytes, sizeof(pointer));
  /* Native AppKit and WindowServer establish the window fact. These references
   * only keep the original sealed Host's Electron object association alive. */
  if (!general_host_window_open(owner->bootstrap, pointer, (uint32_t)id, &owner->window) ||
      napi_create_reference(env, args[2], 1, &owner->window_ref) != napi_ok || napi_create_reference(env, args[3], 1, &owner->contents_ref) != napi_ok ||
      napi_create_reference(env, args[4], 1, &owner->session_ref) != napi_ok) { revoke_owner(owner); return unavailable(env); }
  owner->window_id = (uint32_t)id; return undefined(env);
}
static bool text_argument(napi_env env, napi_value value, char *out, size_t capacity) {
  napi_valuetype type; size_t size, copied;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_string &&
    napi_get_value_string_utf8(env, value, NULL, 0, &size) == napi_ok && size > 0 && size < capacity &&
    napi_get_value_string_utf8(env, value, out, capacity, &copied) == napi_ok && copied == size && !memchr(out, 0, size);
}
static repository_context *repository_receiver(napi_env env, napi_callback_info info, napi_value *args, size_t *count) {
  napi_value self; bool tagged = false; void *pointer = NULL;
  if (!NSThread.isMainThread || !supervisor || napi_get_cb_info(env, info, count, args, &self, NULL) != napi_ok ||
      napi_check_object_type_tag(env, self, &repository_tag, &tagged) != napi_ok || !tagged || napi_unwrap(env, self, &pointer) != napi_ok) return NULL;
  for (unsigned i = 0; i < 2; i++) if (pointer == &supervisor->repositories[i] && supervisor->repositories[i].owner == supervisor) return pointer;
  return NULL;
}
static napi_value repository_assert(napi_env env, napi_callback_info info) {
  size_t count = 0; repository_context *context = repository_receiver(env, info, NULL, &count);
  if (!context || count || !resources_current(context->owner) ||
      !general_host_resources_repository_ready(context->owner->resources, context->kind)) return unavailable(env);
  return undefined(env);
}
static napi_value repository_close(napi_env env, napi_callback_info info) {
  size_t count = 0; repository_context *context = repository_receiver(env, info, NULL, &count); napi_value result;
  if (!context || count) return unavailable(env);
  general_repository_close_result closed = general_host_resources_close_repository(context->owner->resources, context->kind);
  const char *name = closed == GENERAL_PAIR_CLOSED ? "closed" : closed == GENERAL_PAIR_BUSY ? "busy" : "uncertain";
  return napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &result) == napi_ok ? result : unavailable(env);
}
static const char *recipe_names[] = { "begin", "commit", "rollback", "state_read", "state_write", "streams", "events", "sizes", "previous", "count", "append", "version" };
_Static_assert(sizeof(recipe_names) / sizeof(*recipe_names) == GENERAL_SQL_RECIPE_COUNT, "Exact original private SQL recipes");
static napi_value repository_execute(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2], result = NULL, rows = NULL, status = NULL, changes = NULL;
  repository_context *context = repository_receiver(env, info, args, &count); char recipe_name[32]; bool array;
  uint32_t length;
  if (!context || count != 2 || !resources_current(context->owner) || !text_argument(env, args[0], recipe_name, sizeof(recipe_name)) ||
      napi_is_array(env, args[1], &array) != napi_ok || !array || napi_get_array_length(env, args[1], &length) != napi_ok || length > 4) return unavailable(env);
  general_sql_recipe recipe = GENERAL_SQL_RECIPE_COUNT;
  for (unsigned i = 0; i < GENERAL_SQL_RECIPE_COUNT; i++) if (!strcmp(recipe_name, recipe_names[i])) { recipe = (general_sql_recipe)i; break; }
  if (recipe == GENERAL_SQL_RECIPE_COUNT) return unavailable(env);
  general_sql_parameter parameters[4] = {0}; unsigned char *owned[4] = {0}; size_t owned_sizes[4] = {0};
  general_sql_result *output = NULL; bool valid = true;
  for (unsigned i = 0; i < length && valid; i++) {
    napi_value value; napi_valuetype type;
    valid = napi_get_element(env, args[1], i, &value) == napi_ok && napi_typeof(env, value, &type) == napi_ok;
    if (!valid) break;
    if (type == napi_number) {
      double number;
      valid = napi_get_value_double(env, value, &number) == napi_ok && isfinite(number) && fabs(number) <= (double)GENERAL_SQL_SAFE_INTEGER && floor(number) == number;
      if (valid) { parameters[i].type = GENERAL_SQL_INTEGER; parameters[i].integer = (int64_t)number; }
    } else if (type == napi_string) {
      size_t size = 0, copied = 0;
      valid = napi_get_value_string_utf8(env, value, NULL, 0, &size) == napi_ok && size > 0 && size <= 512 * 1024;
      if (valid) { owned[i] = malloc(size + 1); owned_sizes[i] = size + 1; valid = owned[i] != NULL; }
      if (valid) valid = napi_get_value_string_utf8(env, value, (char *)owned[i], size + 1, &copied) == napi_ok && copied == size && !memchr(owned[i], 0, size);
      if (valid) { parameters[i].type = GENERAL_SQL_TEXT; parameters[i].text = owned[i]; parameters[i].bytes = size; }
    } else valid = false;
  }
  general_sql_status outcome = valid ? general_host_resources_execute(context->owner->resources, context->kind, recipe, parameters, length, &output) : GENERAL_SQL_REJECTED;
  const char *name = outcome == GENERAL_SQL_OK ? "ok" : outcome == GENERAL_SQL_BUSY ? "busy" : outcome == GENERAL_SQL_UNCERTAIN ? "uncertain" : "rejected";
  valid = (outcome != GENERAL_SQL_OK || output) && napi_create_object(env, &result) == napi_ok && napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &status) == napi_ok &&
    napi_create_array_with_length(env, output ? output->rows : 0, &rows) == napi_ok &&
    napi_create_int64(env, output ? output->changes : 0, &changes) == napi_ok;
  for (size_t row = 0; output && row < output->rows && valid; row++) {
    napi_value object; valid = napi_create_object(env, &object) == napi_ok;
    for (size_t column = 0; column < output->columns && valid; column++) {
      general_sql_cell *cell = &output->cells[row * output->columns + column]; napi_value value;
      valid = (cell->type == GENERAL_SQL_INTEGER || cell->type == GENERAL_SQL_TEXT) && (cell->type == GENERAL_SQL_INTEGER ? napi_create_int64(env, cell->integer, &value) :
        napi_create_string_utf8(env, (const char *)cell->text, cell->bytes, &value)) == napi_ok &&
        napi_set_named_property(env, object, output->names[column], value) == napi_ok;
    }
    if (valid) valid = napi_object_freeze(env, object) == napi_ok && napi_set_element(env, rows, (uint32_t)row, object) == napi_ok;
  }
  if (valid) valid = napi_object_freeze(env, rows) == napi_ok && napi_set_named_property(env, result, "status", status) == napi_ok &&
    napi_set_named_property(env, result, "rows", rows) == napi_ok && napi_set_named_property(env, result, "changes", changes) == napi_ok && napi_object_freeze(env, result) == napi_ok;
  general_repository_sql_result_free(&output);
  for (unsigned i = 0; i < 4; i++) if (owned[i]) {
    volatile unsigned char *bytes = owned[i]; for (size_t j = 0; j < owned_sizes[i]; j++) bytes[j] = 0; free(owned[i]);
  }
  if (!valid) { revoke_owner(context->owner); return unavailable(env); } return result;
}
static napi_value repository(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value self, args[1], object, kind_value; char kind_name[12];
  bridge *owner = receiver(env, info, &self, args, &count);
  if (!owner || count != 1 || !resources_current(owner) || !text_argument(env, args[0], kind_name, sizeof(kind_name))) return unavailable(env);
  int kind = !strcmp(kind_name, "state") ? GENERAL_REPOSITORY_STATE : !strcmp(kind_name, "signing") ? GENERAL_REPOSITORY_SIGNING : -1;
  if (kind < 0 || !general_host_resources_repository_ready(owner->resources, (general_repository_kind)kind)) return unavailable(env);
  if (owner->repository_refs[kind]) return napi_get_reference_value(env, owner->repository_refs[kind], &object) == napi_ok ? object : unavailable(env);
  owner->repositories[kind] = (repository_context){ .owner = owner, .kind = (general_repository_kind)kind };
  napi_property_descriptor methods[] = {
    { "assertCurrent", NULL, repository_assert, NULL, NULL, NULL, napi_default, NULL },
    { "execute", NULL, repository_execute, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, repository_close, NULL, NULL, NULL, napi_default, NULL }
  };
  if (napi_create_object(env, &object) != napi_ok || napi_type_tag_object(env, object, &repository_tag) != napi_ok ||
      napi_wrap(env, object, &owner->repositories[kind], NULL, NULL, NULL) != napi_ok ||
      napi_define_properties(env, object, sizeof(methods) / sizeof(*methods), methods) != napi_ok ||
      napi_create_string_utf8(env, kind_name, NAPI_AUTO_LENGTH, &kind_value) != napi_ok || napi_set_named_property(env, object, "kind", kind_value) != napi_ok ||
      napi_object_freeze(env, object) != napi_ok || napi_create_reference(env, object, 1, &owner->repository_refs[kind]) != napi_ok) {
    revoke_owner(owner); return unavailable(env);
  }
  return object;
}
static napi_value materialize_resource(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value self, args[1]; char name[32]; bridge *owner = receiver(env, info, &self, args, &count);
  if (!owner || count != 1 || !resources_current(owner) || !text_argument(env, args[0], name, sizeof(name))) return unavailable(env);
  general_resource_kind kind = general_resource_kind_parse(name);
  if (!kind || !general_host_resources_materialize(owner->resources, kind)) { revoke_owner(owner); return unavailable(env); }
  return undefined(env);
}
static napi_value invalidate(napi_env env, napi_callback_info info) {
  size_t count = 0; napi_value self; bridge *owner = receiver(env, info, &self, NULL, &count);
  if (!owner) return unavailable(env); revoke_owner(owner); return undefined(env);
}
static napi_value close_owner(napi_env env, napi_callback_info info) {
  size_t count = 0; napi_value self, result; bridge *owner = receiver(env, info, &self, NULL, &count);
  if (!owner) return unavailable(env); revoke_owner(owner);
  const char *status = "uncertain";
  if (owner->closed) status = "closed";
  else if (owner->jobs || owner->reading || owner->writing) status = "busy";
  else if (!owner->uncertain && general_host_resources_close(&owner->resources) == GENERAL_HOST_RESOURCES_CLOSED && general_host_window_close(&owner->window) &&
      (!owner->loan || general_host_bootstrap_return(owner->bootstrap)) && general_host_bootstrap_close(&owner->bootstrap)) {
    owner->loan = false; owner->closed = true; status = "closed";
    napi_ref *references[] = { &owner->window_ref, &owner->contents_ref, &owner->session_ref };
    for (unsigned i = 0; i < 3; i++) if (*references[i]) { napi_delete_reference(env, *references[i]); *references[i] = NULL; }
    for (unsigned i = 0; i < 2; i++) if (owner->repository_refs[i]) { napi_delete_reference(env, owner->repository_refs[i]); owner->repository_refs[i] = NULL; }
  } else owner->uncertain = true;
  if (napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &result) != napi_ok) return unavailable(env); return result;
}
static void environment_closing(void *context) { bridge *owner = context; revoke_owner(owner); }
static void finalize(napi_env env, void *context, void *hint) { (void)env; (void)hint; revoke_owner(context); }
static napi_value initialize(napi_env env, napi_value exports) {
  uint32_t version; napi_value object, mode, identity, installation, uid, revision;
  if (!NSThread.isMainThread || supervisor || napi_get_version(env, &version) != napi_ok || version < 10 || sqlite3_libversion_number() != 3054001 ||
      strcmp(sqlite3_sourceid(), "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76") ||
      !sqlite3_compileoption_used("THREADSAFE=1") || !sqlite3_compileoption_used("DQS=0") || !sqlite3_compileoption_used("OMIT_LOAD_EXTENSION") || !sqlite3_compileoption_used("USE_URI")) return unavailable(env);
  bridge *owner = calloc(1, sizeof(*owner)); if (!owner) return unavailable(env);
  owner->socket = -1; atomic_init(&owner->revoked, false);
  if (pthread_mutex_init(&owner->mutex, NULL)) { free(owner); return unavailable(env); }
  supervisor = owner;
  general_session_installation receipt;
  if (general_host_bootstrap_open(&owner->bootstrap) != GENERAL_HOST_BOOTSTRAP_READY ||
      !general_host_bootstrap_info(owner->bootstrap, &owner->mode, &receipt) || (owner->socket = general_host_bootstrap_borrow(owner->bootstrap)) < 0) {
    revoke_owner(owner); return unavailable(env);
  }
  owner->loan = true;
  if (napi_create_object(env, &identity) != napi_ok ||
      napi_create_string_utf8(env, receipt.installation_id, NAPI_AUTO_LENGTH, &installation) != napi_ok ||
      napi_create_uint32(env, (uint32_t)geteuid(), &uid) != napi_ok || napi_create_double(env, (double)receipt.revision, &revision) != napi_ok ||
      napi_set_named_property(env, identity, "installationId", installation) != napi_ok || napi_set_named_property(env, identity, "uid", uid) != napi_ok ||
      napi_set_named_property(env, identity, "installationRevision", revision) != napi_ok || napi_object_freeze(env, identity) != napi_ok) {
    revoke_owner(owner); return unavailable(env);
  }
  napi_property_descriptor methods[] = {
    {"assertCurrent", NULL, assert_current, NULL, NULL, NULL, napi_default, NULL}, {"bindWindow", NULL, bind_window, NULL, NULL, NULL, napi_default, NULL},
    {"readFrame", NULL, read_frame, NULL, NULL, NULL, napi_default, NULL}, {"writeFrame", NULL, write_frame, NULL, NULL, NULL, napi_default, NULL},
    {"invalidate", NULL, invalidate, NULL, NULL, NULL, napi_default, NULL}, {"close", NULL, close_owner, NULL, NULL, NULL, napi_default, NULL},
    {"materializeResource", NULL, materialize_resource, NULL, NULL, NULL, napi_default, NULL}, {"repository", NULL, repository, NULL, NULL, NULL, napi_default, NULL}
  };
  if (napi_create_object(env, &object) != napi_ok || napi_type_tag_object(env, object, &owner_tag) != napi_ok ||
      napi_wrap(env, object, owner, finalize, NULL, NULL) != napi_ok || napi_define_properties(env, object, sizeof(methods) / sizeof(*methods), methods) != napi_ok ||
      napi_create_string_utf8(env, owner->mode == GENERAL_HOST_MANAGER ? "manager" : "inspection", NAPI_AUTO_LENGTH, &mode) != napi_ok ||
      napi_set_named_property(env, object, "mode", mode) != napi_ok || napi_set_named_property(env, object, "identity", identity) != napi_ok || napi_object_freeze(env, object) != napi_ok ||
      napi_set_named_property(env, exports, "host", object) != napi_ok || napi_add_env_cleanup_hook(env, environment_closing, owner) != napi_ok) {
    revoke_owner(owner); return unavailable(env);
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
