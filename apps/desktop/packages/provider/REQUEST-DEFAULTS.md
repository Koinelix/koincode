# Model request defaults

`ModelConfig.requestDefaults.maxOutputTokens` is an optional positive safe integer stored by the existing personal provider/model rule owner. It is a request budget, separate from the service capability `optionSpecs.maxOutputTokens.max`. Omitting the personal field restores the applicable default; null clears the inherited configuration at the normal overlay boundary. Catalog capability overlays do not replace this field.

```json
{
  "requestDefaults": { "maxOutputTokens": 256 },
  "optionSpecs": { "maxOutputTokens": { "max": 4096 } }
}
```

The registry serializes the budget to the model factory. Execution validates it against the resolved capability before HTTP. Explicit per-request options take precedence. Wallet model defaults are bounded by 8192 tokens for ordinary calls, 256 for titles, and 4096 for compression, plus the capability and existing context budget. Already frozen payment requests and recovery operations never read a new default.

`Model.walletPayment` is a non-authoritative execution-policy flag established by the trusted factory from provider access. It disables automatic output-limit continuation and selects bounded auxiliary budgets. It cannot create a grant, choose a network, raise a wallet limit, or authorize a signature.

The settings editor saves this value through the original revision-checked configuration command. The pure overlay and validation example is exercised by `packages/services/test/modelRequestBudget.test.ts`.
