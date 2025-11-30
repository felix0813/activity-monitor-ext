<!--
 * @Author: felix 1306332027@qq.com
 * @Date: 2025-11-30 11:41:39
 * @LastEditors: felix 1306332027@qq.com
 * @LastEditTime: 2025-11-30 11:41:43
 * @FilePath: \activity-monitor-ext\README.md
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
-->
# Activity Monitor (browser extension) — 简易版

## 功能

- 页面级事件采集（page_open/page_close/visibility_change/focus/blur）
- 活跃时长计算（active_period：ms）
- 低频用户操作统计（click/scroll/keydown）
- 本地缓存（IndexedDB），批量发送到本地 native host（若已安装）
- Popup：显示统计、手动 flush、导出 JSON 文件

## 安装（开发者/调试）

1. 将本项目文件夹放到本地（例如 `activity-monitor-ext/`）。
2. 打开 Chrome/Edge：`chrome://extensions/`（或 Edge 的扩展页）。
3. 开启“开发者模式” -> 点击“加载已解压的扩展” -> 选择项目文件夹。
4. 在任意网页打开控制台检查 `content_script` 的事件发送；在扩展详情页面打开 service worker 控制台查看 background 日志。

## 与桌面应用通讯（可选）

- background.js 中尝试连接 native host 名称 `com.example.activity_monitor`。如果你提供了 native host（按照 Chrome Native Messaging 规范注册），扩展会自动尝试连接并发送批量 payload（JSON）。
- 若未安装 native host，事件会一直保存在 IndexedDB，直到用户提供 native host 或手动导出。

## 隐私

- 不收集表单输入、密码、cookies。
- 点击事件不会收集元素 id 或输入文本。scroll 只收集页面滚动深度百分比。
- 若需要进一步减少数据量/敏感度，请在 content_script 中删减字段（例如移除 `url` 或 `title`）。

## 扩展改进建议

- 添加最大缓存上限 + 本地轮替清理策略。
- 支持 gzip 压缩批量数据再发送到 native host（native 端需解压）。
- 为生产环境实现域白名单与更严格权限说明、隐私政策页面。
