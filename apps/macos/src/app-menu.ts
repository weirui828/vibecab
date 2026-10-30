import { Menu } from "electron";

export function installApplicationMenu(options: {
  openSettings: () => void;
  newDraft: () => void;
  importMarkdown: () => void;
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
          { label: "Quit", accelerator: "CmdOrCtrl+Q", click: options.quit },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "New draft", accelerator: "CmdOrCtrl+N", click: options.newDraft },
          { label: "Import Markdown…", click: options.importMarkdown },
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
      { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
      { label: "Help", submenu: [] },
    ]),
  );
}
