#include "payment-purpose.h"
#include "session-canonical.h"
#include <CommonCrypto/CommonDigest.h>
#include <string.h>
static bool text(general_canonical_reader *reader, char *out, size_t capacity) { return general_canonical_string(reader, out, capacity); }
static bool uuid(general_canonical_reader *reader, char out[37]) { return text(reader, out, 37) && general_session_uuid_valid(out); }
static bool hash(general_canonical_reader *reader, char out[65]) { return text(reader, out, 65) && general_canonical_hash_valid(out); }
static bool hex(general_canonical_reader *reader, char *out, size_t size) {
  if (!text(reader, out, size + 1) || strlen(out) != size || strncmp(out, "0x", 2)) return false;
  for (size_t i = 2; i < size; i++) if (!((out[i] >= '0' && out[i] <= '9') || (out[i] >= 'a' && out[i] <= 'f'))) return false;
  return true;
}
static bool amount(general_canonical_reader *reader, char out[79]) {
  if (!text(reader, out, 79)) return false;
  size_t size = strlen(out); if (!size || size > 78 || out[0] < '1' || out[0] > '9') return false;
  for (size_t i = 1; i < size; i++) if (out[i] < '0' || out[i] > '9') return false;
  return size < 78 || strcmp(out, "115792089237316195423570985008687907853269984665640564039457584007913129639935") <= 0;
}
static bool timestamp(general_canonical_reader *reader, uint64_t *out) {
  return general_canonical_integer(reader, out) && *out <= GENERAL_SESSION_SAFE_INTEGER_MAX;
}
static bool parse_upto(general_canonical_reader *r, general_exact_payment *out) {
  if (!general_canonical_take(r, ",\"upto\":{")) return true;
  out->upto = true;
  if (!general_canonical_take(r, "\"facilitator\":") || !hex(r, out->facilitator, 42) ||
      !strcmp(out->facilitator, "0x0000000000000000000000000000000000000000") ||
      !general_canonical_take(r, ",\"permitNonce\":")) return false;
  if (!general_canonical_take(r, "null")) {
    if (general_canonical_take(r, "\"0\"")) strcpy(out->permit_nonce, "0");
    else if (!amount(r, out->permit_nonce)) return false;
  }
  return general_canonical_take(r, "}");
}
static bool parse_local_protection(general_canonical_reader *r) {
  if (!general_canonical_take(r, ",\"protection\":")) return true;
  return general_canonical_take(r, "\"local_system\"");
}
bool general_exact_payment_parse(const unsigned char *bytes, size_t size, general_exact_payment *out) {
  if (!bytes || !size || size > GENERAL_EXACT_PAYMENT_MAX || !out) return false;
  char purpose[40] = {0}, format[48] = {0};
  general_exact_payment parsed = {0}; general_canonical_reader r = { .bytes = bytes, .size = size };
  if (!general_canonical_take(&r, "{\"authorization\":{\"amountAtomic\":") || !amount(&r, parsed.amount) ||
      !general_canonical_take(&r, ",\"asset\":") || !hex(&r, parsed.asset, 42) ||
      !general_canonical_take(&r, ",\"network\":") || !text(&r, parsed.network, sizeof(parsed.network)) ||
      !general_canonical_take(&r, ",\"nonce\":") || !hex(&r, parsed.nonce, 66) ||
      !general_canonical_take(&r, ",\"payer\":") || !hex(&r, parsed.payer, 42) || !general_canonical_take(&r, ",\"payTo\":") || !hex(&r, parsed.pay_to, 42) ||
      !parse_upto(&r, &parsed) ||
      !general_canonical_take(&r, ",\"validAfter\":") || !timestamp(&r, &parsed.valid_after) || !general_canonical_take(&r, ",\"validBefore\":") ||
      !timestamp(&r, &parsed.valid_before) || parsed.valid_before <= parsed.valid_after ||
      !general_canonical_take(&r, "},\"format\":") || !text(&r, format, sizeof(format)) ||
      !general_canonical_take(&r, ",\"intentId\":") || !uuid(&r, parsed.intent_id) ||
      !general_canonical_take(&r, ",\"purpose\":") || !text(&r, purpose, sizeof(purpose)) ||
      !general_canonical_take(&r, ",\"quoteDigest\":") || !hash(&r, parsed.quote_digest) ||
      !general_canonical_take(&r, ",\"requestDigest\":") || !hash(&r, parsed.request_digest) || !general_canonical_take(&r, ",\"requestId\":") || !uuid(&r, parsed.request_id) ||
      !general_canonical_take(&r, ",\"source\":{\"enrollmentId\":") || !uuid(&r, parsed.enrollment_id) ||
      !general_canonical_take(&r, ",\"installationId\":") || !uuid(&r, parsed.installation_id) || !general_canonical_take(&r, ",\"profileId\":") || !uuid(&r, parsed.profile_id) ||
      !parse_local_protection(&r) || !general_canonical_take(&r, ",\"sourceCommitment\":") || !hash(&r, parsed.source_commitment) || !general_canonical_take(&r, ",\"sourceId\":") || !uuid(&r, parsed.source_id) ||
      !general_canonical_take(&r, "},\"subjectId\":") || !uuid(&r, parsed.subject_id) || !general_canonical_take(&r, ",\"version\":1,\"walletId\":") || !uuid(&r, parsed.wallet_id) ||
      !general_canonical_take(&r, "}") || r.position != r.size) return false;
  const bool base = !strcmp(parsed.network, "eip155:8453") &&
    !strcmp(parsed.asset, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  const bool sepolia = !strcmp(parsed.network, "eip155:84532") &&
    !strcmp(parsed.asset, "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  if (!base && !sepolia) return false;
  if (parsed.upto) {
    if (strcmp(format, "koincode-general-upto-payment") || parsed.valid_before - parsed.valid_after > 1050 ||
        (strcmp(purpose, "x402_upto") && strcmp(purpose, "x402_usdc_permit"))) return false;
    parsed.permit = !strcmp(purpose, "x402_usdc_permit");
    if (parsed.permit && !parsed.permit_nonce[0]) return false;
  } else if (strcmp(format, "koincode-general-exact-payment") ||
    strcmp(purpose, base ? "x402_exact_base" : "x402_exact_base_sepolia")) return false;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; if (!CC_SHA256(bytes, (CC_LONG)size, digest)) return false;
  static const char digits[] = "0123456789abcdef";
  for (unsigned i = 0; i < sizeof(digest); i++) { parsed.digest[2 * i] = digits[digest[i] >> 4]; parsed.digest[2 * i + 1] = digits[digest[i] & 15]; }
  *out = parsed; return true;
}
