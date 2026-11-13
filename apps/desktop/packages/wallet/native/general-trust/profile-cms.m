#import "profile-cms.h"
#import <Security/CMSDecoder.h>
#import <CommonCrypto/CommonDigest.h>
/* Published DER SHA-256 values from Apple's Certificate Authority page. These
 * filter actual OS anchors; no certificate is downloaded or installed here. */
static BOOL production_root(SecCertificateRef certificate) {
  static const char *const hashes[] = {
    "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024",
    "c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050",
    "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179"
  };
  NSData *data = CFBridgingRelease(SecCertificateCopyData(certificate)); unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (!data.length || data.length > 16384 || !CC_SHA256(data.bytes, (CC_LONG)data.length, digest)) return NO;
  char text[65]; static const char digits[] = "0123456789abcdef";
  for (unsigned i = 0; i < sizeof(digest); i++) { text[i * 2] = digits[digest[i] >> 4]; text[i * 2 + 1] = digits[digest[i] & 15]; } text[64] = 0;
  for (unsigned i = 0; i < sizeof(hashes) / sizeof(hashes[0]); i++) if (!strcmp(text, hashes[i])) return YES;
  return NO;
}
static BOOL marker(SecCertificateRef certificate, NSString *oid) {
  CFErrorRef error = NULL;
  NSDictionary *values = CFBridgingRelease(SecCertificateCopyValues(certificate, (__bridge CFArrayRef)@[oid], &error));
  BOOL valid = !error && [values[oid] isKindOfClass:NSDictionary.class];
  if (error) CFRelease(error); return valid;
}
BOOL general_profile_cms_trust_current(SecTrustRef trust, NSDate *now) {
  if (!trust || ![now isKindOfClass:NSDate.class] || SecTrustSetVerifyDate(trust, (__bridge CFDateRef)now) != errSecSuccess ||
      !SecTrustEvaluateWithError(trust, NULL)) return NO;
  NSArray *chain = CFBridgingRelease(SecTrustCopyCertificateChain(trust));
  if (chain.count < 3 || chain.count > 8 || !production_root((__bridge SecCertificateRef)chain.lastObject) ||
      !marker((__bridge SecCertificateRef)chain[0], @"1.2.840.113635.100.4.11")) return NO;
  // Apple's macOS provisioning policy requires the WWDR intermediate marker.
  return marker((__bridge SecCertificateRef)chain[1], @"1.2.840.113635.100.6.2.1");
}
SecTrustRef general_profile_cms_copy_trust(NSData *cms, NSData **content) {
  if (![cms isKindOfClass:NSData.class] || !cms.length || cms.length > 1024 * 1024 || !content || *content) return NULL;
  CMSDecoderRef decoder = NULL; SecTrustRef trust = NULL; CFDataRef body = NULL; CFArrayRef anchors = NULL;
  SecPolicyRef policy = SecPolicyCreateBasicX509(), revocation = SecPolicyCreateRevocation(kSecRevocationOCSPMethod | kSecRevocationNetworkAccessDisabled);
  BOOL valid = NO; size_t count = 0; CMSSignerStatus signer = kCMSSignerUnsigned;
  if (!policy || !revocation || CMSDecoderCreate(&decoder) != errSecSuccess || !decoder ||
      CMSDecoderUpdateMessage(decoder, cms.bytes, cms.length) != errSecSuccess || CMSDecoderFinalizeMessage(decoder) != errSecSuccess ||
      CMSDecoderGetNumSigners(decoder, &count) != errSecSuccess || count != 1 ||
      CMSDecoderCopySignerStatus(decoder, 0, policy, false, &signer, &trust, NULL) != errSecSuccess ||
      signer != kCMSSignerValid || !trust ||
      CMSDecoderCopyContent(decoder, &body) != errSecSuccess || !body || CFDataGetLength(body) < 1 || CFDataGetLength(body) > 256 * 1024 ||
      SecTrustCopyAnchorCertificates(&anchors) != errSecSuccess || !anchors || CFArrayGetCount(anchors) > 4096) goto done;
  {
    NSMutableArray *roots = [NSMutableArray array];
    for (id candidate in (__bridge NSArray *)anchors) if (CFGetTypeID((__bridge CFTypeRef)candidate) == SecCertificateGetTypeID() && production_root((__bridge SecCertificateRef)candidate)) [roots addObject:candidate];
    NSArray *policies = @[(__bridge id)policy, (__bridge id)revocation];
    if (!roots.count || SecTrustSetAnchorCertificates(trust, (__bridge CFArrayRef)roots) != errSecSuccess ||
        SecTrustSetAnchorCertificatesOnly(trust, true) != errSecSuccess || SecTrustSetNetworkFetchAllowed(trust, false) != errSecSuccess ||
        SecTrustSetPolicies(trust, (__bridge CFArrayRef)policies) != errSecSuccess || !general_profile_cms_trust_current(trust, NSDate.date)) goto done;
    *content = [(__bridge NSData *)body copy]; valid = YES;
  }
done:
  if (anchors) CFRelease(anchors); if (body) CFRelease(body); if (decoder) CFRelease(decoder);
  if (policy) CFRelease(policy); if (revocation) CFRelease(revocation);
  if (!valid && trust) { CFRelease(trust); trust = NULL; }
  return trust;
}
