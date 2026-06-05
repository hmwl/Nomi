export class EventHub<T> {
  private listeners = new Map<number, (event: T) => void>();
  private history: T[] = [];
  private nextId = 1;

  constructor(private readonly maxReplay = 0) {}

  emit(event: T): void {
    if (this.maxReplay > 0) {
      this.history.push(event);
      if (this.history.length > this.maxReplay) this.history.splice(0, this.history.length - this.maxReplay);
    }
    for (const listener of this.listeners.values()) listener(event);
  }

  subscribe(listener: (event: T) => void, replay = true): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.listeners.set(id, listener);
    if (replay && this.maxReplay > 0) {
      for (const event of this.history) listener(event);
    }
    return () => {
      this.listeners.delete(id);
    };
  }
}

