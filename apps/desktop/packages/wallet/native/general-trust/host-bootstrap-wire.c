#include "host-bootstrap-wire.h"
#include <string.h>

static const unsigned char marker[] = "KCWHBT01", greeting[] = "KCWHRD01";
static bool nonce_valid(const unsigned char *nonce) {
  unsigned char any = 0; for (unsigned i = 0; i < GENERAL_HOST_NONCE_SIZE; i++) any |= nonce[i]; return any != 0;
}
static bool path_valid(const char *path, size_t size) {
  if (size < 2 || size >= sizeof(((struct sockaddr_un *)0)->sun_path) || path[0] != '/' || path[size - 1] == '/') return false;
  size_t start = 1;
  for (size_t i = 1; i <= size; i++) {
    if (i < size && (path[i] < 0x21 || path[i] > 0x7e || path[i] == '\\')) return false;
    if (i == size || path[i] == '/') {
      size_t count = i - start;
      if (!count || (count == 1 && path[start] == '.') || (count == 2 && path[start] == '.' && path[start + 1] == '.')) return false;
      start = i + 1;
    }
  }
  return true;
}
bool general_host_bootstrap_encode(const general_host_bootstrap_message *message, unsigned char *out, size_t capacity, size_t *size) {
  if (!message || !out || !size || (message->mode != GENERAL_HOST_INSPECT && message->mode != GENERAL_HOST_MANAGER)) return false;
  size_t length = strnlen(message->path, sizeof(message->path));
  if (!path_valid(message->path, length) || !nonce_valid(message->nonce) || capacity < 43 + length) return false;
  unsigned char bytes[GENERAL_HOST_BOOTSTRAP_MAX]; memcpy(bytes, marker, 8); bytes[8] = (unsigned char)message->mode;
  bytes[9] = (unsigned char)(length >> 8); bytes[10] = (unsigned char)length; memcpy(bytes + 11, message->nonce, GENERAL_HOST_NONCE_SIZE);
  memcpy(bytes + 43, message->path, length); memcpy(out, bytes, 43 + length); *size = 43 + length; return true;
}
bool general_host_bootstrap_parse(const unsigned char *bytes, size_t size, general_host_bootstrap_message *out) {
  if (!bytes || !out || size < 45 || size >= GENERAL_HOST_BOOTSTRAP_MAX || memcmp(bytes, marker, 8) ||
      (bytes[8] != GENERAL_HOST_INSPECT && bytes[8] != GENERAL_HOST_MANAGER)) return false;
  size_t length = (size_t)bytes[9] * 256 + bytes[10];
  if (length != size - 43 || !path_valid((const char *)bytes + 43, length) || !nonce_valid(bytes + 11)) return false;
  general_host_bootstrap_message parsed = { .mode = bytes[8] }; memcpy(parsed.nonce, bytes + 11, GENERAL_HOST_NONCE_SIZE);
  memcpy(parsed.path, bytes + 43, length); *out = parsed; return true;
}
bool general_host_greeting_encode(const unsigned char nonce[GENERAL_HOST_NONCE_SIZE], unsigned char out[GENERAL_HOST_GREETING_SIZE]) {
  if (!nonce || !out || !nonce_valid(nonce)) return false;
  memcpy(out, greeting, 8); memcpy(out + 8, nonce, GENERAL_HOST_NONCE_SIZE); return true;
}
bool general_host_greeting_matches(const unsigned char *bytes, size_t size, const unsigned char nonce[GENERAL_HOST_NONCE_SIZE]) {
  if (!bytes || !nonce || size != GENERAL_HOST_GREETING_SIZE || !nonce_valid(nonce)) return false;
  unsigned char diff = 0;
  for (unsigned i = 0; i < 8; i++) diff |= bytes[i] ^ greeting[i];
  for (unsigned i = 0; i < GENERAL_HOST_NONCE_SIZE; i++) diff |= bytes[i + 8] ^ nonce[i]; return diff == 0;
}
