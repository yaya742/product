type IteratorPrototypeWithJoin = { join?: (separator?: string) => string };
type IteratorConstructorLike = { prototype: IteratorPrototypeWithJoin };

/** PDF.js 6 uses recent iterator and Uint8Array APIs absent in older WebViews. */
export function installPdfCompatibility(): void {
  const prototype = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
  if (typeof prototype.toHex !== 'function') {
    Object.defineProperty(Uint8Array.prototype, 'toHex', {
      configurable: true,
      writable: true,
      value(this: Uint8Array) {
        let result = '';
        for (const byte of this) result += byte.toString(16).padStart(2, '0');
        return result;
      },
    });
  }

  const runtime = globalThis as typeof globalThis & { Iterator?: IteratorConstructorLike };
  if (!runtime.Iterator) {
    const IteratorShim = class Iterator {
      [Symbol.iterator]() { return this; }
    };
    Object.defineProperty(globalThis, 'Iterator', {
      configurable: true,
      writable: true,
      value: IteratorShim,
    });
    runtime.Iterator = IteratorShim as unknown as IteratorConstructorLike;
  }

  const iteratorPrototype = runtime.Iterator.prototype;
  const joinIterator = function (this: Iterable<unknown>, separator?: string) {
    return Array.from(this).join(separator);
  };
  if (typeof iteratorPrototype.join !== 'function') {
    Object.defineProperty(iteratorPrototype, 'join', {
      configurable: true,
      writable: true,
      value: joinIterator,
    });
  }

  const iteratorSamples: Iterable<unknown>[] = [
    [][Symbol.iterator](),
    new Map().entries(),
    new Set().values(),
    new Uint8Array()[Symbol.iterator](),
    ''[Symbol.iterator](),
    (function* iterator() {})(),
  ];
  for (const sample of iteratorSamples) {
    const samplePrototype = Object.getPrototypeOf(sample);
    let prototypeCursor = samplePrototype;
    while (prototypeCursor && prototypeCursor !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(prototypeCursor, Symbol.iterator)) {
        if (prototypeCursor !== iteratorPrototype && Object.getPrototypeOf(prototypeCursor) === Object.prototype) {
          try {
            Object.setPrototypeOf(prototypeCursor, iteratorPrototype);
          } catch {
            // Keep startup working even if an engine locks its shared iterator prototype.
          }
        }
        break;
      }
      prototypeCursor = Object.getPrototypeOf(prototypeCursor);
    }
    if (samplePrototype && Object.getPrototypeOf(samplePrototype) === Object.prototype) {
      try {
        Object.setPrototypeOf(samplePrototype, iteratorPrototype);
      } catch {
        // Keep PDF.js startup working even if an engine locks built-in prototypes.
      }
    }
    if (samplePrototype && typeof (sample as Iterable<unknown> & { join?: unknown }).join !== 'function') {
      try {
        Object.defineProperty(samplePrototype, 'join', { configurable: true, writable: true, value: joinIterator });
      } catch {
        // The global Iterator.prototype.join polyfill still covers inheriting runtimes.
      }
    }
  }
}

// Also run when this module is imported as the worker-entry prelude. The worker
// entry imports this module before importing PDF.js's worker implementation.
installPdfCompatibility();
