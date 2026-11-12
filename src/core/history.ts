// Undo. Values are treated as immutable snapshots, so undoing is just going back to the last one.

export class History<T> {
  private past: T[] = [];
  private present: T;
  private readonly limit: number;

  constructor(initial: T, limit = 200) {
    this.present = initial;
    this.limit = limit;
  }

  get value(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  /** Make a change that can be undone. */
  set(next: T): void {
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
  }

  undo(): boolean {
    if (!this.past.length) return false;
    this.present = this.past.pop()!;
    return true;
  }

  /** Replace everything and forget the past (opening a shared song). */
  reset(value: T): void {
    this.past = [];
    this.present = value;
  }
}
