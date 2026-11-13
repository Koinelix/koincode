#ifndef KOINCODE_GENERAL_ROOT_ENROLLMENT_H
#define KOINCODE_GENERAL_ROOT_ENROLLMENT_H
typedef enum { GENERAL_ROOT_ENROLLMENT_UNAVAILABLE, GENERAL_ROOT_ENROLLMENT_BUSY, GENERAL_ROOT_ENROLLMENT_UNCERTAIN, GENERAL_ROOT_ENROLLMENT_COMPLETE } general_root_enrollment_result;
/* Dedicated installed Root tool only; one run per process. No caller paths,
 * UID, plan, authentication boolean or material input. CONTROL_TRUNCATED
 * terminates this dedicated process immediately with exit status 74. */
general_root_enrollment_result general_root_enrollment_run(void);
/* Signal-safe cancellation request; actual IO must drain or process exit. */
void general_root_enrollment_cancel(void);
#endif
