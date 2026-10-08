审查完成，发现 **2 处真实的取消/槽位释放与安全缺陷**：

### 1. 真实 Bug：客户端提前断开连接时，`legacyTransfer` 内部 Promise 会悬挂至 18 秒超时（取消失效与延迟槽位泄漏）

在 `legacyTransfer` 轮询等待 READY 的 `while` 循环中：

```
const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
```

当客户端在排队阶段（18s 内）提前中断 HTTP 连接时，触发 `reply.raw.once('close')` -> `connection.abort(new Error('ASSET_CONNECTION_CLOSED'))`。 然而 Node.js 规范中，`AbortSignal.abort(reason)` 抛出的 `signal.reason` 是普通 `Error` 对象；`reject(signal.reason)` 导致等待 Promise 被 reject。 **但在当前实现中**： 若 `signal.aborted` 在注册监听前已被触发（或微任务时序中 `signal.removeEventListener` 未匹配），或者 `abort` 回调仅从当前 step reject，外层 `while` 若没有捕获 `signal.reason` 直接重入，最关键的是：**如果队列阻塞，旧客户端在第 10 秒超时 abort，Node 底层触发 close 时，当前轮询若正好在 `setTimeout` 之间切换，事件监听器存在泄漏未清理隐患**。更严重的是，`done=await preparation.legacyTransfer(...)` 在抛出异常时会进入 `catch(error){done?.();throw error;}`，但如果 `legacyTransfer` 内的 `this.release(key,nonce)` 在 `try...catch` 内先执行，而 `reply.raw` 的 `release` 回调仍挂载在 `close` 事件上，导致一旦请求完成或报错后，`release` 会被重复调用，且 `done?.()` 此时为 `undefined`，虽然不会 crash，但掩盖了真实的连接中断原因。

### 2. 真实安全隐患：`RunnerAssetPolicy.cache` 存在异步并发缓存击穿与未校验状态污染

```
const cached=this.cache.get(hash);if(cached){...return cached;}
// 此处发生多次异步 I/O (this.read)
...
this.cache.set(hash,policy);
```

当 20 会话在没有预热的情况下并发请求同一旧版本的图片资源时，`this.cache.get(hash)` 均未命中。系统会发起多达 20 次并行的 `release.json` 读取、JSON 反序列化与 `digest` 计算。由于 2c4g 系统盘在 1Mbps 并发下 CPU 和 I/O 资源敏感，更严重的是如果此时文件句柄超限抛错，由于没有单飞保护（single-flight / in-flight promise 缓存），会同时向多个客户端返回 500。应当缓存 `Promise<'legacy'|'ticket'>` 而非仅仅完成值。

### 3. 升级与状态机验证

除上述两点外：

- 路由缺失三个头走 `legacy`，全带走 `ticket`，部分携带抛出异常分支正常；
- 归档版本契约 hash 严格匹配，fail-closed 机制有效；
- 静态资源解压协商中对于 `identity` 与非压缩 fallback 处理正确。

LEGACY_ASSET_REVIEW_COMPLETE
