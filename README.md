# 我的课表 · Android 应用

把 `../class-schedule` 里那份网页课表打包成能装到手机上的 APK。

用 [Capacitor](https://capacitorjs.com/) 做外壳：网页代码原样塞进 Android 的 WebView，
外面套一层原生容器。好处是**同一份代码维护两处**（网页 + App），不用重写。

---

## 为什么走这条路

这台机器上**没有 JDK、没有 Android SDK、没有 Gradle、没有 Flutter**，只有 Node 和 Python。
所以本地直接 `gradlew assembleDebug` 是不可能的。

| 方案 | 结论 |
|---|---|
| Capacitor + 云构建 | ✅ 采用。APK 由 GitHub 服务器编译，本机什么都不用装 |
| PWABuilder（TWA） | ❌ 依赖 Chrome 内核，国内机型兼容性差，且必须联网 |
| Flutter / 原生重写 | ❌ 等于把课表逻辑重写一遍，且本机同样没有工具链 |
| iOS | ❌ 必须在 macOS 上用 Xcode 构建，Windows 做不到 |

---

## 路线 A：云构建（推荐，不用装任何东西）

### 1. 推到 GitHub

在 GitHub 上新建一个**空仓库**（不要勾选 README/gitignore），然后：

```bash
cd class-schedule-mobile
git init
git add .
git commit -m "课表 Android 应用"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

### 2. 等构建完成

推送后 `.github/workflows/build-apk.yml` 会自动触发。到仓库的 **Actions** 页看进度，
大约 4–8 分钟（第一次要下载 Gradle 和 Android SDK，会慢一些）。

> **工作流里为什么有 `npm ci` 和 `npx cap sync android` 两步？**
>
> 不能直接跑 `gradlew`。Capacitor 生成的 `android/.gitignore` 把这几样排除在版本控制之外：
> `app/src/main/assets/public/`（**网页本体**）、`capacitor.plugins.json`（插件注册表）、
> `capacitor.config.json`、`capacitor-cordova-android-plugins/`。
>
> 同时 `android/capacitor.settings.gradle` 把插件模块指向 `../node_modules/@capacitor/*/android`，
> 所以 `node_modules` 在编译时必须存在。
>
> 少了这两步的结果是：Gradle 找不到插件模块直接报错；就算侥幸编过，APK 里也是**空白页**——
> 因为网页资源根本没被打进去。这是 Capacitor 项目在 CI 上最容易踩的坑。

### 3. 下载 APK

构建成功后，进那次运行的页面，最下方 **Artifacts** 里下载 `课表-调试版-apk`，
解压得到 `app-debug.apk`。

### 4. 装到手机

把 APK 传到手机（微信/数据线/网盘都行），点击安装。
首次安装系统会提示「不允许安装未知来源应用」，按提示到设置里允许即可。

> 调试版 APK 用的是 Android 默认调试签名，**能正常安装使用**，只是不能上架应用商店。
> 要上架或需要固定签名，见下面「正式版签名」。

---

## 路线 B：本地构建

需要一次性安装 [Android Studio](https://developer.android.com/studio)
（约 4 GB，含 JDK 21 + Android SDK 36 + Gradle）。装完后：

```bash
cd class-schedule-mobile
npm install
npm run sync          # 同步网页 + 原生插件
npx cap open android  # 用 Android Studio 打开
```

然后在 Android Studio 里 **Build → Build Bundle(s) / APK(s) → Build APK(s)**。
产物在 `android/app/build/outputs/apk/debug/`。

命令行也行（需已配好 `JAVA_HOME` 和 `ANDROID_HOME`）：

```bash
npm run build:apk
```

---

## 改完网页之后

`www/` 是从 `../class-schedule` **复制**过来的，不要手改 `www/`，会被覆盖。
改完源目录的 `index.html` 后：

```bash
npm run sync      # = sync-web.mjs（复制网页） + cap sync android（同步到原生工程）
```

`sync-web.mjs` 用的是**白名单**，只复制 `index.html` / `manifest.json` / `sw.js` /
`preset-yin.json` / 三个图标。源目录里的验证脚本（`e2e-*.js`）、截图（`preview/`）、
图标生成器都不会被打进 APK。

改完记得重新提交 `www/` 和 `android/`，否则云端构建出来的还是旧版。

---

## 图标

图标是**代码生成**的，不是位图缩放 —— 用有符号距离场解析式渲染，任何尺寸都直接算，
放大到 432px 也不糊。要改样式就改 `make-android-icons.py` 里的颜色常量，然后：

```bash
python make-android-icons.py     # 出全套 20 张 + 2 个 XML
python icon-check.py             # 生成 icon-check.png 对比图，肉眼验收
```

产出：

| 文件 | 用途 |
|---|---|
| `mipmap-*/ic_launcher.png` | 传统方形图标（圆角已烘焙进图里） |
| `mipmap-*/ic_launcher_round.png` | 传统圆形图标 |
| `mipmap-*/ic_launcher_foreground.png` | 自适应图标前景层（透明底，缩到 62% 落在安全区内） |
| `drawable/ic_launcher_background.xml` | 自适应图标背景层（XML 渐变，不用换图） |
| `drawable-*/ic_stat_icon.png` | 通知栏单色图标（白色剪影，Android 只取 alpha） |

### 启动图

Capacitor 模板自带 11 张启动图，内容是它自己的 logo —— 用户一打开 App 就会看到，必须换掉。

```bash
python make-android-splash.py     # 覆盖 drawable*/splash.png 共 11 张
```

尺寸严格对应模板原本的尺寸（`drawable/splash.png` 480×320、`port-*` 320×480 起、
`land-*` 480×320 起），换尺寸会导致系统拉伸变形。

启动图是「品牌渐变底 + 居中图标」，和 App 顶部标题栏同色系，开屏到进入界面不会有跳色。
最大一张 1920×1280 也是解析式直接算出来的，不是把小图拉大。

---

## 正式版签名

`android/app/build.gradle` 已经改成：**只要 `android/keystore.properties` 存在就自动签名**，
不存在就跳过（所以没配密钥也能正常出调试版）。

生成密钥：

```bash
keytool -genkey -v -keystore release.keystore -alias kbschedule \
        -keyalg RSA -keysize 2048 -validity 10000
```

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 里加四个 Secret：

| Secret | 值 |
|---|---|
| `KEYSTORE_BASE64` | `base64 -w0 release.keystore` 的输出 |
| `KEYSTORE_PASSWORD` | 密钥库密码 |
| `KEY_ALIAS` | `kbschedule` |
| `KEY_PASSWORD` | 密钥密码 |

配好后再推一次，除了调试版还会多出 `课表-正式版-apk`。

> **密钥丢了就再也无法给同一个应用发更新**，务必单独备份。
> `*.keystore` 和 `keystore.properties` 已在 `.gitignore` 里，不会进仓库。

---

## 原生适配了什么

网页版和 App 版的运行环境差别是硬性的，这些地方做了分支处理（都在 `index.html` 里，
用能力探测区分，浏览器路径完全不受影响）：

| 问题 | 处理 |
|---|---|
| **APK 里没有 URL 参数，预置课表不会自动载入** | 原生环境首次启动且本地无课时，自动载入 `preset-yin.json` |
| Android WebView **没有** Web Notification API | 改走 `@capacitor/local-notifications`，注册成系统闹钟 |
| `setTimeout` 会随进程被杀而失效 | 原生下一次性预排**未来 4 周**的闹钟，App 关掉也照响 |
| `<a download>` 对 `blob:` URL 无效 | 写进应用缓存再调系统分享，可选存文件/导入日历/发微信 |
| Service Worker 在本地资源下只会缓存旧版本 | 原生环境跳过注册 |
| 按返回键直接退出应用 | 改成：关弹窗 → 回课表页 → 才退出 |
| 状态栏压住标题栏 | 状态栏设成实心同色条 + 浅色图标，不依赖 `env(safe-area-inset-top)`（Android WebView 里它常是 0） |

### 预置课表怎么改

网页版靠 URL 参数 `?preset=yin` 触发载入；**APK 里 WebView 加载的是 `https://localhost/`，
没有查询参数**，所以改成由 `index.html` 里的常量指定：

```js
const NATIVE_DEFAULT_PRESET = "yin";   // 对应 www/preset-yin.json
```

只在**本地一门课都没有**时才载入，不会覆盖用户自己录的课表。不想预置就设成 `""`。

换课表：把新的 `preset-xxx.json` 放进 `../class-schedule/`，加进 `sync-web.mjs` 的白名单，
改这个常量，然后 `npm run sync`。

`AndroidManifest.xml` 里加了四个权限：`POST_NOTIFICATIONS`（Android 13+ 弹通知必须申请）、
`SCHEDULE_EXACT_ALARM`（精确到分钟的闹钟）、`USE_EXACT_ALARM`、`RECEIVE_BOOT_COMPLETED`（重启后重新注册）。

---

## 验证状态

三套自动化测试共 **61 项断言，全部通过**，零运行时异常。跑法：

```bash
cd ../class-schedule
python -m http.server 8123 --bind 127.0.0.1 &     # 起本地服务
node e2e-focus.js            # 20 项 —— 点课表定位高亮
node e2e-native-bridge.js    # 11 项 —— 桥接层在浏览器里必须完全惰性
node e2e-native-runtime.js   # 30 项 —— 注入 Capacitor 桩，真跑原生代码路径
```

第三套是关键：它用 CDP 在页面脚本执行**之前**注入一个假的 `window.Capacitor`，
把每次插件调用记进数组，然后逐条核对参数。这样「原生路径无法验证」变成了可断言：

- 通知真的通过 `LocalNotifications.schedule` 注册（不是走 `setTimeout`）
- 63 条通知全部在未来、id 无重复、跨度 26 天（4 周预排）
- **单双周正确**：思法周四只排奇数周、思法周二（每周课）不受影响、数字素养周四只排偶数周
- 通知带 `ic_stat_icon` 小图标和 `class-reminder` 渠道
- 重新调度前会先 `cancel` 掉旧的 2 条待处理闹钟
- 导出走 `Filesystem.writeFile`（CACHE 目录）+ `Share.share`，不再走 `<a download>`
- 返回键三级行为：关弹窗 → 回课表页 → 才退出
- 状态栏 `overlay:false` + 同色背景 + `DARK` 样式
- 原生环境不注册 Service Worker

**已验证（本地实测）**

- 上述 61 项断言
- **CI 关键路径**：删光被 `.gitignore` 排除的产物后，`cap sync android` 能全部重建
- `package-lock.json` 与 `package.json` 同步（lockfileVersion 3，8 个依赖齐全）→ `npm ci` 不会失败
- 工程结构一致性：插件注册表、Gradle 模块引用、包名、无残留引用
- 图标 20 张 + 启动图 11 张肉眼验收（`icon-check.png`）
- 工作流 YAML 解析 + 步骤顺序（`cap sync` 在 `gradlew` 之前）

**未执行**

- **APK 实际编译**。本机无 JDK / Android SDK / Gradle，且实测 curl 只能访问 localhost 和部署域名 ——
  JDK 与 Android SDK 根本下载不下来，`gradlew assembleDebug` 无法运行。
  首次云构建可能暴露 Gradle 或依赖问题，按报错调即可。
- **实机行为**：通知能否按时弹出、分享面板能否导入日历、返回键手感。
  桩能证明「调对了 API、传对了参数」，但证明不了「系统真的弹了通知」。
- 部分国产 ROM 的自启动/电池优化需要用户手动设置，这一点无法通过任何测试覆盖。

---

## 已知限制

- **首次装完要先给通知权限**。Android 13+ 不授权的话，系统会静默丢掉所有通知 —— 表面上「提醒开了」但一条都不会响。
- 部分国产 ROM（小米/华为/OPPO/vivo）有「自启动管理」和「电池优化」，会杀掉后台闹钟。
  需要在系统设置里给这个应用开**自启动**并**关闭电池优化**，否则提醒可能不准时。
  这是所有 Android 提醒类应用的共同问题，不是这个应用特有的。
- `USE_EXACT_ALARM` 在 Google Play 上架时会受政策审查（仅限闹钟/日历类应用）。
  不上架的话不用管；要上架就删掉这一条，只留 `SCHEDULE_EXACT_ALARM` 并引导用户手动授权。
- 最小支持 **Android 7.0**（minSdk 24），目标 **Android 16**（targetSdk 36）。
