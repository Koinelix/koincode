#import "authentication.h"
#import "auth-scope.h"
#import "trust.h"
#include "broker-control.h"
#include <errno.h>
#include <poll.h>
#include <stdatomic.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static double monotonic_seconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0;
}
static BOOL send_json(int fd, NSDictionary *message) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:message options:NSJSONWritingSortedKeys error:NULL];
  if (!bytes || bytes.length > 8192) return NO;
  NSMutableData *frame = [bytes mutableCopy]; [frame appendBytes:"\n" length:1];
  size_t used = 0;
  while (used < frame.length) {
    ssize_t count = send(fd, (const unsigned char *)frame.bytes + used, frame.length - used, MSG_NOSIGNAL);
    if (count <= 0) return NO;
    used += (size_t)count;
  }
  return YES;
}
static NSData *read_request(int fd) {
  NSMutableData *frame = [NSMutableData data];
  double now = monotonic_seconds(); if (now < 0) return nil;
  const double deadline = now + 3;
  while (frame.length <= 32768) {
    now = monotonic_seconds(); if (now < 0 || now >= deadline) return nil;
    struct pollfd status = { .fd = fd, .events = POLLIN | POLLHUP };
    int result = poll(&status, 1, (int)((deadline - now) * 1000));
    if (result <= 0 || !(status.revents & POLLIN)) return nil;
    unsigned char bytes[32769];
    ssize_t count = recv(fd, bytes, sizeof(bytes), MSG_DONTWAIT);
    if (count <= 0 || frame.length + (NSUInteger)count > 32769) return nil;
    [frame appendBytes:bytes length:(NSUInteger)count];
    const unsigned char *data = frame.bytes;
    const unsigned char *end = memchr(data, '\n', frame.length);
    if (end) {
      if (end != data + frame.length - 1 || frame.length <= 1) return nil;
      return [frame subdataWithRange:NSMakeRange(0, frame.length - 1)];
    }
  }
  return nil;
}
static BOOL peer_idle(int fd) {
  unsigned char byte;
  ssize_t result = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
  return result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK);
}
static BOOL same_installation(const general_trust_receipt *expected) {
  general_trust_receipt current;
  return general_read_receipt(&current) && expected->revision == current.revision &&
    strcmp(expected->installation_id, current.installation_id) == 0 &&
    memcmp(expected->host_hash, current.host_hash, sizeof(current.host_hash)) == 0 &&
    memcmp(expected->broker_hash, current.broker_hash, sizeof(current.broker_hash)) == 0;
}
static int authenticate(int fd) {
  if (general_check_identity(fd) != GENERAL_IDENTITY_VERIFIED) return general_preflight_reply(fd);
  general_trust_receipt receipt;
  if (!general_read_receipt(&receipt)) return 74;
  NSDictionary *scope = general_parse_auth_scope(read_request(fd));
  if (!scope) return send_json(fd, @{@"version":@1, @"code":@"INVALID_REQUEST", @"authenticated":@NO}) ? 0 : 74;
  NSString *reason = general_auth_reason(scope);
  if (!reason) return send_json(fd, @{@"version":@1, @"code":@"GENERAL_AUTH_UNAVAILABLE", @"authenticated":@NO}) ? 0 : 74;
  atomic_int result; atomic_init(&result, -1); atomic_int *result_pointer = &result;
  GeneralScopedAuthentication *request = [[GeneralScopedAuthentication alloc] initWithContext:[LAContext new] reason:reason timeout:60
    current:^BOOL { return peer_idle(fd) && same_installation(&receipt) && general_check_identity(fd) == GENERAL_IDENTITY_VERIFIED; }
    completion:^(GeneralAuthResult outcome) { atomic_store(result_pointer, (int)outcome); }];
  if (!request || ![request start]) return 74;
  while (atomic_load(&result) < 0) {
    if (!peer_idle(fd)) [request cancel];
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  GeneralAuthResult outcome = (GeneralAuthResult)atomic_load(&result);
  if (outcome == GeneralAuthApproved && (!peer_idle(fd) || !same_installation(&receipt) || general_check_identity(fd) != GENERAL_IDENTITY_VERIFIED)) outcome = GeneralAuthCanceled;
  NSArray *codes = @[@"GENERAL_AUTHENTICATED", @"GENERAL_AUTH_REJECTED", @"GENERAL_OPERATION_CANCELED", @"GENERAL_AUTH_UNAVAILABLE", @"GENERAL_AUTH_TIMEOUT"];
  NSDictionary *response = @{@"format":@"koincode-general-auth-result", @"version":@1, @"requestId":scope[@"requestId"],
    @"action":scope[@"action"], @"operationDigest":scope[@"operationDigest"], @"accountAddress":scope[@"accountAddress"],
    @"authenticated":@(outcome == GeneralAuthApproved), @"code":codes[outcome]};
  return send_json(fd, response) ? 0 : 74;
}
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--control") == 0) return general_broker_control_run();
    alarm(argc == 1 ? 30 : 90);
    if (argc == 1) return general_preflight_reply(3);
    if (argc == 2 && strcmp(argv[1], "--authenticate") == 0) return authenticate(3);
    return 64;
  }
}
