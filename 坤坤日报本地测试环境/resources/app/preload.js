const { contextBridge, ipcRenderer } = require('electron');

// 渲染层唯一的数据/系统通道。3.0.0 起不再有主题、导出接口；
// 久坐提醒在 3.0.1 重新补回，通道见下方 standup*。
contextBridge.exposeInMainWorld('todoAPI', {
  // 应用版本号（唯一来源 package.json）
  appVersion: (() => { try { return ipcRenderer.sendSync('boot-version'); } catch (e) { return ''; } })(),

  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  resetData: () => ipcRenderer.invoke('reset-data'),

  // 无边框自绘窗口：拖拽 / 最大化切换 / 贴边分屏 / 最小化 / 关闭
  winControl: (action, payload) => ipcRenderer.invoke('win-control', action, payload),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),

  // 久坐提醒：配置写在 settings.standup（走 saveData），这里只管状态查询与用户响应
  standupGet: () => ipcRenderer.invoke('standup-get'),
  standupRespond: (kind) => ipcRenderer.invoke('standup-respond', kind),
  onStandUpState: (callback) => ipcRenderer.on('standup-state', (e, payload) => callback(payload)),
  onStandUpShow: (callback) => ipcRenderer.on('show-standup', (e, payload) => callback(payload)),

  // 提醒音乐：列表来自 exe 旁边的 music 文件夹（拖进去就出现），
  // 也可以用系统选文件框加歌（music-add 负责复制进那个目录），music-open 打开文件夹
  audioList: () => ipcRenderer.invoke('audio-list'),

  // 本地天气（只看不用管）：拿不到返回 null，界面自己隐藏
  weatherGet: (force) => ipcRenderer.invoke('weather-get', force),
  musicAdd: (paths) => ipcRenderer.invoke('music-add', paths),
  musicOpen: () => ipcRenderer.invoke('music-open'),

  // 升级检测：手动检查 / 打开外链 / 下载安装包并覆盖更新 / 「先不更新」记住版本
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  startUpdate: () => ipcRenderer.invoke('one-click-update'),
  skipUpdate: (version) => ipcRenderer.invoke('skip-update', version),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (e, payload) => callback(payload)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (e, payload) => callback(payload))
});
