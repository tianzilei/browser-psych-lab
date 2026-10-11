全项目设计讨论，传输段 41，源码主题：页面交互和管理（源包 13/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

      card.append(link); list.append(card);
    }
  }
} catch { status.textContent='问卷列表暂时无法加载，请稍后重试。'; }

```

### src/web/replay.html L1–L2

```
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>操作回放</title></head><body><main><h1>操作回放</h1><p id="status">正在读取记录…</p><div id="controls"></div><canvas id="replay"></canvas><pre id="details"></pre></main><script type="module" src="./replay.ts"></script></body></html>

```