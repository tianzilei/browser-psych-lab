Gemini 说

本次审计聚焦真实交互链路中可触发的缺陷，涵盖输入法与软键盘、滑动/触摸并发、页面恢复与重试、异步竞争、焦点管理与事件监听器泄漏。

缺陷 1：诊断屏幕采样体积超出底层事件存储上限（致命崩溃 EVENT_BUDGET_EXCEEDED）

触发步骤：

问卷页面包含较长指导语、多道题目或量表（DOM 节点及文本子节点总数达到 250~300 个以上）。

参与者进行任何点击、输入或按键，interaction-recorder.ts 调度 screen() 进行 DOM 快照采样。

采样提取所有子节点的 14 项计算样式、文字与包围盒；单次采样序列化体积达到 130KB 以上。

批次经 flush() 传递给 api.ledger.interaction(batch)，进而调用 ledger.append。

准确文件和函数：

src/web/interaction-recorder.ts 中的 screen() 与 add()

src/web/ledger.ts 中的 append()

src/web/participant.ts / src/web/run.ts 中的 recordInteractions(..., recovery/stop)

影响：ledger.ts 硬编码了事件体积校验：if(bytes.length > 128*1024) throw new Error('EVENT_BUDGET_EXCEEDED')。由于 interaction-recorder.ts 的节点截断阈值为 1900 个节点且样式冗长，序列化后的快照极易单包超标，直接抛出 EVENT_BUDGET_EXCEEDED 并触发 recovery() 或任务 stop()，导致正在作答或运行的被试页面直接崩溃。

最小补丁建议：
在 interaction-recorder.ts 的 screen() 遍历中增加字节预算上限（如累积 JSON 预估长度超 80KB 时立即截断），或对 style 过滤仅记录非默认/非继承的关键布局属性，确保单条诊断事件尺寸严格受限于 96KB 以内。

回归场景：配置包含 10 个选项的多选或多维度量表页面，在页面上快速点击选项并检查 IndexedDB events 存储是否抛出异常。

不确定性：后端分析消费端对离线 INPUT_DIAGNOSTIC 中 styles 字段完整度的依赖程度。

缺陷 2：量表滑块拖动与快速输入高频并发压垮本地事务预算队列（LOCAL_QUEUE_BUDGET_EXCEEDED）

触发步骤：

参与者在手机触摸屏上按住并拖动 scaleInput 量表滑块，浏览器以 60Hz 频率触发原生的 input 事件。

scale-input.ts 中的 range.addEventListener('input', () => commit(Number(range.value))) 高频执行。

每次 commit 调用 save -> revision -> api.ledger.append(page.id, 'PAGE_REVISION', ...)。

底层 IndexedDB 事务配置为 {durability: 'strict'}，单次落盘需要 5~30ms；内存排队数 this.queued 迅速累加至 64。

准确文件和函数：

src/web/scale-input.ts 中的 scaleInput()

src/web/survey-page.ts 中的 save()

src/web/ledger.ts 中的 serialized()

影响：ledger.ts 命中 if(this.queued >= 64) { this.failure = new Error('LOCAL_QUEUE_BUDGET_EXCEEDED'); return Promise.reject(this.failure); }。不仅当前修改丢失，而且 this.failure 被固化在 Promise 链条上，直接触发 recovery(error) 将页面踢入“保存未完成”的恢复界面。

最小补丁建议：
在 scale-input.ts 中分离展示与持久化：拖动过程中的 input 事件仅执行 sync(value) 更新本地界面展示与 answers 字典；仅在 change 事件、pointerup 或加入 150ms trailing 防抖后再触发 save(value) 提交 PAGE_REVISION。

回归场景：在低端移动设备上快速往复拖拽量表滑块 2 秒，验证页面不报错且最终选择值正确落盘。

不确定性：用户在快速拖动后极短时间内（<150ms）直接点击“下一题”时，需确保 forward() 能立即刷新尚未落盘的防抖值。

缺陷 3：评分任务年龄输入行软键盘/按钮切换时误判视口变更（致命中断 VISUAL_VIEWPORT_CHANGED）

触发步骤：

