#ifndef KOINCODE_GENERAL_SESSION_CODE_H
#define KOINCODE_GENERAL_SESSION_CODE_H
#include "session-installation.h"
#include <Security/Security.h>

typedef enum { GENERAL_CODE_HOST, GENERAL_CODE_BROKER, GENERAL_CODE_PROVISIONER, GENERAL_CODE_PAYMENT_OWNER } general_session_code_role;
/* Fixed formal roles only. This does not verify protected bundle resources,
 * complete provisioning/lifetime authorization, child provenance, authentication
 * or a scope. A running broker additionally requires the actual OS restricted-
 * entitlement validation status, never merely declared signature fields. */
bool general_session_code_matches(SecCodeRef code, general_session_code_role role, const general_session_installation *receipt);
bool general_session_code_self(general_session_code_role role, const general_session_installation *receipt);
/* Static sealed/nested/all-architecture validation of the same fixed role.
 * It does not establish provisioning authorization or a running peer. */
bool general_session_code_distribution(general_session_code_role role, const general_session_installation *receipt);
#endif
