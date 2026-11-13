#import "profile-authorization.h"
#import "profile-cms.h"
#import "profile-payload.h"
#import "session-code.h"
#import "trust.h"
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#define PROFILE_PATH GENERAL_TRUST_HOST "/Contents/Helpers/GeneralProtectionBroker.app/Contents/embedded.provisionprofile"
static BOOL same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size && a->st_uid == b->st_uid &&
    a->st_gid == b->st_gid && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
    a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
static BOOL timely(const struct timespec *before) {
  struct timespec after;
  return !clock_gettime(CLOCK_MONOTONIC, &after) && after.tv_nsec >= 0 && after.tv_nsec < 1000000000 &&
    (after.tv_sec > before->tv_sec || (after.tv_sec == before->tv_sec && after.tv_nsec >= before->tv_nsec)) &&
    (after.tv_sec - before->tv_sec < 30 || (after.tv_sec - before->tv_sec == 30 && after.tv_nsec < before->tv_nsec));
}
@implementation GeneralProfileAuthorization {
  general_broker_namespace *_space; general_session_installation _receipt;
  int _fd; struct stat _identity;
  SecTrustRef _trust; NSDate *_expiration;
  BOOL _known, _closed, _uncertain, _checking;
}
- (instancetype)initWithNamespace:(general_broker_namespace *)space {
  if (!(self = [super init])) return nil;
  _fd = -1;
  general_console_identity console; struct timespec started;
  if (!NSThread.isMainThread || !space || clock_gettime(CLOCK_MONOTONIC, &started) ||
      !general_broker_namespace_info(space, &console, &_receipt) || !general_session_code_self(GENERAL_CODE_BROKER, &_receipt)) return nil;
  _space = space; _fd = general_protected_open(PROFILE_PATH, false);
  if (_fd < 0) return nil;
  if (fstat(_fd, &_identity)) { _uncertain = YES; return self; }
  _known = YES;
  if (!S_ISREG(_identity.st_mode) || _identity.st_uid || (_identity.st_mode & 07022) || _identity.st_nlink != 1 ||
      _identity.st_size < 1 || _identity.st_size > 1024 * 1024 || !general_fd_protected(_fd, false)) goto fail;
  {
    NSMutableData *cms = [NSMutableData dataWithLength:(NSUInteger)_identity.st_size]; size_t used = 0; unsigned interruptions = 0;
    while (used < cms.length) {
      if (!timely(&started) || !general_broker_namespace_current(space)) goto fail;
      ssize_t count = pread(_fd, (unsigned char *)cms.mutableBytes + used, cms.length - used, (off_t)used);
      if (count < 0 && errno == EINTR && ++interruptions <= 64) continue;
      if (count <= 0 || (size_t)count > cms.length - used) goto fail;
      used += (size_t)count;
    }
    NSData *content = nil;
    _trust = general_profile_cms_copy_trust(cms, &content);
    SecCodeRef code = NULL; CFDictionaryRef info = NULL;
    BOOL actual = _trust && content && SecCodeCopySelf(kSecCSDefaultFlags, &code) == errSecSuccess && code &&
      general_session_code_matches(code, GENERAL_CODE_BROKER, &_receipt) &&
      SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess && info && CFGetTypeID(info) == CFDictionaryGetTypeID();
    if (actual) {
      CFTypeRef certificates = CFDictionaryGetValue(info, kSecCodeInfoCertificates);
      actual = certificates && CFGetTypeID(certificates) == CFArrayGetTypeID() && CFArrayGetCount(certificates) > 0 && CFArrayGetCount(certificates) <= 8;
      if (actual) {
        CFTypeRef leaf = CFArrayGetValueAtIndex(certificates, 0);
        actual = leaf && CFGetTypeID(leaf) == SecCertificateGetTypeID();
        if (actual) _expiration = general_profile_payload_expiration(content, CFBridgingRelease(SecCertificateCopyData((SecCertificateRef)leaf)), &_receipt, NSDate.date);
      }
    }
    if (info) CFRelease(info); if (code) CFRelease(code);
    if (!actual || !_expiration || !timely(&started) || ![self current]) goto fail;
  }
  return self;
fail:
  if (![self close]) return self;
  return nil;
}
- (BOOL)current {
  if (!NSThread.isMainThread || _closed || _uncertain || _checking || !_known || !_trust || !_expiration) return NO;
  _checking = YES; struct stat held, named; struct timespec started; NSDate *now = NSDate.date;
  BOOL valid = !clock_gettime(CLOCK_MONOTONIC, &started) && general_broker_namespace_current(_space) &&
    general_session_code_self(GENERAL_CODE_BROKER, &_receipt) && [_expiration compare:now] == NSOrderedDescending &&
    !fstat(_fd, &held) && same(&held, &_identity) && general_fd_protected(_fd, false) &&
    !lstat(PROFILE_PATH, &named) && same(&named, &_identity) &&
    general_profile_cms_trust_current(_trust, now) && timely(&started) && general_broker_namespace_current(_space);
  _checking = NO; return valid;
}
- (BOOL)close {
  if (!NSThread.isMainThread || _checking || _uncertain) return NO;
  if (_closed) return YES;
  _closed = YES;
  if (_fd >= 0) {
    struct stat actual;
    if (!_known || fstat(_fd, &actual) || actual.st_dev != _identity.st_dev || actual.st_ino != _identity.st_ino) { _uncertain = YES; return NO; }
    int fd = _fd; _fd = -1; if (close(fd)) { _uncertain = YES; return NO; }
  }
  if (_trust) CFRelease(_trust); _trust = NULL; _expiration = nil; _space = NULL; return YES;
}
@end
