#ifndef KOINCODE_GENERAL_PAYMENT_PURPOSE_H
#define KOINCODE_GENERAL_PAYMENT_PURPOSE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define GENERAL_EXACT_PAYMENT_MAX 4096U
typedef struct {
  char wallet_id[37], subject_id[37], intent_id[37], request_id[37];
  char request_digest[65], quote_digest[65];
  char installation_id[37], enrollment_id[37], profile_id[37], source_id[37], source_commitment[65];
  char network[13], asset[43], facilitator[43], permit_nonce[79];
  bool upto, permit;
  char payer[43], pay_to[43], amount[79], nonce[67];
  uint64_t valid_after, valid_before;
  char digest[65];
} general_exact_payment;
/* Fixed-purpose metadata only. The original native peer, actual stored ready
 * source/prefix and same sealed original-ledger owner are separate gates.
 * No keys, arbitrary typed data, signature or authority is accepted here. */
bool general_exact_payment_parse(const unsigned char *bytes, size_t size, general_exact_payment *out);
#endif
