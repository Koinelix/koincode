#ifndef KOINCODE_GENERAL_HOST_BOOTSTRAP_WIRE_H
#define KOINCODE_GENERAL_HOST_BOOTSTRAP_WIRE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/un.h>

#define GENERAL_HOST_BOOTSTRAP_MAX (43U + sizeof(((struct sockaddr_un *)0)->sun_path))
#define GENERAL_HOST_NONCE_SIZE 32U
#define GENERAL_HOST_GREETING_SIZE 40U
typedef enum { GENERAL_HOST_INSPECT = 1, GENERAL_HOST_MANAGER = 2 } general_host_mode;
typedef struct {
  general_host_mode mode;
  char path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  unsigned char nonce[GENERAL_HOST_NONCE_SIZE];
} general_host_bootstrap_message;
/* Private, nonpersistent rendezvous data only. Neither a path nor the random
 * challenge authenticates the actual peer. Outputs are unchanged on failure. */
bool general_host_bootstrap_encode(const general_host_bootstrap_message *message, unsigned char *out, size_t capacity, size_t *size);
bool general_host_bootstrap_parse(const unsigned char *bytes, size_t size, general_host_bootstrap_message *out);
bool general_host_greeting_encode(const unsigned char nonce[GENERAL_HOST_NONCE_SIZE], unsigned char out[GENERAL_HOST_GREETING_SIZE]);
bool general_host_greeting_matches(const unsigned char *bytes, size_t size, const unsigned char nonce[GENERAL_HOST_NONCE_SIZE]);
#endif
