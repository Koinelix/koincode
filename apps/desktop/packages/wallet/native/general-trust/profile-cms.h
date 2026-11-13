#ifndef KOINCODE_GENERAL_PROFILE_CMS_H
#define KOINCODE_GENERAL_PROFILE_CMS_H
#import <Foundation/Foundation.h>
#import <Security/Security.h>
/* Verifies one actual CMS signature and its provisioning signer chain against
 * production Apple anchors/markers. No trust-store changes or network fetches.
 * Returned trust/content are owned. Still not code/profile/source admission. */
SecTrustRef general_profile_cms_copy_trust(NSData *cms, NSData **content);
BOOL general_profile_cms_trust_current(SecTrustRef trust, NSDate *now);
#endif
