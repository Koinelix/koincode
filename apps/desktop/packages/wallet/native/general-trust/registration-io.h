#ifndef KOINCODE_GENERAL_REGISTRATION_IO_H
#define KOINCODE_GENERAL_REGISTRATION_IO_H
#include "registration-record.h"
#include "enrollment-payload.h"
#include "assignment.h"

typedef struct general_registration_io general_registration_io;
typedef enum { GENERAL_REGISTRATION_IO_REJECTED, GENERAL_REGISTRATION_IO_COMPLETE, GENERAL_REGISTRATION_IO_UNCERTAIN } general_registration_io_result;
typedef struct {
  bool registration_present, assignment_present;
  general_registration_record registration;
  general_assignment assignment;
} general_registration_view;
/* Root actor private IO, not authority. Caller verifies the fixed namespace,
 * actual fresh/peer/auth/OFD/lock and original DP/prefix/operation facts.
 * This owner retains only fd identity, never a second accepted phase. */
general_registration_io *general_registration_io_create(int directory);
bool general_registration_io_inspect(general_registration_io *owner, bool (*current)(void *), void *context, general_registration_view *out);
/* Freshness must be a genuine fact of the original root actor, not inferred
 * from a missing file or this IO constructor. No other scope may call reserve. */
general_registration_io_result general_registration_io_reserve(general_registration_io *owner, const general_initialization_plan *plan, bool (*current)(void *), void *context);
general_registration_io_result general_registration_io_advance(general_registration_io *owner, const general_initialization_plan *plan,
  general_registration_phase expected, general_registration_phase next, bool (*current)(void *), void *context);
general_registration_io_result general_registration_io_assign(general_registration_io *owner, const general_initialization_plan *plan,
  const general_enrollment_payload *payload, bool (*current)(void *), void *context);
/* Refuses a live operation or prior uncertain close. Never retries a close;
 * retain an unreleasable owner until the dedicated root tool actually exits. */
bool general_registration_io_close(general_registration_io **owner);
#endif
