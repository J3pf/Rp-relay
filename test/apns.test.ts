import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { OutgoingHttpHeaders } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApnsConfig, ApnsError, createApnsSender } from "../src/push/apns.js";

const { connectStub } = vi.hoisted(() => ({ connectStub: vi.fn() }));
vi.mock("node:http2", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:http2")>();
	return { ...actual, connect: (...args: Parameters<typeof actual.connect>) => connectStub(...args) };
});

interface FakeResponse {
	status: number;
	reason?: string;
	beforeResponse?: () => void;
}

interface CapturedRequest {
	authority: string;
	headers: OutgoingHttpHeaders;
	body?: string;
}

class FakeRequest extends EventEmitter {
	constructor(
		private response: FakeResponse,
		private capture: CapturedRequest,
	) {
		super();
	}

	end(body?: string): void {
		this.capture.body = body;
		queueMicrotask(() => {
			this.response.beforeResponse?.();
			this.emit("response", { ":status": this.response.status });
			if (this.response.reason) this.emit("data", Buffer.from(JSON.stringify({ reason: this.response.reason })));
			this.emit("end");
			this.emit("close");
		});
	}

	close(): void {
		this.emit("close");
	}
}

class FakeSession extends EventEmitter {
	constructor(
		private authority: string,
		private nextResponse: () => FakeResponse,
		private requests: CapturedRequest[],
	) {
		super();
	}

	request(headers: OutgoingHttpHeaders): FakeRequest {
		const capture = { authority: this.authority, headers };
		this.requests.push(capture);
		return new FakeRequest(this.nextResponse(), capture);
	}

	close(): void {}
}

const START = Date.UTC(2026, 0, 1);
let tempDir: string;
let keyFile: string;
let publicKey: KeyObject;

function makeRig(responses: FakeResponse[], initialTime = START) {
	let now = initialTime;
	const requests: CapturedRequest[] = [];
	const authorities: string[] = [];
	const clientFactory = (authority: string) => {
		authorities.push(authority);
		return new FakeSession(
			authority,
			() => {
				const response = responses.shift();
				if (!response) throw new Error("fake APNs response queue exhausted");
				return response;
			},
			requests,
		);
	};
	connectStub.mockImplementation(clientFactory);
	const config: ApnsConfig = {
		keyId: "KEY123",
		teamId: "TEAM123",
		keyFile,
		bundleId: "com.example.app",
		env: "production",
	};
	const sender = createApnsSender(config, { now: () => now, clientFactory });
	return {
		sender,
		requests,
		authorities,
		setNow(value: number) {
			now = value;
		},
	};
}

const message = {
	host: "api.push.apple.com" as const,
	token: "device-token",
	payload: { aps: { alert: "hello" } },
	headers: { topic: "com.example.app", collapseId: "prompt-1", pushType: "alert", priority: 10 as const },
};

function bearer(request: CapturedRequest): string {
	return String(request.headers.authorization).replace(/^bearer /, "");
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
	const [header, payload, signature] = token.split(".");
	expect(header).toBeTruthy();
	expect(payload).toBeTruthy();
	expect(signature).toBeTruthy();
	return {
		header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>,
		payload: JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>,
	};
}

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rp-apns-test-"));
	keyFile = join(tempDir, "test-key.p8");
	const pair = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	writeFileSync(keyFile, pair.privateKey, { mode: 0o600 });
	publicKey = pair.publicKey as unknown as KeyObject;
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => connectStub.mockReset());

