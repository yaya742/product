declare module 'aes-js' {
  export namespace ModeOfOperation {
    class cfb {
      constructor(key: number[], iv: number[], segmentSize?: number);
      encrypt(input: number[] | Uint8Array): number[];
      decrypt(input: number[] | Uint8Array): number[];
    }
  }

  export namespace utils {
    namespace utf8 {
      function toBytes(value: string): number[];
      function fromBytes(value: number[] | Uint8Array): string;
    }

    namespace hex {
      function fromBytes(value: number[] | Uint8Array): string;
      function toBytes(value: string): number[];
    }
  }
}
