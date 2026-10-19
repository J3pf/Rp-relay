import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: { "@j3pf/rp-protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 60_000,
		pool: "forks",
		maxWorkers: 4,
	},
});
