#ifndef KOINCODE_GENERAL_SESSION_FRAME_H
#define KOINCODE_GENERAL_SESSION_FRAME_H
#include <stdbool.h>
#include <stddef.h>

#define GENERAL_SESSION_METADATA_MAX 32768U
#define GENERAL_SESSION_VALUE_MAX 1048576U
#define GENERAL_SESSION_FRAME_MAX (8U + GENERAL_SESSION_METADATA_MAX + GENERAL_SESSION_VALUE_MAX)

/* Transport ownership only. The session actor must establish peer identity and validate canonical command semantics. */
typedef bool (*general_session_metadata_validator)(const unsigned char *bytes, size_t size, void *context);
typedef bool (*general_session_frame_current)(void *context);
typedef struct {
  unsigned char *metadata;
  size_t metadata_size;
  unsigned char *value;
  size_t value_size;
} general_session_frame;
typedef struct { unsigned char *bytes; size_t size; } general_session_wire;
typedef enum {
  GENERAL_SESSION_FRAME_COMPLETE,
  GENERAL_SESSION_FRAME_EOF,
  GENERAL_SESSION_FRAME_INVALID,
  GENERAL_SESSION_FRAME_CANCELED,
  GENERAL_SESSION_FRAME_TIMEOUT,
  GENERAL_SESSION_FRAME_IO_ERROR,
  /* Enrollment receiver must terminate its dedicated process on unexpected
   * truncation: Darwin may have installed fd numbers absent from the output. */
  GENERAL_SESSION_FRAME_CONTROL_TRUNCATED
} general_session_frame_result;

/* Output must be empty. Callers retain stable input bytes for the duration of each call. */
bool general_session_frame_encode(const unsigned char *metadata, size_t metadata_size,
  const unsigned char *value, size_t value_size, general_session_metadata_validator validate,
  void *context, general_session_wire *output);
bool general_session_frame_decode(const unsigned char *bytes, size_t size,
  general_session_metadata_validator validate, void *context, general_session_frame *output);
/* Reads exactly one frame; the actor separately admits any following frame and closes on malformed input. */
general_session_frame_result general_session_frame_read(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output);
/* Protected Host reply ingress: recvmsg on every fragment, no descriptor is
 * ever accepted. Known rejected descriptors are closed; unknown ancillary
 * cleanup returns CONTROL_TRUNCATED and requires dedicated-process reaping.
 * An original pending begin may wait up to 360 seconds for its first byte;
 * an actual frame still has a single 30-second limit, without renewal. */
general_session_frame_result general_session_frame_read_protected(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output);
/* Enrollment-only transport. descriptor must start at -1; output owns its duplicate
 * on success. No lock/peer/authentication authority is established by receipt.
 * Command parsing supplies a raw-value limit after metadata validation. */
general_session_frame_result general_session_frame_read_enrollment(int fd, unsigned timeout_ms,
  general_session_metadata_validator validate, size_t (*value_limit)(void *), void *validation_context,
  general_session_frame_current current, void *current_context, general_session_frame *output, int *descriptor);
/* Requires an exclusively owned O_NONBLOCK socket description; does not alter
 * its flags. Consumes and wipes the owned wire on every return. Partial/uncertain delivery
 * requires the original actor to close this channel, never resend the command.
 * COMPLETE means accepted by the socket only, not consumed by its peer. */
general_session_frame_result general_session_frame_write(int fd, unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context);
/* Enrollment reserve only. Borrows the original actor's owner-lock loan; never
 * closes/unlocks it. One rights message accompanies the first successful bytes,
 * never subsequent fragments. Same consuming/unknown-delivery contract. */
general_session_frame_result general_session_frame_write_enrollment(int fd, int owner_lock, unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context,
  general_session_frame_current current, void *current_context);
void general_session_frame_clear(general_session_frame *frame);
void general_session_wire_clear(general_session_wire *wire);
#endif
