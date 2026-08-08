import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const assetsDirectory = new URL("../dist/client/assets/", import.meta.url);
const entries = await readdir(assetsDirectory);
const assets = await Promise.all(
	entries
		.filter((name) => /\.(?:js|css)$/.test(name))
		.map(async (name) => ({
			name,
			bytes: (await stat(join(assetsDirectory.pathname, name))).size,
		})),
);

const javascript = assets.filter(({ name }) => name.endsWith(".js"));
const largest = [...javascript].sort((left, right) => right.bytes - left.bytes);
const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0);
const { routeIsolation, scalarAssetNames } =
	await inspectClientRouteIsolation(assets);
const scalarAssets = assets.filter(({ name }) => scalarAssetNames.has(name));
const scalarBytes = scalarAssets.reduce(
	(total, asset) => total + asset.bytes,
	0,
);

const workerDirectory = await mkdtemp(join(tmpdir(), "gmpay-edge-worker-"));
try {
	const output = await runWrangler(workerDirectory);
	const workerFiles = await collectFiles(workerDirectory);
	const workerModules = workerFiles
		.filter(({ name }) => /(?:\.js|\.mjs|\.wasm)$/.test(name))
		.sort((left, right) => right.bytes - left.bytes);
	const moduleCount = Number(
		output.match(/Total \((\d+) modules\)/)?.[1] ?? Number.NaN,
	);
	const upload = output.match(
		/Total Upload:\s*([\d.]+) KiB\s*\/ gzip:\s*([\d.]+) KiB/,
	);
	if (!Number.isFinite(moduleCount) || !upload) {
		throw new Error("Unable to parse Wrangler dry-run bundle summary.");
	}

	const report = {
		client: {
			assets: assets.length,
			totalBytes,
			scalarAssets: scalarAssets.sort(
				(left, right) => right.bytes - left.bytes,
			),
			scalarBytes,
			largestJavaScript: largest.slice(0, 10),
			routeIsolation,
		},
		worker: {
			modules: moduleCount,
			uploadBytes: Math.round(Number(upload[1]) * 1024),
			gzipUploadBytes: Math.round(Number(upload[2]) * 1024),
			largestModules: workerModules.slice(0, 10),
			startupTimeMs: null,
			startupTimeEvidence: "requires-deployment",
		},
		budgets: {
			maxClientBytes: 7_000_000,
			maxLargestClientJavaScriptBytes: 2_300_000,
			maxScalarBytes: 3_800_000,
			maxWorkerUploadBytes: 9_216_000,
			maxWorkerGzipUploadBytes: 1_945_600,
			maxLargestWorkerModuleBytes: 1_100_000,
		},
	};

	console.log(JSON.stringify(report, null, 2));

	const largestJavaScriptBytes = largest[0]?.bytes ?? 0;
	const largestWorkerModuleBytes = workerModules[0]?.bytes ?? 0;
	if (
		totalBytes > report.budgets.maxClientBytes ||
		largestJavaScriptBytes > report.budgets.maxLargestClientJavaScriptBytes ||
		scalarBytes > report.budgets.maxScalarBytes ||
		report.worker.uploadBytes > report.budgets.maxWorkerUploadBytes ||
		report.worker.gzipUploadBytes > report.budgets.maxWorkerGzipUploadBytes ||
		largestWorkerModuleBytes > report.budgets.maxLargestWorkerModuleBytes
	) {
		throw new Error("Bundle budget exceeded.");
	}
} finally {
	await rm(workerDirectory, { force: true, recursive: true });
}

type ClientAsset = { name: string; bytes: number };
type StartManifest = {
	routes: Record<string, { preloads?: string[] }>;
};

