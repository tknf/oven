/**
 * Standard Schema-based form validation layer.
 * Bundles "validation + (default view HTML handled by `form_field.tsx`)" into a
 * single vocabulary. Users are free to pick any schema library (zod/valibot/etc.)
 * (this module only depends on the `@standard-schema/spec` types, the same
 * approach as `validateEnv` in `env_validation.ts`).
 *
 * ## Input type
 * Accepts field values as-is in the shape returned by Hono's `c.req.parseBody()`
 * (`string | File | (string | File)[]`).
 *
 * ## Trim contract (design decision)
 * **String values are automatically trimmed of leading/trailing whitespace inside
 * `validate()`**. Callers do not need to trim individually. Array values are
 * trimmed element-by-element (string elements only). `File` values are left
 * untouched. `trimFormInput` does not mutate `input`; it returns a new object.
 *
 * ## Error shape
 * Normalizes errors into `FormError` as `{ field, message }[]`. `toFormErrors`
 * converts from Standard Schema `issues` (`path`/`message`): it takes the first
 * element of `path` as the field name (anything beyond the first level of a
 * nested path is discarded, since a form field corresponds to a single HTML
 * `name`, unlike `config.ts`'s `formatPath` which dot-joins). An issue without a
 * `path` (or an empty one) — a validation error on the object as a whole — uses
 * `FORM_BASE_ERROR_FIELD` (`"base"`) as its `field`, following the convention for
 * whole-object errors.
 *
 * ## Supporting both the success and failure flow
 * - **Re-render the same response with 422**: a failed `validate()` result
 *   includes `values` (the trimmed input itself) in addition to `errors`, so
 *   callers don't need to build a `values` object for re-rendering by hand.
 * - **Re-render after flash + redirect**: `flashFormErrors` pushes state into the
 *   `Session` (`session.ts`), and the next GET handler retrieves it with
 *   `consumeFlashedFormState`. `File` values cannot be flashed (browsers can't
 *   re-populate `input[type=file]` from JS, so there'd be no point reproducing
 *   them — `toOldFormInput` drops them).
 * - On success, respond with a 303 PRG (a Turbo Drive requirement); this module
 *   does not enforce it in code — it's a convention for the calling handler.
 *
 * ## Field metadata (`bind`/`FormBinding`/`BoundField`)
 * Standard Schema doesn't expose field lists, labels, hints, or other metadata
 * (it's validation-only by spec), so field declarations live on the `Form` class
 * itself via `fields()` (the schema stays validation-only and unchanged). `bind()`
 * returns a `FormBinding` that bundles the validation result (`errors`/`values`)
 * with the field declarations, so `FormField`/`FormView` in `form_field.tsx` can
 * render the default view from that alone (callers no longer need to manually
 * wire `FormError[]` to fields).
 *
 * ## The `widget` vocabulary
 * The discriminant key on `FieldDef`/`BoundField` is called `widget`. Since
 * validation is entirely Standard Schema's job, this axis purely represents
 * "which form control to render as."
 *
 * ## The prefix round trip between validate/bind
 * To avoid name collisions when placing multiple forms of the same kind on one
 * page, `bind({ prefix })` prepends `${prefix}-` to the rendered name/id. Since
 * the browser submits using the prefixed name, `Form#validate(input, { prefix })`
 * **strips `${prefix}-`** before passing input to the schema, restoring the raw
 * keys. Only keys starting with `${prefix}-` are stripped; non-matching keys are
 * discarded (as belonging to another form). Meanwhile `errors` come from the
 * schema (which only knows raw keys), so when `bind` re-prefixes name/id for
 * display, it **matches `errors`' field against the raw name** (matching against
 * the prefixed key would fail to line up). In summary: `validate(input, { prefix })`
 * strips the prefix → schema validation → `bind({ prefix, errors, values })`
 * re-adds it for display — one round trip.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Session } from "../session/session.js";

/** A single field's value, as returned by `c.req.parseBody()`. */
export type FormInputValue = string | File | (string | File)[] | undefined;

