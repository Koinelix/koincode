#ifndef KOINCODE_GENERAL_PROFILE_ORIGIN_H
#define KOINCODE_GENERAL_PROFILE_ORIGIN_H
#include "profile-view.h"
#include "resource-session.h"
typedef struct general_profile_origin general_profile_origin;
typedef enum { GENERAL_PROFILE_ORIGIN_REJECTED, GENERAL_PROFILE_ORIGIN_READY, GENERAL_PROFILE_ORIGIN_UNCERTAIN } general_profile_origin_result;
/* Native basic-manager factory only. Derives initial-new profile, stage and
 * fixed parent descriptors from actual Root/DP/native-prefix evidence.
 * Caller retains view and directory through this object's successful close;
 * this object must outlive any original resource session using its resolver.
 * No path/profile/phase/create flag or supplied record bytes are accepted. */
general_profile_origin_result general_profile_origin_open(general_profile_view *view, general_native_directory *directory,
  bool (*current)(void *), void *context, general_profile_origin **out);
bool general_profile_origin_resolver(general_profile_origin *owner, general_resource_origin_resolver *out);
bool general_profile_origin_close(general_profile_origin **owner);
#endif
