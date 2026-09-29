export type DecisionEvent = {
  type: "decision"
  projectId: string
  expenseRequestId: string
  outcome: string
  reason: string
  chainStatus: string
}

export class Bus {
  private readonly listeners = new Map<string, Set<(event: DecisionEvent) => void>>()

  publish(event: DecisionEvent): void {
    for (const listener of this.listeners.get(event.projectId) ?? []) listener(event)
  }

  subscribe(projectId: string, listener: (event: DecisionEvent) => void): () => void {
    const set = this.listeners.get(projectId) ?? new Set()
    set.add(listener)
    this.listeners.set(projectId, set)
    return () => set.delete(listener)
  }
}
