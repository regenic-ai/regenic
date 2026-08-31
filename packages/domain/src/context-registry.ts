import type {
  ContextProjector,
  ContextProjectorRegistry,
  ContextRetriever,
  ContextRetrieverRegistry,
} from "./context-port";

class MemoryContextRegistry<T extends { readonly id: string }> {
  private readonly values = new Map<string, T>();
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  register(value: T): () => void {
    if (this.values.has(value.id)) {
      throw new Error(`${this.label} already registered: ${value.id}`);
    }
    this.values.set(value.id, value);
    return () => {
      if (this.values.get(value.id) === value) {
        this.values.delete(value.id);
      }
    };
  }

  get(id: string): T | undefined {
    return this.values.get(id);
  }

  list(): T[] {
    return [...this.values.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  }
}

export class MemoryContextProjectorRegistry implements ContextProjectorRegistry {
  private readonly registry = new MemoryContextRegistry<ContextProjector>("Context projector");

  register(projector: ContextProjector): () => void {
    return this.registry.register(projector);
  }

  get(id: string): ContextProjector | undefined {
    return this.registry.get(id);
  }

  list(): ContextProjector[] {
    return this.registry.list();
  }
}

export class MemoryContextRetrieverRegistry implements ContextRetrieverRegistry {
  private readonly registry = new MemoryContextRegistry<ContextRetriever>("Context retriever");

  register(retriever: ContextRetriever): () => void {
    return this.registry.register(retriever);
  }

  get(id: string): ContextRetriever | undefined {
    return this.registry.get(id);
  }

  list(): ContextRetriever[] {
    return this.registry.list();
  }
}