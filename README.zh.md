# dsh-restart-app

DeepSeek Harness 侧边栏底部的 **重启 DSH** 按钮。点一下，整个桌面应用（窗口外壳、
宿主进程、渲染进程、工具子进程）会被停掉并重新拉起，页面随后自动刷新进新实例。

面向打包版 **Windows 桌面应用**。其它宿主（`dsh web`、`dsh tui`、普通 Node 进程）里
按钮会自动隐藏：那里没有可重启的东西，浏览器会话也绝不该有杀掉自己终端的能力。

## 为什么做成插件

宿主卡住的时候刷新页面没用——会话、工具子进程、插件状态都在宿主里。手动重启要自己
找窗口、退出、等待、重开；而在 Windows 上只关掉其中一个 `DeepSeek Harness.exe`，
剩下的进程树会留在后台。

插件从应用内部重启，因此能精确地停掉这个应用的**每一个**进程，而不碰别的。

## 安装

```powershell
dsh plugin --profile desktop add dsh-restart-app
```

然后**重启一次应用**让 profile 加载插件。之后按钮就出现在侧边栏底部、设置齿轮旁边。

从本地目录安装：

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-restart-app
```

卸载：

```powershell
dsh plugin --profile desktop remove dsh-restart-app
```

## 点一下发生了什么

1. `POST /dsh-restart-app/restart` → 宿主立刻回 `202`。
2. 宿主在 `%TEMP%\dsh-restart-app\<时间戳>\` 写下两个 PowerShell 脚本并启动 *stage*。
3. stage 用 `Start-Process` 拉起真正的 helper 后立即退出，于是应用被停掉时，helper
   在应用的进程树里已经没有活着的祖先。
4. helper 先等 900 ms（够 HTTP 响应刷出去），然后停掉所有「镜像名等于应用」或
   「可执行文件在应用目录下」的进程，等进程表清空，再用 `Start-Process` 拉起可执行文件。
5. 5 秒后记录新实例是否还活着，然后退出。
6. 页面每秒轮询一次自己的源，服务器重新应答后自动刷新。

出问题时先看 helper 日志：

```
%TEMP%\dsh-restart-app\<时间戳>\helper.log
```

```
2026-10-23T17:59:01.7560041+08:00 helper start pid=21416
2026-10-23T17:59:03.0707319+08:00 stopping 1 application process(es): 25428
2026-10-23T17:59:03.3103882+08:00 application processes are gone
2026-10-23T17:59:03.8181757+08:00 relaunching C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe
2026-10-23T17:59:03.9243984+08:00 relaunched pid=24200
2026-10-23T17:59:08.9546037+08:00 relaunched application is alive after 5s (pid=24200)
2026-10-23T17:59:08.9556013+08:00 helper done
```

## Windows 上真正难的两件事

**活过这次 kill。** helper 不能是宿主的子进程，否则停宿主进程树时会连它一起停。
Node 的 `detached: true` 和 `stdio: 'ignore'` 在这台机器上都会让子进程立刻被回收
（exit 0，什么都没做）。可行的是：普通子进程 `Start-Process` 拉起 helper 后立刻退出——
父进程已经不在的 helper 不属于任何人的进程树。

**继承一份能用的环境。** 重启出来的应用必须带着用户启动它时的环境。插件的第一版把
环境写进 JSON 再由 PowerShell 重建，这是个坑：PowerShell 5.1 会把无 BOM 的文件按
ANSI 代码页解码，`PATH` 里的中文目录要么变成乱码，要么让 `ConvertFrom-Json` 直接抛错
——而这时 `EnvironmentVariables.Clear()` 已经执行，应用于是拿到**空环境**。没有
`TEMP`，Electron 外壳就会用 `os.tmpdir()` 去解析自己的原生插件缓存，而那个值此时是
字面相对路径 `undefined\temp`，宿主还没就绪就死了：

```
dsh: host preparation failed: No usable native binding found for
node-addon-require-builtin-win32-x64-msvc (auto)
```

所以 helper 从不复制环境：它本来就有（宿主 → helper），它只做一件事——删掉两个会让
外壳变成 Node 运行时的标记（`ELECTRON_RUN_AS_NODE`、`DSH_DESKTOP_NODE_EXECUTABLE`）。
另外它还带一个 `TEMP` 兜底，因为就是这一个变量的缺失，决定了应用能用还是弹崩溃框。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半边：两条路由，以及启动 stage。 |
| `scripts.js` | `restart.ps1` / `stage.ps1` 的文本与桌面判定——纯函数，无 `ctx`、无 I/O。 |
| `client.js` | 客户端半边：侧边栏控件、状态机、字典。 |
| `cordis.patch.yml` | 把插件插进 profile 的 bundle patch。 |
| `locale/*.json` | 只有插件管理器元数据；运行时字符串在 `client.js` 里。 |
| `test/render.mjs` | 对生成脚本的零依赖断言。 |

```powershell
node test/render.mjs
```

## 环境要求

- Windows 10/11，打包版 DeepSeek Harness 桌面应用。
- PowerShell 5.1（所有受支持的 Windows 都有）。
- 宿主侧需要 Node 20+。

## 许可

MIT
