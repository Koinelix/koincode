<p align="center">
  <img src="brand/koincode-logo.svg" alt="KoinCode" width="480">
</p>
<p align="center"><strong>KoinCode</strong>：开源的 LLM x402 智能体</p>
<p align="center">
  <a href="https://github.com/Koinelix/koincode/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Koinelix/koincode?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Koinelix/koincode?style=flat-square"></a>
</p>
<p align="center"><a href="https://koinelix.com/">官网</a> | <a href="README.md">English</a> | 中文</p>

KoinCode 是一款面向 LLM x402 的开源桌面 AI Agent，将模型发现、付款授权、模型调用和结算明细整合到任务流程中。你可以用它进行对话、处理本地代码，并结合工具、MCP 和技能完成任务。内置 [Koinelix](https://koinelix.com) 接入，通过 x402 使用模型，无需配置 LLM API key。

**当前源码版本：4.1.3。** 已发布安装包的版本和平台请以 [Releases 页面](https://github.com/Koinelix/koincode/releases) 为准。

## LLM x402 Agent 工作流

**创建任务 → 选择模型 → 核对报价并授权 → 执行任务 → 查看结果与结算。**

- **LLM x402 接入**：获取并选择 Koinelix 模型，通过 x402 连接模型请求与 USDC 付款。
- **Agent 任务执行**：对话、处理本地代码，并结合工具、MCP 和技能完成任务。
- **可控的付款授权**：选择单次请求或当前会话授权，付款受钱包限额约束。
- **清晰的结算信息**：查看实际费用、授权上限和付款状态。
![LLM x402 Agent 流程演示：任务、模型、授权、回复与结算](docs/images/demo.gif)

演示由 macOS 应用的英文界面、提供的付款授权截图及已有对话和付款记录组成，用于说明操作流程，并非一项新付费任务的连续录屏。图中的模型、余额和金额为当时界面的示例，当前可用模型与价格以平台目录及请求报价为准。

## 下载

安装包发布在 [Releases 页面](https://github.com/Koinelix/koincode/releases/latest)，源码仓库本身不包含任何二进制安装包。

| 平台 | 安装包 |
| --- | --- |
| macOS（Apple 芯片 M 系列，arm64） | `.dmg` |
| Windows x64 | `.exe` 安装程序 |

macOS 安装包仅适用于搭载 M 系列芯片（M1、M2、M3、M4 等）的 Mac，不支持 Intel 芯片的 Mac；Intel Mac 暂未提供安装包，可尝试从源码构建（`package.sh x64`，我们尚未验证）。

每个安装包旁附有同名 `.sha256` 校验文件，下载后建议核对。

## 快速开始：运行第一个 LLM x402 任务

### 1. 启动应用并获取模型

安装对应平台的安装包并启动 KoinCode。如果出现 **Welcome to KoinCode**，选择 **Skip for now** 进入工作区。

进入 **Preferences → Model settings**，选择 **KoinCode**。点击 **Refresh models**，启用需要的模型。这个内置供应商连接 Koinelix，无需填写 API key，也无需新增自定义供应商。

![LLM x402 模型接入：内置 KoinCode 供应商及可用模型列表](docs/images/003.png)

### 2. 创建任务并选择模型

返回工作区，选择 **New task**。打开输入框中的模型选择菜单，展开 **KoinCode**，选择已启用的模型。处理本地代码时，先选择项目目录和适当的权限范围。首次发送消息前，按下一步准备付款。

![英文模型选择菜单：为 Agent 任务选择 KoinCode 模型](docs/images/004.png)

### 3. 准备首次请求的付款

打开 **Preferences → Wallet**，或在内置供应商的模型设置中点击 **Open wallet**。尚无钱包时，先创建或导入钱包。

核对当前网络，通过 **Receive** 查看收款地址，并转入该网络的 USDC。安装包使用 Base 主网，模型调用会支付真实 USDC。**Payment limits (USDC)** 展示单笔、24 小时与总付款限额。

<img src="docs/images/002.png" alt="英文钱包界面：Base 主网、USDC 余额、收款入口和付款限额" width="480">

### 4. 发送请求并核对付款授权

在任务输入框中描述目标并发送消息。需要付款授权时，**KoinCode Payment** 窗口会显示 **Maximum authorization**。选择 **This request only**（仅本次请求）或 **This session**（当前会话），展开 **Payment details** 核对本次请求的付款信息后再授权。会话授权可覆盖其范围内符合条件的请求，同时受钱包限额约束。

这里的金额是授权上限，并非最终费用。图中示例上限为 **0.145155 USDC**；调用后的实际结算金额请在 Payment history 中查看。

![英文付款授权：授权上限及单次请求或当前会话的授权范围](docs/images/005.png)

### 5. 查看模型回复并继续工作

模型回复会显示在任务中。截图展示已有的英文对话，所选模型为 **KoinCode/gpt-6.1-sol**。随后可继续追问或处理项目任务，模型请求使用适用的钱包授权并受限额约束。

![LLM x402 Agent 任务中的英文模型回复及所选模型](docs/images/006.png)

### 6. 查看实际费用和结算详情

打开钱包，选择 **Payment history**，查看金额、状态和结算时间。根据界面显示的状态区分已确认费用与待处理的预占。

<img src="docs/images/007.png" alt="英文付款历史：模型调用、USDC 金额、Confirmed 状态和结算时间" width="480">

展开一条 **Model call**，查看网络、请求地址、授权上限、释放的预占和交易引用。下图记录显示已确认金额 **0.035652 USDC**、授权上限 **0.145155 USDC**、释放预占 **0.109503 USDC**。这些数值用于说明授权上限与实际结算费用的区别，并非固定模型价格。

<img src="docs/images/008.png" alt="展开的付款记录：Base 主网、实际金额、授权上限、释放预占和交易引用" width="480">

源码开发默认使用 Base Sepolia 测试网与本地平台；连接正式平台请使用下文的主网启动参数。测试网 USDC 与主网 USDC 分属不同网络。

## 功能

- 在桌面窗口中与 AI 对话，选择项目目录后处理本地代码。
- 内置 LLM x402 模型接入，将 Koinelix 模型调用、付款授权和结算明细纳入 Agent 工作流；也支持 OAuth 账号与自带 API key 的模型供应商。
- 在应用内查看 Codex、Antigravity 和 Cline 账号的订阅套餐用量。
- 支持插件、MCP、技能、子代理与工作流。
- 导入 Claude Code、Codex 或 Antigravity 的可见对话历史，并在 KoinCode 中继续对话。
- 在偏好设置中配置 SSH 主机，通过 `/remote-host` 与内置 `remote-host-operations` 技能操作远程文件和命令。
- 内置浏览器，可用于查看和操作网页。
- Computer Use 可通过截图和真实键鼠操作本机应用，提供 macOS 与 Windows 桌面入口（实验性，使用方法见下文）。
- 工作区、会话与设置保存在本机。

## Computer Use：操作本机应用（实验性）

Computer Use 让模型观察屏幕、操作真实应用，并通过操作后的画面核对结果。例如，可以要求它在剪映中打开指定视频，将完整音频导出为 MP3，保存到指定目录并使用新的文件名。它会占用本机前台、鼠标和键盘；普通对话不会自动启用桌面操作。

1. 通过 Koinelix 或其他供应商配置并选择支持图片输入的模型。
2. 新建任务，在输入框输入 `/`，选择官方 **computer-use** 技能，再描述应用、目标文件、输出目录和期望结果。
3. 首次观察桌面时，确认本任务的主显示器截图和真实键鼠操作。截图可能包含其他应用，并会发送给所选模型；操作时 KoinCode 会隐藏。macOS 需要 14 或更高版本，并按提示授予屏幕录制、辅助功能及事件监听所需权限。
4. 需要接管时按**物理 Esc** 暂停，或回到 KoinCode 的任务面板点击**暂停 / 停止**。普通移动鼠标、键盘输入和切换应用不会取消任务；macOS 下 KoinCode 回到前台时会自动让出普通窗口，重新截图后继续。需要恢复明确暂停的任务时使用**继续操作电脑**；权限不足、锁屏、安全输入或受保护的确认窗口阻挡时，先人工处理原因再继续。

**macOS 上升级 KoinCode 后，权限开关已开启但仍提示权限不足？** 当前 ad-hoc 签名可能随构建改变，系统保留的旧授权不一定适用于新版本。退出 KoinCode，在“系统设置 → 隐私与安全性”的“辅助功能”和“录屏与系统录音”中移除旧 KoinCode 条目，再用“+”添加当前安装的 KoinCode.app 并开启权限；重启 KoinCode，重新明确选择 Computer Use 发起任务。应给当前 KoinCode 主应用授权，不要单独添加包内 Helper，也不要重置其他应用的权限。

4.1.2 优化了截图上下文和操作流程：发送给模型的历史最多保留最近**三张操作截图**，较早的操作文本和回执保留；用户主动上传的图片不受这条规则删除，继续使用统一压缩和媒体预算。SDK 支持一次工具调用内执行一个逻辑操作并观察操作后画面，任务面板区分等待模型和实际操作。

目前已在 Apple 芯片 Mac 的单屏开发环境中验证剪映完整音频导出。Windows 提供桌面操作入口，本次截图优化的 Windows 实机复测尚未完成；Intel Mac、多屏和新版安装包的兼容性仍需分别验证。任务效果与耗时取决于模型、应用界面和系统权限，不保证所有软件都能完成操作。

## 其他模型接入方式

需要连接账号或使用自己的 API key 时，打开 **Preferences → Model settings → Add provider**。

- **OAuth 账号**：选择 Codex、Antigravity 或其他支持的账号，在浏览器中完成授权。自动回调失败时，将本次授权产生的完整回调地址粘贴至本机应用的 **Complete callback URL**。Cline 使用设备码授权。完成后刷新模型并启用需要的模型。
- **自带 API key**：选择供应商，填写 Base URL、API 格式与 API key。不要在截图、Issue 或日志中公开密钥和授权回调地址。
- **账号用量**：支持的账号在账号卡片中显示 **Usage limits**，悬停输入框用量圆环可查看上下文及账号限额。模型权限和配额由对应服务决定。Codex 的 **Reset limits** 会消耗重置额度。

发送消息前，在输入框中选择已启用的模型。模型列表加载失败时先尝试 **Refresh models**；服务提示需要重新授权时，重新发起登录流程。

## 安装说明

使用安装包无需安装 Node.js、pnpm，也无需执行编译命令。macOS 安装包默认未使用 Developer ID 签名或公证；包含 Computer Use Helper 的本地构建使用 ad-hoc 签名，并不等同于 Apple 验证的开发者签名，系统仍可能阻止打开。安装包请从本项目 Releases 页面获取；没有对应平台安装包时，可从源码构建。

## 从源码构建

使用 `apps/desktop` 下的三个脚本完成：**编译（Build）→ 运行（Run）→ 打包（Package）**。以下命令均从仓库根目录执行。

### 环境要求

| 平台 | 需要准备 |
| --- | --- |
| macOS | Node.js 与 pnpm（版本见 `apps/desktop/mise.toml`）、Xcode Command Line Tools（`xcode-select --install`） |
| Windows x64 | Node.js 24.x，加入 `PATH`；pnpm 10.x 可选。缺少 pnpm 时，脚本通过 corepack 启用项目声明的版本，首次需要联网下载。 |

首次编译会自动执行 `pnpm install --frozen-lockfile` 安装依赖，无需手动安装。

### macOS

```bash
# 1. 编译
./apps/desktop/build.sh

# 2. 运行（开发模式启动桌面端，退出按 Ctrl+C）
./apps/desktop/run.sh
#  连接主网
./apps/desktop/run.sh mainnet

# 3. 打包（生成 .dmg，默认与本机架构一致）
./apps/desktop/package.sh
```

常用选项：

```bash
./apps/desktop/build.sh --release    # 编译后继续打包，等价于依次执行 build.sh 和 package.sh
./apps/desktop/package.sh arm64      # 指定架构，可选 arm64 或 x64
```

#### 测试网与正式网

开发运行时用参数选择付款网络，网络与 Koinelix 模型地址成对定义在 `apps/desktop/config/network.json`，不读环境变量：

```bash
./apps/desktop/run.sh            # 测试网（默认）：Base Sepolia，模型地址 http://127.0.0.1:8080/v1（需本机平台已启动）
./apps/desktop/run.sh mainnet    # 正式网：Base 主网，模型地址 https://api.koinelix.com/v1，模型调用会支付真实 USDC
```

- 网络在构建时写入，切换需停止后带参数重新运行；运行中不能切换。
- 两网钱包数据分开：测试网 `~/.koincode/wallet/m4-testnet`，正式网 `~/.koincode/wallet/mainnet`。首次在正式网付款需按现有流程登记付款来源（Touch ID）。
- 切换后在设置中刷新一次 Koinelix 模型列表。
- 打包（`package.sh`）固定使用正式网，不受运行参数影响。

### Windows

```powershell
# 1. 编译
.\apps\desktop\build.cmd

# 2. 运行（开发模式启动桌面端，退出按 Ctrl+C）
.\apps\desktop\run.cmd

# 3. 打包（生成 .exe 安装包，仅支持 x64）
.\apps\desktop\package.cmd
```

常用选项：

```powershell
.\apps\desktop\build.cmd --release   # 编译后继续打包
.\apps\desktop\run.cmd mainnet       # 以正式网运行（默认测试网），说明见上方“测试网与正式网”
```

也可以在 `apps/desktop` 目录中双击对应脚本。

### 运行说明

- 第一次使用请先编译，再运行；缺少依赖时 Run 会提示先执行 Build。
- Run 使用 `~/.koincode/dev` 隔离开发数据。正式安装版默认使用 `~/.koincode`；钱包文件使用独立的 `wallet/` 子目录，秘密继续由系统安全存储保护。
- Run 需要本机 5174 端口空闲；端口被占用时请先关闭之前启动的实例。
- 运行时保持终端打开，退出时按 `Ctrl+C`。

### 安装包输出位置

- Windows：`releases/windows/<版本号>/`，生成 `.exe` 安装包。
- macOS：`releases/macos/<版本号>/`，生成 `.dmg` 并附 `.sha256` 校验文件（构建时还会附带一个 `.zip`，仅供本地使用，不对外发布）。

这些目录是本地构建产物，已被 `.gitignore` 忽略，不会提交到仓库；对外发布的安装包统一上传到 [GitHub Releases](https://github.com/Koinelix/koincode/releases)。

## 反馈与贡献

使用中遇到问题或有改进建议，欢迎在 [Issues](https://github.com/Koinelix/koincode/issues) 中反馈，也欢迎提交 Pull Request。

## 来源与第三方许可

项目来源与致谢见 [ATTRIBUTION.md](ATTRIBUTION.md)，第三方组件及其许可证见 [apps/desktop/THIRD-PARTY-NOTICES.md](apps/desktop/THIRD-PARTY-NOTICES.md)。

## 许可证

本项目依照 [Apache License 2.0](LICENSE) 开源。