/** The type of the result of `c.req.parseBody()` itself. The input `Form#validate` accepts. */
export type FormInput = Record<string, FormInputValue>;

/** A single validation error, normalized as `{ field, message }[]`. */
export type FormError = { field: string; message: string };

/**
 * The `field` used for a Standard Schema issue that has no `path` (i.e. an
 * error on the object as a whole), following the convention of collapsing
 * whole-object errors into a single key.
 */
export const FORM_BASE_ERROR_FIELD = "base";

/**
 * The result of `Form#validate`. On success, returns the validated (and
 * schema-transformed) `value`. On failure, returns `errors` plus the trimmed
 * input `values` (so callers can pass it straight to the view when
 * re-rendering the same response).
 */
export type FormResult<Output> =
	| { ok: true; value: Output }
	| { ok: false; errors: FormError[]; values: FormInput };

/** Trims only the string parts of `value` (leaves `File` untouched, processes arrays element-by-element). */
const trimFormValue = (value: FormInputValue): FormInputValue => {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		return value.map((item) => (typeof item === "string" ? item.trim() : item));
	}
	return value;
};

/**
 * Returns a new object with `input`'s string values (including string elements
 * inside arrays) trimmed of leading/trailing whitespace. Does not mutate `input`.
 */
export const trimFormInput = (input: FormInput): FormInput =>
	Object.fromEntries(Object.entries(input).map(([key, value]) => [key, trimFormValue(value)]));

/**
 * Returns a new object with the `${prefix}-` prefix stripped from `input`'s keys
 * (see the module JSDoc "The prefix round trip between validate/bind"). Keys
 * that don't match the prefix are discarded as belonging to another form.
 */
const stripPrefix = (input: FormInput, prefix: string): FormInput => {
	const marker = `${prefix}-`;
	const result: FormInput = {};
	for (const [key, value] of Object.entries(input)) {
		if (key.startsWith(marker)) result[key.slice(marker.length)] = value;
	}
	return result;
};

/**
 * Converts a scalar value (string/number/bigint/boolean) to a string usable as
 * a `FormInputValue`. Returns `undefined` for object/null/undefined (avoiding
 * the `"[object Object]"` pitfall of `String(value)`).
 */
const scalarToString = (value: unknown): string | undefined => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
};

/** Converts the first element of a Standard Schema `issue.path` into a `field` name string. */
const fieldFromPath = (path: StandardSchemaV1.Issue["path"]): string => {
	if (!path || path.length === 0) return FORM_BASE_ERROR_FIELD;
	const [first] = path;
	return String(typeof first === "object" ? first.key : first);
};

/** Converts Standard Schema `issues` to `FormError[]`. */
export const toFormErrors = (issues: ReadonlyArray<StandardSchemaV1.Issue>): FormError[] =>
	issues.map((issue) => ({ field: fieldFromPath(issue.path), message: issue.message }));

/** A single option for `select`/`radio-group`/`checkbox-group`. */
export type SelectOption = { value: string; label: string };

/** Arbitrary attributes spread directly onto the native HTML element. */
export type FieldAttrs = Record<string, string | number | boolean>;

/**
 * Field metadata common to all widgets.
 * - `placeholder`/`readonly` only make sense for text-like widgets
 *   (`input`/`textarea`), but live in the common part of the type since
 *   `FormField` can simply ignore them where irrelevant (splitting the type per
 *   widget buys type-safe value resolution/render branching via a discriminated
 *   union, not narrowing the meaning of each individual property).
 * - `initial` is used as the initial value for a "create" form. For
 *   `input`/`textarea`/`select`/`radio-group`/`checkbox-group`/`hidden`, it's
 *   decided by **per-field** key presence (`Object.hasOwn(values, name)`) —
 *   falling back to `initial` only when `values` has no key for that field.
 *   `checkbox`'s `checked` resolution alone uses a different criterion: whether
 *   the `values` option itself was passed to `Form#bind` (`FormBinding`'s
 *   `hasValuesOption`). If `values` was passed (i.e. this is a re-render of a
 *   submitted form), the existing rule "key present = checked" is kept even
 *   when that checkbox's key is absent, ignoring `initial`. The asymmetric
 *   criterion exists because falling back to `initial` when **`values` has
 *   other fields' values but is missing this checkbox's key** (i.e. the user
 *   unchecked it and submitted an edit form) would cause the bug of "unchecked
 *   but comes back checked."
 * - `attrs` is spread onto `FormField`'s control element (input/textarea/select,
 *   or each option's input for group widgets). When an `attrs` key collides
 *   with an explicit prop like `disabled`/`readonly`/`autofocus`, **`attrs`
 *   wins**.
 */
