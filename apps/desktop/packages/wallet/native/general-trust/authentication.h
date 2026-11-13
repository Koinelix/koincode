#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

typedef NS_ENUM(NSUInteger, GeneralAuthResult) {
  GeneralAuthApproved, GeneralAuthRejected, GeneralAuthCanceled, GeneralAuthUnavailable, GeneralAuthTimedOut,
};

/* Internal native policy engine. The broker always supplies a fresh real LAContext. */
@interface GeneralScopedAuthentication : NSObject
- (instancetype)initWithContext:(LAContext *)context reason:(NSString *)reason timeout:(NSTimeInterval)timeout
  current:(BOOL (^)(void))current completion:(void (^)(GeneralAuthResult result))completion;
- (BOOL)start;
- (void)cancel;
- (BOOL)settled;
@end
