#ifndef KOINCODE_GENERAL_BINARY_PLIST_H
#define KOINCODE_GENERAL_BINARY_PLIST_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static inline uint64_t general_plist_unsigned(const unsigned char *bytes, size_t count) {
  uint64_t value = 0;
  for (size_t index = 0; index < count; index++) value = (value << 8) | bytes[index];
  return value;
}

/* CF can collapse duplicate keys. Validate the original top-level entry count before CF parsing. */
static inline bool general_plist_dictionary_count(const unsigned char *bytes, size_t size, size_t expected) {
  if (!bytes || size < 40 || memcmp(bytes, "bplist00", 8) != 0) return false;
  const unsigned char *trailer = bytes + size - 32;
  for (size_t index = 0; index < 6; index++) if (trailer[index] != 0) return false;
  size_t width = trailer[6], reference = trailer[7];
  uint64_t objects = general_plist_unsigned(trailer + 8, 8), top = general_plist_unsigned(trailer + 16, 8);
  uint64_t table = general_plist_unsigned(trailer + 24, 8);
  if (width < 1 || width > 8 || reference < 1 || reference > 8 || objects < 1 || top >= objects ||
      table < 8 || table >= size - 32 || objects > (size - 32 - table) / width) return false;
  uint64_t position = general_plist_unsigned(bytes + table + top * width, width);
  if (position < 8 || position >= table || (bytes[position] >> 4) != 0xd) return false;
  unsigned char low = bytes[position++] & 0xf;
  uint64_t count = low;
  if (low == 0xf) {
    if (position >= table || (bytes[position] >> 4) != 1 || (bytes[position] & 0xf) > 3) return false;
    size_t length = (size_t)1 << (bytes[position++] & 0xf);
    if (length > table - position) return false;
    count = general_plist_unsigned(bytes + position, length); position += length;
  }
  return count == expected && expected <= (table - position) / (2 * reference);
}
#endif
