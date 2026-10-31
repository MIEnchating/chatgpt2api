// Best-effort hardening for the dry-run worker, not a sandbox: the worker is same-origin, and a
// dynamic import() of a generated module cannot be intercepted from inside it. Removing these
// network entry points stops generated plugins from using them. fetch is replaced separately
// by the dry-run itself, which needs to assign and restore it.
const BLOCKED_APIS = ['XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport'] as const;

export function blockNetworkAPIs(scope: object) {
  for (const name of BLOCKED_APIS) {
    Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false });
  }
}
