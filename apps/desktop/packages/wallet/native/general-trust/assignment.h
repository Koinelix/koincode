#ifndef KOINCODE_GENERAL_ASSIGNMENT_H
#define KOINCODE_GENERAL_ASSIGNMENT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GENERAL_ASSIGNMENT_MAX_BYTES 16384
typedef struct {
  uint32_t uid;
  char enrollment_id[37];
  char installation_id[37];
  char owner_id[37];
  char initialization_id[37];
  char initialization_digest[65];
} general_assignment;

/* Format and expected-identity checks only; no filesystem, lock, authentication or secret admission. */
bool general_parse_assignment(const unsigned char *bytes, size_t size, uint32_t expected_uid,
  const char *expected_installation, general_assignment *assignment);
/* Existing v1 public metadata only, not enrollment or publication authority.
 * Failure leaves caller output and size unchanged. The root actor alone owns
 * fixed policy, verified original plan, exclusive publication and durability. */
bool general_encode_assignment(const general_assignment *assignment, unsigned char *out, size_t capacity, size_t *size);
#endif
