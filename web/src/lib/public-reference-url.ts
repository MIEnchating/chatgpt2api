export const MAX_PUBLIC_REFERENCE_URL_LENGTH = 2083;

function isNonPublicIPv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) {
    return false;
  }
  const [first, second, third] = parts.map(Number);
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224;
}

function isNonPublicIPv6(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host) || host.startsWith("ff") || host.startsWith("2001:db8:")) {
    return true;
  }
  const mappedIPv4 = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIPv4 ? isNonPublicIPv4(mappedIPv4) : false;
}

export function isPublicReferenceURL(value: string) {
  const input = value.trim();
  if (!input || [...input].length > MAX_PUBLIC_REFERENCE_URL_LENGTH) return false;
  try {
    const parsed = new URL(input);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) return false;
    if (isNonPublicIPv4(hostname) || isNonPublicIPv6(hostname)) return false;
    return hostname.includes(".") || hostname.includes(":");
  } catch {
    return false;
  }
}
