import type { IncomingMessage, Server } from "node:http";
import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { CloseCode, MAX_FRAME_BYTES } from "@j3pf/rp-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { AuthResult } from "../auth/middleware.js";
import { effectiveTrustProxy } from "../config.js";
import type { Ctx } from "../context.js";
import { isLoopbackAddress, normalizeIp } from "../util/loopback.js";
import { MINUTE } from "../util/time.js";
import { handleAgentSocket } from "./agentGateway.js";
import { handleAppSocket } from "./appGateway.js";
import { handleHostSocket } from "./hostGateway.js";

type UpgradeServer = Pick<Server, "on" | "off">;
type TrustMatcher = (addr: string, hopIndex: number) => boolean;

const MAX_FAILED_UPGRADES_PER_MIN = 30;
const MAX_FAILED_UPGRADE_ENTRIES = 1_000;

function addTrustRule(bl: BlockList, token: string): void {
	const lower = token.toLowerCase();
	if (lower === "loopback") {
		bl.addSubnet("127.0.0.0", 8, "ipv4");
		bl.addAddress("::1", "ipv6");
		return;
	}
	if (lower === "linklocal") {
		bl.addSubnet("169.254.0.0", 16, "ipv4");
		bl.addSubnet("fe80::", 10, "ipv6");
		return;
	}
	if (lower === "uniquelocal") {
		bl.addSubnet("10.0.0.0", 8, "ipv4");
		bl.addSubnet("172.16.0.0", 12, "ipv4");
		bl.addSubnet("192.168.0.0", 16, "ipv4");
		bl.addSubnet("fc00::", 7, "ipv6");
		return;
	}
	const slash = token.indexOf("/");
	if (slash !== -1) {
		const ip = normalizeIp(token.slice(0, slash));
		const prefix = Number(token.slice(slash + 1));
		const v = isIP(ip);
		if ((v === 4 || v === 6) && Number.isInteger(prefix)) {
			try {
				bl.addSubnet(ip, prefix, v === 4 ? "ipv4" : "ipv6");
			} catch {
				// Ignore invalid CIDR entry
			}
		}
		return;
	}
	const ip = normalizeIp(token);
	const v = isIP(ip);
	if (v === 4 || v === 6) bl.addAddress(ip, v === 4 ? "ipv4" : "ipv6");
}

function buildTrustMatcher(trustProxy: boolean | number | string): TrustMatcher {
	if (trustProxy === false || trustProxy === 0) return () => false;
	if (trustProxy === true) return () => true;
	if (typeof trustProxy === "number") return (_addr, hopIndex) => hopIndex < trustProxy;
	if (trustProxy.trim().toLowerCase() === "loopback") return (addr) => isLoopbackAddress(addr);
	const bl = new BlockList();
	for (const part of trustProxy.split(",")) {
		const token = part.trim();
		if (token) addTrustRule(bl, token);
	}
	return (addr) => {
		const norm = normalizeIp(addr);
		const v = isIP(norm);
		if (v === 4) return bl.check(norm, "ipv4");
		if (v === 6) return bl.check(norm, "ipv6");
		return false;
	};
}

function resolveRemoteIp(req: IncomingMessage, isTrusted: TrustMatcher): string {
	const rawRemote = normalizeIp(req.socket.remoteAddress ?? "unknown");
	const xffRaw = req.headers["x-forwarded-for"];
	const xffHeader = Array.isArray(xffRaw) ? xffRaw.join(",") : (xffRaw ?? "");
	const xffParts = xffHeader
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// Chain ordered from closest hop (socket peer) to farthest origin
	const addrs = [rawRemote, ...xffParts.reverse()];
	for (let i = 0; i < addrs.length; i++) {
		const addr = addrs[i]!;
		if (i === addrs.length - 1 || !isTrusted(addr, i)) return normalizeIp(addr);
	}
	return rawRemote;
}

/**
 * Monta los tres endpoints WebSocket sobre el servidor HTTP de Fastify (`ws` en modo `noServer`).
 * Con token inválido se completa el upgrade y se cierra con `4001`, para que el cliente reciba el código
 * (PROTOCOLO §1: "no reconectar").
 */
