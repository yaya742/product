/** PDF.js 6 uses Uint8Array#toHex in its worker; older Android WebViews lack it. */
export function installUint8ArrayToHexPolyfill(): void {
  const prototype = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
  if (typeof prototype.toHex === 'function') return;

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

// Also run when this module is imported as the worker-entry prelude. The worker
// entry imports this module before importing PDF.js's worker implementation.
installUint8ArrayToHexPolyfill();