type FieldDefBase = {
	label: string;
	hint?: string;
	required?: boolean;
	autocomplete?: string;
	placeholder?: string;
	initial?: string | string[] | boolean;
	disabled?: boolean;
	readonly?: boolean;
	autofocus?: boolean;
	attrs?: FieldAttrs;
};

/**
 * Values `input[inputmode]` can take (matches the same literal union as
 * hono/jsx's `HTMLAttributes.inputmode` in `intrinsic-elements.d.ts` — a plain
 * `string` type would cause a type mismatch when `FormField` passes it straight
 * through to JSX).
 */
export type InputMode =
	| "none"
	| "text"
	| "tel"
	| "url"
	| "email"
	| "numeric"
	| "decimal"
	| "search";

/** `input`-specific validation constraint attributes (kept in sync with server-side validation for HTML native validation). */
type InputConstraints = {
	minLength?: number;
	maxLength?: number;
	min?: string | number;
	max?: string | number;
	step?: string | number;
	pattern?: string;
	inputmode?: InputMode;
	/** For `type: "file"`. */
	accept?: string;
	multiple?: boolean;
};

/**
 * A single field's declaration.
 * `Form#fields()` returns a record of this type, and `bind()` bundles it with
 * validation results to build a `BoundField`. It's a discriminated union on
 * `widget`, carrying type-safe `textarea`/`select`/`checkbox`/`radio-group`/
 * `checkbox-group`/`hidden`-specific info (`options`/`multiple`/`rows`, etc.).
 * When `widget` is omitted, it's treated as `"input"` (for backward compatibility).
 */
export type FieldDef =
	| (FieldDefBase & ({ widget?: "input"; type?: string } & InputConstraints))
	| (FieldDefBase & {
			widget: "textarea";
			rows?: number;
			minLength?: number;
			maxLength?: number;
			cols?: number;
	  })
	| (FieldDefBase & {
			widget: "select";
			options: SelectOption[];
			multiple?: boolean;
			size?: number;
	  })
	| (FieldDefBase & { widget: "checkbox" })
	| (FieldDefBase & { widget: "radio-group"; options: SelectOption[] })
	| (FieldDefBase & { widget: "checkbox-group"; options: SelectOption[] })
	| (FieldDefBase & { widget: "hidden" });

/**
 * Abstract base class that bundles Standard Schema-based form validation into
 * a single vocabulary. Subclasses implement `schema()` (used for validation)
 * and the field declarations `fields()` (a design that consolidates
 * "validation + default view" into a single class; the view side is handled
 * by `form_field.tsx`).
 *
 * ```ts
 * class RedeemCodeForm extends Form<typeof redeemCodeSchema, "code"> {
 *   protected schema() { return redeemCodeSchema; }
 *   protected fields() {
 *     return { code: { label: "Serial code", hint: "Enter the code printed in your book." } };
 *   }
 * }
 *
 * const result = await new RedeemCodeForm().validate(await c.req.parseBody());
 * const binding = new RedeemCodeForm().bind(result.ok ? undefined : result);
 * ```
 */
export abstract class Form<S extends StandardSchemaV1, FieldName extends string = string> {
	/** The Standard Schema this form uses. Evaluated on every call (a method, not a field). */
	protected abstract schema(): S;

	/** This form's field declarations. Object key order determines display order in the default view. */
	protected abstract fields(): Record<FieldName, FieldDef>;

