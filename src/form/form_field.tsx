/**
 * The form's default view parts. Bundles the boilerplate block — label +
 * input + `aria-invalid` + `aria-describedby` + a `role="alert"` error
 * message — into a single function that accepts `form.ts`'s `FormBinding`/
 * `BoundField` (metadata bundling validation results with field declarations)
 * as-is (semantic HTML with ARIA attributes; BEM-style class names are
 * intentionally not used).
 *
 * **Overridable**: `FormField` is just a function component, not the only
 * rendering mechanism tied to a `Form` class. Apps are free to swap in their
 * own field component (any rendering approach works, as long as it accepts a
 * `BoundField`).
 *
 * ## Per-widget rendering policy
 * Since it's a discriminated union on `BoundField.widget`, `FormField`
 * branches with a `switch`:
 * - `input`: label + input + hint + error message. Also reflects the
 *   validation constraint attributes `minLength`/`maxLength`/`min`/`max`/
 *   `step`/`pattern`/`inputmode`/`accept`/`multiple` (for `type: "file"`),
 *   keeping HTML native validation in sync with server-side validation.
 * - `textarea`: label + textarea. hono/jsx's `textarea` is a plain tag like
 *   any other element and does not special-case the `value` attribute (as
 *   with a real browser DOM, a textarea's value must be rendered as child
 *   text. `TextareaHTMLAttributes` in
 *   `node_modules/hono/dist/types/jsx/intrinsic-elements.d.ts` does declare
 *   `value`, but that's for React compatibility — it won't appear in the
 *   actual HTML during SSR stringification unless placed as a child).
 *   Also reflects `minLength`/`maxLength`/`cols`.
 * - `select`: label + select > option (expresses selection via `option`'s
 *   `selected` — checked against `field.values` when `multiple`, or against
 *   `field.value` for single selection). Also reflects `size`.
 * - `checkbox`: input[type=checkbox] (reflecting `checked`) + label (after
 *   the input — matching the convention of placing the control before its
 *   descriptive label for checkboxes).
 * - `radio-group`/`checkbox-group`: `fieldset` + `legend` (using `label` as
 *   the legend) + one input + label per option. Group-wide ARIA
 *   (`aria-describedby`/`aria-invalid`/error message) is wired onto the
 *   `fieldset` rather than the individual inputs (since the error subject is
 *   "the group as one value," not each individual option). Each input shares
 *   the same `name` (`checkbox-group` submits multiple values under one
 *   name). `id` is uniquified as `${field.id}-${option.value}` and used for
 *   the matching `label`'s `for`.
 * - `file`: label + `input[type=file]` (reflecting `accept`/`multiple`) + hint
 *   + error message. The dedicated widget for a file input (see `FieldDef` in
 *   `form.ts`); `widget: "input"` + `type: "file"` still renders through
 *   `InputField` for backward compatibility. Unlike `InputField`, there is no
 *   `value`/`readonly`/`autocomplete` attribute — browsers refuse to
 *   pre-populate a file input's selection from a `value` attribute, and
 *   `readonly`/`autocomplete` have no meaning for `type=file`.
 * - `hidden`: renders only `input[type=hidden]`. No label, hint, error
 *   message, or wrapper div (labeling/describing an invisible field would be
 *   meaningless).
 *
 * ## Spreading `attrs` (arbitrary attribute pass-through)
 * `field.attrs` is spread onto the control element (input/textarea/select, or
 * each option's input for group widgets). Since JSX lets a later attribute
 * override an earlier same-named one, placing `{...field.attrs}` **last** in
 * each element's attribute list realizes the rule "when an explicit prop and
 * `attrs` collide, `attrs` wins." `attrs`'s value type
 * (`string | number | boolean`) can be passed straight through to hono/jsx's
 * `AnyAttributes` (`[attributeName: string]: any` in `intrinsic-elements.d.ts`).
 *
 * The CSRF hidden input is provided as a separate component, `CsrfField`.
 * Retrieving the token string itself (calling `Csrf`'s `csrfToken(c)`)
 * requires Hono's `Context`, so that's left to the caller, keeping this
 * module a pure JSX part with no Hono dependency.
 *
 * `FormView` is the default view that generates a whole form at once. Directly
 * under `<form>` it lays out, in order: (1) automatic CSRF hidden insertion,
 * (2) `form.hiddenFields()` bundled right after CSRF, (3) if
 * `form.baseErrors()` is non-empty, a `role="alert"` whole-form error block
 * (tagged with `form.formErrorId()` and wired to `<form>`'s
 * `aria-describedby`), (4) `form.visibleFields()` rendered in declaration
 * order, and (5) `children` (the action row). The `csrfToken` prop is
 * required to enforce automatic CSRF insertion at the type level; an explicit
 * opt-out (e.g. for GET forms) is expressed with `null`. `noValidate` defaults
 * to `false` (keeping HTML native validation on by default — since oven
 * centers around SSR + Turbo Drive and doesn't assume client-side JS
 * validation, the default value doesn't kill native validation).
 */
