#import "auth-scope.h"
#import "trust.h"
#include <sys/stat.h>
#include <unistd.h>

BOOL general_auth_hexadecimal(NSString *value, NSUInteger length) {
  if (![value isKindOfClass:NSString.class] || value.length != length) return NO;
  const char *bytes = value.UTF8String;
  if (!bytes || strlen(bytes) != length) return NO;
  for (NSUInteger index = 0; index < length; index++) if (!((bytes[index] >= '0' && bytes[index] <= '9') || (bytes[index] >= 'a' && bytes[index] <= 'f'))) return NO;
  return YES;
}
BOOL general_auth_uuid(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length != 36) return NO;
  const char *text = value.UTF8String;
  if (!text || strlen(text) != 36) return NO;
  for (NSUInteger index = 0; index < 36; index++) {
    char c = text[index];
    if (index == 8 || index == 13 || index == 18 || index == 23) { if (c != '-') return NO; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return NO;
  }
  return YES;
}
NSDictionary *general_parse_auth_scope(NSData *data) {
  if (!data || !data.length || data.length > 32768) return nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  if (![object isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *scope = object;
  BOOL manual = [scope[@"action"] isEqual:@"manual_transfer"];
  NSMutableSet *expected = [NSMutableSet setWithArray:@[@"format", @"version", @"requestId", @"action", @"operationDigest", @"accountAddress", @"locale"]];
  if (manual) [expected addObject:@"manualTransfer"];
  if (![[NSSet setWithArray:scope.allKeys] isEqualToSet:expected]) return nil;
  id version = scope[@"version"];
  NSSet *actions = [NSSet setWithArray:@[@"create_wallet", @"import_mnemonic", @"import_private_key", @"reveal_mnemonic", @"export_private_key", @"backup_wallet", @"restore_wallet", @"manual_transfer"]];
  if (![scope[@"format"] isEqual:@"koincode-general-auth-request"] || ![version isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)version) != CFNumberGetTypeID() || CFNumberIsFloatType((__bridge CFNumberRef)version) || [version longLongValue] != 1 ||
      !general_auth_uuid(scope[@"requestId"]) || !general_auth_hexadecimal(scope[@"operationDigest"], 64) || ![actions containsObject:scope[@"action"]] ||
      ![@[@"en-US", @"zh-CN"] containsObject:scope[@"locale"]]) return nil;
  id account = scope[@"accountAddress"];
  if (account != NSNull.null && (![account isKindOfClass:NSString.class] || [account length] != 42 ||
      ![account hasPrefix:@"0x"] || !general_auth_hexadecimal([account substringFromIndex:2], 40))) return nil;
  if (([scope[@"action"] isEqual:@"reveal_mnemonic"] || [scope[@"action"] isEqual:@"export_private_key"]) && account == NSNull.null) return nil;
  if (manual && !general_manual_auth_scope(scope)) return nil;
  NSData *canonical = [NSJSONSerialization dataWithJSONObject:scope options:NSJSONWritingSortedKeys error:NULL];
  if (!canonical || ![canonical isEqualToData:data]) return nil;
  return scope;
}
NSString *general_auth_reason(NSDictionary *scope) {
  NSString *path = [NSString stringWithFormat:@GENERAL_TRUST_HOST "/Contents/Resources/native-auth/%@.json", scope[@"locale"]];
  int fd = general_protected_open(path.fileSystemRepresentation, false);
  if (fd < 0) return nil;
  struct stat info; NSMutableData *data = [NSMutableData data];
  if (fstat(fd, &info) == 0 && info.st_size > 0 && info.st_size <= 65536) {
    unsigned char bytes[4096]; ssize_t count;
    while ((count = read(fd, bytes, sizeof(bytes))) > 0 && data.length + (NSUInteger)count <= 65536) [data appendBytes:bytes length:(NSUInteger)count];
    if (count != 0 || data.length != (NSUInteger)info.st_size) data = nil;
  }
  close(fd);
  if (!data.length) return nil;
  id messages = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  if (![messages isKindOfClass:NSDictionary.class]) return nil;
  if ([scope[@"action"] isEqual:@"manual_transfer"]) return general_manual_auth_reason(scope, messages);
  id reason = messages[scope[@"action"]];
  if (![reason isKindOfClass:NSString.class] || ![reason length] || [reason length] > 512) return nil;
  return scope[@"accountAddress"] == NSNull.null ? reason : [reason stringByAppendingFormat:@"\n%@", scope[@"accountAddress"]];
}
