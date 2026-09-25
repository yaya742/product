/** PDF.js uses Uint8Array.toHex, which may be absent in older Android WebViews. */
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
}

// Also run in the worker's separate JavaScript realm.
installPdfCompatibility();
