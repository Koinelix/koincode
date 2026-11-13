#import "auth-scope.h"
#include <CommonCrypto/CommonDigest.h>

static BOOL fields(id value, NSArray *keys) {
  return [value isKindOfClass:NSDictionary.class] && [[NSSet setWithArray:[value allKeys]] isEqualToSet:[NSSet setWithArray:keys]];
}
static BOOL integer(id value, int64_t minimum, int64_t maximum) {
  return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) == CFNumberGetTypeID() &&
    !CFNumberIsFloatType((__bridge CFNumberRef)value) && [value longLongValue] >= minimum && [value longLongValue] <= maximum;
}
static int compare(NSString *a, NSString *b) {
  if (a.length != b.length) return a.length < b.length ? -1 : 1;
  return (int)[a compare:b options:NSLiteralSearch];
}
static BOOL atomic(id value, BOOL positive) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *text = value;
  if (!text.length || text.length > 78 || (text.length > 1 && [text hasPrefix:@"0"]) || (positive && [text isEqual:@"0"])) return NO;
  const char *bytes = text.UTF8String;
  if (!bytes || strlen(bytes) != text.length) return NO;
  for (NSUInteger i = 0; i < text.length; i++) if (bytes[i] < '0' || bytes[i] > '9') return NO;
  return compare(text, @"115792089237316195423570985008687907853269984665640564039457584007913129639935") <= 0;
}
static BOOL address(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 42 || ![value hasPrefix:@"0x"] ||
      !general_auth_hexadecimal([value substringFromIndex:2], 40)) return NO;
  return ![value isEqual:@"0x0000000000000000000000000000000000000000"];
}
static NSString *fee_total(NSString *gas, NSString *price, NSString *layer) {
  unsigned int digits[157] = {0};
  for (NSUInteger i = 0; i < gas.length; i++) for (NSUInteger j = 0; j < price.length; j++)
    digits[i + j] += ([gas characterAtIndex:gas.length - i - 1] - '0') * ([price characterAtIndex:price.length - j - 1] - '0');
  for (NSUInteger i = 0; i < layer.length; i++) digits[i] += [layer characterAtIndex:layer.length - i - 1] - '0';
  for (NSUInteger i = 0; i < 156; i++) { digits[i + 1] += digits[i] / 10; digits[i] %= 10; }
  NSUInteger length = 157;
  while (length > 1 && digits[length - 1] == 0) length--;
  if (length > 78) return nil;
  char output[79] = {0};
  for (NSUInteger i = 0; i < length; i++) output[i] = (char)('0' + digits[length - i - 1]);
  NSString *result = [NSString stringWithUTF8String:output];
  return atomic(result, YES) ? result : nil;
}

BOOL general_manual_auth_scope(NSDictionary *scope) {
  NSDictionary *preview = scope[@"manualTransfer"];
  if (!fields(preview, @[@"transferId", @"ownerId", @"accountId", @"accountAddress", @"networkId", @"chainId", @"asset", @"recipient",
      @"amountAtomic", @"nonce", @"fee", @"maxFeeExposureAtomic", @"unsignedTransaction", @"configVersion", @"signingPolicyVersion",
      @"signingPolicyDigest", @"expiresAt", @"digest"])) return NO;
  NSString *chain = preview[@"chainId"];
  // Base Sepolia stays reserved; OP-stack fee authorization has not been approved.
  if (![@[@"1", @"11155111", @"42161", @"421614", @"56", @"97", @"137", @"80002", @"43114", @"43113"] containsObject:chain] ||
      ![preview[@"networkId"] isEqual:[@"eip155:" stringByAppendingString:chain]] ||
      !general_auth_uuid(preview[@"transferId"]) || !general_auth_uuid(preview[@"ownerId"]) || !general_auth_uuid(preview[@"accountId"]) ||
      !address(preview[@"accountAddress"]) || !address(preview[@"recipient"]) || ![scope[@"accountAddress"] isEqual:preview[@"accountAddress"]] ||
      !atomic(preview[@"amountAtomic"], YES) || !atomic(preview[@"maxFeeExposureAtomic"], YES) ||
      !integer(preview[@"nonce"], 0, 9007199254740991LL) || !integer(preview[@"configVersion"], 1, 9007199254740991LL) ||
      !integer(preview[@"expiresAt"], 1, 9007199254740991LL) || !integer(preview[@"signingPolicyVersion"], 2, 2) ||
      ![preview[@"signingPolicyDigest"] isEqual:@"bc4de042d0a1cf3d9ba868395d7759339fe9e6e6fbcc8874673caf92d5c7bc10"] ||
      !general_auth_hexadecimal(preview[@"digest"], 64) || ![scope[@"operationDigest"] isEqual:preview[@"digest"]]) return NO;
  id encoding = preview[@"unsignedTransaction"];
  if (![encoding isKindOfClass:NSString.class] || [encoding length] < 4 || [encoding length] > 16384 || [encoding length] % 2 != 0 ||
      ![encoding hasPrefix:@"0x"] || !general_auth_hexadecimal([encoding substringFromIndex:2], [encoding length] - 2)) return NO;
  NSDictionary *asset = preview[@"asset"], *fee = preview[@"fee"];
  if (![asset isKindOfClass:NSDictionary.class] || ![fee isKindOfClass:NSDictionary.class]) return NO;
  BOOL native = [asset[@"kind"] isEqual:@"native"], legacy = [fee[@"type"] isEqual:@"legacy"];
  if (native ? !fields(asset, @[@"kind", @"decimals"]) || !integer(asset[@"decimals"], 18, 18)
      : ![asset[@"kind"] isEqual:@"erc20"] || !fields(asset, @[@"kind", @"decimals", @"address"]) ||
        !integer(asset[@"decimals"], 0, 255) || !address(asset[@"address"])) return NO;
  if (legacy ? !fields(fee, @[@"type", @"gasLimitAtomic", @"gasPriceAtomic", @"maxLayerFeeAtomic", @"policy"])
      : ![fee[@"type"] isEqual:@"eip1559"] || !fields(fee, @[@"type", @"gasLimitAtomic", @"maxFeePerGasAtomic", @"maxPriorityFeePerGasAtomic", @"maxLayerFeeAtomic", @"policy"])) return NO;
  NSString *price = fee[legacy ? @"gasPriceAtomic" : @"maxFeePerGasAtomic"];
  BOOL arbitrum = [@[@"42161", @"421614"] containsObject:chain];
  if (!atomic(fee[@"gasLimitAtomic"], YES) || !atomic(price, YES) || !atomic(fee[@"maxLayerFeeAtomic"], NO) ||
      ![fee[@"policy"] isEqual:arbitrum ? @"arbitrum" : @"standard"] ||
      (arbitrum && ![fee[@"maxLayerFeeAtomic"] isEqual:@"0"]) || (native && compare(fee[@"gasLimitAtomic"], @"21000") < 0) ||
      (!legacy && (!atomic(fee[@"maxPriorityFeePerGasAtomic"], NO) || compare(fee[@"maxPriorityFeePerGasAtomic"], price) > 0)) ||
      ![fee_total(fee[@"gasLimitAtomic"], price, fee[@"maxLayerFeeAtomic"]) isEqual:preview[@"maxFeeExposureAtomic"]]) return NO;
  NSMutableDictionary *body = [preview mutableCopy]; [body removeObjectForKey:@"digest"];
  NSData *data = [NSJSONSerialization dataWithJSONObject:body options:NSJSONWritingSortedKeys error:NULL];
  if (!data || data.length > 32768) return NO;
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *hex = [NSMutableString string];
  for (NSUInteger i = 0; i < sizeof(hash); i++) [hex appendFormat:@"%02x", hash[i]];
  return [hex isEqual:preview[@"digest"]];
}

