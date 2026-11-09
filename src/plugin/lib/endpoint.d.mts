export interface ParsedHostPort {
  /** Unbracketed host; an empty host defaults to 127.0.0.1. */
  host: string;
  /** 1-65535. */
  port: number;
}

/**
 * Parses an LS endpoint address. Accepted grammar: "host:port",
 * "hostname:port", IPv4 "127.0.0.1:59999", bracketed IPv6 "[::1]:59999"
 * (host is returned unbracketed). An empty host (":59999") defaults to
 * 127.0.0.1. Throws with a clear message for: a missing or non-numeric or
 * out-of-range port, bare (unbracketed) IPv6 such as "::1:59999", scheme
 * prefixes such as "http://host:6000", and whitespace inside the host.
 */
export declare function parseHostPort(value: string): ParsedHostPort;

export interface EndpointIdentity {
  host: string;
  port: number;
  product?: string | null;
}

/** "host:port:product" identity of a discovered LS (product defaults to ''). */
export declare function endpointFingerprint(endpoint: EndpointIdentity): string;