export function attachWebSockets(server: UpgradeServer, c: () => Ctx): { close(): void } {
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_FRAME_BYTES,
		perMessageDeflate: {
			threshold: 1024,
			serverNoContextTakeover: true,
			clientNoContextTakeover: true,
		},
	});

	const activeWs = new Set<WebSocket>();
	const failedUpgrades = new Map<string, { count: number; resetAt: number }>();
	let cachedTrustSpec: boolean | number | string | undefined;
	let cachedTrustMatcher: TrustMatcher = () => false;

	const getTrustMatcher = (spec: boolean | number | string): TrustMatcher => {
		if (cachedTrustSpec !== spec) {
			cachedTrustSpec = spec;
			cachedTrustMatcher = buildTrustMatcher(spec);
		}
		return cachedTrustMatcher;
	};

	const checkFailedUpgradeRate = (ip: string): boolean => {
		const now = Date.now();
		const entry = failedUpgrades.get(ip);
		if (entry && entry.resetAt > now) {
			entry.count += 1;
			failedUpgrades.delete(ip);
			failedUpgrades.set(ip, entry);
			return entry.count <= MAX_FAILED_UPGRADES_PER_MIN;
		}
		if (entry) failedUpgrades.delete(ip);
		if (failedUpgrades.size >= MAX_FAILED_UPGRADE_ENTRIES) {
			for (const [k, v] of failedUpgrades) {
				if (v.resetAt <= now) failedUpgrades.delete(k);
			}
			for (const k of failedUpgrades.keys()) {
				if (failedUpgrades.size < MAX_FAILED_UPGRADE_ENTRIES) break;
				failedUpgrades.delete(k);
			}
		}
		failedUpgrades.set(ip, { count: 1, resetAt: now + MINUTE });
		return true;
	};

	const upgradeAuth = <T>(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		ctx: Ctx,
		remoteIp: string,
		reject: (status: string) => void,
		auth: AuthResult<T>,
		checkLimits: ((row: T) => string | null) | null,
		onAuthed: (ws: WebSocket, row: T) => void,
	) => {
		if (!auth.ok) {
			if (!checkFailedUpgradeRate(remoteIp)) {
				reject("429 Too Many Requests");
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				ws.on("error", () => {});
				ws.close(CloseCode.Unauthorized, `unauthorized: ${auth.reason}`);
			});
			return;
		}
		if (Math.max(activeWs.size, ctx.hub.size) >= ctx.config.limits.maxWsTotal) {
			reject("503 Service Unavailable");
			return;
		}
		const limitErr = checkLimits?.(auth.row);
		if (limitErr) {
			reject(limitErr);
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.on("error", () => {});
			activeWs.add(ws);
			ws.once("close", () => activeWs.delete(ws));
			onAuthed(ws, auth.row);
		});
	};

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		socket.on("error", () => {});
		const reject = (status: string) => {
			if (!socket.destroyed && socket.writable) {
				socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
			}
			socket.destroy();
		};
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://localhost");
		} catch {
			reject("400 Bad Request");
			return;
		}
		const ctx = c();
		const remoteIp = resolveRemoteIp(req, getTrustMatcher(effectiveTrustProxy(ctx.config)));
		switch (url.pathname) {
			case "/ws/agent":
				upgradeAuth(req, socket, head, ctx, remoteIp, reject, ctx.auth.machine(req.headers), null, (ws, row) => {
					handleAgentSocket(c, ws, row);
				});
				return;
			case "/ws/host":
				upgradeAuth(req, socket, head, ctx, remoteIp, reject, ctx.auth.machine(req.headers), null, (ws, row) => {
					handleHostSocket(c, ws, row);
				});
				return;
			case "/ws/app": {
				const mode = url.searchParams.get("mode") === "direct" ? "direct" : "foreground";
				upgradeAuth(
					req,
					socket,
					head,
					ctx,
					remoteIp,
					reject,
					ctx.auth.device(req.headers),
					(row) =>
						ctx.hub.appsOfDevice(row.id).length >= ctx.config.limits.maxWsPerDevice ? "429 Too Many Requests" : null,
					(ws, row) => {
						handleAppSocket(c, ws, row, mode);
					},
				);
				return;
			}
			default:
				reject("404 Not Found");
		}
	};

	server.on("upgrade", onUpgrade);
	return {
		close() {
			server.off("upgrade", onUpgrade);
			activeWs.clear();
			for (const client of wss.clients) client.terminate();
			wss.close();
		},
	};
}