自步调评分任务进入年龄录入阶段（question === items）。

被试点击屏幕上的虚拟数字键盘按钮（例如按键“2”）。

焦点自 age 输入框转移至数字按键 <button>，此时 document.activeElement !== age。

移动端因软键盘收起、地址栏缩放或按键点击触发 visualViewport.onresize 或 onscroll。

准确文件和函数：

src/web/rating-run.ts 中的 typing()、visualChange()、change()

影响：visualChange() 执行 if(!typing()) void stop('VISUAL_VIEWPORT_CHANGED')。由于被试刚才点击了虚拟键盘按钮，document.activeElement 是按钮而非 age，导致 typing() 返回 false。系统误判为违规视口篡改，直接触发 stop('VISUAL_VIEWPORT_CHANGED')，以 SOFTWARE_RUN_INTERRUPTED 状态强行终止本组任务。

最小补丁建议：
放宽 rating-run.ts 的 typing 判定范围：当处于年龄阶段时，只要焦点位于年龄录入容器内均属于输入态：

TypeScript
const typing = () => phase === 'rating' && question === items && (document.activeElement === age || !!ageRow?.contains(document.activeElement));


回归场景：在移动端浏览器（iOS Safari / Android Chrome）进入评分年龄输入页，使用屏幕按键连续输入两位数年龄并观察地址栏动态缩放是否导致中断。

不确定性：无；源码判定逻辑明确存在对 activeElement === age 的单一限制。

缺陷 4：任务结束保存异常时残留全局指针监听器，点击“重试”反遭会话销毁

触发步骤：

行为实验组完成所有试次，run.ts 进入 finish()。

finish() 执行 remove(true)（保留了全局输入监听以捕获尾部诊断），随后发起 api.seal(plan.scope)。

若遭遇偶发网络超时或 503 错误，进入 catch(error) 分支，渲染包含“重试保存”按钮的恢复界面。

catch 分支未执行 remove()，window 上的 pointerdown / pointerup / keydown 监听器仍然活跃。

被试点击“重试保存”按钮。

准确文件和函数：

src/web/run.ts 中的 finish() 与 input()

影响：被试点击界面的瞬间，全局 pointerdown 优先捕获该事件。input(r) 检查到 closing === true，触发 a.ledger.append('d-...', 'INPUT_DIAGNOSTIC').catch(stop)。一旦此时存储链仍处于繁忙失败态，stop() 被唤醒并向服务端发送 terminate('SOFTWARE_RUN_INTERRUPTED')，将原本已经正常答完的数据强行标记为软件异常中断。

最小补丁建议：
在 run.ts 的 finish() 的 catch 块开头显式调用 remove() 清理输入监听器，避免恢复界面的交互被作为实验输入捕获：

