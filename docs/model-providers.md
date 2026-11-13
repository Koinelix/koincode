English | [中文](model-providers.zh-CN.md)

# Other model connections

For account access or your own API key, open **Preferences → Model settings → Add provider**.

- **OAuth accounts**: choose Codex, Antigravity or another supported account and finish authorization in the browser. If automatic callback fails, paste this attempt's complete callback URL into **Complete callback URL** in the local app. Cline uses device-code authorization instead. Then refresh and enable the account's models.
- **Your own API key**: choose a provider and enter its Base URL, API format and API key. Keep keys and authorization callbacks out of screenshots, Issues and logs.
- **Account usage**: supported accounts show **Usage limits** on the account card; hover over the composer usage ring for available context and account limits. Access and quotas depend on the service. Codex's **Reset limits** consumes a reset credit.

Choose an enabled model in the composer before sending a message. If the model list fails to load, try **Refresh models**; if the service asks for authorization again, restart the sign-in flow.

For the built-in x402 model access, see the [README](../README.md).
