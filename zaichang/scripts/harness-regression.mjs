// Compatibility entry: all validation now uses isolated fixtures and explicit live authorization.
// The former script relied on an unrelated account directory and a production profile.
console.log('Harness regression uses the isolated evaluation runner. Pass --live only with explicit test authorization.');
await import('./evaluate-harness.mjs');