TypeScript
} catch(error) {
  remove();
  if(stopped) return;
  ...


回归场景：在 DevTools Network 中屏蔽 /seal 请求，完成最后一轮呈现，验证在弹出的重试界面点击按钮不会触发 input() 或意外 terminate。

不确定性：若被试在重试界面直接按 Enter 键触发按钮，亦会命中同样的全局按键拦截。

缺陷 5：个人信息输入框失焦后未脱离 typing 模式，导致题干与元信息永久不可见

触发步骤：

问卷进行到文本输入题（个人信息题）。

被试点击输入框，focus 触发 editing = true 并为 document.body 添加 typing 类（CSS 将题干、顶部标题与说明全部 visibility: hidden 或 display: none）。

被试点击空白区域或收起输入法以重新阅读题目，输入框触发 blur。

准确文件和函数：

src/web/survey-page.ts 中的 input()、render()

src/web/participant.css 中的 body.typing

影响：input 的 blur 仅绑定了 requestResize，没有清除 editing = false（原意是防止点击“完成输入”按钮瞬间发生几何跳动）。然而在 render() 中：

TypeScript
if (q?.type === 'text' && editing) { navigation(); return; }


因为 editing 始终为 true，render() 直接跳过渲染。页面被永久定格在输入法极简布局中，被试无法看到题干文字、标题与进度，且前进按钮持续显示为“完成输入”，造成交互卡死假象。

最小补丁建议：
在 survey-page.ts 中，检测到失焦且焦点没有转移到 next 按钮时（或被试点击空白/非提交区域后），重置 editing = false 并移除 typing 类，触发 render() 恢复原题干排版。

回归场景：进入文本题，点击激活软键盘后在界面空白处轻点使输入框失焦，验证题干与顶部元信息是否重新出现。

不确定性：需保留防轻触跳动逻辑（例如延迟 100ms 检查 document.activeElement !== next 后再退出 editing）。

缺陷 6：标签页排他锁竞争失败后界面不可恢复（无重试与唤醒机制）

触发步骤：

被试在移动端多标签页或误双击打开了两个问卷标签 A 与 B。

B 标签页通过 navigator.locks.request 获取锁失败，owned = false。

B 标签页执行 status.textContent = ui.duplicateTab; content.replaceChildren(); return;。

被试随后关闭了 A 标签页，切换回 B 标签页。

准确文件和函数：

src/web/participant.ts 第 51 行

src/web/run.ts 第 109 行

影响：页面内容已被 content.replaceChildren() 清空，且没有安装任何恢复按钮或事件监听。即使持有锁的前序标签页已经关闭释放，处于当前标签页的被试既无法再次申请锁，也没有任何重新加载/恢复入口，只能手动刷新页面。

最小补丁建议：
当 !owned 时，在 content 中渲染“刷新重试”按钮，并监听 document.addEventListener('visibilitychange')；当页面重新回到前台时，尝试重新申请锁并执行 action(restore)。

回归场景：在两个标签页打开同一参与链接，关闭第一个标签页后切换到第二个标签页，验证能否自动或通过按钮恢复作答。

不确定性：无。

缺陷 7：设备方向看门狗监听器与隐藏遮罩永久泄漏

触发步骤：

页面加载并调用 requireOrientation(version)。

initialize() 调用 watchOrientation(meta.orientation) 创建 overlay 并在 window 上添加 resize、orientationchange、screen.orientation.change 监听。

方向正确后 passed Promise 解析。

准确文件和函数：

src/web/orientation-gate.ts 中的 initialize() 与 watchOrientation()

影响：initialize() 内部执行 await watchOrientation(meta.orientation).passed; 后，从未调用返回的 dispose()。该遮罩 DOM 节点永久留在页面（仅 hidden = true），并且所有方向变化的事件监听器在整个会话生命周期内永久常驻。

最小补丁建议：
在 initialize() 中保存 dispose 句柄，并在 ParticipantAPI.open 结束或页面卸载时提供系统级释放调用，或将其封装为单例并在重置时解绑旧监听器。

回归场景：在单页多次切换与重试进入时监控 window 事件监听器数量，验证不会随恢复次数线性增长。

不确定性：部分研究可能希望在问卷作答全流程持续强制方向锁定，但当前写法未暴露受控的管理句柄。

缺陷 8：评分项切换导致焦点重置到 <body>（键盘无障碍导航断裂）

触发步骤：

在评分任务 runRating 中，被试使用键盘（Enter/Space）或屏幕阅读器在第 1 题完成选择。

当前焦点位于 submit 按钮（“下一题”）。

被试点击或按回车触发 submit.onclick。

代码执行 question++; submit.disabled = true;。

准确文件和函数：

src/web/rating-run.ts 中的 submit.onclick 与 resetQuestion()

影响：浏览器原生规范规定：当获得焦点的元素被置为 disabled = true 时，焦点被强制抛弃并掉落到 document.body。被试无法感知已进入第 2 项，后续键盘操作（如方向键、空格）完全失效，必须按多次 Tab 键重新盲搜定位。

最小补丁建议：
在 submit.onclick 递增 question 并切换到下一题控件后，显式将焦点转移到下一题的滑块或标题元素上：

TypeScript
ranges[question]?.focus({ preventScroll: true });


回归场景：仅使用键盘 Tab 和方向键/回车键完成一组含多个子项目的评分任务，验证切换题目时焦点平滑衔接。

不确定性：触控设备无需焦点移动，需配置 { preventScroll: true } 避免触发视口扰动。