import type { Child } from "hono/jsx";
import type { BoundField, FieldAttrs, FormBinding, SelectOption } from "./form.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";

/** Props for `FormField`. */
export type FormFieldProps = {
	field: BoundField;
};

/** The common hint/error message (`role="alert"`) block, appended after every widget (except hidden). */
const FieldMessages = ({ field }: { field: BoundField }) => (
	<>
		{field.hint && <p id={field.hintId}>{field.hint}</p>}
		{field.error && (
			<p id={field.errorId} role="alert">
				{field.error}
			</p>
		)}
	</>
);

/** Renders `widget: "input"`. Also reflects validation constraint attributes (minLength etc.) and `attrs`. */
const InputField = ({ field }: { field: Extract<BoundField, { widget: "input" }> }) => (
	<div>
		<label for={field.id}>{field.label}</label>
		<input
			type={field.type}
			id={field.id}
			name={field.name}
			value={field.value}
			required={field.required}
			disabled={field.disabled}
			readonly={field.readonly}
			autofocus={field.autofocus}
			autocomplete={field.autocomplete}
			placeholder={field.placeholder}
			minlength={field.minLength}
			maxlength={field.maxLength}
			min={field.min}
			max={field.max}
			step={field.step}
			pattern={field.pattern}
			inputmode={field.inputmode}
			accept={field.accept}
			multiple={field.multiple}
			aria-invalid={field.error ? "true" : undefined}
			aria-describedby={field.describedBy}
			{...field.attrs}
		/>
		<FieldMessages field={field} />
	</div>
);

/** Renders `widget: "textarea"`. The value is passed as child text (see module JSDoc). */
const TextareaField = ({ field }: { field: Extract<BoundField, { widget: "textarea" }> }) => (
	<div>
		<label for={field.id}>{field.label}</label>
		<textarea
			id={field.id}
			name={field.name}
			rows={field.rows}
			cols={field.cols}
			required={field.required}
			disabled={field.disabled}
			readonly={field.readonly}
			autofocus={field.autofocus}
			placeholder={field.placeholder}
			minlength={field.minLength}
			maxlength={field.maxLength}
			aria-invalid={field.error ? "true" : undefined}
			aria-describedby={field.describedBy}
			{...field.attrs}
		>
			{field.value}
		</textarea>
		<FieldMessages field={field} />
	</div>
);

/** Renders `widget: "select"`. `option`'s `selected` is determined differently depending on whether `multiple` is set. */
const SelectField = ({ field }: { field: Extract<BoundField, { widget: "select" }> }) => (
	<div>
		<label for={field.id}>{field.label}</label>
		<select
			id={field.id}
			name={field.name}
			multiple={field.multiple}
			size={field.size}
			required={field.required}
			disabled={field.disabled}
			autofocus={field.autofocus}
			aria-invalid={field.error ? "true" : undefined}
			aria-describedby={field.describedBy}
			{...field.attrs}
		>
			{field.options.map((option) => (
				<option
					value={option.value}
					selected={
						field.multiple ? field.values.includes(option.value) : field.value === option.value
					}
				>
					{option.label}
				</option>
			))}
		</select>
		<FieldMessages field={field} />
	</div>
);

/** Renders `widget: "checkbox"` (a single checkbox). Places the label after the input. */
const CheckboxField = ({ field }: { field: Extract<BoundField, { widget: "checkbox" }> }) => (
	<div>
		<input
			type="checkbox"
			id={field.id}
			name={field.name}
			checked={field.checked}
			required={field.required}
			disabled={field.disabled}
			autofocus={field.autofocus}
			aria-invalid={field.error ? "true" : undefined}
			aria-describedby={field.describedBy}
			{...field.attrs}
		/>
		<label for={field.id}>{field.label}</label>
		<FieldMessages field={field} />
	</div>
);

/**
 * Common rendering for `radio-group`/`checkbox-group`: `fieldset` + `legend`
 * (using `label`) + one `input` per option (differing only in `type`) +
 * `label`. Group-wide ARIA is wired onto the `fieldset`. `attrs` is spread
 * onto each option's input (since it's a per-option attribute, not a
 * group-wide one).
 */
const OptionGroupField = ({
	field,
	type,
	isSelected,
	attrs,
}: {
	field: Extract<BoundField, { widget: "radio-group" | "checkbox-group" }>;
	type: "radio" | "checkbox";
	isSelected: (option: SelectOption) => boolean;
	attrs: FieldAttrs | undefined;
}) => (
	<fieldset aria-invalid={field.error ? "true" : undefined} aria-describedby={field.describedBy}>
		<legend>{field.label}</legend>
		{field.options.map((option) => {
			const optionId = `${field.id}-${option.value}`;
			return (
				<div>
					<input
						type={type}
						id={optionId}
						name={field.name}
						value={option.value}
						checked={isSelected(option)}
						required={field.required}
						disabled={field.disabled}
						{...attrs}
					/>
					<label for={optionId}>{option.label}</label>
				</div>
			);
		})}
		<FieldMessages field={field} />
	</fieldset>
);

