export class History {
  constructor(document, limit = 150) {
    this.document = document;
    this.savedDocument = document;
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
  }

  commit(label, next) {
    if (next === this.document) return false;
    this.undoStack.push({ label, before: this.document, after: next });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.document = next;
    this.redoStack = [];
    return true;
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return false;
    this.redoStack.push(command);
    this.document = command.before;
    return true;
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return false;
    this.undoStack.push(command);
    this.document = command.after;
    return true;
  }

  markSaved(document = this.document) { this.savedDocument = document; }
  get dirty() { return this.document !== this.savedDocument; }
}
