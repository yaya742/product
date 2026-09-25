class RunnerUrlSearchParams {
  private entries: Array<[string, string]> = [];

  constructor(init: string | Record<string, string> = '') {
    if (typeof init === 'string') {
      const source = init.startsWith('?') ? init.slice(1) : init;
      for (const pair of source.split('&')) {
        if (!pair) continue;
        const separator = pair.indexOf('=');
        const key = separator < 0 ? pair : pair.slice(0, separator);
        const value = separator < 0 ? '' : pair.slice(separator + 1);
        this.entries.push([this.decode(key), this.decode(value)]);
      }
    } else {
      for (const [key, value] of Object.entries(init)) this.entries.push([key, String(value)]);
    }
  }

  get(name: string): string | null {
    return this.entries.find(([key]) => key === name)?.[1] ?? null;
  }

  append(name: string, value: string): void {
    this.entries.push([name, value]);
  }

  set(name: string, value: string): void {
    const first = this.entries.findIndex(([key]) => key === name);
    this.entries = this.entries.filter(([key]) => key !== name);
    this.entries.splice(first < 0 ? this.entries.length : first, 0, [name, value]);
  }

  toString(): string {
    return this.entries.map(([key, value]) => `${this.encode(key)}=${this.encode(value)}`).join('&');
  }

  private decode(value: string): string {
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
  }

  private encode(value: string): string {
    return encodeURIComponent(value).replace(/%20/g, '+').replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  }
}

class RunnerUrl {
  private protocolValue = '';
  private hostnameValue = '';
  private portValue = '';
  private pathnameValue = '/';
  private searchValue = '';
  private hashValue = '';

  constructor(input: string | RunnerUrl, base?: string | RunnerUrl) {
    const source = String(input);
    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(source)
      ? source
      : this.resolve(source, base === undefined ? undefined : String(base));
    const match = absolute.match(/^([a-z][a-z\d+.-]*:)\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i);
    if (!match) throw new TypeError('Invalid URL');
    this.protocolValue = match[1].toLowerCase();
    const authority = match[2].split('@').pop() || '';
    const hostMatch = authority.match(/^([^:]*)(?::(\d+))?$/);
    if (!hostMatch?.[1]) throw new TypeError('Invalid URL host');
    this.hostnameValue = hostMatch[1].toLowerCase();
    this.portValue = hostMatch[2] || '';
    if ((this.protocolValue === 'https:' && this.portValue === '443') || (this.protocolValue === 'http:' && this.portValue === '80')) this.portValue = '';
    this.pathnameValue = this.normalizePath(match[3] || '/');
    this.searchValue = match[4] ? `?${match[4]}` : '';
    this.hashValue = match[5] ? `#${match[5]}` : '';
  }

  get protocol(): string { return this.protocolValue; }
  set protocol(value: string) { this.protocolValue = value.endsWith(':') ? value.toLowerCase() : `${value.toLowerCase()}:`; }
  get hostname(): string { return this.hostnameValue; }
  get port(): string { return this.portValue; }
  get host(): string { return `${this.hostnameValue}${this.portValue ? `:${this.portValue}` : ''}`; }
  get pathname(): string { return this.pathnameValue; }
  get search(): string { return this.searchValue; }
  get hash(): string { return this.hashValue; }
  get origin(): string { return `${this.protocolValue}//${this.host}`; }
  get href(): string { return `${this.origin}${this.pathnameValue}${this.searchValue}${this.hashValue}`; }
  get searchParams(): RunnerUrlSearchParams { return new RunnerUrlSearchParams(this.searchValue); }
  toString(): string { return this.href; }
  toJSON(): string { return this.href; }

  private resolve(source: string, base?: string): string {
    if (!base) throw new TypeError('Invalid URL');
    const parent = new RunnerUrl(base);
    if (source.startsWith('//')) return `${parent.protocol}${source}`;
    if (source.startsWith('?')) return `${parent.origin}${parent.pathname}${source}`;
    if (source.startsWith('#')) return `${parent.origin}${parent.pathname}${parent.search}${source}`;
    if (source.startsWith('/')) return `${parent.origin}${source}`;
    const directory = parent.pathname.slice(0, parent.pathname.lastIndexOf('/') + 1);
    return `${parent.origin}${directory}${source}`;
  }

  private normalizePath(path: string): string {
    const trailingSlash = path.endsWith('/');
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
    const normalized = `/${segments.join('/')}`;
    return trailingSlash && normalized !== '/' ? `${normalized}/` : normalized;
  }
}

export function installBackgroundWebPolyfills(): void {
  const runtime = globalThis as typeof globalThis & {
    URL?: typeof URL;
    URLSearchParams?: typeof URLSearchParams;
  };
  if (typeof runtime.URL !== 'function') runtime.URL = RunnerUrl as unknown as typeof URL;
  if (typeof runtime.URLSearchParams !== 'function') runtime.URLSearchParams = RunnerUrlSearchParams as unknown as typeof URLSearchParams;
}
