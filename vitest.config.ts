import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: { "@j3pf/rp-protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 30_000,
		pool: "forks",
		poolOptions: {
			forks: {
				maxForks: 4,
			},
		},
	},
});