	/**
	 * Validates `input`. String values are trimmed before validation (see the
	 * module JSDoc "Trim contract"). When `options.prefix` is given, the
	 * `${prefix}-` prefix is stripped before trimming and passing to the schema
	 * (see the module JSDoc "The prefix round trip between validate/bind").
	 * Standard Schema's `validate` may return sync or async, so both are
	 * awaited uniformly (the same approach as `validateEnv` in `env_validation.ts`).
	 */
	async validate(
		input: FormInput,
		options?: { prefix?: string },
	): Promise<FormResult<StandardSchemaV1.InferOutput<S>>> {
		const unprefixed = options?.prefix ? stripPrefix(input, options.prefix) : input;
		const values = trimFormInput(unprefixed);
		const rawResult = this.schema()["~standard"].validate(values);
		const result = rawResult instanceof Promise ? await rawResult : rawResult;

		if (result.issues) return { ok: false, errors: toFormErrors(result.issues), values };
		return { ok: true, value: result.value };
	}

	/**
	 * Returns a `FormBinding` that bundles the field declarations with the
	 * validation result (if any). When `state` is omitted, builds the initial
	 * display view (no errors, no values). `state.values` accepts either the
	 * `values` (`FormInput`) from a failed `validate()` result, or the `values`
	 * (`OldFormInput`) from `consumeFlashedFormState`. When `state.prefix` is
	 * given, `${prefix}-` is prepended to name/id, and `values` is also looked
	 * up by the prefixed key (since the HTML form submits with the prefixed
	 * name). `errors` field matching still uses the raw name (see the module
	 * JSDoc "The prefix round trip between validate/bind").
	 */
	bind(state?: {
		errors?: FormError[];
		values?: FormInput | OldFormInput;
		prefix?: string;
	}): FormBinding<FieldName> {
		return new FormBinding(
			this.fields(),
			state?.errors ?? [],
			state?.values ?? {},
			state?.values !== undefined,
			state?.prefix,
		);
	}

	/**
	 * Converts a single DB row `record` into a `FormInput` that can be passed
	 * straight to `bind({ values })`. Intended for admin edit forms
	 * (`form.bind({ values: form.toInput(row) })`). Keys use the raw declared
	 * names (no prefix, since `toInput` runs before `bind`). Conversion rules
	 * per widget:
	 * - `checkbox`: sets `"on"` when `record[name]` is truthy; omits the key
	 *   entirely when falsy (mirrors the HTML submission behavior where an
	 *   unchecked checkbox sends no key at all, since `FormBinding`'s `checked`
	 *   is decided by key presence).
	 * - `checkbox-group` and `select` (`multiple: true`): if an array, keeps
	 *   only string elements as `string[]`; if a scalar, wraps it as a
	 *   single-element `string[]`. null/undefined omit the key.
	 * - Everything else (`select` single/`radio-group`/`hidden`/`input`/
	 *   `textarea`, and `widget` omitted meaning `"input"`): sets the key only
	 *   when `scalarToString` can produce a single string; otherwise (object,
	 *   null, undefined) the key is omitted, deferring to the `initial` fallback.
	 * None of the branches assign `undefined` to a key (since `hasValue`
	 * checking is based on `Object.hasOwn`, an assigned-but-`undefined` key
	 * would defeat the `initial` fallback).
	 */
	toInput(record: Record<string, unknown>): FormInput {
		const result: FormInput = {};
		const declarations = this.fields();
		for (const name of Object.keys(declarations) as FieldName[]) {
			const def = declarations[name];
			const raw = record[name];

			if (def.widget === "checkbox") {
				if (raw) result[name] = "on";
				continue;
			}

			if (def.widget === "checkbox-group" || (def.widget === "select" && def.multiple)) {
				if (raw === null || raw === undefined) continue;
				if (Array.isArray(raw)) {
					result[name] = raw.filter((item): item is string => typeof item === "string");
				} else {
					const value = scalarToString(raw);
					if (value !== undefined) result[name] = [value];
				}
				continue;
			}

			const value = scalarToString(raw);
			if (value !== undefined) result[name] = value;
		}
		return result;
	}
}

