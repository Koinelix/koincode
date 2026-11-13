import { DEFAULT_LOCALE, type Locale } from "./protocol.js";
import menuMessages from "./desktopMenuMessages.json" with { type: "json" };

export const desktopMenuMessageIds = {
  file: "titleBar.menu.file",
  edit: "titleBar.menu.edit",
  view: "titleBar.menu.view",
  window: "titleBar.menu.window",
  help: "titleBar.menu.help",
  fileNewTask: "titleBar.menu.file.newTask",
  fileOpenWorkspace: "titleBar.menu.file.openWorkspace",
  fileCloseWindow: "titleBar.menu.file.closeWindow",
  editUndo: "titleBar.menu.edit.undo",
  editRedo: "titleBar.menu.edit.redo",
  editCut: "titleBar.menu.edit.cut",
  editCopy: "titleBar.menu.edit.copy",
  editPaste: "titleBar.menu.edit.paste",
  editDelete: "titleBar.menu.edit.delete",
  editSelectAll: "titleBar.menu.edit.selectAll",
  viewToggleFullScreen: "titleBar.menu.view.toggleFullScreen",
  viewActualSize: "titleBar.menu.view.actualSize",
  viewZoomIn: "titleBar.menu.view.zoomIn",
  viewZoomOut: "titleBar.menu.view.zoomOut",
  windowMinimize: "titleBar.menu.window.minimize",
  windowZoom: "titleBar.menu.window.zoom",
  windowBringAllToFront: "titleBar.menu.window.bringAllToFront",
  appServices: "titleBar.menu.app.services",
  appHide: "titleBar.menu.app.hide",
  appHideOthers: "titleBar.menu.app.hideOthers",
  appShowAll: "titleBar.menu.app.showAll",
  appQuit: "titleBar.menu.app.quit",
  helpAbout: "titleBar.menu.help.about",
  helpWhatsNew: "titleBar.menu.help.whatsNew",
  helpCheckForUpdates: "titleBar.menu.help.checkForUpdates",
  helpToggleDevTools: "titleBar.menu.help.toggleDevTools",
  helpResourceManager: "titleBar.menu.help.resourceManager",
  helpToggleFCodeStdioTap: "titleBar.menu.help.toggleFCodeStdioTap",
  helpFCodeEndpoint: "titleBar.menu.help.fcodeEndpoint",
  helpFCodeEndpointProduction: "titleBar.menu.help.fcodeEndpoint.production",
  helpFCodeEndpointTest: "titleBar.menu.help.fcodeEndpoint.test",
  helpFCodeEndpointCustom: "titleBar.menu.help.fcodeEndpoint.custom",
  helpFCodeEndpointReset: "titleBar.menu.help.fcodeEndpoint.reset",
  helpExportLogs: "titleBar.menu.help.exportLogs",
  helpClearAllData: "titleBar.menu.help.clearAllData",
  helpCheckingForUpdates: "desktopMenu.help.checkingForUpdates",
  helpUpdateAvailableVersion: "desktopMenu.help.updateAvailableVersion",
  helpDownloadingUpdateVersion: "desktopMenu.help.downloadingUpdateVersion",
  helpDownloadingUpdateProgress: "desktopMenu.help.downloadingUpdateProgress",
  helpRestartToUpdate: "desktopMenu.help.restartToUpdate",
  dockShowCurrentWindow: "dock.menu.showCurrentWindow",
  trayTooltip: "tray.tooltip",
  trayOpenFCode: "tray.menu.openFCode",
  trayQuit: "tray.menu.quit",
} as const;

export type DesktopMenuMessageId =
  (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds];

type DesktopMenuLocaleMessages = Record<DesktopMenuMessageId, string>;

export const desktopMenuMessages: Record<Locale, DesktopMenuLocaleMessages> = menuMessages;

export function getDesktopMenuMessage(locale: Locale, id: DesktopMenuMessageId): string {
  const messages = desktopMenuMessages[locale] ?? desktopMenuMessages[DEFAULT_LOCALE];
  return messages[id];
}

export function formatDesktopMenuMessage(
  locale: Locale,
  id: DesktopMenuMessageId,
  values?: Record<string, string | number>,
): string {
  let message = getDesktopMenuMessage(locale, id);
  if (!values) {
    return message;
  }

  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value));
  }

  return message;
}
