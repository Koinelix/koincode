#import "management-record-policy.h"
#import "auth-scope.h"
#include <CommonCrypto/CommonDigest.h>
#include <math.h>

static BOOL keys(NSDictionary *value, NSArray *required, NSArray *optional) {
  if (![value isKindOfClass:NSDictionary.class] || value.count < required.count || value.count > required.count + optional.count) return NO;
  for (NSString *key in required) if (!value[key]) return NO;
  for (id key in value) if (![key isKindOfClass:NSString.class] || (![required containsObject:key] && ![optional containsObject:key])) return NO;
  return YES;
}
static BOOL integer(id value) {
  return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
    isfinite([value doubleValue]) && [value doubleValue] >= 0 && [value doubleValue] <= (double)GENERAL_SESSION_SAFE_INTEGER_MAX &&
    floor([value doubleValue]) == [value doubleValue];
}
static BOOL boolean(id value) { return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(); }
static NSData *encode(id value) {
  if (!value || ![NSJSONSerialization isValidJSONObject:value]) return nil;
  return [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes error:NULL];
}
static NSString *sha(NSData *bytes) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; char hex[65]; static const char alphabet[] = "0123456789abcdef";
  if (!bytes || bytes.length > UINT32_MAX || !CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, hash)) return nil;
  for (unsigned i = 0; i < sizeof(hash); i++) { hex[i * 2] = alphabet[hash[i] >> 4]; hex[i * 2 + 1] = alphabet[hash[i] & 15]; }
  hex[64] = 0; return [NSString stringWithUTF8String:hex];
}
static BOOL address(id value) {
  return [value isKindOfClass:NSString.class] && [value length] == 42 && [value hasPrefix:@"0x"] &&
    general_auth_hexadecimal([value substringFromIndex:2], 40);
}
static BOOL key_reference(id value) {
  return [value isKindOfClass:NSString.class] && [value length] == 47 && [value hasPrefix:@"source-key:"] &&
    general_auth_uuid([value substringFromIndex:11]);
}
static id find(NSArray *rows, NSString *key, id value) {
  for (NSDictionary *row in rows) if ([row[key] isEqual:value]) return row;
  return nil;
}
NSString *general_management_source_commitment(NSDictionary *source) {
  if (!keys(source, @[@"id", @"setupId", @"address", @"sourceType", @"protectedMaterial", @"keyRef", @"inputDigest", @"backupVerified", @"status", @"createdAt"], @[@"derivationPath"])) return nil;
  if (!general_auth_uuid(source[@"id"]) || !general_auth_uuid(source[@"setupId"]) || !address(source[@"address"]) ||
      ![@[@"mnemonic", @"private_key"] containsObject:source[@"sourceType"]] ||
      ![source[@"protectedMaterial"] isKindOfClass:NSString.class] || ![source[@"protectedMaterial"] length] || [source[@"protectedMaterial"] length] > 8192 ||
      !key_reference(source[@"keyRef"]) || ![source[@"keyRef"] isEqual:[@"source-key:" stringByAppendingString:source[@"id"]]] ||
      !general_auth_hexadecimal(source[@"inputDigest"], 64) || !boolean(source[@"backupVerified"]) ||
      ![@[@"staged", @"ready"] containsObject:source[@"status"]] || !integer(source[@"createdAt"])) return nil;
  BOOL mnemonic = [source[@"sourceType"] isEqual:@"mnemonic"];
  if (mnemonic ? ![source[@"derivationPath"] isEqual:@"m/44'/60'/0'/0/0"] : source[@"derivationPath"] != nil) return nil;
  return sha(encode(@[source[@"id"], source[@"setupId"], source[@"address"], source[@"sourceType"], source[@"protectedMaterial"],
    source[@"keyRef"], source[@"inputDigest"], source[@"derivationPath"] ?: NSNull.null, source[@"createdAt"]]));
}
static BOOL setup_shape(NSDictionary *setup) {
  if (!keys(setup, @[@"id", @"mode", @"createdAt", @"inputBinding", @"phase"],
      @[@"stagedCommitment", @"resumePhase", @"pendingKeyRef", @"backupPositions"]) || !general_auth_uuid(setup[@"id"]) ||
      ![@[@"create", @"import_mnemonic", @"import_private_key"] containsObject:setup[@"mode"]] || !integer(setup[@"createdAt"]) ||
      !general_auth_hexadecimal(setup[@"inputBinding"], 64) ||
      ![@[@"started", @"secret_staged", @"backup_pending", @"ready", @"canceled"] containsObject:setup[@"phase"]] ||
      (setup[@"pendingKeyRef"] && !key_reference(setup[@"pendingKeyRef"])) ||
      (setup[@"stagedCommitment"] && !general_auth_hexadecimal(setup[@"stagedCommitment"], 64)) ||
      (setup[@"resumePhase"] && ![@[@"secret_staged", @"backup_pending"] containsObject:setup[@"resumePhase"]])) return NO;
  BOOL staged = setup[@"stagedCommitment"] != nil, canceled = [setup[@"phase"] isEqual:@"canceled"];
  if ([setup[@"phase"] isEqual:@"started"] ? staged || setup[@"resumePhase"] : canceled ? staged != (setup[@"resumePhase"] != nil) : !staged || setup[@"resumePhase"]) return NO;
  NSArray *positions = setup[@"backupPositions"];
  if (positions) {
    if (![setup[@"mode"] isEqual:@"create"] || ![positions isKindOfClass:NSArray.class] || positions.count != 3 || [NSSet setWithArray:positions].count != 3) return NO;
    for (id position in positions) if (!integer(position) || [position unsignedIntValue] > 11) return NO;
  }
  return ![setup[@"mode"] isEqual:@"create"] || ![@[@"backup_pending", @"ready"] containsObject:setup[@"phase"]] || positions != nil;
}
NSDictionary *general_management_checkpoint(NSData *bytes, const general_native_identity *identity) {
  if (![bytes isKindOfClass:NSData.class] || !bytes.length || bytes.length > 512 * 1024 || !general_native_identity_valid(identity)) return nil;
  NSDictionary *record = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
  if (!keys(record, @[@"format", @"version", @"digest", @"state"], @[]) || ![record[@"format"] isEqual:@"koincode-general-checkpoint"] ||
      !integer(record[@"version"]) || ![record[@"version"] isEqual:@1] || ![encode(record) isEqual:bytes]) return nil;
  NSDictionary *state = record[@"state"];
  if (!keys(state, @[@"format", @"version", @"ownerId", @"installationId", @"revision", @"signingPolicyVersion", @"signingPolicyDigest", @"setups", @"sources"], @[]) ||
      ![state[@"format"] isEqual:@"koincode-general-wallet-state"] || !integer(state[@"version"]) || ![state[@"version"] isEqual:@1] ||
      ![state[@"ownerId"] isEqual:[NSString stringWithUTF8String:identity->owner_id]] ||
      ![state[@"installationId"] isEqual:[NSString stringWithUTF8String:identity->installation_id]] || !integer(state[@"revision"]) ||
      !integer(state[@"signingPolicyVersion"]) || !general_auth_hexadecimal(state[@"signingPolicyDigest"], 64) ||
      ![record[@"digest"] isEqual:sha(encode(state))]) return nil;
  NSArray *setups = state[@"setups"], *sources = state[@"sources"];
  if (![setups isKindOfClass:NSArray.class] || setups.count > 1000 || ![sources isKindOfClass:NSArray.class] || sources.count > 256) return nil;
  NSMutableSet *setupIds = [NSMutableSet set], *pendingRefs = [NSMutableSet set], *sourceIds = [NSMutableSet set], *addresses = [NSMutableSet set];
  unsigned active = 0, pending = 0;
  for (NSDictionary *setup in setups) {
    if (!setup_shape(setup) || [setupIds containsObject:setup[@"id"]] || (setup[@"pendingKeyRef"] && [pendingRefs containsObject:setup[@"pendingKeyRef"]])) return nil;
    [setupIds addObject:setup[@"id"]]; if (setup[@"pendingKeyRef"]) [pendingRefs addObject:setup[@"pendingKeyRef"]];
    if ([@[@"started", @"secret_staged", @"backup_pending"] containsObject:setup[@"phase"]]) active++;
    if (![setup[@"phase"] isEqual:@"ready"] && setup[@"stagedCommitment"]) pending++;
    NSUInteger count = 0; for (NSDictionary *source in sources) {
      if (![source isKindOfClass:NSDictionary.class]) return nil;
      if ([source[@"setupId"] isEqual:setup[@"id"]]) count++;
    }
    if (count != (setup[@"stagedCommitment"] ? 1U : 0U)) return nil;
  }
  if (active > 1 || pending > 5) return nil;
  for (NSDictionary *source in sources) {
    if (![source isKindOfClass:NSDictionary.class]) return nil;
    NSString *commitment = general_management_source_commitment(source); NSDictionary *setup = find(setups, @"id", source[@"setupId"]);
    if (!commitment || !setup || [sourceIds containsObject:source[@"id"]] || [addresses containsObject:source[@"address"]] ||
        ![setup[@"stagedCommitment"] isEqual:commitment] || ![setup[@"pendingKeyRef"] isEqual:source[@"keyRef"]] ||
        [setup[@"mode"] isEqual:@"import_private_key"] != [source[@"sourceType"] isEqual:@"private_key"] ||
        [setup[@"phase"] isEqual:@"ready"] != [source[@"status"] isEqual:@"ready"]) return nil;
    [sourceIds addObject:source[@"id"]]; [addresses addObject:source[@"address"]];
  }
  return state;
}
BOOL general_management_setup_scope(NSDictionary *auth, NSDictionary *state, NSDictionary *setup) {
  if (![auth isKindOfClass:NSDictionary.class] || !setup_shape(setup) || ![auth[@"accountAddress"] isEqual:NSNull.null]) return NO;
  NSString *action = [setup[@"mode"] isEqual:@"create"] ? @"create_wallet" : setup[@"mode"];
  return [auth[@"action"] isEqual:action] && [auth[@"operationDigest"] isEqual:sha(encode(@{
    @"format":@"koincode-general-setup-operation", @"version":@1, @"ownerId":state[@"ownerId"], @"installationId":state[@"installationId"],
    @"setupId":setup[@"id"], @"mode":setup[@"mode"], @"inputBinding":setup[@"inputBinding"]}))];
}
static BOOL export_scope(NSDictionary *auth, NSDictionary *source) {
  NSString *format = [auth[@"action"] isEqual:@"reveal_mnemonic"] ? @"mnemonic" : [auth[@"action"] isEqual:@"export_private_key"] ? @"private_key" : nil;
  NSString *commitment = general_management_source_commitment(source);
  if (!format || !commitment || ![auth[@"accountAddress"] isEqual:source[@"address"]] ||
      ([format isEqual:@"mnemonic"] && ![source[@"sourceType"] isEqual:@"mnemonic"])) return NO;
  return [auth[@"operationDigest"] isEqual:sha(encode(@{ @"format":@"koincode-general-secret-export", @"version":@1, @"address":source[@"address"],
    @"source":@{ @"sourceId":source[@"id"], @"setupId":source[@"setupId"], @"sourceCommitment":commitment, @"format":format } }))];
}
BOOL general_management_key_scope(NSDictionary *auth, NSDictionary *state, NSString *reference, BOOL writing) {
  if (!key_reference(reference)) return NO;
  NSDictionary *setup = find(state[@"setups"], @"pendingKeyRef", reference);
  if (!setup) return NO;
  NSDictionary *source = find(state[@"sources"], @"keyRef", reference);
  if (general_management_setup_scope(auth, state, setup))
    return writing ? [setup[@"phase"] isEqual:@"started"] && !source : ![setup[@"phase"] isEqual:@"canceled"];
  if (writing || !source || !export_scope(auth, source)) return NO;
  if ([source[@"status"] isEqual:@"ready"] && [setup[@"phase"] isEqual:@"ready"]) return YES;
  return [auth[@"action"] isEqual:@"reveal_mnemonic"] && [setup[@"mode"] isEqual:@"create"] &&
    [@[@"secret_staged", @"backup_pending"] containsObject:setup[@"phase"]] && [source[@"status"] isEqual:@"staged"];
}
static BOOL setup_advance(NSDictionary *before, NSDictionary *after) {
  for (NSString *field in @[@"id", @"mode", @"createdAt", @"inputBinding", @"stagedCommitment", @"pendingKeyRef", @"backupPositions"])
    if (before[field] && ![before[field] isEqual:after[field]]) return NO;
  NSString *phase = before[@"phase"];
  NSArray *allowed = [phase isEqual:@"started"] ? @[@"started", @"secret_staged", @"canceled"] :
    [phase isEqual:@"secret_staged"] ? ([before[@"mode"] isEqual:@"create"] ? @[@"secret_staged", @"backup_pending", @"canceled"] : @[@"secret_staged", @"ready", @"canceled"]) :
    [phase isEqual:@"backup_pending"] ? @[@"backup_pending", @"ready", @"canceled"] :
    [phase isEqual:@"canceled"] ? (before[@"resumePhase"] ? @[@"canceled", before[@"resumePhase"]] : @[@"canceled"]) : @[@"ready"];
  return [allowed containsObject:after[@"phase"]] && (!([phase isEqual:@"canceled"] && [after[@"phase"] isEqual:@"canceled"]) ||
    [before[@"resumePhase"] ?: NSNull.null isEqual:after[@"resumePhase"] ?: NSNull.null]);
}
BOOL general_management_state_advance(NSDictionary *auth, NSDictionary *before, NSDictionary *after) {
  if (!before || !after || [before[@"revision"] unsignedLongLongValue] >= GENERAL_SESSION_SAFE_INTEGER_MAX ||
      [after[@"revision"] unsignedLongLongValue] != [before[@"revision"] unsignedLongLongValue] + 1) return NO;
  for (NSString *field in before) if (![@[@"revision", @"setups", @"sources"] containsObject:field] && ![before[field] isEqual:after[field]]) return NO;
  NSDictionary *target = nil;
  for (NSDictionary *setup in after[@"setups"]) {
    if (general_management_setup_scope(auth, after, setup)) { if (target) return NO; target = setup; }
    else {
      NSDictionary *source = find(after[@"sources"], @"setupId", setup[@"id"]);
      if (source && [setup[@"mode"] isEqual:@"create"] && [auth[@"action"] isEqual:@"reveal_mnemonic"] && export_scope(auth, source)) {
        if (target) return NO; target = setup;
      }
    }
  }
  if (!target) return NO;
  for (NSDictionary *old in before[@"setups"]) {
    NSDictionary *next = find(after[@"setups"], @"id", old[@"id"]);
    if (!next || ([old[@"id"] isEqual:target[@"id"]] ? !setup_advance(old, next) : ![old isEqual:next])) return NO;
  }
  for (NSDictionary *next in after[@"setups"]) if (!find(before[@"setups"], @"id", next[@"id"]) &&
      (![next[@"id"] isEqual:target[@"id"]] || ![next[@"phase"] isEqual:@"started"] || next[@"pendingKeyRef"] || next[@"stagedCommitment"])) return NO;
  for (NSDictionary *old in before[@"sources"]) {
    NSDictionary *next = find(after[@"sources"], @"id", old[@"id"]);
    if (!next || ![general_management_source_commitment(old) isEqual:general_management_source_commitment(next)] ||
        ([old[@"backupVerified"] boolValue] && ![next[@"backupVerified"] boolValue]) ||
        ([old[@"status"] isEqual:@"ready"] && ![next[@"status"] isEqual:@"ready"]) ||
        (![old[@"setupId"] isEqual:target[@"id"]] && ![old isEqual:next])) return NO;
  }
  for (NSDictionary *next in after[@"sources"]) if (!find(before[@"sources"], @"id", next[@"id"]) &&
      (![next[@"setupId"] isEqual:target[@"id"]] || ![next[@"status"] isEqual:@"staged"] || [next[@"backupVerified"] boolValue] ||
      ![target[@"phase"] isEqual:@"secret_staged"])) return NO;
  return YES;
}
BOOL general_management_initial_checkpoint(NSData *bytes, const general_initialization_record *initialization) {
  if (!general_initialization_record_valid(initialization) || initialization->kind != GENERAL_INITIALIZATION_NEW) return NO;
  NSDictionary *state = general_management_checkpoint(bytes, &initialization->identity);
  return state && [state[@"revision"] isEqual:@0] && ![state[@"setups"] count] && ![state[@"sources"] count] &&
    [sha(encode(state)) isEqual:[NSString stringWithUTF8String:initialization->target_state_commitment]];
}
BOOL general_management_initial_registry(NSData *bytes, NSDictionary *initial_state, const general_initialization_record *initialization) {
  if (![bytes isKindOfClass:NSData.class] || !bytes.length || bytes.length > 512 * 1024 || !initial_state ||
      !general_initialization_record_valid(initialization) || initialization->kind != GENERAL_INITIALIZATION_NEW) return NO;
  NSDictionary *registry = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
  return keys(registry, @[@"format", @"version", @"ownerId", @"installationId", @"domainId", @"signingPolicyVersion", @"signingPolicyDigest", @"streams"], @[]) &&
    [encode(registry) isEqual:bytes] && [registry[@"format"] isEqual:@"koincode-general-signing-registry"] && integer(registry[@"version"]) &&
    [registry[@"version"] isEqual:@1] && [registry[@"ownerId"] isEqual:initial_state[@"ownerId"]] &&
    [registry[@"installationId"] isEqual:initial_state[@"installationId"]] &&
    [registry[@"domainId"] isEqual:[NSString stringWithUTF8String:initialization->initial_signing_domain_id]] &&
    [registry[@"signingPolicyVersion"] isEqual:initial_state[@"signingPolicyVersion"]] && integer(registry[@"signingPolicyVersion"]) &&
    [registry[@"signingPolicyDigest"] isEqual:initial_state[@"signingPolicyDigest"]] &&
    [registry[@"streams"] isKindOfClass:NSArray.class] && ![registry[@"streams"] count];
}
