/** Credential patterns only. This is not a semantic privacy classifier or an authority to read data. */
const credentialPatterns = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /Bearer\s+[A-Za-z0-9_.-]{12,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
export function redactCredentials(text: string) {
  let redacted = text;
  for (const pattern of credentialPatterns) redacted = redacted.replace(pattern, '[凭据已隐藏]');
  return redacted;
}
export function hasCredentials(text: string) {
  return redactCredentials(text) !== text || /(?:密码|password)\s*(?:是|[:：=])\s*\S{3,}/i.test(text);
}
export function redactExport(value: unknown): any {
  if (typeof value === 'string') return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactExport);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !/^(apiKey|password|cookie|authorization|accessToken|refreshToken|secret)$/i.test(key),
        )
        .map(([key, item]) => [key, redactExport(item)]),
    );
  return value;
}