/** Collects only the messages whose `field` matches, in declaration order (i.e. input array order). */
export const errorsFor = (errors: FormError[], field: string): string[] =>
	errors.filter((error) => error.field === field).map((error) => error.message);

/**
 * Extracts only the string elements when `value` (either the `FormInputValue`
 * from a failed `validate()` result, or the `OldFormInputValue` from
 * `consumeFlashedFormState`) is an array value (ignores mixed-in `File`s). A
 * single string value is not included in `BoundField#values` (`values` is
 * exclusively for array-valued fields; per spec, single values only populate
 * `value`).
 */
const arrayStringValuesOf = (value: FormInputValue | OldFormInputValue | undefined): string[] => {
	if (!Array.isArray(value)) return [];
	const strings: string[] = [];
	for (const item of value) if (typeof item === "string") strings.push(item);
	return strings;
};

/**
 * Resolves a single string value from `rawValue` (used by `radio-group` and
 * single-select `select`). Returns the string itself if it is one, the first
 * string element if it's an array, or `""` if neither.
 */
const singleStringValueOf = (value: FormInputValue | OldFormInputValue | undefined): string => {
	if (typeof value === "string") return value;
	return arrayStringValuesOf(value)[0] ?? "";
};

/**
 * Resolves the `initial` fallback (for single-value widgets) when `rawValue`
 * is absent. `initial` may be `string | string[] | boolean`, but single-value
 * resolution only uses the string (or, for an array, its first element).
 */
const initialStringValueOf = (initial: string | string[] | boolean | undefined): string => {
	if (typeof initial === "string") return initial;
	if (Array.isArray(initial)) return initial[0] ?? "";
	return "";
};

/** Resolves a string array from `initial` (for array-valued widgets). A single string becomes a one-element array. */
const initialArrayValueOf = (initial: string | string[] | boolean | undefined): string[] => {
	if (Array.isArray(initial)) return initial;
	if (typeof initial === "string") return [initial];
	return [];
};

/**
 * Determines whether `rawValue` represents a checked `checkbox`. Based on
 * actual HTML form submission behavior (an unchecked checkbox sends no `name`
 * key at all), treats "the key is present and has a value" itself as checked
 * (the value isn't necessarily fixed to `"on"` — a checkbox with an explicit
 * `value` attribute sends an arbitrary string, so this check doesn't look at
 * the value's contents).
 */
const isCheckedValue = (value: FormInputValue | OldFormInputValue | undefined): boolean => {
	if (value === undefined) return false;
	if (typeof value === "string") return true;
	if (Array.isArray(value)) return value.length > 0;
	return true;
};

/**
 * A table deriving only the `autocomplete` defaults that HTML spec uniquely
 * determines from `input[type]`. `password` is intentionally excluded since
 * `type` alone can't distinguish `new-password` from `current-password`
 * (left unspecified, deferring to the browser default).
 */
const AUTOCOMPLETE_DEFAULTS_BY_TYPE: Readonly<Record<string, string>> = {
	email: "email",
	tel: "tel",
	url: "url",
};

/** Resolves the `autocomplete` default for `def` (an `input` declaration). An explicit value always wins. */
const resolveAutocomplete = (def: FieldDef): string | undefined => {
	if (def.autocomplete) return def.autocomplete;
	if (def.widget === undefined || def.widget === "input") {
		return def.type ? AUTOCOMPLETE_DEFAULTS_BY_TYPE[def.type] : undefined;
	}
	return undefined;
};

/** Builds the `BoundField` common part (hintId/errorId/describedBy) from `id`, `hint`, and `fieldErrors`. */
const resolveDescribedBy = (
	id: string,
	hint: string | undefined,
	fieldErrors: string[],
): { hintId: string | undefined; errorId: string | undefined; describedBy: string | undefined } => {
	const hintId = hint ? `${id}-hint` : undefined;
	const errorId = fieldErrors[0] ? `${id}-error` : undefined;
	const describedBy = [hintId, errorId].filter((part) => part !== undefined).join(" ") || undefined;
	return { hintId, errorId, describedBy };
};

