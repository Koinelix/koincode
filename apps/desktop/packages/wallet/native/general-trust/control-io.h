#ifndef KOINCODE_GENERAL_CONTROL_IO_H
#define KOINCODE_GENERAL_CONTROL_IO_H
#include <stdbool.h>
#include <stddef.h>
#ifndef GENERAL_CONTROL_INPUT_MAX
#define GENERAL_CONTROL_INPUT_MAX 8192U
#endif
typedef struct general_control_io general_control_io;
typedef enum { GENERAL_CONTROL_IO_WAIT, GENERAL_CONTROL_IO_FRAME, GENERAL_CONTROL_IO_EOF,
  GENERAL_CONTROL_IO_INVALID, GENERAL_CONTROL_IO_UNCERTAIN } general_control_io_result;
/* Fixed public stdin/stdout only. Captures the actual kernel parent/start time
 * and original descriptors. It grants no protected peer or wallet authority. */
general_control_io *general_control_io_open(void);
bool general_control_io_current(general_control_io *owner);
/* Original actor only: readiness polling of its retained private descriptor,
 * never reading that descriptor. Zero timeout means event-driven idle wait;
 * an admitted partial public frame still expires within its original 30s. */
bool general_control_io_wait(general_control_io *owner, int private_descriptor, unsigned maximum_ms);
general_control_io_result general_control_io_read(general_control_io *owner, unsigned char output[GENERAL_CONTROL_INPUT_MAX], size_t *size);
/* Revocation wakeup only; caller retains the original queue until every real
 * reader/writer has returned. This never certifies OS IO or owner drainage. */
void general_control_io_interrupt(general_control_io *owner);
bool general_control_io_write(general_control_io *owner, const unsigned char *bytes, size_t size);
bool general_control_io_close(general_control_io **owner);
#endif
