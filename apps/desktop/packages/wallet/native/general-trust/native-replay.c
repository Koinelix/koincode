#include "native-replay.h"
#include <stdlib.h>
#include <string.h>

typedef struct { general_native_ref_state state; char profile[37]; uint32_t left, right; int height; } node;
struct general_native_replay {
  general_native_head anchor;
  char last_digest[65], tail_digest[65];
  general_native_event tail;
  general_native_scope_resolver resolver;
  node *nodes;
  uint32_t capacity, count, root;
  uint64_t seen;
  bool sealed, invalid, has_tail;
  general_native_replay_status status;
};
_Static_assert(sizeof(node) * (GENERAL_NATIVE_EVENT_LIMIT + 1ULL) <= 64ULL * 1024 * 1024, "The replay index must stay within 64 MiB.");
static void erase(void *value, size_t size) {
  volatile unsigned char *bytes = value; if (bytes) while (size--) *bytes++ = 0;
}
static size_t pool_size(uint32_t capacity) { return capacity ? ((size_t)capacity + 1) * sizeof(node) : 0; }
general_native_replay *general_native_replay_create(const general_native_head *anchor, const general_native_scope_resolver *resolver) {
  if (!general_native_head_valid(anchor) || anchor->sequence > GENERAL_NATIVE_EVENT_LIMIT) return NULL;
  general_native_replay *out = calloc(1, sizeof(*out)); if (!out) return NULL;
  out->anchor = *anchor; out->capacity = (uint32_t)anchor->sequence;
  if (resolver) out->resolver = *resolver;
  if (!general_native_genesis_digest(&anchor->identity, out->last_digest)) { erase(out, sizeof(*out)); free(out); return NULL; }
  if (out->capacity) {
    out->nodes = calloc(1, pool_size(out->capacity));
    if (!out->nodes) { erase(out, sizeof(*out)); free(out); return NULL; }
  }
  return out;
}
static bool reject(general_native_replay *replay) {
  if (replay) { replay->invalid = true; replay->status = GENERAL_NATIVE_REPLAY_INVALID; } return false;
}
bool general_native_reference_profile_scoped(const char *reference) {
  general_resource_kind kind; char profile[37];
  if (general_canonical_resource_reference(reference, &kind, profile)) return kind != GENERAL_RESOURCE_PROFILES_ROOT;
  return reference && (!strcmp(reference, "general-state-v1") || !strcmp(reference, "general-signing-registry-v1") ||
    !strncmp(reference, "general-intent:", 15) || !strncmp(reference, "general-signed:", 15) || !strncmp(reference, "general-broadcast:", 18));
}
static int compare(const char *profile, const char *reference, const node *node) {
  int scope = strcmp(profile, node->profile); return scope ? scope : strcmp(reference, node->state.event.reference);
}
static uint32_t find(const general_native_replay *replay, const char *profile, const char *reference) {
  uint32_t index = replay->root;
  while (index) {
    int compared = compare(profile, reference, &replay->nodes[index]);
    if (!compared) return index;
    index = compared < 0 ? replay->nodes[index].left : replay->nodes[index].right;
  }
  return 0;
}
static int height(const general_native_replay *r, uint32_t index) { return index ? r->nodes[index].height : 0; }
static void update(general_native_replay *r, uint32_t index) {
  int left = height(r, r->nodes[index].left), right = height(r, r->nodes[index].right);
  r->nodes[index].height = 1 + (left > right ? left : right);
}
static uint32_t left(general_native_replay *r, uint32_t index) {
  uint32_t next = r->nodes[index].right; r->nodes[index].right = r->nodes[next].left; r->nodes[next].left = index;
  update(r, index); update(r, next); return next;
}
static uint32_t right(general_native_replay *r, uint32_t index) {
  uint32_t next = r->nodes[index].left; r->nodes[index].left = r->nodes[next].right; r->nodes[next].right = index;
  update(r, index); update(r, next); return next;
}
static uint32_t insert(general_native_replay *r, uint32_t root, uint32_t added) {
  if (!root) return added;
  int compared = compare(r->nodes[added].profile, r->nodes[added].state.event.reference, &r->nodes[root]);
  if (compared < 0) r->nodes[root].left = insert(r, r->nodes[root].left, added);
  else r->nodes[root].right = insert(r, r->nodes[root].right, added);
  update(r, root); int balance = height(r, r->nodes[root].left) - height(r, r->nodes[root].right);
  if (balance > 1) {
    if (compare(r->nodes[added].profile, r->nodes[added].state.event.reference, &r->nodes[r->nodes[root].left]) > 0)
      r->nodes[root].left = left(r, r->nodes[root].left);
    return right(r, root);
  }
  if (balance < -1) {
    if (compare(r->nodes[added].profile, r->nodes[added].state.event.reference, &r->nodes[r->nodes[root].right]) < 0)
      r->nodes[root].right = right(r, r->nodes[root].right);
    return left(r, root);
  }
  return root;
}
static bool same_attempt(const general_native_event *a, const general_native_event *b) {
  return !strcmp(a->operation_id, b->operation_id) && !strcmp(a->operation_digest, b->operation_digest) &&
    a->has_expected == b->has_expected && (!a->has_expected || !strcmp(a->expected_digest, b->expected_digest)) && !strcmp(a->next_digest, b->next_digest);
}
static bool transition(const general_native_ref_state *previous, const general_native_event *next, uint64_t *admitted) {
  if (next->stage == GENERAL_NATIVE_ADMITTED) {
    if (previous && (previous->event.stage != GENERAL_NATIVE_COMMITTED || !next->has_expected || strcmp(previous->event.next_digest, next->expected_digest))) return false;
    *admitted = next->sequence; return true;
  }
  if (!previous || !same_attempt(&previous->event, next)) return false;
  general_native_stage before = previous->event.stage;
  bool ok = (before == GENERAL_NATIVE_ADMITTED && next->stage == GENERAL_NATIVE_WRITE_STARTED) ||
    (before == GENERAL_NATIVE_WRITE_STARTED && (next->stage == GENERAL_NATIVE_COMMITTED || next->stage == GENERAL_NATIVE_UNCERTAIN)) ||
    (before == GENERAL_NATIVE_UNCERTAIN && next->stage == GENERAL_NATIVE_COMMITTED);
  if (ok) *admitted = previous->admitted_sequence;
  return ok;
}
bool general_native_replay_feed(general_native_replay *replay, const unsigned char *body, size_t size, const char *row_digest) {
  if (!replay || replay->invalid || replay->sealed || replay->has_tail || !general_canonical_hash_valid(row_digest)) return reject(replay);
  general_native_event event; char checked[65];
  if (!general_native_event_parse(body, size, &event) || event.sequence != replay->seen + 1 || event.sequence > GENERAL_NATIVE_EVENT_LIMIT ||
      strcmp(event.previous_digest, replay->last_digest) || !general_native_event_digest(&event, checked) || strcmp(checked, row_digest)) return reject(replay);
  char profile[37] = {0};
  if (general_native_reference_profile_scoped(event.reference) && (!replay->resolver.profile ||
      !replay->resolver.profile(&event, replay->resolver.context, profile) || !general_session_uuid_valid(profile))) return reject(replay);
  general_resource_kind resource; char bound[37];
  if (general_canonical_resource_reference(event.reference, &resource, bound) && strcmp(bound, profile)) return reject(replay);
  uint32_t index = find(replay, profile, event.reference); uint64_t admitted;
  if (!transition(index ? &replay->nodes[index].state : NULL, &event, &admitted)) return reject(replay);
  if (event.sequence == replay->anchor.sequence && strcmp(checked, replay->anchor.head_digest)) return reject(replay);
  if (event.sequence > replay->anchor.sequence) {
    if (event.sequence != replay->anchor.sequence + 1) return reject(replay);
    replay->tail = event; memcpy(replay->tail_digest, checked, sizeof(checked)); replay->has_tail = true;
  } else {
    if (!index) {
      if (replay->count >= replay->capacity) return reject(replay);
      index = ++replay->count; replay->nodes[index].height = 1; replay->nodes[index].state.event = event;
      memcpy(replay->nodes[index].profile, profile, sizeof(profile));
      replay->root = insert(replay, replay->root, index);
    }
    replay->nodes[index].state.event = event; replay->nodes[index].state.admitted_sequence = admitted;
  }
  replay->seen = event.sequence; memcpy(replay->last_digest, checked, sizeof(checked)); return true;
}
general_native_replay_status general_native_replay_seal(general_native_replay *replay) {
  if (!replay || replay->invalid) return GENERAL_NATIVE_REPLAY_INVALID;
  if (replay->sealed) return replay->status;
  replay->sealed = true;
  if (replay->seen < replay->anchor.sequence) { reject(replay); return GENERAL_NATIVE_REPLAY_INVALID; }
  replay->status = replay->has_tail ? GENERAL_NATIVE_REPLAY_TAIL : GENERAL_NATIVE_REPLAY_MATCHED; return replay->status;
}
static bool readable(const general_native_replay *replay) {
  return replay && replay->sealed && !replay->invalid && (replay->status == GENERAL_NATIVE_REPLAY_MATCHED || replay->status == GENERAL_NATIVE_REPLAY_TAIL);
}
general_native_ref_presence general_native_replay_lookup(const general_native_replay *replay, const char *profile_id, const char *reference, general_native_ref_state *out) {
  if (!readable(replay) || !general_canonical_native_reference_valid(reference) || !out) return GENERAL_NATIVE_REF_ERROR;
  bool scoped = general_native_reference_profile_scoped(reference);
  if ((scoped && (!replay->resolver.profile || !general_session_uuid_valid(profile_id))) || (!scoped && profile_id)) return GENERAL_NATIVE_REF_ERROR;
  general_resource_kind resource; char bound[37];
  if (general_canonical_resource_reference(reference, &resource, bound) && strcmp(bound, scoped ? profile_id : "")) return GENERAL_NATIVE_REF_ERROR;
  uint32_t index = find(replay, scoped ? profile_id : "", reference); if (!index) return GENERAL_NATIVE_REF_UNREGISTERED;
  *out = replay->nodes[index].state; return GENERAL_NATIVE_REF_REGISTERED;
}
bool general_native_replay_matched_head(const general_native_replay *replay, general_native_head *out) {
  if (!out || !readable(replay) || replay->status != GENERAL_NATIVE_REPLAY_MATCHED) return false;
  *out = replay->anchor; return true;
}
bool general_native_replay_tail(const general_native_replay *replay, general_native_event *out, char digest[65]) {
  if (!readable(replay) || !replay->has_tail || !out || !digest) return false;
  *out = replay->tail; memcpy(digest, replay->tail_digest, 65); return true;
}
void general_native_replay_destroy(general_native_replay **owner) {
  if (!owner || !*owner) return;
  general_native_replay *replay = *owner; erase(replay->nodes, pool_size(replay->capacity)); free(replay->nodes);
  erase(replay, sizeof(*replay)); free(replay); *owner = NULL;
}