/** `BoundField` metadata common to all widgets. */
type BoundFieldBase = {
	name: string;
	/** `id` of the input/textarea/select/fieldset element. Defaults to the same value as `name` (prefixed when a prefix is given). */
	id: string;
	label: string;
	error: string | undefined;
	errors: string[];
	/** `true` when this field has no error. */
	valid: boolean;
	hint: string | undefined;
	hintId: string | undefined;
	errorId: string | undefined;
	/** Whichever of hint/error ids exist, joined by a space (hint first). `undefined` when neither exists. */
	describedBy: string | undefined;
	required: boolean | undefined;
	placeholder: string | undefined;
	disabled: boolean | undefined;
	readonly: boolean | undefined;
	autofocus: boolean | undefined;
	/** Arbitrary attributes spread directly onto the native element. Wins over explicit props on collision (see module JSDoc). */
	attrs: FieldAttrs | undefined;
};

/**
 * Per-field metadata that the view can use directly for rendering. Returned by
 * `FormBinding#field`/`fields`. A discriminated union on `widget`, so
 * `FormField`'s widget-specific render branches can be written type-safely
 * (`options`/`multiple`/`rows`/`checked` only exist per widget, so a
 * discriminated union rejects "combinations impossible for this widget" at
 * the type level, unlike a single type with everything optional).
 */
export type BoundField =
	| (BoundFieldBase & {
			widget: "input";
			type: string;
			value: string;
			autocomplete: string | undefined;
			minLength: number | undefined;
			maxLength: number | undefined;
			min: string | number | undefined;
			max: string | number | undefined;
			step: string | number | undefined;
			pattern: string | undefined;
			inputmode: InputMode | undefined;
			accept: string | undefined;
			multiple: boolean | undefined;
	  })
	| (BoundFieldBase & {
			widget: "textarea";
			value: string;
			rows: number | undefined;
			cols: number | undefined;
			minLength: number | undefined;
			maxLength: number | undefined;
	  })
	| (BoundFieldBase & {
			widget: "select";
			options: SelectOption[];
			multiple: boolean;
			size: number | undefined;
			value: string;
			values: string[];
	  })
	| (BoundFieldBase & { widget: "checkbox"; checked: boolean })
	| (BoundFieldBase & { widget: "radio-group"; options: SelectOption[]; value: string })
	| (BoundFieldBase & { widget: "checkbox-group"; options: SelectOption[]; values: string[] })
	| (BoundFieldBase & { widget: "hidden"; value: string });

/**
 * The bundle of field declarations + validation result returned by
 * `Form#bind`. `FormField`/`FormView` in `form_field.tsx` can render the
 * default view from this alone.
 */
export class FormBinding<FieldName extends string> {
	private readonly declarations: Record<FieldName, FieldDef>;
	private readonly errors: FormError[];
	private readonly values: FormInput | OldFormInput;
	/**
	 * Whether the `values` option itself was passed to `Form#bind` (used only
	 * for `checkbox`'s `checked` resolution; see the `initial` explanation in
	 * the module JSDoc "Field metadata common to all widgets"). While other
	 * widgets' `initial` fallback is decided by per-field key presence, only
	 * `checkbox` is decided by whether `values` was passed to the form at all
	 * (i.e. this is a re-render of a submitted form). Once `values` was
	 * passed, a missing key means the user unchecked it before submitting, so
	 * it does not fall back to `initial`.
	 */
	private readonly hasValuesOption: boolean;
	private readonly prefix: string | undefined;

	constructor(
		declarations: Record<FieldName, FieldDef>,
		errors: FormError[],
		values: FormInput | OldFormInput,
		hasValuesOption: boolean,
		prefix?: string,
	) {
		this.declarations = declarations;
		this.errors = errors;
		this.values = values;
		this.hasValuesOption = hasValuesOption;
		this.prefix = prefix;
	}

	/** Returns the display name/id for `name` (the raw declared name) with the prefix prepended. Returns it unchanged when no prefix is set. */
	private prefixedName(name: FieldName): string {
		return this.prefix ? `${this.prefix}-${name}` : name;
	}

