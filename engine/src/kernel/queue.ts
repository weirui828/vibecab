export class SerialQueue {
    private tail: Promise<void> = Promise.resolve();
    run<T>(action: () => T | Promise<T>): Promise<T> { const result = this.tail.then(action); this.tail = result.then(() => undefined, () => undefined); return result; }
    idle(): Promise<void> { return this.tail; }
}