/**
 * Renders `widget: "file"`. No `value` (browsers refuse to pre-populate a file
 * input's selection) and no `readonly`/`autocomplete` (meaningless for
 * `type=file`); everything else mirrors `InputField`.
 */
const FileField = ({ field }: { field: Extract<BoundField, { widget: "file" }> }) => (
	<div>
		<label for={field.id}>{field.label}</label>
		<input
			type="file"
			id={field.id}
			name={field.name}
			required={field.required}
			disabled={field.disabled}
			autofocus={field.autofocus}
			accept={field.accept}
			multiple={field.multiple}
			aria-invalid={field.error ? "true" : undefined}
			aria-describedby={field.describedBy}
			{...field.attrs}
		/>
		<FieldMessages field={field} />
	</div>
);

/** Renders `widget: "hidden"`. Has no label, hint, error message, or wrapper div (see module JSDoc). */
const HiddenField = ({ field }: { field: Extract<BoundField, { widget: "hidden" }> }) => (
	<input type="hidden" id={field.id} name={field.name} value={field.value} {...field.attrs} />
);

/**
 * Renders one field's view according to `field.widget` (see the module JSDoc
 * "Per-widget rendering policy"). `aria-describedby` uses `field.describedBy`
 * as-is (already computed by `FormBinding#field`).
 */
export const FormField = ({ field }: FormFieldProps) => {
	switch (field.widget) {
		case "textarea":
			return <TextareaField field={field} />;
		case "select":
			return <SelectField field={field} />;
		case "checkbox":
			return <CheckboxField field={field} />;
		case "radio-group":
			return (
				<OptionGroupField
					field={field}
					type="radio"
					isSelected={(option) => field.value === option.value}
					attrs={field.attrs}
				/>
			);
		case "checkbox-group":
			return (
				<OptionGroupField
					field={field}
					type="checkbox"
					isSelected={(option) => field.values.includes(option.value)}
					attrs={field.attrs}
				/>
			);
		case "file":
			return <FileField field={field} />;
		case "hidden":
			return <HiddenField field={field} />;
		default:
			return <InputField field={field} />;
	}
};

export type CsrfFieldProps = {
	/** The token string obtained from `Csrf`'s `csrfToken(c)`. */
	token: string;
};

/**
 * The CSRF token's hidden input. Uses the `CSRF_FORM_FIELD_NAME` constant from
 * `csrf.ts` for `name` (kept in sync with where the validation middleware
 * reads from). Since hono/jsx auto-escapes attribute values, this component
 * needs no extra escaping of its own (unlike `csrf.ts`'s `csrfMetaTag`, which
 * manually escapes because it's a raw string template).
 */
export const CsrfField = ({ token }: CsrfFieldProps) => (
	<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={token} />
);

export type FormViewProps = {
	form: FormBinding<string>;
	action: string;
	/** The `<form>`'s `method` attribute (only values hono/jsx allows for `<form method>`). Defaults to `"post"`. */
	method?: "get" | "post" | "dialog";
	/** The token to auto-insert the CSRF hidden field. `null` is an explicit opt-out (e.g. for GET forms). */
	csrfToken: string | null;
	/**
	 * Whether to add `<form novalidate>`. Defaults to `false` (keeping HTML
	 * native validation on). Since oven centers around SSR + Turbo Drive and
	 * doesn't assume client-side JS validation, the default `false` doesn't
	 * kill native validation.
	 */
	noValidate?: boolean;
	/** The action row, e.g. a submit button. Rendered after the field list. */
	children?: Child;
};

/**
 * Generates the default view for one whole form.
 * See the module JSDoc "FormView" for the render order.
 */
export const FormView = ({
	form,
	action,
	method = "post",
	csrfToken,
	noValidate = false,
	children,
}: FormViewProps) => {
	const baseErrors = form.baseErrors();
	const formErrorId = form.formErrorId();

	return (
		<form action={action} method={method} novalidate={noValidate} aria-describedby={formErrorId}>
			{csrfToken !== null && <CsrfField token={csrfToken} />}
			{form.hiddenFields().map((field) => (
				<FormField field={field} />
			))}
			{baseErrors.length > 0 && (
				<div id={formErrorId} role="alert">
					{baseErrors.map((message) => (
						<p>{message}</p>
					))}
				</div>
			)}
			{form.visibleFields().map((field) => (
				<FormField field={field} />
			))}
			{children}
		</form>
	);
};
