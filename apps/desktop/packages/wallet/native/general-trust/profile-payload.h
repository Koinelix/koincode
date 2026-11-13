#ifndef KOINCODE_GENERAL_PROFILE_PAYLOAD_H
#define KOINCODE_GENERAL_PROFILE_PAYLOAD_H
#import <Foundation/Foundation.h>
#include "session-installation.h"
/* Pure profile association, not CMS verification or OS authorization. The
 * native factory supplies the actual running broker certificate and receipt. */
NSDate *general_profile_payload_expiration(NSData *content, NSData *broker_certificate,
  const general_session_installation *installation, NSDate *now);
#endif