	/**
	 * Returns field metadata for `name`. An arrow-function class field, since
	 * callers (templates) may pass it around by reference. Branches on
	 * `def.widget` and applies the per-widget value resolution rule (checkbox:
	 * checked; checkbox-group/multiple select: values; radio-group/single
	 * select/hidden: value). `values` lookup and name/id display use the
	 * prefixed name, while `errors` matching uses the raw name (see the module
	 * JSDoc "The prefix round trip between validate/bind").
	 */
	field = (name: FieldName): BoundField => {
		const def = this.declarations[name];
		const displayName = this.prefixedName(name);
		const hasValue = Object.hasOwn(this.values, displayName);
		const rawValue = this.values[displayName];
		const fieldErrors = errorsFor(this.errors, name);
		const id = displayName;
		const { hintId, errorId, describedBy } = resolveDescribedBy(id, def.hint, fieldErrors);
		const base = {
			name: displayName,
			id,
			label: def.label,
			error: fieldErrors[0],
			errors: fieldErrors,
			valid: fieldErrors.length === 0,
			hint: def.hint,
			hintId,
			errorId,
			describedBy,
			required: def.required,
			placeholder: def.placeholder,
			disabled: def.disabled,
			readonly: def.readonly,
			autofocus: def.autofocus,
			attrs: def.attrs,
		};

		switch (def.widget) {
			case "textarea": {
				const value = hasValue ? singleStringValueOf(rawValue) : initialStringValueOf(def.initial);
				return {
					...base,
					widget: "textarea",
					value,
					rows: def.rows,
					cols: def.cols,
					minLength: def.minLength,
					maxLength: def.maxLength,
				};
			}
			case "select": {
				const values = hasValue ? arrayStringValuesOf(rawValue) : initialArrayValueOf(def.initial);
				const value = hasValue ? singleStringValueOf(rawValue) : (values[0] ?? "");
				return {
					...base,
					widget: "select",
					options: def.options,
					multiple: def.multiple ?? false,
					size: def.size,
					value,
					values,
				};
			}
			case "checkbox": {
				const checked = this.hasValuesOption ? isCheckedValue(rawValue) : def.initial === true;
				return { ...base, widget: "checkbox", checked };
			}
			case "radio-group": {
				const value = hasValue ? singleStringValueOf(rawValue) : initialStringValueOf(def.initial);
				return { ...base, widget: "radio-group", options: def.options, value };
			}
			case "checkbox-group": {
				const values = hasValue ? arrayStringValuesOf(rawValue) : initialArrayValueOf(def.initial);
				return { ...base, widget: "checkbox-group", options: def.options, values };
			}
			case "hidden": {
				const value = hasValue ? singleStringValueOf(rawValue) : initialStringValueOf(def.initial);
				return { ...base, widget: "hidden", value };
			}
			default: {
				const value = hasValue ? singleStringValueOf(rawValue) : initialStringValueOf(def.initial);
				return {
					...base,
					widget: "input",
					type: def.type ?? "text",
					value,
					autocomplete: resolveAutocomplete(def),
					minLength: def.minLength,
					maxLength: def.maxLength,
					min: def.min,
					max: def.max,
					step: def.step,
					pattern: def.pattern,
					inputmode: def.inputmode,
					accept: def.accept,
					multiple: def.multiple,
				};
			}
		}
	};

	/** Returns all `BoundField`s in declaration order (`fields()` key order). Used by `FormView` for render order. */
	fields(): BoundField[] {
		return (Object.keys(this.declarations) as FieldName[]).map((name) => this.field(name));
	}

	/** Returns all `BoundField`s with `widget !== "hidden"` in declaration order. Used by `FormView` to render visible fields. */
	visibleFields(): BoundField[] {
		return this.fields().filter((field) => field.widget !== "hidden");
	}

	/** Returns all `BoundField`s with `widget === "hidden"` in declaration order. Used by `FormView` to place them right after CSRF. */
	hiddenFields(): BoundField[] {
		return this.fields().filter((field) => field.widget === "hidden");
	}

