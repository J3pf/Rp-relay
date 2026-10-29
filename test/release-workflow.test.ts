import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The GitHub Release must not depend on the npm publication job.
 * npm publishing is deferred until credentials exist (see CHANGELOG), and a
 * `needs: [npm, docker]` edge silently produced no release at all because the
 * npm job had no token to publish with.
 *
 * The workflow is read as text on purpose: this repo has no YAML dependency and
 * the assertion only needs the job graph, which is a simple two-space indent map.
 */

const workflow = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
	bundledDependencies?: string[];
	dependencies?: Record<string, string>;
};

/** Splits the `jobs:` block into job name → body, keyed by two-space indentation. */
function jobs(): Map<string, string> {
	const out = new Map<string, string>();
	const lines = workflow.split("\n");
	let inJobs = false;
	let current: string | null = null;
	let body: string[] = [];
	const flush = () => {
		if (current) out.set(current, body.join("\n"));
	};
	for (const line of lines) {
		if (/^jobs:\s*$/.test(line)) {
			inJobs = true;
			continue;
		}
		if (!inJobs) continue;
		if (/^\S/.test(line) && line.trim() !== "") {
			flush();
			break;
		}
		const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (start) {
			flush();
			current = start[1]!;
			body = [];
			continue;
		}
		if (current) body.push(line);
	}
	flush();
	return out;
}

/** `needs:` entries of one job body. */
function needsOf(body: string): string[] {
	const inline = /^\s{4}needs:\s*\[(.*)\]\s*$/m.exec(body);
	if (inline)
		return inline[1]!
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	const block = /^\s{4}needs:\s*\n((?:\s{6}-\s*\S+\s*\n?)+)/m.exec(body);
	if (block) return [...block[1]!.matchAll(/-\s*(\S+)/g)].map((m) => m[1]!);
	const single = /^\s{4}needs:\s*(\S+)\s*$/m.exec(body);
	return single ? [single[1]!] : [];
}

function reachable(from: string, graph: Map<string, string[]>): Set<string> {
	const seen = new Set<string>();
	const queue = [...(graph.get(from) ?? [])];
	while (queue.length > 0) {
		const job = queue.shift()!;
		if (seen.has(job)) continue;
		seen.add(job);
		queue.push(...(graph.get(job) ?? []));
	}
	return seen;
}

describe("release workflow", () => {
	it("publishes the GitHub Release without depending on the npm job", () => {
		const all = jobs();
		const graph = new Map([...all].map(([name, body]) => [name, needsOf(body)]));

		expect([...all.keys()]).toContain("github-release");
		expect(graph.get("github-release")).not.toContain("npm");
		expect([...reachable("github-release", graph)]).not.toContain("npm");
	});

	it("keeps verification in the release dependency graph", () => {
		const all = jobs();
		const graph = new Map([...all].map(([name, body]) => [name, needsOf(body)]));
		const released = reachable("github-release", graph);
		expect(released).toContain("docker");
		expect(released).toContain("verify");
	});

	it("keeps npm publishing opt-in and out of the default path", () => {
		const all = jobs();
		const npm = all.get("npm");
		if (npm === undefined) return; // removing the job entirely is also valid
		expect(npm).toMatch(/^\s{4}if:.*RP_PUBLISH_NPM/m);
		for (const [name, body] of all) {
			if (name === "npm") continue;
			expect(body, `${name} must not reference the npm token`).not.toContain("NPM_TOKEN");
		}
	});

	it("packs the installable tarball and attaches it to the release", () => {
		const release = jobs().get("github-release");
		expect(release).toBeDefined();
		// `deploy/install.sh` runs `npm install -g <release tarball>`, so the release job must build and pack.
		expect(release).toMatch(/^\s{6}-\s+run:\s*npm ci\s*$/m);
		expect(release).toMatch(/^\s{6}-\s+run:\s*npm run build\s*$/m);
		expect(release).toMatch(/^\s{6}-\s+run:\s*npm pack\s*$/m);
		// and the artifact has to reach the release, not stay in the workspace
		expect(release).toMatch(/files:\s*\S*\.tgz/);
	});

	it("installs the packed tarball and checks the version before releasing", () => {
		// The artifact that is attached must be the artifact that was proven installable.
		const release = jobs().get("github-release");
		expect(release).toBeDefined();
		expect(release).toMatch(/npm install -g --prefix/);
		expect(release).toMatch(/rp-relay" --version|rp-relay --version/);
		expect(release).toMatch(/GITHUB_REF_NAME#v/);
	});

	it("bundles the workspace protocol package so the tarball installs without the npm registry", () => {
		// `@j3pf/rp-protocol` is not published; without bundling it, `npm install -g <tgz>` fails with E404.
		expect(manifest.dependencies?.["@j3pf/rp-protocol"]).toBeDefined();
		expect(manifest.bundledDependencies ?? []).toContain("@j3pf/rp-protocol");
	});

	it("publishes the curated release notes as the release body", () => {
		// `docs/RELEASE-NOTES-<version>.md` is written for users; GitHub's own generated notes
		// replace it with "What's Changed" commit noise, so the file never reaches the page.
		const release = jobs().get("github-release");
		expect(release).toBeDefined();
		expect(release).toMatch(/body_path:\s*\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}/);
		expect(workflow).toContain("docs/RELEASE-NOTES-${GITHUB_REF_NAME#v}.md");
	});

	it("does not let GitHub generate the body over the curated notes", () => {
		const release = jobs().get("github-release");
		expect(release).toBeDefined();
		expect(release).not.toMatch(/generate_release_notes:\s*true/);
	});

	it("fails before publishing anything when the curated notes are missing", () => {
		// Failing in `github-release` would publish the image and only then die, leaving a half
		// release; the gate belongs in `verify`, which runs before `docker`.
		const verify = jobs().get("verify");
		expect(verify).toBeDefined();
		expect(verify).toMatch(/\[ -f [^\]]+\] \|\| \{[^}]*exit 1/);
	});
});
