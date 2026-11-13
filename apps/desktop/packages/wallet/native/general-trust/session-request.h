#ifndef KOINCODE_GENERAL_SESSION_REQUEST_H
#define KOINCODE_GENERAL_SESSION_REQUEST_H
#include "session-frame.h"
#include "session-canonical.h"
#include <stdint.h>

#define GENERAL_SESSION_CANDIDATE_MAX 16384U

typedef enum {
  GENERAL_SESSION_COMMAND_NONE, GENERAL_SESSION_BEGIN, GENERAL_SESSION_READ, GENERAL_SESSION_WRITE,
  GENERAL_SESSION_PUBLISH, GENERAL_SESSION_INSPECT, GENERAL_SESSION_END, GENERAL_SESSION_CANCEL, GENERAL_SESSION_CLOSE, GENERAL_SESSION_RESOURCE, GENERAL_SESSION_WINDOW
} general_session_command;
typedef enum {
  GENERAL_SESSION_SCOPE_NONE, GENERAL_SESSION_INSPECTION, GENERAL_SESSION_BOOTSTRAP_RESTORE,
  GENERAL_SESSION_OPERATION, GENERAL_SESSION_INITIALIZATION
} general_session_begin_kind;
typedef enum { GENERAL_SESSION_LOCALE_NONE, GENERAL_SESSION_EN_US, GENERAL_SESSION_ZH_CN } general_session_locale;
typedef enum { GENERAL_RESOURCE_ACTION_NONE, GENERAL_RESOURCE_PREPARE, GENERAL_RESOURCE_START, GENERAL_RESOURCE_COMMIT,
  GENERAL_RESOURCE_INSPECT, GENERAL_RESOURCE_RELEASE } general_resource_action;
typedef enum { GENERAL_SESSION_ORIGIN_NONE, GENERAL_SESSION_ORIGIN_INITIALIZATION, GENERAL_SESSION_ORIGIN_RESTORE } general_session_resource_origin;

typedef struct {
  char session_id[37], request_id[37], operation_id[37];
  uint64_t sequence;
  general_session_command command;
  union {
    struct {
      general_session_begin_kind kind;
      union {
        struct { uint32_t byte_length; char ciphertext_digest[65]; general_session_locale locale; } bootstrap;
        struct { bool has_plan; char plan_id[37]; } operation;
        struct { char initialization_id[37], initialization_digest[65]; } initialization;
      } data;
    } begin;
    struct { char reference[GENERAL_SESSION_REFERENCE_MAX + 1]; } reference;
    struct { bool has_expected; char expected_digest[65], next_digest[65], reference[GENERAL_SESSION_REFERENCE_MAX + 1]; } write;
    struct { char recovery_id[37], plan_digest[65]; bool has_expected; char expected_binding_digest[65];
      char canonical_candidate[GENERAL_SESSION_CANDIDATE_MAX + 1]; } publish;
    struct { char target_request_id[37]; } cancel;
    struct { uint32_t window_id; } window;
    struct { general_resource_action action; general_resource_kind kind; bool has_profile;
      char profile_id[37], ticket_id[37], origin_id[37], origin_digest[65]; general_session_resource_origin origin; } resource;
  } body;
} general_session_request;

/* Structural parsing only. No peer, replay, record semantics, authentication or IO authority is established. */
bool general_session_parse_request(const unsigned char *bytes, size_t size, general_session_request *output);
bool general_session_request_metadata_valid(const unsigned char *bytes, size_t size, void *output);
bool general_session_request_accepts_value(const general_session_request *request, size_t size);
bool general_session_parse_hello(const unsigned char *bytes, size_t size, char session_id[37]);
void general_session_request_clear(general_session_request *request);
#endif
