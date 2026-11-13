#include "trust.h"
#include <sys/stat.h>
#include <string.h>
#include <unistd.h>

static bool integer(CFTypeRef value, int64_t *number) {
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType((CFNumberRef)value) &&
    CFNumberGetValue((CFNumberRef)value, kCFNumberSInt64Type, number);
}
static bool hash_value(CFTypeRef value, unsigned char target[20]) {
  if (!value || CFGetTypeID(value) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)value) != 20) return false;
  memcpy(target, CFDataGetBytePtr((CFDataRef)value), 20);
  unsigned char bits = 0;
  for (size_t i = 0; i < 20; i++) bits |= target[i];
  return bits != 0;
}

bool general_parse_receipt(const unsigned char *bytes, size_t size, general_trust_receipt *receipt) {
  if (!bytes || !receipt || size < 8 || size > GENERAL_TRUST_MAX_RECEIPT || memcmp(bytes, "bplist00", 8) != 0) return false;
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)size);
  if (!data) return false;
  CFPropertyListFormat format;
  CFPropertyListRef value = CFPropertyListCreateWithData(NULL, data, kCFPropertyListImmutable, &format, NULL);
  CFRelease(data);
  if (!value) return false;
  bool ok = false;
  general_trust_receipt parsed = {0};
  if (format != kCFPropertyListBinaryFormat_v1_0 || CFGetTypeID(value) != CFDictionaryGetTypeID()) goto done;
  CFDictionaryRef row = (CFDictionaryRef)value;
  if (CFDictionaryGetCount(row) != 6) goto done;
  CFTypeRef marker = CFDictionaryGetValue(row, CFSTR("format"));
  CFTypeRef identity = CFDictionaryGetValue(row, CFSTR("installationId"));
  int64_t version = 0;
  if (!marker || CFGetTypeID(marker) != CFStringGetTypeID() || !CFEqual(marker, CFSTR("koincode-general-wallet-installation")) ||
      !integer(CFDictionaryGetValue(row, CFSTR("version")), &version) || version != 1 ||
      !integer(CFDictionaryGetValue(row, CFSTR("revision")), &parsed.revision) || parsed.revision < 1 || parsed.revision > 9007199254740991LL ||
      !identity || CFGetTypeID(identity) != CFStringGetTypeID() || CFStringGetLength((CFStringRef)identity) != 36 ||
      !CFStringGetCString((CFStringRef)identity, parsed.installation_id, sizeof(parsed.installation_id), kCFStringEncodingASCII) ||
      !hash_value(CFDictionaryGetValue(row, CFSTR("hostCdHash")), parsed.host_hash) ||
      !hash_value(CFDictionaryGetValue(row, CFSTR("brokerCdHash")), parsed.broker_hash)) goto done;
  for (size_t i = 0; i < 36; i++) {
    char c = parsed.installation_id[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') goto done; }
    else if (!((c >= 'a' && c <= 'f') || (c >= '0' && c <= '9'))) goto done;
  }
  *receipt = parsed; ok = true;
done:
  CFRelease(value);
  return ok;
}

bool general_read_receipt(general_trust_receipt *receipt) {
  int fd = general_protected_open(GENERAL_TRUST_RECEIPT, false);
  if (fd < 0) return false;
  struct stat info;
  unsigned char bytes[GENERAL_TRUST_MAX_RECEIPT + 1];
  bool ok = false;
  if (fstat(fd, &info) != 0 || info.st_nlink != 1 || info.st_size < 8 || info.st_size > GENERAL_TRUST_MAX_RECEIPT) goto done;
  size_t used = 0;
  while (used < sizeof(bytes)) {
    ssize_t count = read(fd, bytes + used, sizeof(bytes) - used);
    if (count < 0) goto done;
    if (count == 0) break;
    used += (size_t)count;
  }
  if (used == (size_t)info.st_size) ok = general_parse_receipt(bytes, used, receipt);
done:
  close(fd);
  return ok;
}
