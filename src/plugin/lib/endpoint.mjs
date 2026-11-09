// Language Server endpoint address grammar shared by panel discovery:
//
//   Accepted:  "host:port"        -> host verbatim ("" becomes 127.0.0.1)
//              "hostname:port"    -> e.g. "localhost:6000"
//              "127.0.0.1:59999"  -> IPv4
//              "[::1]:59999"      -> bracketed IPv6, returned unbracketed so
//                                    node:http can dial it directly
//
//   Rejected:  no port ("127.0.0.1"), ports outside 1-65535 or non-numeric
//              ports, bare IPv6 ("::1:59999" must be bracketed), scheme
//              prefixes ("http://host:6000"), whitespace in the host.
//
// Every rejection throws with a message naming the offending input and the
// expected shape, so a broken ANTIGRAVITY_LS_ADDRESS fails loudly instead of
// parsing into a wrong endpoint (bare IPv6 previously parsed as port 1).

const DEFAULT_HOST = '127.0.0.1';
const BRACKETED_IPV6_RE = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i;
const HOST_PORT_RE = /^([^:\s]*):(\d{1,5})$/;
const SCHEME_RE = /^[a-z][a-z\d+.-]*:\/\//i;

function portFrom(digits, raw) {
  const port = Number(digits);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid LS address "${raw}": port must be between 1 and 65535`);
  }
  return port;
}

function parseHostPort(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('LS address must be a non-empty "host:port" string');
  }
  const raw = value.trim();
  if (SCHEME_RE.test(raw)) {
    throw new Error(`Invalid LS address "${raw}": omit the scheme, use "host:port"`);
  }
  const bracketed = raw.match(BRACKETED_IPV6_RE);
  if (bracketed) return { host: bracketed[1], port: portFrom(bracketed[2], raw) };
  if (raw.startsWith('[')) {
    throw new Error(`Invalid LS address "${raw}": bracketed IPv6 must be written as "[::1]:port"`);
  }
  if (raw.split(':').length > 2) {
    throw new Error(
      `Invalid LS address "${raw}": bare IPv6 addresses must be bracketed, e.g. "[::1]:port"`,
    );
  }
  const match = raw.match(HOST_PORT_RE);
  if (!match) {
    throw new Error(`Invalid LS address "${raw}": expected "host:port" or "[::1]:port"`);
  }
  return { host: match[1] || DEFAULT_HOST, port: portFrom(match[2], raw) };
}

/**
 * Identity of a discovered LS: same host, port, and product means the same
 * server, so responses can keep merging into session state. An LS restart
 * binds a new random port, which changes the fingerprint.
 */
function endpointFingerprint(endpoint) {
  return `${endpoint.host}:${endpoint.port}:${endpoint.product ?? ''}`;
}

export { endpointFingerprint, parseHostPort };
