全项目设计讨论，传输段 8，源码主题：随机化、动态补测及重放（源包 2/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

    const status = this.executions.get(next.candidate.instance_id);
    if (status === 'STAGED') {
      this.executions.set(next.candidate.instance_id, 'ABORTED_BEFORE_SOFTWARE_ONSET');
      return this.stop('CORRECTION_BEFORE_SOFTWARE_ONSET');
    }
    if (status === 'UNSTARTED') return this.cancel(next.proposal_id!, op, now, evidence);
    // Observed instance keeps its complete fixed phases and consumed slot.
    return null;
  }
  closing(unresolvedObligations: boolean) {
    if (this.state !== 'RUNNING') throw new Error('RUN_NOT_ACTIVE');
    if (this.queue.length || this.pending || unresolvedObligations) return this.stop('UNRESOLVED_GROUP_TAIL');
    this.state = 'GROUP_CLOSING';
  }
  interrupt(knownBeforeOnset: boolean) {
    for (const [id, state] of this.executions) {
      if (state === 'STAGED') this.executions.set(id, knownBeforeOnset ? 'ABORTED_BEFORE_SOFTWARE_ONSET' : 'UNKNOWN');
      if (state === 'ONSET_OBSERVED' || state === 'WINDOW_CLOSED') this.executions.set(id, 'ABORTED_AFTER_SOFTWARE_ONSET');
    }
    if (this.pending?.audit.type === 'INTENT') this.executions.set(this.pending.audit.instance_id, 'UNKNOWN');
    this.state = 'TERMINATED'; this.reason = 'INTERRUPTED';
  }
}

```