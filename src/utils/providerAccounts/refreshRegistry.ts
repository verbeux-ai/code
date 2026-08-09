export class AccountWorkRegistry<T> {
  private readonly inFlight = new Map<string, Promise<T>>()

  run(key: string, work: () => Promise<T>): Promise<T> {
    const current = this.inFlight.get(key)
    if (current) return current

    const pending = work().finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
    })
    this.inFlight.set(key, pending)
    return pending
  }
}
