import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { PairingService } from "../auth/pairing.js";
import { formatCode } from "../auth/tokens.js";
import { c, fmtTime, open } from "./util.js";

function showQr(text: string): Promise<void> {
	return new Promise((resolve) =>
		qrcode.generate(text, { small: true }, (q: string) => {
			console.log(q);
			resolve();
		}),
	);
}

/** `rp-relay pair device|machine`: genera un código de 10 min (y el QR para el teléfono). */
export async function pair(argv: string[]): Promise<void> {
	const kind = argv[0];
	if (kind !== "device" && kind !== "machine")
		throw new Error("uso: rp-relay pair device | pair machine [--name N] [--context personal|work]");
	const { values } = parseArgs({
		args: argv.slice(1),
		options: { name: { type: "string" }, context: { type: "string" }, "no-qr": { type: "boolean" } },
	});
	const { config, repos, close } = open();
	try {
		const svc = new PairingService(repos, config.relayName);
		const { code, expiresAt } = svc.createCode(
			kind,
			"cli",
			kind === "machine" ? { name: values.name, context: values.context } : undefined,
		);
		const url = config.publicUrl.replace(/\/$/, "");
		if (kind === "device") {
			const uri = `rp://pair?u=${encodeURIComponent(url)}&c=${code}`;
			if (!values["no-qr"]) await showQr(uri);
			console.log(`Código: ${c.bold(formatCode(code))}   (caduca ${fmtTime(expiresAt)} UTC, un solo uso)`);
			console.log(c.dim(`URI: ${uri}`));
		} else {
			console.log(`Código: ${c.bold(formatCode(code))}   (caduca ${fmtTime(expiresAt)} UTC, un solo uso)`);
			console.log(
				`En Pi, en la PC a emparejar:\n  ${c.bold(`/rp pair ${url} ${code}${values.name ? ` --name "${values.name}"` : ""}${values.context ? ` --context ${values.context}` : ""}`)}`,
			);
		}
	} finally {
		close();
	}
}
