#import "control-protocol.h"
#include "session-canonical.h"
#include <string.h>
static BOOL keys(id value, NSArray *expected) {
  return [value isKindOfClass:NSDictionary.class] && [value count] == expected.count &&
    [[NSSet setWithArray:[value allKeys]] isEqualToSet:[NSSet setWithArray:expected]];
}
static BOOL number(id value, BOOL positive) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == CFNumberGetTypeID() && !CFNumberIsFloatType((__bridge CFNumberRef)value) &&
    [value longLongValue] >= (positive ? 1 : 0) && [value unsignedLongLongValue] <= GENERAL_SESSION_SAFE_INTEGER_MAX;
}
static BOOL identifier(id value, char *out) {
  if (![value isKindOfClass:NSString.class] || [value length] != 36 || !general_session_uuid_valid([value UTF8String])) return NO;
  if (out) memcpy(out, [value UTF8String], 37); return YES;
}
static NSData *canonical(id value) { return [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes error:NULL]; }
static NSData *frame(NSDictionary *value, NSUInteger maximum) {
  NSData *body = canonical(value); if (!body.length || body.length > maximum) return nil;
  unsigned char header[4] = { (unsigned char)(body.length >> 24), (unsigned char)(body.length >> 16), (unsigned char)(body.length >> 8), (unsigned char)body.length };
  NSMutableData *wire = [NSMutableData dataWithBytes:header length:4]; [wire appendData:body]; return wire;
}
bool general_control_request_parse(NSData *bytes, general_control_request *out) {
  if (![bytes isKindOfClass:NSData.class] || !bytes.length || bytes.length > GENERAL_CONTROL_REQUEST_MAX || !out) return false;
  id row = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL]; general_control_request parsed = {0};
  if (!keys(row, @[@"format", @"version", @"controlId", @"sequence", @"requestId", @"windowId", @"command", @"body"]) ||
      ![row[@"format"] isEqual:@"koincode-general-control-request"] || !number(row[@"version"], YES) || ![row[@"version"] isEqual:@1] ||
      !number(row[@"sequence"], YES) || !identifier(row[@"controlId"], parsed.control_id) || !identifier(row[@"requestId"], parsed.request_id) ||
      !identifier(row[@"windowId"], parsed.window_id) || ![canonical(row) isEqualToData:bytes]) return false;
  NSArray *commands = @[@"snapshot", @"open_manager", @"cancel", @"close"]; NSUInteger index = [commands indexOfObject:row[@"command"]];
  if (index == NSNotFound) return false;
  parsed.command = (general_control_command)(index + 1); parsed.sequence = [row[@"sequence"] unsignedLongLongValue];
  if (parsed.command == GENERAL_CONTROL_CANCEL ? !keys(row[@"body"], @[@"targetRequestId"]) || !identifier(row[@"body"][@"targetRequestId"], parsed.target_id) : !keys(row[@"body"], @[])) return false;
  *out = parsed; return true;
}
static BOOL address(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 42 || ![value hasPrefix:@"0x"]) return NO;
  const char *text = [value UTF8String]; if (!text || strlen(text) != 42) return NO;
  for (unsigned i = 2; i < 42; i++) if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f'))) return NO;
  return YES;
}
static BOOL utc(id value) {
  if (![value isKindOfClass:NSString.class] || ([value length] != 20 && [value length] != 24) || ![value hasSuffix:@"Z"]) return NO;
  NSISO8601DateFormatter *format = [NSISO8601DateFormatter new];
  format.formatOptions = NSISO8601DateFormatWithInternetDateTime | ([value length] == 24 ? NSISO8601DateFormatWithFractionalSeconds : 0);
  format.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0]; NSDate *date = [format dateFromString:value];
  return date && [[format stringFromDate:date] isEqualToString:value];
}
static BOOL snapshot(NSDictionary *body) {
  if (!keys(body, @[@"format", @"version", @"viewId", @"generation", @"state", @"sourceRevision", @"observedAt", @"accounts"]) ||
      ![body[@"format"] isEqual:@"koincode-general-wallet-view"] || !number(body[@"version"], YES) || ![body[@"version"] isEqual:@1] ||
      !identifier(body[@"viewId"], NULL) || !number(body[@"generation"], YES) || ![body[@"accounts"] isKindOfClass:NSArray.class] || [body[@"accounts"] count] > 256) return NO;
  if (![body[@"state"] isEqual:@"ready"]) return [@[@"needs_initialization", @"locked", @"recovery_required", @"unavailable"] containsObject:body[@"state"]] &&
    body[@"sourceRevision"] == NSNull.null && body[@"observedAt"] == NSNull.null && ![body[@"accounts"] count];
  if (!number(body[@"sourceRevision"], NO) || !utc(body[@"observedAt"])) return NO;
  NSMutableSet *seen = [NSMutableSet set];
  for (id account in body[@"accounts"]) {
    if (!keys(account, @[@"sourceId", @"address", @"sourceType", @"backupVerified"]) || !identifier(account[@"sourceId"], NULL) ||
        [seen containsObject:account[@"sourceId"]] || !address(account[@"address"]) || ![@[@"mnemonic", @"private_key"] containsObject:account[@"sourceType"]] ||
        CFGetTypeID((__bridge CFTypeRef)account[@"backupVerified"]) != CFBooleanGetTypeID()) return NO;
    [seen addObject:account[@"sourceId"]];
  }
  return YES;
}
NSData *general_control_hello(const char control_id[37]) {
  if (!general_session_uuid_valid(control_id)) return nil;
  return frame(@{@"format":@"koincode-general-control-hello", @"version":@1, @"controlId":[NSString stringWithUTF8String:control_id]}, 1024);
}
NSData *general_control_reply(const general_control_request *request, uint64_t delivery, general_control_status status, NSDictionary *body) {
  if (!request || !general_session_uuid_valid(request->control_id) || !general_session_uuid_valid(request->request_id) || !general_session_uuid_valid(request->window_id) ||
      !request->sequence || request->sequence > GENERAL_SESSION_SAFE_INTEGER_MAX || !delivery || delivery > GENERAL_SESSION_SAFE_INTEGER_MAX ||
      request->command < GENERAL_CONTROL_SNAPSHOT || request->command > GENERAL_CONTROL_CLOSE || (unsigned)status > GENERAL_CONTROL_CANCELED) return nil;
  BOOL valid = status != GENERAL_CONTROL_OK ? keys(body, @[]) : request->command == GENERAL_CONTROL_SNAPSHOT ? snapshot(body) :
    request->command == GENERAL_CONTROL_OPEN_MANAGER ? keys(body, @[@"opened"]) && (__bridge CFTypeRef)body[@"opened"] == kCFBooleanTrue : keys(body, @[]);
  if (!valid) return nil;
  NSArray *statuses = @[@"ok", @"unavailable", @"busy", @"canceled"], *codes = @[@"GENERAL_CONTROL_OK", @"GENERAL_CONTROL_UNAVAILABLE", @"GENERAL_OPERATION_BUSY", @"GENERAL_OPERATION_CANCELED"];
  return frame(@{@"format":@"koincode-general-control-reply", @"version":@1, @"controlId":[NSString stringWithUTF8String:request->control_id],
    @"sequence":@(request->sequence), @"requestId":[NSString stringWithUTF8String:request->request_id], @"windowId":[NSString stringWithUTF8String:request->window_id],
    @"deliverySequence":@(delivery), @"status":statuses[status], @"code":codes[status], @"body":body}, GENERAL_CONTROL_REPLY_MAX);
}
NSData *general_control_event(const char control_id[37], uint64_t delivery, const char view_id[37], uint64_t generation, BOOL manager_closed) {
  if (!general_session_uuid_valid(control_id) || !general_session_uuid_valid(view_id) || !delivery || delivery > GENERAL_SESSION_SAFE_INTEGER_MAX || !generation || generation > GENERAL_SESSION_SAFE_INTEGER_MAX) return nil;
  return frame(@{@"format":@"koincode-general-control-event", @"version":@1, @"controlId":[NSString stringWithUTF8String:control_id], @"deliverySequence":@(delivery),
    @"viewId":[NSString stringWithUTF8String:view_id], @"generation":@(generation), @"event":manager_closed ? @"manager_closed" : @"invalidated"}, 1024);
}
