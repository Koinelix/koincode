#ifndef KOINCODE_GENERAL_CONTROL_PROTOCOL_H
#define KOINCODE_GENERAL_CONTROL_PROTOCOL_H
#import <Foundation/Foundation.h>
#include <stdint.h>
#define GENERAL_CONTROL_REQUEST_MAX 8192U
#define GENERAL_CONTROL_REPLY_MAX (128U * 1024U)
#define GENERAL_CONTROL_ID_LIMIT 65536U
typedef enum { GENERAL_CONTROL_NONE, GENERAL_CONTROL_SNAPSHOT, GENERAL_CONTROL_OPEN_MANAGER, GENERAL_CONTROL_CANCEL, GENERAL_CONTROL_CLOSE } general_control_command;
typedef enum { GENERAL_CONTROL_OK, GENERAL_CONTROL_UNAVAILABLE, GENERAL_CONTROL_BUSY, GENERAL_CONTROL_CANCELED } general_control_status;
typedef struct {
  char control_id[37], request_id[37], window_id[37], target_id[37];
  uint64_t sequence; general_control_command command;
} general_control_request;
/* Public metadata only, never a protected channel, authentication or wallet
 * authority. Canonical input/output is bounded and fields are allowlisted. */
bool general_control_request_parse(NSData *bytes, general_control_request *out);
NSData *general_control_hello(const char control_id[37]);
NSData *general_control_reply(const general_control_request *request, uint64_t delivery_sequence,
  general_control_status status, NSDictionary *body);
NSData *general_control_event(const char control_id[37], uint64_t delivery_sequence, const char view_id[37],
  uint64_t generation, BOOL manager_closed);
#endif
