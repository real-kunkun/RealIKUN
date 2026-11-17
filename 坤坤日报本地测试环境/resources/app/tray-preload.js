const { contextBridge, ipcRenderer } = require('electron');

// 托盘右键菜单面板的通道：只做「选了哪一项」和「关掉」，不碰任何数据。
contextBridge.exposeInMainWorld('trayMenu', {
  pick: (action) => ipcRenderer.send('tray-menu-action', action),
  close: () => ipcRenderer.send('tray-menu-close')
});
