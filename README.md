# 坤坤日报

摸鱼搞出的个人桌面工作台，欢迎各位大佬提供脑洞一起完善。我是真IKUN，不是小黑子！！！

## 模块
个人计划 / 工作日报 / 阅读打卡 / 每日锻炼 / 记账本 / 心情日记 / 灵感墙
个人计划与阶段目标支持历史档案。

## 使用
1. 到 Releases 下载最新 .7z 压缩包
2. 解压到任意文件夹（不要解压到系统目录）
3. 双击 坤坤日报/坤坤日报.exe
首次启动在本地生成数据文件，数据只存在自己电脑上。

## 环境要求
Windows 10 / 11（64 位），解压即用，无需安装任何运行环境。

## 源码与构建

源码在 `坤坤日报本地测试环境/resources/app/`，一个 Electron 应用：

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：窗口、托盘、久坐提醒、更新器、音乐目录 |
| `app.js` / `style.css` / `index.html` | 界面与交互 |
| `data-layer.js` | 数据结构、版本迁移、字段归一化 |
| `update-check.js` | 更新检测（三通道并发）与下载 |
| `holidays.js` / `lunar.js` | 法定节假日、农历（离线数据，不联网） |
| `weather.js` | 本地天气（wttr.in） |
| `preload.js` / `tray-preload.js` | 渲染层与主进程之间的桥 |

打包：`node _pack.js`，产物写到 `dist/`（依赖随包的 `resources/app/7zr.exe`）。

版本号：产品版本在 `resources/app/package.json` 的 `version`；数据层版本是 `data-layer.js` 里的 `SCHEMA_VERSION`，是数据迁移锁，两者不是一回事。

## 许可证
MIT © 2026 BiliBili我错哪了我

