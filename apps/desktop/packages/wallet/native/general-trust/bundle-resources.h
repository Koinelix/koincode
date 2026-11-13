#ifndef KOINCODE_GENERAL_BUNDLE_RESOURCES_H
#define KOINCODE_GENERAL_BUNDLE_RESOURCES_H
#include "session-installation.h"
typedef enum { GENERAL_BUNDLE_RESOURCE_INVALID, GENERAL_BUNDLE_RESOURCE_BUSY, GENERAL_BUNDLE_RESOURCE_CHECKED,
  GENERAL_BUNDLE_RESOURCE_UNCERTAIN } general_bundle_resource_result;
/* Read-only fixed distribution inspection, under the original actor's actual
 * installation lease/receipt lifetime. No accepted cache or authorization.
 * Unknown cleanup requires the dedicated process to exit, never a retry. */
general_bundle_resource_result general_bundle_resources_check(const general_session_installation *receipt, bool (*current)(void *), void *context);
#endif
