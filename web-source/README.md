# 课表应用 —— 网页源码与测试

课表应用（纯前端单文件应用）的开发源码，以及配套的端到端测试。

> **仓库根目录是 Android 打包工程**（Capacitor 外壳）。它里面的 `www/` 是这份源码的
> 打包副本，由 `sync-web.mjs` 按白名单复制过去。
> **改代码请改这里，不要改 `www/`** —— 那边的改动下次同步就会被覆盖。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | **应用本体**。全部 HTML / CSS / JS 都在这一个文件里（约 2300 行） |
| `manifest.json` | PWA 清单 |
| `sw.js` | Service Worker。仅浏览器环境注册，APK 里会跳过 |
| `preset-yin.json` | 预置课表（殷志峰 · 2026-2027-1 学期，16 门课 / 20 周） |
| `icon-192.png` `icon-512.png` `icon-maskable-512.png` | 应用图标 |
| `make_icons.py` | 图标生成器。纯标准库（zlib + struct）手写 PNG，不依赖 Pillow |
| `e2e-focus.js` | 测试：点课表块 → 定位高亮对应课次（20 项） |
| `e2e-import.js` | 测试：课表导入器（34 项） |
| `e2e-native-bridge.js` | 测试：原生桥接层在浏览器里的降级行为（11 项） |
| `e2e-native-runtime.js` | 测试：原生通知 / 文件导出 / 返回键（用 Capacitor 桩，30 项） |
| `shot-focus.js` | 截图脚本 |
| `preview/` | 界面截图 |

## 跑测试

测试用 **CDP 直连 headless Edge**，不需要装 puppeteer / playwright。

```bash
# 起本地服务。测试脚本把端口写死了，必须对应：
python -m http.server 8123    # e2e-focus / e2e-native-bridge / e2e-native-runtime 用
python -m http.server 8124    # e2e-import 用

# 另开一个终端
node e2e-import.js
node e2e-focus.js
node e2e-native-bridge.js
node e2e-native-runtime.js
```

环境要求：**Node 22**（用到内置全局 `WebSocket` 和 `fetch`）+ **Microsoft Edge**。

> 端口不一致时测试会全挂，且报错是 `Cannot read properties of undefined (reading 'length')`
> —— 看起来像代码回归，其实是页面没加载出来。跑之前先确认端口。

## 关键设计

- **单文件应用**：没有构建步骤，`index.html` 双击就能跑
- **数据存 localStorage**（key `kb_schedule_v1`），字段结构见 `index.html` 顶部注释
- **单双周**：`session.parity`（`0`=每周 / `1`=单周 / `2`=双周`）
- **大节制**：`settings.sections[].label` 支持 `"1-2"` 这类自定义标签
- **提醒双通道**：浏览器走页面内 Notification + 导出 `.ics` 导入系统日历；
  APK 里走 `@capacitor/local-notifications`，一次性预排未来 4 周闹钟
- **课表导入**：支持 JSON（自家备份 / 中文别名 / 英文表头）、CSV、TSV、粘贴文本。
  认不出的格式**返回失败而不是瞎猜**
