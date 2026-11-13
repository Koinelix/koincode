#include "trust.h"
#include <string.h>
#include <unistd.h>

general_identity_status general_check_identity(int fd) {
  general_identity_status status = GENERAL_IDENTITY_INSTALLATION_UNVERIFIED;
  general_trust_receipt receipt;
  audit_token_t token; SecCodeRef peer = NULL, self = NULL;
  if (!general_read_receipt(&receipt)) goto reply;
  status = GENERAL_IDENTITY_CODE_UNVERIFIED;
  int self_fd = general_protected_open(GENERAL_TRUST_BROKER, false);
  if (self_fd < 0) goto reply;
  close(self_fd);
  if (!general_socket_peer(fd, &token, &peer) || SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess) goto reply;
  if (!general_matches_code((SecStaticCodeRef)self, GENERAL_TRUST_BROKER, GENERAL_TRUST_BROKER_ID, receipt.broker_hash, true) ||
      !general_matches_code((SecStaticCodeRef)peer, GENERAL_TRUST_HOST, GENERAL_TRUST_HOST_ID, receipt.host_hash, true) ||
      !general_bundle_is_valid() || !general_host_fuses_valid() || !general_peer_launch_valid(fd, &token)) goto reply;
  general_trust_receipt current;
  if (!general_read_receipt(&current) || receipt.revision != current.revision ||
      strcmp(receipt.installation_id, current.installation_id) != 0 ||
      memcmp(receipt.host_hash, current.host_hash, sizeof(receipt.host_hash)) != 0 ||
      memcmp(receipt.broker_hash, current.broker_hash, sizeof(receipt.broker_hash)) != 0) goto reply;
  status = GENERAL_IDENTITY_VERIFIED;
reply:
  if (peer) CFRelease(peer);
  if (self) CFRelease(self);
  return status;
}
