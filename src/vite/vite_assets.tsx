/**
 * A minimal integration bridging Hono/JSX SSR and frontend builds (Vite).
 *
 * Takes inspiration from `vite-ssr-components` but **does not re-export it**;
 * this is an independent implementation. The biggest difference is that it does
 * not adopt **automatic entry discovery** via AST traversal of all sources.
 * Instead it follows an "explicit declaration + manifest resolution +
 * fail-closed" approach: the app explicitly passes an entry name (e.g. via
 * `<Script name="..." />`), and in production that name is resolved against
 * `manifest.json`. An unknown entry is rejected fail-closed
 * by throwing `ViteEntryNotFoundError`.
 *
 * The dev/prod branch is not sniffed from `import.meta.env` inside this module.
 * The caller explicitly specifies it via `ViteAssetsOptions.mode`. The `vite`
 * package itself is not imported either (the manifest shape is received via the
 * self-contained `ViteManifest` structural type from `./manifest.js`).
 */
import type { JSX } from "hono/jsx";
import type { ViteManifest } from "./manifest.js";

export type ViteAssetsMode = "development" | "production";

export type ViteAssetsOptions = {
	/** Explicit dev/prod selection. This library never sniffs `import.meta.env`. */
	mode: ViteAssetsMode;
	/** The manifest, required in production. Ignored in development. */
	manifest?: ViteManifest;
	/** The prefix for output/source paths. Defaults to `"/"`. */
	base?: string;
};

/** Error thrown when `resolveEntry` is given an unknown entry name in production. */
export class ViteEntryNotFoundError extends Error {
	constructor(name: string) {
		super(
			`Entry "${name}" was not found in the Vite manifest. Check that it matches an entry name explicitly declared in build.rollupOptions.input.`,
		);
		this.name = "ViteEntryNotFoundError";
	}
}

/** The return value of `resolveEntry`. Separates the entry's own JS from its associated CSS and preload targets. */
export type ResolvedViteEntry = {
	js: string;
	css: string[];
	imports: string[];
};

/** A pure function that joins `base` and a path without producing a double slash. */
const joinBase = (base: string, path: string): string => {
	const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
	const trimmedPath = path.startsWith("/") ? path.slice(1) : path;
	return `${trimmedBase}/${trimmedPath}`;
};

type ScriptAttrs = Omit<JSX.IntrinsicElements["script"], "type" | "src">;
type LinkAttrs = Omit<JSX.IntrinsicElements["link"], "rel" | "href">;
type ImgAttrs = Omit<JSX.IntrinsicElements["img"], "src">;

export type ScriptProps = {
	/** An entry name explicitly declared in `build.rollupOptions.input`. */
	name: string;
	/** Whether to also emit a `modulepreload` link in production. Defaults to `true`. */
	preload?: boolean;
} & ScriptAttrs;

export type LinkProps = {
	/** A CSS entry name explicitly declared in `build.rollupOptions.input`. */
	name: string;
} & LinkAttrs;

export type ImgProps = {
	/** An image entry name explicitly declared in the manifest (or the source path in development). */
	name: string;
} & ImgAttrs;

/**
 * A class providing `<Script>`/`<Link>`/`<ViteClient>`. Components are arrow
 * function class fields (so `this` remains accessible even when they are
 * destructured out and passed around).
 */
export class ViteAssets {
	private readonly mode: ViteAssetsMode;
	private readonly manifest?: ViteManifest;
	private readonly base: string;

	constructor(options: ViteAssetsOptions) {
		if (options.mode === "production" && options.manifest === undefined) {
			throw new Error(
				'ViteAssets: a manifest is required when mode is "production" (load manifest.json with parseViteManifest and pass it in).',
			);
		}
		this.mode = options.mode;
		this.manifest = options.manifest;
		this.base = options.base ?? "/";
	}

	/**
	 * The primitive that resolves an arbitrary manifest entry to a single
	 * fingerprinted URL. In development, the manifest is not consulted and
	 * `name` is treated as the source path as-is. In production, it resolves
	 * from the manifest, throwing
	 * `ViteEntryNotFoundError` if not found (fail-closed). `resolveEntry` reuses
	 * this same primitive for JS resolution.
	 */
	asset = (name: string): string => {
		if (this.mode === "development") {
			return joinBase(this.base, name);
		}

		const manifest = this.manifest;
		if (!manifest) {
			throw new Error("ViteAssets: the production manifest has not been initialized.");
		}

		const chunk = manifest[name];
		if (!chunk) {
			throw new ViteEntryNotFoundError(name);
		}

		return joinBase(this.base, chunk.file);
	};

	/**
	 * Resolves an entry name to its actual path. In development, the manifest is
	 * not consulted and `name` is treated as the source path as-is. In
	 * production, it resolves from the manifest, throwing
	 * `ViteEntryNotFoundError` if not found (fail-closed). Resolution of
	 * `imports` is best-effort (keys missing from the manifest are skipped,
	 * since a missing preload is not fatal).
	 */
	resolveEntry = (name: string): ResolvedViteEntry => {
		if (this.mode === "development") {
			return { js: this.asset(name), css: [], imports: [] };
		}

		const manifest = this.manifest;
		if (!manifest) {
			throw new Error("ViteAssets: the production manifest has not been initialized.");
		}

		const chunk = manifest[name];
		if (!chunk) {
			throw new ViteEntryNotFoundError(name);
		}

		const imports = (chunk.imports ?? [])
			.map((key) => manifest[key])
			.filter((imported) => imported !== undefined)
			.map((imported) => joinBase(this.base, imported.file));

		return {
			js: this.asset(name),
			css: (chunk.css ?? []).map((cssFile) => joinBase(this.base, cssFile)),
			imports,
		};
	};

	/**
	 * Renders the script tag for an entry. In production, also emits `<link>`
	 * tags for CSS and (when `preload` defaults to `true`) `modulepreload`.
	 */
	Script = ({ name, preload = true, ...rest }: ScriptProps) => {
		if (this.mode === "development") {
			return <script type="module" src={this.resolveEntry(name).js} {...rest} />;
		}

		const { js, css, imports } = this.resolveEntry(name);
		return (
			<>
				<script type="module" src={js} {...rest} />
				{css.map((href) => (
					<link rel="stylesheet" href={href} />
				))}
				{preload && imports.map((href) => <link rel="modulepreload" href={href} />)}
			</>
		);
	};

	/** Renders a `<link rel="stylesheet">` for a CSS entry. */
	Link = ({ name, ...rest }: LinkProps) => {
		const href =
			this.mode === "development" ? joinBase(this.base, name) : this.resolveEntry(name).js;
		return <link rel="stylesheet" href={href} {...rest} />;
	};

	/**
	 * Renders an `<img>` for an image entry.
	 * `name` is the app's explicitly declared asset entry name; `src` is
	 * excluded from rest since it is managed by `asset()`.
	 */
	Img = ({ name, ...rest }: ImgProps) => <img src={this.asset(name)} {...rest} />;

	/**
	 * The Vite dev server client injection script (`/@vite/client`). Renders
	 * only in development; renders nothing (`null`) in production.
	 */
	ViteClient = () => {
		if (this.mode === "development") {
			return <script type="module" src={joinBase(this.base, "@vite/client")} />;
		}
		return null;
	};
}
