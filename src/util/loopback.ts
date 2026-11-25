import { isIP } from "node:net";

const LOOPBACK_IPV4_RE = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/;

export function normalizeIp(ip: string): string {
	const trimmed = ip.trim();
	if (trimmed.toLowerCase().startsWith("::ffff:")) {
		const v4 = trimmed.slice(7);
		if (isIP(v4) === 4) return v4;
	}
	return trimmed;
}

/** Returns true for IPv4 loopback (127.0.0.0/8, including ::ffff:-mapped) and IPv6 loopback (::1). */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
	if (!addr) return false;
	const norm = normalizeIp(addr);
	if (norm === "::1") return true;
	return isIP(norm) === 4 && LOOPBACK_IPV4_RE.test(norm);
}

/** Returns true for loopback hostnames or IP literals (localhost, 127.0.0.0/8, ::1, [::1]). */
export function isLoopbackHost(host: string | null | undefined): boolean {
	if (!host) return false;
	const trimmed = host.trim().toLowerCase();
	if (trimmed === "localhost") return true;
	const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return isLoopbackAddress(unbracketed);
}
