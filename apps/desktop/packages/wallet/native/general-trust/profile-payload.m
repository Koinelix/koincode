#import "profile-payload.h"
#include <math.h>
#include <string.h>
static BOOL string(id value, NSString *expected) {
  return [value isKindOfClass:NSString.class] && [value isEqualToString:expected];
}
static BOOL allowed(id patterns, NSString *value, NSString *team) {
  if (![patterns isKindOfClass:NSArray.class] || ![patterns count] || [patterns count] > 128) return NO;
  NSString *prefix = [team stringByAppendingString:@"."];
  for (id candidate in patterns) {
    if (![candidate isKindOfClass:NSString.class] || [candidate length] > 256 || ![candidate hasPrefix:prefix]) continue;
    NSRange star = [candidate rangeOfString:@"*"];
    if (star.location == NSNotFound ? [candidate isEqualToString:value] :
        star.location == [candidate length] - 1 && [value hasPrefix:[candidate substringToIndex:star.location]]) return YES;
  }
  return NO;
}
NSDate *general_profile_payload_expiration(NSData *content, NSData *certificate,
    const general_session_installation *receipt, NSDate *now) {
  if (![content isKindOfClass:NSData.class] || !content.length || content.length > 256 * 1024 ||
      ![certificate isKindOfClass:NSData.class] || !certificate.length || certificate.length > 16384 || !receipt || receipt->team_id[10] ||
      !memchr(receipt->keychain_access_group, 0, sizeof(receipt->keychain_access_group)) || ![now isKindOfClass:NSDate.class] || !isfinite(now.timeIntervalSince1970)) return nil;
  NSString *team = [NSString stringWithUTF8String:receipt->team_id], *group = [NSString stringWithUTF8String:receipt->keychain_access_group];
  if (team.length != 10 || !group || ![group isEqualToString:[team stringByAppendingString:@GENERAL_SESSION_ACCESS_GROUP_SUFFIX]]) return nil;
  id payload = [NSPropertyListSerialization propertyListWithData:content options:NSPropertyListImmutable format:NULL error:NULL];
  if (![payload isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *row = payload; id creation = row[@"CreationDate"], expiration = row[@"ExpirationDate"], teams = row[@"TeamIdentifier"], certificates = row[@"DeveloperCertificates"];
  if (![creation isKindOfClass:NSDate.class] || ![expiration isKindOfClass:NSDate.class] ||
      !isfinite([creation timeIntervalSince1970]) || !isfinite([expiration timeIntervalSince1970]) ||
      [creation compare:now] == NSOrderedDescending || [expiration compare:now] != NSOrderedDescending || [expiration compare:creation] != NSOrderedDescending ||
      ![teams isKindOfClass:NSArray.class] || [teams count] != 1 || !string([teams firstObject], team) || (__bridge CFTypeRef)row[@"ProvisionsAllDevices"] != kCFBooleanTrue ||
      ![certificates isKindOfClass:NSArray.class] || ![certificates count] || [certificates count] > 128) return nil;
  BOOL found = NO;
  for (id value in certificates) {
    if (![value isKindOfClass:NSData.class] || ![value length] || [value length] > 16384) return nil;
    if ([value isEqualToData:certificate]) found = YES;
  }
  id entitlements = row[@"Entitlements"];
  if (!found || ![entitlements isKindOfClass:NSDictionary.class] || !string(entitlements[@"com.apple.developer.team-identifier"], team)) return nil;
  NSString *application = [team stringByAppendingString:@".dev.koincode.wallet.protection"];
  if (!allowed(@[entitlements[@"com.apple.application-identifier"] ?: NSNull.null], application, team) ||
      !allowed(entitlements[@"keychain-access-groups"], group, team)) return nil;
  for (NSString *name in @[@"get-task-allow", @"com.apple.security.get-task-allow"])
    if (entitlements[name] && (__bridge CFTypeRef)entitlements[name] != kCFBooleanFalse) return nil;
  return [expiration copy];
}