	/** The list of error messages addressed to `FORM_BASE_ERROR_FIELD` (`"base"`). Used by `FormView`'s whole-form error block. */
	baseErrors(): string[] {
		return errorsFor(this.errors, FORM_BASE_ERROR_FIELD);
	}

	/**
	 * Returns a unique `id` for the whole-form error block when `baseErrors()`
	 * has at least one entry (wired to `aria-describedby` by `FormView`).
	 * Returns `undefined` when there are none.
	 */
	formErrorId(): string | undefined {
		if (this.baseErrors().length === 0) return undefined;
		return `${this.prefix ?? "form"}-errors`;
	}
}

/** A single field's value for old input (used to re-render after flash). `File` can't be represented (see module JSDoc). */
export type OldFormInputValue = string | string[];

/** The type of old input pushed to flash. `toOldFormInput` builds it from `FormInput` with `File` values removed. */
export type OldFormInput = Record<string, OldFormInputValue>;

/** Builds an `OldFormInput` from `input` with `File` values removed (arrays keep only their string elements). */
export const toOldFormInput = (input: FormInput): OldFormInput => {
	const result: OldFormInput = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "string") {
			result[key] = value;
			continue;
		}
		if (Array.isArray(value)) {
			const strings = value.filter((item): item is string => typeof item === "string");
			if (strings.length > 0) result[key] = strings;
		}
	}
	return result;
};

/** The state for one flash round trip, pushed by `flashFormErrors` and retrieved by `consumeFlashedFormState`. */
export type FlashedFormState = { errors: FormError[]; values: OldFormInput };

/**
 * Flash key names (reserved under `__oven_form_*__` so they don't collide with
 * the app's own session data. Note this is a separate reservation layer from
 * `session.ts`'s own flash key reservation `__flash_${key}__`).
 */
const ERRORS_FLASH_KEY = "__oven_form_errors__";
const VALUES_FLASH_KEY = "__oven_form_old_input__";

/**
 * Pushes a `Form#validate` failure result to `session`'s flash.
 * The caller should then redirect with 303, and call
 * `consumeFlashedFormState` in the destination GET handler to retrieve it.
 */
export const flashFormErrors = <Output>(
	session: Session,
	result: Extract<FormResult<Output>, { ok: false }>,
): void => {
	session.flash(ERRORS_FLASH_KEY, result.errors);
	session.flash(VALUES_FLASH_KEY, toOldFormInput(result.values));
};

/** Whether `value` has a shape usable as a `FormError`. */
const isFormError = (value: unknown): value is FormError =>
	typeof value === "object" &&
	value !== null &&
	"field" in value &&
	"message" in value &&
	typeof value.field === "string" &&
	typeof value.message === "string";

/** Whether `value` has a shape usable as a `FormError[]`. */
const isFormErrorArray = (value: unknown): value is FormError[] =>
	Array.isArray(value) && value.every(isFormError);

/** Whether `value` has a shape usable as an `OldFormInputValue` (a string, or an array of only strings). */
const isOldFormInputValue = (value: unknown): value is OldFormInputValue =>
	typeof value === "string" ||
	(Array.isArray(value) && value.every((item) => typeof item === "string"));

/** Whether `value` has a shape usable as an `OldFormInput`. */
const isOldFormInput = (value: unknown): value is OldFormInput =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every(isOldFormInputValue);

/**
 * Retrieves the validation errors and old input pushed by `flashFormErrors`.
 * Consume-once, like `Session#get`'s flash handling (cleared by this call).
 * Returns `null` when nothing was flashed (e.g. a normal GET request) or the
 * stored value's shape is malformed.
 */
export const consumeFlashedFormState = (session: Session): FlashedFormState | null => {
	const errors = session.get(ERRORS_FLASH_KEY);
	const values = session.get(VALUES_FLASH_KEY);
	if (!isFormErrorArray(errors) || !isOldFormInput(values)) return null;
	return { errors, values };
};
