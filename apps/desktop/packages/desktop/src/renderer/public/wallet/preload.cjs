const { contextBridge, ipcRenderer } = require("electron");
const channel = "koincode:trusted-wallet-window";
const invoke = (action, walletId) =>
  ipcRenderer.invoke(channel, walletId === undefined ? { action } : { action, walletId });
contextBridge.exposeInMainWorld(
  "walletControl",
  Object.freeze({
    status: () => invoke("status"),
    accountNames: () => ipcRenderer.invoke("koincode:wallet-account-names", { action: "read" }),
    renameAccount: (address, name) => ipcRenderer.invoke("koincode:wallet-account-names", { action: "rename", address, name }),
    presentation: () => invoke("presentation"),
    onLocaleChanged: (callback) => {
      const listener = (_event, locale) => { if (locale === "en-US" || locale === "zh-CN") callback(); };
      ipcRenderer.on("fcode:application-locale-changed", listener);
      return () => ipcRenderer.removeListener("fcode:application-locale-changed", listener);
    },
    openProfile: () => invoke("open_profile"),
    createProfile: () => invoke("create_profile"),
    createWallet: () => invoke("create_wallet"),
    setDefault: (walletId) => invoke("set_default", walletId),
    lock: (walletId) => invoke("lock", walletId),
    unlock: (walletId) => invoke("unlock", walletId),
    inspectWallet: (walletId, section, offset = 0, displayOnly = false) => ipcRenderer.invoke(channel,
      { action: "inspect_wallet", walletId, section, offset, ...(displayOnly === true ? { displayOnly: true } : {}) }),
    allowanceStatus: (walletId) => ipcRenderer.invoke(channel, { action: "allowance_status", walletId }),
    allowancePreview: (walletId, amount) => ipcRenderer.invoke(channel, { action: "allowance_preview", walletId, amount }),
    allowanceConfirm: (walletId, previewId) => ipcRenderer.invoke(channel, { action: "allowance_confirm", walletId, previewId }),
    allowanceResend: (walletId, hash) => ipcRenderer.invoke(channel, { action: "allowance_resend", walletId, hash }),
    setLimits: (walletId, limits) => ipcRenderer.invoke(channel, { action: "set_limits", walletId, limits }),
    registerClient: (walletId, kind) => ipcRenderer.invoke(channel, { action: "register_client", walletId, kind }),
    useClient: (walletId, clientId, offset) => ipcRenderer.invoke(channel, { action: "use_client", walletId, clientId, offset }),
    revokeClient: (walletId, clientId, offset) => ipcRenderer.invoke(channel, { action: "revoke_client", walletId, clientId, offset }),
    revokeGrant: (walletId, grantId, offset) => ipcRenderer.invoke(channel, { action: "revoke_grant", walletId, grantId, offset }),
    paymentStatus: () => ipcRenderer.invoke("koincode:trusted-wallet-payment", { action: "payment_status" }),
    generalStatus: () => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "status" }),
    migrateStorage: () => ipcRenderer.invoke("koincode:wallet-manager-window", { action: "migrate_storage" }),
    openManager: (view = "create") => ipcRenderer.invoke("koincode:wallet-manager-window", { action: "open_manager", view }),
    generalNetworks: () => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "networks" }),
    generalRpcChoices: (networkId) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "rpc_choices", networkId }),
    generalChangeRpc: (networkId, rpcChoice) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "change_rpc", networkId, rpcChoice }),
    generalReadDisplayPreferences: () => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "read_display_preferences" }),
    generalSaveDisplayPreferences: (mainnets) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "save_display_preferences", mainnets }),
    generalReadNetworkVisibility: () => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "read_network_visibility" }),
    generalSaveNetworkVisibility: (visibility) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "save_network_visibility", visibility }),
    generalBalance: (walletId, networkId) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "balances", walletId, networkId }),
    generalCancelBalances: () => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "cancel_balances" }),
    generalInspectToken: (walletId, networkId, contractAddress) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "inspect_token", walletId, networkId, contractAddress }),
    generalCancelInspections: () => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "cancel_inspections" }),
    generalListAssets: (walletId, networkId, offset) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "list_assets", walletId, networkId, offset }),
    generalCustomBalances: (walletId, networkId, offset) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "custom_balances", walletId, networkId, offset }),
    generalAddAsset: (walletId, networkId, inspectionId, unverifiedDecimals) => ipcRenderer.invoke("koincode:trusted-general-wallet", {
      action: "add_asset", walletId, networkId, inspectionId, ...(unverifiedDecimals === undefined ? {} : { unverifiedDecimals }),
    }),
    generalSetAssetVisibility: (walletId, networkId, contractAddress, visible) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "set_asset_visibility", walletId, networkId, contractAddress, visible }),
    generalReceive: (walletId, networkId, assetId) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "receive", walletId, networkId, assetId }),
    generalReceiveAssets: (walletId, networkId) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "receive_assets", walletId, networkId }),
    generalCopyReceive: (walletId, networkId, assetId) => ipcRenderer.invoke("koincode:trusted-general-wallet", { action: "copy_receive", walletId, networkId, assetId }),
    decidePayment: (approvalId, choice) => ipcRenderer.invoke("koincode:trusted-wallet-payment", { action: "payment_decide", approvalId, choice }),
    onPaymentChanged: (callback) => ipcRenderer.on("koincode:trusted-wallet-payment-changed", () => callback()),
    onReady: (callback) => ipcRenderer.on("koincode:trusted-wallet-ready", () => callback()),
    onStateInvalidated: (callback) =>
      ipcRenderer.on("koincode:trusted-wallet-state-invalidated", (_event, reason) => {
        if (["changed", "lock_requested", "exited", "profile_created", "setup_required", "startup_failed", "maintenance_finished", "profile_opened"].includes(reason))
          callback(reason);
      }),
  }),
);
