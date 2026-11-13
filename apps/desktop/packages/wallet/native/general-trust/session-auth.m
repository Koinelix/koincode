#import "session-auth.h"
#import "auth-scope.h"
#include <string.h>

static NSDictionary *archive(NSData *data) {
  general_canonical_reader reader = { .bytes = data.bytes, .size = data.length };
  char locale[8], digest[65], request[37];
  if (!general_canonical_take(&reader, "{\"accountAddress\":null,\"action\":\"archive_read\",\"format\":\"koincode-general-auth-request\",\"locale\":") ||
      !general_canonical_string(&reader, locale, sizeof(locale)) || (strcmp(locale, "en-US") && strcmp(locale, "zh-CN")) ||
      !general_canonical_take(&reader, ",\"operationDigest\":") || !general_canonical_string(&reader, digest, sizeof(digest)) || !general_canonical_hash_valid(digest) ||
      !general_canonical_take(&reader, ",\"requestId\":") || !general_canonical_string(&reader, request, sizeof(request)) || !general_session_uuid_valid(request) ||
      !general_canonical_take(&reader, ",\"version\":1}") || reader.position != reader.size) return nil;
  return @{@"format":@"koincode-general-auth-request", @"version":@1, @"action":@"archive_read", @"accountAddress":NSNull.null,
    @"locale":[NSString stringWithUTF8String:locale], @"operationDigest":[NSString stringWithUTF8String:digest], @"requestId":[NSString stringWithUTF8String:request]};
}
NSDictionary *general_parse_session_auth(NSData *data) {
  if (![data isKindOfClass:NSData.class] || !data.length || data.length > 32768) return nil;
  return general_parse_auth_scope(data) ?: archive(data);
}
/* Bounded object boundary only. The original fixed-schema parsers establish
 * the inner syntax and canonical form. Arrays have no place in this schema. */
static BOOL object(general_canonical_reader *reader, size_t maximum, NSRange *range) {
  if (reader->position >= reader->size || reader->bytes[reader->position] != '{') return NO;
  size_t start = reader->position; unsigned depth = 0;
  while (reader->position < reader->size && reader->position - start < maximum) {
    unsigned char byte = reader->bytes[reader->position];
    if (byte == '"') {
      if (!general_canonical_string(reader, NULL, maximum + 1)) return NO;
      continue;
    }
    reader->position++;
    if (byte == '{') { if (++depth > 8) return NO; }
    else if (byte == '}') {
      if (!depth) return NO;
      if (!--depth) { *range = NSMakeRange(start, reader->position - start); return range->length <= maximum; }
    } else if (byte == '[' || byte == ']') return NO;
  }
  return NO;
}
static BOOL envelope(const general_session_request *request, size_t size) {
  return request && request->command == GENERAL_SESSION_BEGIN && general_session_uuid_valid(request->session_id) &&
    general_session_uuid_valid(request->request_id) && general_session_uuid_valid(request->operation_id) && request->sequence > 0 &&
    request->sequence <= GENERAL_SESSION_SAFE_INTEGER_MAX && general_session_request_accepts_value(request, size);
}
NSDictionary *general_parse_session_begin_auth(const general_session_request *request, NSData *data,
  const general_initialization_plan *reservation, general_initialization_record *initialization) {
  if (![data isKindOfClass:NSData.class] || !envelope(request, data.length)) return nil;
  NSData *auth = data; general_initialization_record record;
  if (request->body.begin.kind == GENERAL_SESSION_INITIALIZATION) {
    if (!initialization || !general_initialization_plan_valid(reservation) ||
        !general_session_uuid_valid(request->body.begin.data.initialization.initialization_id) ||
        !general_canonical_hash_valid(request->body.begin.data.initialization.initialization_digest) ||
        strcmp(request->body.begin.data.initialization.initialization_id, reservation->identity.initialization_id) ||
        strcmp(request->body.begin.data.initialization.initialization_digest, reservation->identity.initialization_digest)) return nil;
    general_canonical_reader reader = { .bytes = data.bytes, .size = data.length }; NSRange auth_range, record_range;
    if (!general_canonical_take(&reader, "{\"authRequest\":") || !object(&reader, 32768, &auth_range) || !general_canonical_take(&reader, ",\"record\":") ||
        !object(&reader, GENERAL_NATIVE_INITIALIZATION_MAX, &record_range) || !general_canonical_take(&reader, "}") || reader.position != reader.size ||
        !general_initialization_record_parse((const unsigned char *)data.bytes + record_range.location, record_range.length, &record) ||
        !general_initialization_binding_valid(&record, reservation)) return nil;
    auth = [data subdataWithRange:auth_range];
  } else if (request->body.begin.kind != GENERAL_SESSION_OPERATION || reservation) return nil;
  NSDictionary *scope = general_parse_session_auth(auth);
  if (!scope || strcmp([scope[@"requestId"] UTF8String], request->request_id)) return nil;
  if (request->body.begin.kind == GENERAL_SESSION_INITIALIZATION) {
    NSString *action = reservation->kind == GENERAL_INITIALIZATION_NEW ? @"create_wallet" : @"restore_wallet";
    if (![scope[@"action"] isEqual:action] || strcmp([scope[@"operationDigest"] UTF8String], reservation->identity.initialization_digest)) return nil;
    *initialization = record;
  } else {
    BOOL planned = [scope[@"action"] isEqual:@"restore_wallet"] || [scope[@"action"] isEqual:@"archive_read"];
    if (planned != request->body.begin.data.operation.has_plan || (planned && !general_session_uuid_valid(request->body.begin.data.operation.plan_id))) return nil;
  }
  return scope;
}