static NSString *label(NSDictionary *messages, NSString *key) {
  id value = messages[key];
  return [value isKindOfClass:NSString.class] && [value length] > 0 && [value length] <= 512 ? value : nil;
}
static NSString *decimal_text(NSString *value, NSUInteger decimals) {
  if (decimals == 0) return value;
  NSMutableString *padded = [NSMutableString string];
  while (padded.length + value.length <= decimals) [padded appendString:@"0"];
  [padded appendString:value]; [padded insertString:@"." atIndex:padded.length - decimals];
  while ([padded hasSuffix:@"0"]) [padded deleteCharactersInRange:NSMakeRange(padded.length - 1, 1)];
  if ([padded hasSuffix:@"."]) [padded deleteCharactersInRange:NSMakeRange(padded.length - 1, 1)];
  return padded;
}
NSString *general_manual_auth_reason(NSDictionary *scope, NSDictionary *messages) {
  if (!general_manual_auth_scope(scope) || ![messages isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *p = scope[@"manualTransfer"], *asset = p[@"asset"];
  NSString *chain = p[@"chainId"], *network = label(messages, [@"network_" stringByAppendingString:chain]);
  NSString *symbol = [@[@"56", @"97"] containsObject:chain] ? @"BNB" : [@[@"137", @"80002"] containsObject:chain] ? @"POL" :
    [@[@"43114", @"43113"] containsObject:chain] ? @"AVAX" : @"ETH";
  NSArray *keys = @[@"transfer_account", @"transfer_network", @"transfer_recipient", @"transfer_asset", @"transfer_amount", @"transfer_max_fee", @"transfer_nonce", @"transfer_digest"];
  NSString *title = label(messages, @"manual_transfer"), *atomic_label = label(messages, @"transfer_atomic");
  if (!title || !network || !atomic_label) return nil;
  NSArray *values = @[p[@"accountAddress"], [NSString stringWithFormat:@"%@ (%@)", network, p[@"networkId"]], p[@"recipient"],
    [asset[@"kind"] isEqual:@"native"] ? symbol : asset[@"address"],
    [NSString stringWithFormat:@"%@ (%@ %@)", decimal_text(p[@"amountAtomic"], [asset[@"decimals"] unsignedIntegerValue]), p[@"amountAtomic"], atomic_label],
    [NSString stringWithFormat:@"%@ %@ (%@ %@)", decimal_text(p[@"maxFeeExposureAtomic"], 18), symbol, p[@"maxFeeExposureAtomic"], atomic_label],
    [p[@"nonce"] stringValue], p[@"digest"]];
  NSMutableString *reason = [title mutableCopy];
  for (NSUInteger i = 0; i < keys.count; i++) {
    NSString *name = label(messages, keys[i]); if (!name) return nil;
    [reason appendFormat:@"\n%@: %@", name, values[i]];
  }
  return reason.length <= 2048 ? reason : nil;
}
