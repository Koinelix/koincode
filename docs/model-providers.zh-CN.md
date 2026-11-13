[English](model-providers.md) | 中文

# 其他模型接入方式

需要连接账号或使用自己的 API key 时，打开 **Preferences → Model settings → Add provider**。

- **OAuth 账号**：选择 Codex、Antigravity 或其他支持的账号，在浏览器中完成授权。自动回调失败时，将本次授权产生的完整回调地址粘贴至本机应用的 **Complete callback URL**。Cline 使用设备码授权。完成后刷新模型并启用需要的模型。
- **自带 API key**：选择供应商，填写 Base URL、API 格式与 API key。不要在截图、Issue 或日志中公开密钥和授权回调地址。
- **账号用量**：支持的账号在账号卡片中显示 **Usage limits**，悬停输入框用量圆环可查看上下文及账号限额。模型权限和配额由对应服务决定。Codex 的 **Reset limits** 会消耗重置额度。

发送消息前，在输入框中选择已启用的模型。模型列表加载失败时先尝试 **Refresh models**；服务提示需要重新授权时，重新发起登录流程。

内置的 x402 模型接入见 [README](../README.zh-CN.md)。
