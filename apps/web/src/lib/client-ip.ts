import "server-only";

/**
 * The payer's public IP, for MoonPay's IP matching.
 *
 * Taken from proxy headers rather than from the request body: a client-supplied
 * IP would let anyone bind a signed widget URL to an address of their choosing,
 * which defeats the entire point of binding it. Only the first hop in
 * `x-forwarded-for` is used, and only when a trusted proxy actually sets it.
 *
 * Loopback and private ranges are treated as "unknown". MoonPay compares the
 * hash against the address it observes from the public internet, so binding to
 * 127.0.0.1 or 10.x guarantees a mismatch and an "Unverified Connection" error
 * - worse than not binding at all. In production this returns a real address
 * because the load balancer sets the header; in local development it returns
 * undefined, which is why IP matching is off by default in sandbox.
 */
export function clientIp(headers: Headers): string | undefined {
  const forwarded = headers.get("x-forwarded-for");
  const candidate = forwarded?.split(",")[0]?.trim() ?? headers.get("x-real-ip")?.trim() ?? undefined;
  if (!candidate) return undefined;

  if (
    candidate === "::1" ||
    candidate === "0.0.0.0" ||
    candidate.startsWith("127.") ||
    candidate.startsWith("10.") ||
    candidate.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(candidate) ||
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    /^f[cd]/i.test(candidate) ||
    /^fe[89ab]/i.test(candidate)
  ) {
    return undefined;
  }

  return candidate;
}
