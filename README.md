<p align="center">
  <img src="brand/koincode-logo.svg" alt="KoinCode" width="480">
</p>
<p align="center"><strong>KoinCode</strong>: Use LLMs with your wallet. No API key required.</p>
<p align="center">
  <a href="https://github.com/Koinelix/koincode/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Koinelix/koincode?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Koinelix/koincode?style=flat-square"></a>
</p>
<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

KoinCode is a desktop AI agent for chatting, coding and working on local projects. Use a crypto wallet to pay in USDC for models on the [Koinelix platform](https://koinelix.com) through LLM 402 (x402), without requesting or configuring an LLM API key. Discover models, authorize USDC payments, complete AI tasks and review payment details in the app. The built-in provider is named **KoinCode** in the interface; it connects to Koinelix.

**Current source version: 4.1.3.** Check the [Releases page](https://github.com/Koinelix/koincode/releases) for published installer versions and platforms.

## LLM 402: from wallet to model results

**Prepare a wallet → discover models → select a model → authorize payment → get a reply → review settlement.**

- **No LLM API key to configure**: discover models through the built-in KoinCode provider and pay for calls with your wallet.
- **Pay in USDC**: each model call receives a quote through LLM 402 (x402). The authorization maximum and final settled charge are shown separately.
- **Choose the authorization scope**: approve one request or the current session; wallet payment limits continue to apply.
- **Put models to work**: chat, work on local code, and use tools, MCP and skills in your tasks.

![LLM 402 walkthrough: wallet, models, authorization, reply and settlement](docs/images/demo.gif)

This walkthrough combines English screens from the macOS app with the supplied payment-authorization screenshot and existing conversation and payment records. It illustrates the workflow rather than a continuous recording of a new paid task. Models, balances and amounts are examples from those screens; current availability and prices depend on the platform catalog and request quote.

## Download

Installers are published on the [Releases page](https://github.com/Koinelix/koincode/releases/latest). The source repository itself contains no binary installers.

| Platform | Package |
| --- | --- |
| macOS (Apple silicon, M series, arm64) | `.dmg` |
| Windows x64 | `.exe` installer |

The macOS package is for Macs with an M-series chip (M1, M2, M3, M4 and so on) only and does not support Intel-based Macs. No installer is provided for Intel Macs yet; you can try building from source (`package.sh x64`, not verified by us).

Each package comes with a same-named `.sha256` checksum file; verifying it after download is recommended.

## Quick start: use LLMs with your wallet

### 1. Open KoinCode and prepare a wallet

Install the package for your platform and launch KoinCode. If **Welcome to KoinCode** appears, choose **Skip for now** to enter the workspace. Open **Preferences → Wallet**, or use **Open wallet** in the built-in provider's model settings. Create or import a wallet if needed.

Check the network and use **Receive** to find the receiving address. Fund it with USDC on that network. Installed packages use Base mainnet, where model calls spend real USDC. **Payment limits (USDC)** shows the per-payment, 24-hour and total limits.

<img src="docs/images/002.png" alt="English wallet showing Base mainnet, USDC balance, Receive and payment limits" width="480">

### 2. Discover and enable models without an API key

Open **Preferences → Model settings** and select **KoinCode**. Click **Refresh models**, then enable the models you want. This built-in provider connects to Koinelix and does not require an API key or a new custom provider. Its **Open wallet** button takes you to the same wallet.

![Built-in KoinCode provider: wallet payment, no API key and available models](docs/images/003.png)

### 3. Select a model and start a task

Return to the workspace and choose **New task**. Open the model selector in the composer, expand **KoinCode** and choose an enabled model. Send a message; for local coding tasks, select the project directory and an appropriate permission level first.

![English model selector with the KoinCode provider and enabled models](docs/images/004.png)

### 4. Review and authorize payment

When payment authorization is needed, the **KoinCode Payment** window shows the **Maximum authorization**. Choose **This request only** or **This session**. Expand **Payment details** to review the request's payment information before approving. Session authorization can cover matching requests within its scope and wallet limits.

The amount shown here is an authorization ceiling, not the final charge. In this example the maximum is **0.145155 USDC**; check the settled amount in Payment history after the call.

![English payment authorization showing the maximum and request or session scope](docs/images/005.png)

### 5. Read the reply and continue working

The model's response appears in the task. The screenshot shows an existing English conversation using **KoinCode/gpt-6.1-sol**. Continue with follow-up questions or a project task; model requests use the applicable wallet authorization and limits.

![English model reply in a KoinCode task with the selected wallet-paid provider](docs/images/006.png)

### 6. Review actual charges and settlement details

Open the wallet and choose **Payment history** to see amounts, statuses and settlement times. Read the displayed status to distinguish confirmed charges from pending reservations.

<img src="docs/images/007.png" alt="English payment history listing model calls, USDC amounts, Confirmed status and settlement times" width="480">

Expand a **Model call** row to inspect its network, request URL, authorized maximum, released reservation and transaction reference. The example below shows **0.035652 USDC** confirmed, an authorized maximum of **0.145155 USDC** and a released reservation of **0.109503 USDC**. These illustrate the difference between the authorization ceiling and the settled charge; they are not a fixed model price.

<img src="docs/images/008.png" alt="Expanded payment record with Base mainnet, actual amount, authorized maximum, released reservation and transaction reference" width="480">

For source development, the default is Base Sepolia with a local platform. Use the mainnet startup option in the build instructions to connect to production. Testnet and mainnet USDC belong to separate networks.

## Features

- Chat with an AI in a desktop window and work on local code after choosing a project directory.
- Use wallet USDC payments to access Koinelix LLMs without an API key; OAuth accounts and custom API-key providers are also available.
- View subscription usage of Codex, Antigravity and Cline accounts inside the app.
- Plugins, MCP, skills, subagents and workflows.
- Import visible conversation history from Claude Code, Codex or Antigravity and continue chatting in KoinCode.
- Configure SSH hosts in Preferences and use `/remote-host` with the built-in `remote-host-operations` skill to work with remote files and commands.
- A built-in browser for viewing and operating web pages.
- Computer Use operates local applications through screenshots and real mouse and keyboard input, with macOS and Windows desktop entry points (experimental; see below).
- Workspaces, sessions and settings are stored on your machine.

## Computer Use: operate local applications (experimental)

Computer Use lets the model observe the screen, operate real applications and check the result in a fresh screenshot. For example, ask it to open a specified video in Jianying, export the complete audio as MP3 and save it to a chosen directory with a new filename. It uses your machine's foreground, mouse and keyboard; ordinary conversations do not automatically enable desktop control.

1. Configure and select a model that supports image input through Koinelix or another provider.
2. Start a new task, type `/` in the composer, select the official **computer-use** skill and describe the application, input file, output directory and expected result.
3. At the first desktop observation, approve primary-display screenshots and real mouse and keyboard input for this task. Screenshots may include other applications and are sent to the selected model; KoinCode hides while operating. macOS requires version 14 or later and the requested screen recording, accessibility and event monitoring permissions.
4. Press **physical Esc** to pause and take over, or return to the task panel in KoinCode and click **Pause / Stop**. Ordinary mouse movement, typing and application switching do not cancel the task. On macOS, KoinCode automatically yields its ordinary windows when brought forward, observes a fresh screenshot and continues. Use **Continue with Computer Use** to resume an explicitly paused task. Resolve missing permissions, a locked screen, Secure Input or a protected confirmation dialog manually before continuing.

**Permission denied after updating KoinCode on macOS even though the switches are on?** The current ad-hoc signature can change between builds, so an old system grant may not apply to the new version. Quit KoinCode, remove its old entries in **System Settings → Privacy & Security → Accessibility** and **Screen & System Audio Recording**, then use **+** to add the currently installed KoinCode.app and enable its permissions. Restart KoinCode and explicitly select Computer Use for a new task. Grant access to the current KoinCode main application; do not add the bundled Helper separately or reset permissions for other applications.

Version 4.1.2 improves screenshot context and the operation flow: model history retains at most the latest **three operation screenshots**, while earlier operation text and receipts remain. User-uploaded images are not removed by this rule and continue through the existing unified compression and media budget. The SDK can dispatch one logical action and observe its result in the same tool call, and the task panel distinguishes waiting for the model from active operation.

Complete audio export through Jianying has been verified in a single-display development environment on an Apple silicon Mac. Windows has a desktop entry point, but the new screenshot optimization has not yet been retested on a real Windows machine. Intel Macs, multiple displays and the new installers still need separate compatibility checks. Results and duration depend on the model, application UI and system permissions; operation is not guaranteed for every application.

## Other model connections

For account access or your own API key, open **Preferences → Model settings → Add provider**.

- **OAuth accounts**: choose Codex, Antigravity or another supported account and finish authorization in the browser. If automatic callback fails, paste this attempt's complete callback URL into **Complete callback URL** in the local app. Cline uses device-code authorization instead. Then refresh and enable the account's models.
- **Your own API key**: choose a provider and enter its Base URL, API format and API key. Keep keys and authorization callbacks out of screenshots, Issues and logs.
- **Account usage**: supported accounts show **Usage limits** on the account card; hover over the composer usage ring for available context and account limits. Access and quotas depend on the service. Codex's **Reset limits** consumes a reset credit.

Choose an enabled model in the composer before sending a message. If the model list fails to load, try **Refresh models**; if the service asks for authorization again, restart the sign-in flow.

## Installation notes

Using an installer does not require Node.js, pnpm or build commands. By default, macOS packages have no Developer ID signature or notarization. Local builds containing the Computer Use Helper use ad-hoc signing, which is not an Apple-verified developer signature, so macOS may still block opening. Use this project's Releases page for installers; build from source if your platform has no package.

## Build from source

Three scripts under `apps/desktop` cover the whole flow: **Build → Run → Package**. Run all commands from the repository root.

### Requirements

| Platform | What you need |
| --- | --- |
| macOS | Node.js and pnpm (versions in `apps/desktop/mise.toml`), Xcode Command Line Tools (`xcode-select --install`) |
| Windows x64 | Node.js 24.x on `PATH`; pnpm 10.x is optional. If pnpm is missing, the scripts enable the declared version through corepack (the first run needs network access). |

The first build runs `pnpm install --frozen-lockfile` automatically, so you do not need to install dependencies by hand.

### macOS

```bash
# 1. Build
./apps/desktop/build.sh

# 2. Run (starts the desktop app in development mode; press Ctrl+C to exit)
./apps/desktop/run.sh
# Connect to mainnet
./apps/desktop/run.sh mainnet

# 3. Package (produces a .dmg, for the host architecture by default)
./apps/desktop/package.sh
```

Useful options:

```bash
./apps/desktop/build.sh --release    # build, then package; same as build.sh followed by package.sh
./apps/desktop/package.sh arm64      # pick the architecture: arm64 or x64
```

#### Testnet and mainnet

Choose the payment network when starting development. The network and Koinelix endpoint are paired in `apps/desktop/config/network.json`:

```bash
./apps/desktop/run.sh            # Base Sepolia; local platform at http://127.0.0.1:8080/v1
./apps/desktop/run.sh mainnet    # Base mainnet; https://api.koinelix.com/v1; spends real USDC
```

- The network is fixed at build time. Stop and restart with the desired argument to change it.
- Wallet data is separate: `~/.koincode/wallet/m4-testnet` for testnet and `~/.koincode/wallet/mainnet` for mainnet. First-time mainnet payment requires registering the payment source through the existing system authentication flow (Touch ID on macOS).
- Refresh the Koinelix model list after switching.
- Packaging (`package.sh`) always uses mainnet.

### Windows

```powershell
# 1. Build
.\apps\desktop\build.cmd

# 2. Run (starts the desktop app in development mode; press Ctrl+C to exit)
.\apps\desktop\run.cmd

# 3. Package (produces an .exe installer; x64 only)
.\apps\desktop\package.cmd
```

Useful options:

```powershell
.\apps\desktop\build.cmd --release   # build, then package
.\apps\desktop\run.cmd mainnet       # run on mainnet (testnet is the default)
```

You can also double-click the scripts inside `apps/desktop`.

### Notes on running

- Build before the first Run; Run tells you to run Build first if dependencies are missing.
- Run isolates development data in `~/.koincode/dev`. Installed builds default to `~/.koincode`; wallet files use a separate `wallet/` subtree, with secrets protected by the operating system.
- Run needs local port 5174 to be free; stop any previously started instance if it is in use.
- Keep the terminal open while it runs and press `Ctrl+C` to exit.

### Where installers are written

- Windows: `releases/windows/<version>/`, producing an `.exe` installer.
- macOS: `releases/macos/<version>/`, producing a `.dmg` plus a `.sha256` checksum file (the build also leaves a `.zip` for local use only; it is not published).

These directories are local build output, ignored by `.gitignore` and never committed. Installers for distribution are uploaded to [GitHub Releases](https://github.com/Koinelix/koincode/releases).

## Feedback and contributing

If you run into a problem or have a suggestion, please open an [issue](https://github.com/Koinelix/koincode/issues). Pull requests are welcome.

## Attribution and third-party licenses

Project provenance and acknowledgements are recorded in [ATTRIBUTION.md](ATTRIBUTION.md). Third-party components and their licenses are listed in [apps/desktop/THIRD-PARTY-NOTICES.md](apps/desktop/THIRD-PARTY-NOTICES.md).

## License

This project is released under the [Apache License 2.0](LICENSE).