async function inspectClientRouteIsolation(assets: ClientAsset[]) {
	const serverAssetsDirectory = new URL(
		"../dist/server/assets/",
		import.meta.url,
	);
	const manifestName = (await readdir(serverAssetsDirectory)).find((name) =>
		name.startsWith("_tanstack-start-manifest_v-"),
	);
	if (!manifestName) {
		throw new Error("TanStack Start route manifest was not found.");
	}

	const manifestModule: unknown = await import(
		pathToFileURL(join(serverAssetsDirectory.pathname, manifestName)).href
	);
	if (!isStartManifestModule(manifestModule)) {
		throw new Error("TanStack Start route manifest has an unexpected shape.");
	}

	const assetNames = new Set(assets.map(({ name }) => name));
	const sources = new Map<string, string>();
	const readAsset = async (name: string) => {
		if (!sources.has(name)) {
			sources.set(
				name,
				await readFile(join(assetsDirectory.pathname, name), "utf8"),
			);
		}
		return sources.get(name) ?? "";
	};
	const routeAssets = new Map<string, Set<string>>();
	for (const [route, entry] of Object.entries(
		manifestModule.tsrStartManifest().routes,
	)) {
		const pending = (entry.preloads ?? [])
			.map(assetFileName)
			.filter((name): name is string => Boolean(name && assetNames.has(name)));
		const closure = new Set<string>();
		while (pending.length > 0) {
			const name = pending.pop();
			if (!name || closure.has(name)) continue;
			closure.add(name);
			if (!name.endsWith(".js")) continue;
			for (const reference of assetReferences(await readAsset(name))) {
				if (assetNames.has(reference) && !closure.has(reference)) {
					pending.push(reference);
				}
			}
		}
		routeAssets.set(route, closure);
	}
	const routeDynamicAssets = new Map<string, Set<string>>();
	for (const [route, closure] of routeAssets) {
		const dynamicAssets = new Set<string>();
		for (const name of closure) {
			if (!name.endsWith(".js")) continue;
			for (const reference of dynamicAssetReferences(await readAsset(name))) {
				if (assetNames.has(reference)) dynamicAssets.add(reference);
			}
		}
		routeDynamicAssets.set(route, dynamicAssets);
	}

	await Promise.all(
		assets
			.filter(({ name }) => name.endsWith(".js"))
			.map(({ name }) => readAsset(name)),
	);
	const classified = {
		scalarEntry: new Set(
			assets
				.filter(({ name }) =>
					/^api-reference-client-.+\.(?:js|css)$/.test(name),
				)
				.map(({ name }) => name),
		),
		editor: matchingAssets(sources, /pro-editor/),
		chart: matchingAssets(sources, /recharts-wrapper/),
		devtools: matchingAssets(
			sources,
			/TanStackDevtools|ReactQueryDevtoolsPanel|TanStackRouterDevtoolsPanel/,
		),
		providerAdapters: matchingAssets(
			sources,
			/BinancePayAdapter|OkxPayAdapter|OkPayAdapter|TronAdapter|EvmAdapter|SolanaAdapter|AptosAdapter|TonAdapter/,
		),
	};
	const owners = Object.fromEntries(
		Object.entries(classified).map(([group, names]) => {
			const graph = group === "scalarEntry" ? routeDynamicAssets : routeAssets;
			return [
				group,
				[...graph]
					.filter(([, closure]) => intersects(closure, names))
					.map(([route]) => route)
					.sort(),
			];
		}),
	) as Record<keyof typeof classified, string[]>;

	if (
		owners.scalarEntry.some((route) => route !== "/(public)/docs") ||
		owners.scalarEntry.length !== 1
	) {
		throw new Error(
			`Scalar escaped the public docs route: ${owners.scalarEntry.join(", ") || "none"}.`,
		);
	}
	if (owners.editor.some((route) => !route.startsWith("/admin/telegram"))) {
		throw new Error("The editor escaped the Telegram module.");
	}
	if (owners.chart.length > 0) {
		throw new Error(
			`Dashboard charts entered eager route closures: ${owners.chart.join(", ")}.`,
		);
	}
	if (
		classified.chart.size === 0 ||
		[...classified.chart].some(
			(name) => !/^order-trend-chart-.+\.js$/.test(name),
		)
	) {
		throw new Error("Dashboard charts lost their isolated dynamic asset.");
	}
	if (classified.devtools.size > 0) {
		throw new Error("TanStack Devtools entered the production client bundle.");
	}
	if (classified.providerAdapters.size > 0) {
		throw new Error("A payment provider adapter entered the client bundle.");
	}

	const scalarAssetNames = new Set(classified.scalarEntry);
	const pendingScalarAssets = [...classified.scalarEntry];
	while (pendingScalarAssets.length > 0) {
		const name = pendingScalarAssets.pop();
		if (!name?.endsWith(".js")) continue;
		for (const reference of assetReferences(await readAsset(name))) {
			if (assetNames.has(reference) && !scalarAssetNames.has(reference)) {
				scalarAssetNames.add(reference);
				pendingScalarAssets.push(reference);
			}
		}
	}
	return {
		routeIsolation: {
			scalarRoutes: owners.scalarEntry,
			editorRoutes: owners.editor,
			chartRoutes: owners.chart,
			chartAssets: [...classified.chart].sort(),
			devtoolsAssets: [...classified.devtools].sort(),
			providerAdapterAssets: [...classified.providerAdapters].sort(),
		},
		scalarAssetNames,
	};
}

function isStartManifestModule(
	value: unknown,
): value is { tsrStartManifest: () => StartManifest } {
	return (
		typeof value === "object" &&
		value !== null &&
		"tsrStartManifest" in value &&
		typeof value.tsrStartManifest === "function"
	);
}

function assetFileName(preload: string) {
	return preload.match(/^\/assets\/(.+\.(?:js|css))$/)?.[1];
}

function assetReferences(source: string) {
	return [
		...source.matchAll(
			/(?:\bfrom\s*|\bimport\s*)["'`]\.\/([^"'`]+\.(?:js|css))["'`]/g,
		),
	].flatMap((match) => (match[1] ? [match[1]] : []));
}

function dynamicAssetReferences(source: string) {
	return [
		...source.matchAll(
			/\bimport\s*\(\s*["'`]\.\/([^"'`]+\.(?:js|css))["'`]\s*\)/g,
		),
	].flatMap((match) => (match[1] ? [match[1]] : []));
}

function matchingAssets(sources: Map<string, string>, pattern: RegExp) {
	return new Set(
		[...sources]
			.filter(([, source]) => pattern.test(source))
			.map(([name]) => name),
	);
}

function intersects(left: Set<string>, right: Set<string>) {
	for (const value of left) if (right.has(value)) return true;
	return false;
}

function runWrangler(outputDirectory: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"wrangler",
			["deploy", "--dry-run", "--outdir", outputDirectory],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(output);
				return;
			}
			reject(new Error(`Wrangler dry-run exited with code ${code ?? 1}.`));
		});
	});
}

async function collectFiles(
	directory: string,
	prefix = "",
): Promise<Array<{ name: string; bytes: number }>> {
	const files: Array<{ name: string; bytes: number }> = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const relativePath = join(prefix, entry.name);
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(path, relativePath)));
		} else if (entry.name !== "meta.json") {
			files.push({ name: relativePath, bytes: (await stat(path)).size });
		}
	}
	return files;
}
