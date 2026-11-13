# Reference host adapter

Python 3.9+ and the standard library are sufficient. The reference transport supports POSIX Unix sockets (macOS/Linux); it explicitly refuses Windows, which needs a separate ACL-authenticated named-pipe implementation. No additional third-party dependency or license is introduced.

A trusted launcher registers an external client and unlocks/authorizes the wallet using its existing trusted controls. The launcher supplies a private inherited connected socket, default fd 4, then starts:

```sh
python3 scripts/generate_image.py --host reference --bootstrap-fd 4 --url https://merchant.example/v1/images/generations --api-version model-v1 --model example/image --access-mode anonymous_x402 --prompt "A lighthouse"
```

This is a launcher contract, not a command that works in an ordinary shell without a host. Do not put a token, API Key or private key in argv, environment, a regular config file, stdout or a model tool result. The bootstrap socket receives exactly one newline-terminated JSON object, at most 128 KiB, within 10 seconds:

| Field | Required value |
|---|---|
| version | Integer 1 |
| socketPath | Explicit absolute path to the running wallet's public payment socket, owned by the current user with no group/world permissions |
| clientId / token | Existing registered identity and protected token, supplied privately by the launcher |
| context.taskId | Stable 64 lowercase hex identity owned by the host; preserve for recovery |
| context.stateDirectory | Existing absolute directory owned by the user, mode 0700; durable across restarts |
| context.outputDirectory | Separate existing absolute private directory, mode 0700 |
| credential | Optional object: exact url, protected secret, and opaque 64 lowercase hex credentialTag |

The launcher owns private directories and their parent directories, protects inherited descriptors, obtains secrets from secure storage and enforces cancellation/process lifetime. It must not point at another host's private files, invent a new task to bypass an unknown result, or expose bootstrap JSON. Parent-directory trust is the launcher's responsibility; this is not a sandbox or protection against a malicious same-user process.

The adapter authenticates with `{clientId, token, protocol: "payment-v1"}` and waits for the successful reply before sending numbered frames. It implements context/credential lookup locally, forwards only the published payment methods, and binds authorize_payment to the original digest prepared on this connection. It neither grants payment authority nor changes budgets, capabilities or accounting. Wallet connection calls have a 45-minute socket timeout; there is no automatic reconnect or replay.

The same business client, durable OperationStore and image ArtifactPublisher are used by both hosts. A tool host must publish files from outputDirectory through its own artifact facility, returning only a bounded receipt. Direct stdout is a receipt for a trusted launcher; never forward private pipe content, raw responses or signatures. Retain state and output on cancellation. If moving hosts, explicitly transfer the same protected request state through an approved migration; this adapter does not discover or migrate KoinCode state. With no recoverable state, stop rather than create a replacement purchase.

For a lost response, use `--recover <original-operation-id>` with the same state. Recovery reads the frozen URL, API version and mode, saves no new payment and sends no merchant request. It requires neither the model nor the original API Key when a retained response can be delivered. Explicitly selecting a conflicting access mode/API version fails. A missing or untrusted response remains pending.

Existing KoinCode callers keep fd 3 and the old tool arguments. `--host reference` is opt-in; lack of fd 3 in KoinCode is not permission to bypass its controls with this adapter.
