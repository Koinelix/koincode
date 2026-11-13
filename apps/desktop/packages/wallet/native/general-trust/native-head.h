#ifndef KOINCODE_GENERAL_NATIVE_HEAD_H
#define KOINCODE_GENERAL_NATIVE_HEAD_H
#include "session-canonical.h"

#define GENERAL_NATIVE_HEAD_MAX 16384U
#define GENERAL_NATIVE_EVENT_MAX 4096U
#define GENERAL_NATIVE_EVENT_LIMIT 131072U
typedef struct {
  uint32_t uid;
  char owner_id[37], installation_id[37], enrollment_id[37], initialization_id[37], initialization_digest[65];
} general_native_identity;
typedef struct { general_native_identity identity; uint64_t sequence; char head_digest[65]; } general_native_head;
typedef enum {
  GENERAL_NATIVE_STAGE_NONE, GENERAL_NATIVE_ADMITTED, GENERAL_NATIVE_WRITE_STARTED,
  GENERAL_NATIVE_COMMITTED, GENERAL_NATIVE_UNCERTAIN
} general_native_stage;
typedef struct {
  uint64_t sequence;
  char previous_digest[65], operation_id[37], operation_digest[65], reference[GENERAL_SESSION_REFERENCE_MAX + 1];
  general_native_stage stage;
  bool has_expected;
  char expected_digest[65], next_digest[65];
} general_native_event;

/* Pure metadata validation only. An identity or head supplied by a caller is not a trusted anchor. */
bool general_native_identity_valid(const general_native_identity *identity);
bool general_native_head_valid(const general_native_head *head);
bool general_native_event_valid(const general_native_event *event);
bool general_native_head_same_identity(const general_native_head *head, const general_native_identity *identity);
bool general_native_genesis_digest(const general_native_identity *identity, char out[65]);
bool general_native_event_digest(const general_native_event *event, char out[65]);
bool general_native_head_parse(const unsigned char *bytes, size_t size, general_native_head *out);
bool general_native_event_parse(const unsigned char *bytes, size_t size, general_native_event *out);
/* Encode and parse leave caller output/size unchanged on failure. */
bool general_native_head_encode(const general_native_head *head, unsigned char *out, size_t capacity, size_t *size);
bool general_native_event_encode(const general_native_event *event, unsigned char *out, size_t capacity, size_t *size);
#endif
