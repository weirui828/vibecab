import { Menu } from "electron";

export function installApplicationMenu(options: {
  openSettings: () => void;
  newDraft: () => void;
  restoreBackup: () => void;
  openAtLogin: boolean;
  setOpenAtLogin: (enabled: boolean) => void;
  notifications: boolean;
  setNotifications: (enabled: boolean) => void;
  quit: () => void;
}): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "VibeCab",
        submenu: [
          { label: "About VibeCab", role: "about" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: options.openSettings },
          { type: "separator" },
          // What only the Mac app can do lives in its menu; the page has no way to ask for it.
          {
            label: "Open at Login",
            type: "checkbox",
            checked: options.openAtLogin,
            click: (item) => options.setOpenAtLogin(item.checked),
          },
          {
            label: "Notifications",
            type: "checkbox",
            checked: options.notifications,
            click: (item) => options.setNotifications(item.checked),
          },
          { type: "separator" },
          { label: "Quit", accelerator: "CmdOrCtrl+Q", click: options.quit },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "New Draft…", accelerator: "CmdOrCtrl+N", click: options.newDraft },
          { type: "separator" },
          { label: "Restore from Backup…", click: options.restoreBackup },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
      { label: "Help", submenu: [] },
    ]),
  );
}
