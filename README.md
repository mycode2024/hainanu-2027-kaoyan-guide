# 海南大学 2027 计算机 408 考研导航

这是一个带本地 Node.js 后端的备考导航成品。时间轴、报名流程和材料清单可离线使用；启动服务后，“官方动态”面板会自动读取海南大学与研招网的官方招生通知。

## 最简单的启动方式

1. 电脑需安装 Node.js 18 或更高版本。
2. 双击桌面的 `海南大学2027考研导航.cmd`，或项目内的 `start-guide.cmd`。
3. 浏览器会自动打开 `http://127.0.0.1:4173`。
4. 服务在后台运行；需要停止时双击桌面的 `停止海南大学考研导航.cmd`，或项目内的 `stop-guide.cmd`。

启动器会先确认本地 API 与静态页面已经可访问，再打开浏览器；官方来源暂时离线时，本地页面仍会启动，并用 `ready: false` 诚实表示尚无可信通知缓存。如果启动失败，会直接显示原因并把日志写入 `data/`，不会再提前打开一个“连接被拒绝”的页面。重复双击或同时启动是安全的：同一项目和端口只会创建一个由启动器管理的服务，其他启动调用会在服务存活后成功返回。浏览器打开失败只会显示警告，已经启动的服务会继续运行，可手动访问上面的地址。

也可以在本目录打开终端后运行：

```powershell
npm start
```

然后访问 `http://127.0.0.1:4173`。

本项目没有第三方运行依赖，不需要先执行 `npm install`。

`start-guide.cmd` / `stop-guide.cmd` 是推荐的安全启停方式。启动与停止会通过同一项目、同一端口的 Windows 全局互斥锁串行执行，在不同登录会话中同时操作也不会交叉覆盖 PID。停止器只会停止 PID 文件所指向、且实际入口脚本精确属于本项目 `server.cjs` 的 Node 进程；仅仅把 `server.cjs` 路径放在其他脚本的普通参数中不会被误认。它最多等待 10 秒并确认健康接口已经不可用，之后才删除 PID。查询或终止失败时会保留 PID 并报错，请根据提示排查，不要手工结束不确定归属的进程或随意删除 launcher PID 文件。

需要临时使用其他端口时，启动和停止必须传入同一个端口，例如：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Port 49152 -NoBrowser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1 -Port 49152
```

默认端口 4173 为兼容既有安装继续使用 `data/server.pid`；其他端口各自使用 `data/server-<端口>.pid`（上例为 `data/server-49152.pid`），因此可并行管理。启动与停止必须使用完全相同的 `-Port`，脚本不会回退到 4173。

直接运行 `npm start` 时服务在前台，使用 `Ctrl+C` 停止；这种方式不创建 launcher PID，不应再用 `stop-guide.cmd` 代替 `Ctrl+C`。

## 数据会怎样更新

- 服务启动后立即尝试同步一次。
- 后台每 1 小时自动检查一次官方列表；瞬时网络失败会在 750 毫秒后重试一次。
- 网页每 1 分钟读取一次后台快照；读取时若发现同步已到期，会无阻塞地补触发检查。
- 点击“立即同步”可手动检查；为防止其他网页滥用本机接口，手动请求之间默认至少间隔 10 秒。
- 成功结果写入 `data/updates-cache.json`；写入主缓存时会保留上一份可用备份，主缓存损坏或读取失败时会自动回退备份。
- 某个官网临时不可访问时，页面会标明缓存状态并保留最近一次成功内容，不会清空通知。
- 新鲜度按来源分别计算：每个官网保留自己的最近成功时间，一个来源成功不会掩盖另一个来源已经逾期或失败。距该来源上次成功同步超过 2 小时会明确标记“已逾期”。再次访问时，新发现的通知会显示“新公告”。

当前监控的官方来源：

- 海南大学研究生院“硕士生招生”：<https://gs.hainanu.edu.cn/yjszs/ssszs.htm>
- 海南大学研究生院首页（报考点、网上确认等短期公告）：<https://gs.hainanu.edu.cn/>
- 海南大学计算机科学与技术学院“研究生招生”：<https://cs.hainanu.edu.cn/zsgz/yjszs.htm>
- 研招网“教育部研究生招生政策”：<https://yz.chsi.com.cn/kyzx/jybzc/>

自动更新依赖本机服务保持运行，也依赖各官网可访问。电脑关机时本地服务无法抓取，下一次启动会立即补查。它只负责发现列表中的新通知；报名日期、专业代码、考试科目等重要决定仍需点击通知并核对官方原文。

## 日志与排障

后台服务的标准输出和错误输出分别写入 `data/server-*.log` 与 `data/server-*.error.log`。启动器按成对日志管理，只保留最新 14 对，旧日志会自动清理。启动失败时先查看终端提示和最新的 `.error.log`；停止失败时保留 PID 是安全保护，表示脚本没有确认服务已经完整退出。

## 自检

```powershell
npm run check
```

自检会检查 JavaScript 语法，并运行抓取、缓存、API、静态页面和前端数据处理测试。

## 本地接口

- `GET /api/health`：启动器使用的产品身份与存活检查。`live` 表示本地进程和页面可用；只有存在可信的 fresh/stale 通知数据时 `ready` 才为 `true`。
- `GET /api/updates`：读取当前快照。
- `POST /api/refresh`：立即抓取官方列表并返回新快照；仅接受 Host 与 Origin 都精确指向当前 `127.0.0.1` 端口、且携带 `X-HNU-Guide-Request: 1` 的请求。缺少 Origin、端口不一致或疑似 DNS rebinding 的请求都会被拒绝；冷却期内返回 `429` 与有界 `Retry-After`。

在默认端口从 PowerShell 手动调用的示例：

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4173/api/refresh' -Headers @{ 'X-HNU-Guide-Request' = '1'; Origin = 'http://127.0.0.1:4173' }
```

使用自定义端口时，URI 与 `Origin` 中的端口必须同时改成该端口。

服务只监听 `127.0.0.1`，不会默认暴露到局域网或互联网。
