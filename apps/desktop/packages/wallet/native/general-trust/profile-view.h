#ifndef KOINCODE_GENERAL_PROFILE_VIEW_H
#define KOINCODE_GENERAL_PROFILE_VIEW_H
#include "broker-namespace.h"
#include "native-directory.h"
#include "native-journal-connection.h"
#include "native-replay.h"
#include "domain-binding.h"
typedef struct general_profile_view general_profile_view;
typedef struct {
  general_native_head head;
  general_initialization_record initialization;
  bool has_binding;
  general_domain_binding binding;
} general_profile_snapshot;
/* Basic-management production provenance from actual assigned Root metadata and
 * the same physical directory/journal. No supplied identity/phase/profile/plan.
 * Parents must outlive this private serialized observer. Restored-profile
 * continuity requires its original restore actor; it is never treated as new. */
general_profile_view *general_profile_view_open(general_broker_namespace *space, general_native_directory *directory,
  general_native_journal_connection *journal, bool (*current)(void *), void *context);
bool general_profile_view_current(general_profile_view *owner);
/* Same retained physical journal, not merely a matching path or parsed ID. */
bool general_profile_view_uses_journal(general_profile_view *owner, general_native_journal_connection *journal);
/* Complete matched native prefix plus actual fixed committed DP records.
 * One original journal loan per call; output/replay unchanged on failure.
 * These snapshots are evidence, not portable material or creation authority. */
bool general_profile_view_snapshot(general_profile_view *owner, general_profile_snapshot *out, general_native_replay **replay);
bool general_profile_view_identity(general_profile_view *owner, general_native_identity *identity, general_session_installation *installation);
/* Native-only historical mapping for this actual initial-new profile. Other
 * profile epochs fail closed instead of relabeling history or making a DB. */
bool general_profile_view_history(general_profile_view *owner, general_native_scope_resolver *out);
bool general_profile_view_close(general_profile_view **owner);
#endif
