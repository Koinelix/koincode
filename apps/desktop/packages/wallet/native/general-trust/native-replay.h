#ifndef KOINCODE_GENERAL_NATIVE_REPLAY_H
#define KOINCODE_GENERAL_NATIVE_REPLAY_H
#include "native-head.h"

typedef struct general_native_replay general_native_replay;
typedef enum { GENERAL_NATIVE_REPLAY_INVALID, GENERAL_NATIVE_REPLAY_MATCHED, GENERAL_NATIVE_REPLAY_TAIL } general_native_replay_status;
typedef enum { GENERAL_NATIVE_REF_ERROR, GENERAL_NATIVE_REF_UNREGISTERED, GENERAL_NATIVE_REF_REGISTERED } general_native_ref_presence;
typedef struct { general_native_event event; uint64_t admitted_sequence; } general_native_ref_state;
/* Native-only, synchronous lookup over already verified historical metadata; never wire/JS-supplied. */
typedef struct {
  bool (*profile)(const general_native_event *event, void *context, char out[37]);
  void *context;
} general_native_scope_resolver;

/* A real DP anchor and verified assignment must be supplied by the native owner, never a wire caller. */
general_native_replay *general_native_replay_create(const general_native_head *anchor, const general_native_scope_resolver *resolver);
bool general_native_replay_feed(general_native_replay *replay, const unsigned char *body, size_t size, const char *row_digest);
general_native_replay_status general_native_replay_seal(general_native_replay *replay);
/* No accepted facts are exposed until the complete prefix has been sealed against that anchor. */
bool general_native_reference_profile_scoped(const char *reference);
/* profile_id comes from the native bound view; NULL is required for enrollment references. */
general_native_ref_presence general_native_replay_lookup(const general_native_replay *replay, const char *profile_id, const char *reference, general_native_ref_state *out);
/* Complete matched prefix only, no unanchored tail; structural evidence, not native authority. */
bool general_native_replay_matched_head(const general_native_replay *replay, general_native_head *out);
bool general_native_replay_tail(const general_native_replay *replay, general_native_event *out, char digest[65]);
void general_native_replay_destroy(general_native_replay **owner);
#endif