describe("createApnsSender", () => {
	it("signs a provider JWT and sends an HTTP/2 request with APNs headers", async () => {
		const rig = makeRig([{ status: 200 }]);
		await rig.sender.send(message);

		expect(rig.requests).toHaveLength(1);
		expect(rig.authorities).toEqual(["https://api.push.apple.com"]);
		expect(rig.requests[0]?.headers).toMatchObject({
			":method": "POST",
			":path": "/3/device/device-token",
			"apns-topic": "com.example.app",
			"apns-collapse-id": "prompt-1",
			"apns-push-type": "alert",
			"apns-priority": "10",
		});
		expect(rig.requests[0]?.body).toBe(JSON.stringify(message.payload));
		const token = bearer(rig.requests[0]!);
		const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
		const jwt = decodeJwt(token);
		expect(jwt.header).toMatchObject({ alg: "ES256", kid: "KEY123" });
		expect(jwt.payload).toMatchObject({ iss: "TEAM123", iat: Math.floor(START / 1000) });
		expect(
			verify(
				"SHA256",
				Buffer.from(`${encodedHeader}.${encodedPayload}`),
				{ key: publicKey, dsaEncoding: "ieee-p1363" },
				Buffer.from(encodedSignature!, "base64url"),
			),
		).toBe(true);
	});

	it("reuses the same provider token for sends less than 40 minutes apart", async () => {
		const rig = makeRig([{ status: 200 }, { status: 200 }]);
		await rig.sender.send(message);
		rig.setNow(START + 39 * 60_000);
		await rig.sender.send(message);

		expect(rig.requests).toHaveLength(2);
		expect(bearer(rig.requests[1]!)).toBe(bearer(rig.requests[0]!));
	});

	it("lazily signs a new provider token after 40 minutes", async () => {
		const rig = makeRig([{ status: 200 }, { status: 200 }]);
		await rig.sender.send(message);
		rig.setNow(START + 50 * 60_000);
		await rig.sender.send(message);

		expect(rig.requests).toHaveLength(2);
		expect(bearer(rig.requests[1]!)).not.toBe(bearer(rig.requests[0]!));
		expect(decodeJwt(bearer(rig.requests[1]!)).payload.iat).toBe(Math.floor((START + 50 * 60_000) / 1000));
	});

	it("regenerates once and retries once after 403 ExpiredProviderToken", async () => {
		const rig = makeRig([
			{ status: 403, reason: "ExpiredProviderToken", beforeResponse: () => rig.setNow(START + 1_000) },
			{ status: 200 },
		]);
		await rig.sender.send(message);

		expect(rig.requests).toHaveLength(2);
		expect(bearer(rig.requests[1]!)).not.toBe(bearer(rig.requests[0]!));
		expect(decodeJwt(bearer(rig.requests[1]!)).payload.iat).toBe(Math.floor((START + 1_000) / 1000));
		expect(rig.requests[1]?.body).toBe(rig.requests[0]?.body);
	});

	it("maps 410 to Unregistered", async () => {
		const rig = makeRig([{ status: 410, reason: "Unregistered" }]);
		await expect(rig.sender.send(message)).rejects.toMatchObject({
			name: "ApnsError",
			code: "Unregistered",
			status: 410,
		});
		expect(rig.requests).toHaveLength(1);
	});

	it("maps 400 BadDeviceToken to BadDeviceToken", async () => {
		const rig = makeRig([{ status: 400, reason: "BadDeviceToken" }]);
		await expect(rig.sender.send(message)).rejects.toMatchObject({
			name: "ApnsError",
			code: "BadDeviceToken",
			status: 400,
		});
		expect(rig.requests).toHaveLength(1);
	});

	it("rejects other 5xx responses as generic APNs errors", async () => {
		const rig = makeRig([{ status: 503, reason: "ServiceUnavailable" }]);
		await expect(rig.sender.send(message)).rejects.toMatchObject({
			name: "ApnsError",
			code: "ServiceUnavailable",
			status: 503,
		});
		expect(rig.requests).toHaveLength(1);
	});

	it("surfaces a second ExpiredProviderToken failure without retrying again", async () => {
		const rig = makeRig([
			{ status: 403, reason: "ExpiredProviderToken", beforeResponse: () => rig.setNow(START + 1_000) },
			{ status: 403, reason: "ExpiredProviderToken" },
		]);
		await expect(rig.sender.send(message)).rejects.toBeInstanceOf(ApnsError);
		expect(rig.requests).toHaveLength(2);
		expect(rig.requests.map(bearer)[1]).not.toBe(rig.requests.map(bearer)[0]);
	});
});
