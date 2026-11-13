#include "resource-commit-send.h"
#include "session-frame-private.h"
#include <fcntl.h>
#include <sys/stat.h>
static bool commit(const unsigned char *bytes, size_t size, void *context) {
  general_session_request *request = context;
  return general_session_parse_request(bytes, size, request) && request->command == GENERAL_SESSION_RESOURCE && request->body.resource.action == GENERAL_RESOURCE_COMMIT;
}
general_session_frame_result general_resource_commit_send(int socket, int database, int writer_lease, unsigned timeout_ms,
  general_session_wire *wire, general_session_frame_current current, void *context) {
  general_session_request request = {0}; general_session_frame parsed = {0}; struct stat first, second; int first_flags, second_flags;
  bool valid = wire && general_session_frame_decode(wire->bytes, wire->size, commit, &request, &parsed) && !parsed.value_size &&
    !fstat(database, &first) && !fstat(writer_lease, &second) && S_ISREG(first.st_mode) && S_ISREG(second.st_mode) &&
    (first.st_dev != second.st_dev || first.st_ino != second.st_ino) &&
    (first_flags = fcntl(database, F_GETFD)) >= 0 && (first_flags & FD_CLOEXEC) && (second_flags = fcntl(writer_lease, F_GETFD)) >= 0 && (second_flags & FD_CLOEXEC);
  general_session_frame_clear(&parsed); general_session_request_clear(&request);
  if (!valid) { general_session_wire_clear(wire); return GENERAL_SESSION_FRAME_INVALID; }
  int descriptors[] = { database, writer_lease };
  general_session_frame_result result = general_session_frame_write_pair(socket, descriptors, timeout_ms, wire, commit, &request, current, context);
  general_session_request_clear(&request); return result;
}
