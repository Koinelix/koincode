#import <Foundation/Foundation.h>
NSDictionary *general_parse_auth_scope(NSData *data);
NSString *general_auth_reason(NSDictionary *scope);
BOOL general_auth_hexadecimal(NSString *value, NSUInteger length);
BOOL general_auth_uuid(NSString *value);
BOOL general_manual_auth_scope(NSDictionary *scope);
NSString *general_manual_auth_reason(NSDictionary *scope, NSDictionary *messages);
