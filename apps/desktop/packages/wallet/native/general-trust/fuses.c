#include "trust.h"
#include <libkern/OSByteOrder.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* Electron 41.0.3 build/fuses/fuses.json5, including its ninth Wasm fuse. */
static const unsigned char sentinel[] = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
static const unsigned char expected[] = "000011001";
#define MAX_FRAMEWORK_BYTES (512U * 1024U * 1024U)

static bool wire_valid(const unsigned char *bytes, size_t size) {
  if (!bytes || size == 0 || size > MAX_FRAMEWORK_BYTES) return false;
  size_t offset = 0, count = 0, marker_size = sizeof(sentinel) - 1;
  while (offset < size) {
    const unsigned char *marker = memmem(bytes + offset, size - offset, sentinel, marker_size);
    if (!marker) break;
    size_t start = (size_t)(marker - bytes) + marker_size;
    if (++count > 1 || size - start < 2 + sizeof(expected) - 1 ||
        bytes[start] != 1 || bytes[start + 1] != sizeof(expected) - 1 ||
        memcmp(bytes + start + 2, expected, sizeof(expected) - 1) != 0) return false;
    offset = start + 2 + sizeof(expected) - 1;
  }
  return count > 0;
}

static bool slice_valid(const unsigned char *bytes, size_t size, cpu_type_t architecture) {
  if (size < sizeof(struct mach_header_64)) return false;
  struct mach_header_64 header; memcpy(&header, bytes, sizeof(header));
  return header.magic == MH_MAGIC_64 && header.filetype == MH_DYLIB && header.cputype == architecture &&
    (architecture == CPU_TYPE_ARM64 || architecture == CPU_TYPE_X86_64) && wire_valid(bytes, size);
}

bool general_fuses_bytes_valid(const unsigned char *bytes, size_t size) {
  if (!bytes || size < sizeof(struct mach_header_64) || size > MAX_FRAMEWORK_BYTES) return false;
  uint32_t magic; memcpy(&magic, bytes, sizeof(magic));
  if (magic == MH_MAGIC_64) {
    struct mach_header_64 header; memcpy(&header, bytes, sizeof(header));
    return slice_valid(bytes, size, header.cputype);
  }
  struct fat_header header; memcpy(&header, bytes, sizeof(header));
  uint32_t count = OSSwapBigToHostInt32(header.nfat_arch);
  if (OSSwapBigToHostInt32(header.magic) != FAT_MAGIC || count == 0 || count > 2 ||
      size < sizeof(header) + count * sizeof(struct fat_arch)) return false;
  size_t ends[2] = {0}, starts[2] = {0}; cpu_type_t types[2] = {0};
  for (uint32_t i = 0; i < count; i++) {
    struct fat_arch arch; memcpy(&arch, bytes + sizeof(header) + i * sizeof(arch), sizeof(arch));
    size_t start = OSSwapBigToHostInt32(arch.offset), length = OSSwapBigToHostInt32(arch.size);
    cpu_type_t type = (cpu_type_t)OSSwapBigToHostInt32(arch.cputype);
    if (start < sizeof(header) + count * sizeof(arch) || start > size || length > size - start ||
        !slice_valid(bytes + start, length, type)) return false;
    starts[i] = start; ends[i] = start + length; types[i] = type;
    if (i > 0 && (types[0] == type || (starts[0] < ends[i] && start < ends[0]))) return false;
  }
  return true;
}

bool general_host_fuses_valid(void) {
  int fd = general_protected_open(GENERAL_TRUST_FRAMEWORK, false);
  if (fd < 0) return false;
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 || info.st_size > MAX_FRAMEWORK_BYTES) {
    close(fd); return false;
  }
  size_t size = (size_t)info.st_size;
  void *bytes = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (bytes == MAP_FAILED) { close(fd); return false; }
  bool valid = general_fuses_bytes_valid(bytes, size) && general_fd_protected(fd, false);
  munmap(bytes, size); close(fd); return valid;
}
