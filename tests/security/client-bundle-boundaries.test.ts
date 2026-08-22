import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sourceFiles = collectSourceFiles(resolve(root, "src"));
const resolveModule = createRequire(import.meta.url).resolve;
const workerSourceFiles = sourceFiles.filter((file) => {
	const path = projectPath(file);
	return (
		path === "src/server-entry.ts" ||
		path.startsWith("src/server/") ||
		path.startsWith("src/integrations/") ||
		path.includes("/server/")
	);
});

describe("client bundle boundaries", () => {
	it("keeps heavy client dependencies with their semantic owners", () => {
		expect(runtimeImportOwners("@scalar/api-reference-react")).toEqual([]);
		expect(runtimeImportOwners("recharts")).toEqual([
			"src/components/ui/chart.tsx",
			"src/features/dashboard/components/order-trend-chart.tsx",
		]);
		expect(runtimeImportOwners("#/components/pro/editor")).toEqual([
			"src/features/telegram/pages/form-fields.tsx",
		]);
		expect(runtimeImportOwners("react-markdown")).toEqual([
			"src/features/telegram/pages/form-fields.tsx",
		]);
		expect(runtimeImportOwners("gsap")).toEqual([
			"src/features/auth/components/animated-characters.tsx",
		]);
		expect(runtimeImportOwners("@gsap/react")).toEqual([
			"src/features/auth/components/animated-characters.tsx",
		]);
	});

	it("keeps provider adapters and locale catalogs out of client source", () => {
		const adapterOwners = sourceFiles
			.filter((file) =>
				runtimeImports(readFileSync(file, "utf8")).some((specifier) =>
					specifier.startsWith("#/integrations/"),
				),
			)
			.map(projectPath);
		expect(
			adapterOwners.every(
				(file) =>
					file.includes("/server/") ||
					file.startsWith("src/server/") ||
					file.startsWith("src/integrations/"),
			),
		).toBe(true);
		for (const file of sourceFiles) {
			expect(
				runtimeImports(readFileSync(file, "utf8")).some((specifier) =>
					/messages\/(?:en|ja|ko|ru|zh)[^/]*\.json$/.test(specifier),
				),
				projectPath(file),
			).toBe(false);
		}
	});

	it("loads Devtools only in development and preserves automatic route splitting", () => {
		const rootRoute = read("src/routes/__root.tsx");
		expect(rootRoute).toMatch(
			/import\.meta\.env\.DEV\s*\?\s*lazy\(\(\)\s*=>\s*import\("#\/components\/development-tools"\)\)/,
		);
		expect(read("vite.config.ts")).not.toMatch(
			/manualChunks|splitVendorChunk|rollupOptions/,
		);
	});

	it("loads dashboard charts through the dashboard-owned lazy boundary", () => {
		const dashboard = read("src/features/dashboard/pages/admin.tsx");
		expect(dashboard).toMatch(
			/lazy\(\(\)\s*=>\s*import\("#\/features\/dashboard\/components\/order-trend-chart"\)/,
		);
		expect(dashboard).not.toMatch(/import\s+\{\s*OrderTrendChart\s*\}\s+from/);
	});

	it("keeps optional Scalar localhost tooling disabled on the public reference", () => {
		const reference = read("src/features/docs/api-reference-client.tsx");
		expect(reference).toContain(
			"https://cdn.jsdmirror.com/npm/@scalar/api-reference@1.62.5/dist/browser/standalone.js",
		);
		expect(reference).toContain("sha384-");
		expect(reference).toMatch(/agent:\s*\{\s*disabled:\s*true\s*\}/);
		expect(reference).toMatch(/showDeveloperTools:\s*"never"/);
		expect(reference).toMatch(/hideClientButton:\s*true/);
		expect(reference).toMatch(/hideTestRequestButton:\s*true/);
		expect(reference).toMatch(/telemetry:\s*false/);
		expect(reference).not.toContain("MutationObserver");
		expect(reference).not.toContain("key={resolvedTheme}");
	});

	it("registers the GSAP browser plugin only when a DOM exists", () => {
		expect(
			read("src/features/auth/components/animated-characters.tsx"),
		).toMatch(
			/if \(typeof document !== "undefined"\) \{\s*gsap\.registerPlugin\(useGSAP\);\s*\}/,
		);
	});

	it("loads one global stylesheet and only supported font subsets", () => {
		expect(runtimeImportOwners("../styles/global.css?url")).toEqual([
			"src/routes/__root.tsx",
		]);
		const css = read("src/styles/global.css");
		expect(css).not.toMatch(/@import\s+["']@fontsource-variable\//);
		expect(css.match(/@font-face\s*\{/g)).toHaveLength(8);
		const fontSources = [
			...css.matchAll(/url\("(@fontsource-variable\/.+?\.woff2)"\)/g),
		]
			.map((match) => match[1])
			.filter((source): source is string => Boolean(source));
		expect(fontSources).toHaveLength(8);
		for (const source of fontSources)
			expect(resolveModule(source)).toBeTruthy();
		expect(css).not.toMatch(
			/(?:cyrillic-ext|devanagari|greek|latin-ext|vietnamese)-wght-normal/,
		);
	});

	it("does not introduce list virtualization without browser evidence", () => {
		const packageManifest = read("package.json");
		expect(packageManifest).not.toMatch(/react-virtual|virtualizer/);
		for (const file of sourceFiles) {
			expect(readFileSync(file, "utf8"), projectPath(file)).not.toMatch(
				/\buseVirtualizer\b|from\s+["'][^"']*react-virtual/,
			);
		}
	});
});

describe("Worker top-level initialization", () => {
	it("keeps static client assets out of Worker-owned source", () => {
		const staticAssetPattern =
			/\.(?:css|gif|jpe?g|json|png|svg|webp|woff2?|ya?ml)(?:\?|$)/;
		const imports = workerSourceFiles.flatMap((file) =>
			moduleSpecifiers(file)
				.filter((specifier) => staticAssetPattern.test(specifier))
				.map((specifier) => `${projectPath(file)} -> ${specifier}`),
		);
		expect(imports).toEqual([]);
		expect(
			sourceFiles.some((file) =>
				readFileSync(file, "utf8").includes("serveStaticAsset"),
			),
		).toBe(false);
	});

	it("does not perform binding I/O or construct provider clients at module load", () => {
		for (const file of workerSourceFiles) {
			const source = ts.createSourceFile(
				file,
				readFileSync(file, "utf8"),
				ts.ScriptTarget.Latest,
				true,
				file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
			);
			visit(source, (node) => {
				if (
					isBindingIo(node) ||
					isRuntimeConstruction(node) ||
					isProviderConstruction(node)
				) {
					expect(hasFunctionAncestor(node), projectPath(file)).toBe(true);
				}
			});
		}
	});
});

function runtimeImportOwners(specifier: string) {
	return sourceFiles
		.filter((file) =>
			runtimeImports(readFileSync(file, "utf8")).includes(specifier),
		)
		.map(projectPath)
		.sort();
}

function runtimeImports(source: string) {
	return ts
		.createSourceFile(
			"imports.tsx",
			source,
			ts.ScriptTarget.Latest,
			false,
			ts.ScriptKind.TSX,
		)
		.statements.flatMap((statement) =>
			ts.isImportDeclaration(statement) &&
			statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
			ts.isStringLiteral(statement.moduleSpecifier)
				? [statement.moduleSpecifier.text]
				: [],
		);
}

function moduleSpecifiers(file: string) {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	return source.statements.flatMap((statement) => {
		if (
			(ts.isImportDeclaration(statement) ||
				ts.isExportDeclaration(statement)) &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			return [statement.moduleSpecifier.text];
		}
		return [];
	});
}

function isBindingIo(node: ts.Node) {
	if (
		!ts.isCallExpression(node) ||
		!ts.isPropertyAccessExpression(node.expression)
	) {
		return false;
	}
	const owner = node.expression.expression.getText();
	const operation = node.expression.name.text;
	return (
		(owner.endsWith(".DB") && operation === "prepare") ||
		(owner.endsWith(".CACHE") &&
			["get", "put", "delete"].includes(operation)) ||
		(owner.endsWith(".FILES") &&
			["get", "put", "delete"].includes(operation)) ||
		(owner.endsWith("_QUEUE") && operation === "send")
	);
}

function isProviderConstruction(node: ts.Node) {
	if (!ts.isNewExpression(node)) return false;
	return /(?:Adapter|Api|Bot)$/.test(node.expression.getText());
}

function isRuntimeConstruction(node: ts.Node) {
	if (!ts.isCallExpression(node)) return false;
	return [
		"betterAuth",
		"createAuth",
		"createTelegramApi",
		"drizzle",
		"fetch",
	].includes(node.expression.getText());
}

function hasFunctionAncestor(node: ts.Node) {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isFunctionLike(current)) return true;
		if (ts.isSourceFile(current)) return false;
	}
	return false;
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void) {
	inspect(node);
	node.forEachChild((child) => visit(child, inspect));
}

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}

function projectPath(file: string) {
	return relative(root, file).replaceAll("\\", "/");
}

function collectSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectSourceFiles(path);
		return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
	});
}
