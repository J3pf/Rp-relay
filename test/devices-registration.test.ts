import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, cleanup, pairDevice, startRelay, type TestRelay } from "./helpers.js";

const validToken = "0123456789abcdef".repeat(4);
const retainedToken = "ab".repeat(32);
const retainedFcmToken = "android-original-token";

const invalidTokens = [
	{ name: "uppercase hexadecimal", token: "A".repeat(64) },
	{ name: "63 characters", token: "a".repeat(63) },
	{ name: "65 characters", token: "a".repeat(65) },
	{ name: "separator", token: `${"a".repeat(32)}-${"b".repeat(31)}` },
	{ name: "spaces", token: ` ${"a".repeat(64)} ` },
	{ name: "non-hexadecimal", token: `${"a".repeat(63)}g` },
];

describe("registro APNs de dispositivos", () => {
	let t: TestRelay;

	beforeEach(async () => {
		t = await startRelay();
	});

	afterEach(async () => {
		await t.stop();
		cleanup(t);
	});

	it("acepta un token hexadecimal minúsculo de 64 caracteres sin transformarlo", async () => {
		const device = await pairDevice(t);
		const response = await api(t, "PUT", "/v1/devices/me/push", device.deviceToken, {
			apnsToken: validToken,
			apnsEnvironment: "production",
			direct: false,
		});

		expect(response.status).toBe(200);
		expect((await api(t, "GET", "/v1/devices", device.deviceToken)).json.devices[0]).toMatchObject({
			apns: true,
			apnsEnvironment: "production",
		});
		const pushTest = await api(t, "POST", "/v1/devices/me/push-test", device.deviceToken);
		expect(pushTest.status).toBe(200);
		expect(t.apns!.sent.at(-1)).toMatchObject({ token: validToken, host: "api.push.apple.com" });
	});

	it.each(invalidTokens)("rechaza $name sin cambiar los registros", async ({ token }) => {
		const device = await pairDevice(t);
		const registered = await api(t, "PUT", "/v1/devices/me/push", device.deviceToken, {
			fcmToken: retainedFcmToken,
			apnsToken: retainedToken,
			apnsEnvironment: "sandbox",
			direct: true,
		});
		expect(registered.status).toBe(200);
		const before = await api(t, "GET", "/v1/devices", device.deviceToken);
		const apnsSentBefore = t.apns!.sent.length;
		const fcmSentBefore = t.fcm.sent.length;

		const response = await api(t, "PUT", "/v1/devices/me/push", device.deviceToken, {
			fcmToken: "android-replacement-token",
			apnsToken: token,
			apnsEnvironment: "production",
			direct: false,
		});

		expect(response.status).toBe(400);
		expect((await api(t, "GET", "/v1/devices", device.deviceToken)).json).toEqual(before.json);
		expect(t.apns!.sent).toHaveLength(apnsSentBefore);
		expect(t.fcm.sent).toHaveLength(fcmSentBefore);

		const pushTest = await api(t, "POST", "/v1/devices/me/push-test", device.deviceToken);
		expect(pushTest.status).toBe(200);
		expect(t.apns!.sent.at(-1)).toMatchObject({ token: retainedToken, host: "api.development.push.apple.com" });
		expect(t.fcm.sent.at(-1)?.token).toBe(retainedFcmToken);
	});

	it("mantiene el string vacío como instrucción para borrar token y entorno", async () => {
		const device = await pairDevice(t);
		await api(t, "PUT", "/v1/devices/me/push", device.deviceToken, {
			apnsToken: retainedToken,
			apnsEnvironment: "sandbox",
			direct: false,
		});

		const response = await api(t, "PUT", "/v1/devices/me/push", device.deviceToken, {
			apnsToken: "",
			direct: false,
		});

		expect(response.status).toBe(200);
		const listed = await api(t, "GET", "/v1/devices", device.deviceToken);
		expect(listed.status).toBe(200);
		expect(listed.json.devices[0]).toMatchObject({ apns: false });
		expect(listed.json.devices[0]).not.toHaveProperty("apnsEnvironment");
	});

	it("deja intacto el registro Android legacy sin campos APNs", async () => {
		const device = await pairDevice(t);
		const response = await api(t, "PUT", "/v1/devices/me/push", device.deviceToken, {
			fcmToken: retainedFcmToken,
			direct: false,
		});

		expect(response.status).toBe(200);
		const listed = await api(t, "GET", "/v1/devices", device.deviceToken);
		expect(listed.status).toBe(200);
		expect(listed.json.devices[0]).toMatchObject({ direct: false, fcm: true, apns: false });
		const pushTest = await api(t, "POST", "/v1/devices/me/push-test", device.deviceToken);
		expect(pushTest.status).toBe(200);
		expect(t.fcm.sent.at(-1)?.token).toBe(retainedFcmToken);
		expect(t.apns!.sent).toHaveLength(0);
	});
});
