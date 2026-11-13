import { PERMIT2_ADDRESS, UPTO_PROXY_ADDRESS } from "../domain/uptoAuthorization.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { PaymentBuilder } from "../app/paymentBuilder.js";
import type { WalletPayments } from "../app/payments.js";
import { requireWallet } from "../domain/errors.js";
export class SdkPaymentBuilder implements PaymentBuilder {
  constructor(private readonly payments: WalletPayments) {}
  async build(input: Parameters<PaymentBuilder["build"]>[0]) {
    if (input.quote.selected.scheme === "upto") {
      const quote = input.quote.selected;
      const extensions = input.quote.challenge.extensions as Record<string, unknown> | undefined;
      input.assertCurrent();
      const signed = await this.payments.sign(input.handle, input.scope, null, input.signal,
        { assertCurrent: input.assertCurrent, maxTimeoutSeconds: quote.maxTimeoutSeconds, uptoShared: input.uptoShared === true, onReserved: input.onReserved,
          uptoTerms: { facilitator: quote.extra.facilitatorAddress!, timeout: quote.maxTimeoutSeconds,
            sponsoring: Boolean(extensions?.eip2612GasSponsoring) } });
      const authorization = signed.upto;
      requireWallet(authorization, "PERMIT_MISMATCH", "The upto signer did not return its authorization.");
      const payload = {
        x402Version: 2, resource: input.quote.challenge.resource as PaymentRequired["resource"], accepted: quote,
        payload: { signature: signed.signature, permit2Authorization: {
          from: authorization.payer, permitted: { token: authorization.asset, amount: authorization.amountAtomic },
          spender: UPTO_PROXY_ADDRESS, nonce: BigInt(authorization.nonce).toString(), deadline: String(authorization.validBefore),
          witness: { to: authorization.payTo, facilitator: authorization.upto.facilitator, validAfter: String(authorization.validAfter) },
        } },
        ...(signed.permitSignature ? { extensions: { eip2612GasSponsoring: { info: {
          from: authorization.payer, asset: authorization.asset, spender: PERMIT2_ADDRESS, amount: authorization.amountAtomic,
          nonce: authorization.upto.permitNonce!, deadline: String(authorization.validBefore), signature: signed.permitSignature, version: "1",
        } } } } : {}),
      };
      return { intentId: signed.intentId, header: encodePaymentSignatureHeader(payload) };
    }
    let intentId: string | undefined;
    const exact = new ExactEvmScheme({
      address: input.walletAddress as `0x${string}`,
      signTypedData: async (data) => {
        input.assertCurrent();
        const signed = await this.payments.sign(input.handle, input.scope, data, input.signal, {
          assertCurrent: input.assertCurrent,
          replacementFrom: input.replacementFrom,
          unsignedRetryFrom: input.unsignedRetryFrom,
          maxTimeoutSeconds: input.quote.selected.maxTimeoutSeconds,
        });
        intentId = signed.intentId;
        return signed.signature as `0x${string}`;
      },
    });
    const bridge = {
      scheme: "exact",
      findDefaultAsset: exact.findDefaultAsset,
      createPaymentPayload: (
        version: number,
        requirements: Parameters<ExactEvmScheme["createPaymentPayload"]>[1],
        context: Parameters<ExactEvmScheme["createPaymentPayload"]>[2],
      ) =>
        exact.createPaymentPayload(
          version,
          { ...requirements, maxTimeoutSeconds: Math.min(110, requirements.maxTimeoutSeconds) },
          context,
        ),
    };
    const client = new x402Client().register(input.quote.selected.network, bridge);
    const required = {
      ...input.quote.challenge,
      accepts: [input.quote.selected],
    } as unknown as PaymentRequired;
    const payload = await client.createPaymentPayload(required);
    requireWallet(intentId, "PERMIT_MISMATCH", "The precise wallet signer was not called.");
    return { intentId, header: encodePaymentSignatureHeader(payload) };
  }
}
