/**
 * Verifies `FormField`/`CsrfField`/`FormView` (the form's default view parts)
 * (docs/testing.md L1). Since JSX literals can't be used in `.test.ts`, the components
 * are called directly as functions and their output is stringified for verification.
 * `JSX.Element` is `HtmlEscapedString | Promise<HtmlEscapedString>` (confirmed in
 * `hono/jsx/base`), so it is `await`ed before calling `.toString()`, same as `src/mail_template.ts`.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vite-plus/test";
import type { FieldDef } from "../../src/form/form.js";
import { CSRF_FORM_FIELD_NAME } from "../../src/security/csrf.js";
import { CsrfField, FormField, FormView } from "../../src/form/form_field.js";
import { Form } from "../../src/form/form.js";

/** Minimal Standard Schema implementation for tests (always succeeds). */
const defineStubSchema = <Output>(): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate: (value) => ({ value: value as Output }),
	},
});

/** A form for verifying `FormView` (two fields, nickname/bio, both defaulting to widget=input). */
class ProfileForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>();
	}
	protected fields() {
		return {
			nickname: { label: "Nickname", required: true },
			bio: { label: "Bio", hint: "Please enter no more than 200 characters." },
		};
	}
}

/** Options for verifying rendering per widget (shared by radio-group/checkbox-group/select). */
const colorOptions = [
	{ value: "red", label: "Red" },
	{ value: "blue", label: "Blue" },
];

type AllWidgetsFieldName =
	| "nickname"
	| "bio"
	| "favoriteColor"
	| "colors"
	| "agree"
	| "plan"
	| "hobbies";

/**
 * A form with one field for each widget (input/textarea/select/checkbox/radio-group/checkbox-group).
 * So it can also be passed directly to `FormView` (which accepts `FormBinding<string>`), the
 * `FieldName` type parameter is left at its default `string`; `AllWidgetsFieldName` is used only
 * for the type annotation on `fields()`'s return value.
 */
class AllWidgetsForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>();
	}
	protected fields(): Record<AllWidgetsFieldName, FieldDef> {
		return {
			nickname: { label: "Nickname" },
			bio: {
				label: "Bio",
				widget: "textarea",
				rows: 4,
				hint: "Please enter no more than 200 characters.",
			},
			favoriteColor: { label: "Favorite color", widget: "select", options: colorOptions },
			colors: {
				label: "Available colors",
				widget: "select",
				options: colorOptions,
				multiple: true,
			},
			agree: { label: "I agree to the terms of service", widget: "checkbox", required: true },
			plan: { label: "Plan", widget: "radio-group", options: colorOptions },
			hobbies: { label: "Hobbies", widget: "checkbox-group", options: colorOptions },
		};
	}
}

describe("FormField", () => {
	test("renders the minimal case with no errors and no hint", async () => {
		const field = new ProfileForm().bind().field("nickname");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('<label for="nickname">Nickname</label>');
		expect(html).toContain('id="nickname"');
		expect(html).toContain('name="nickname"');
		expect(html).not.toContain("aria-invalid");
		expect(html).not.toContain('role="alert"');
	});

	test("reflects value/type", async () => {
		const field = new ProfileForm().bind({ values: { nickname: "taro" } }).field("nickname");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('type="text"');
		expect(html).toContain('value="taro"');
	});

	test("when there is an error, emits aria-invalid, aria-describedby, and the role=alert error text", async () => {
		const field = new ProfileForm()
			.bind({ errors: [{ field: "nickname", message: "This field is required" }] })
			.field("nickname");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('aria-describedby="nickname-error"');
		expect(html).toContain('<p id="nickname-error" role="alert">This field is required</p>');
	});

	test("when both a hint and an error are present, aria-describedby lists hint then error", async () => {
		const field = new ProfileForm()
			.bind({ errors: [{ field: "bio", message: "The format is invalid" }] })
			.field("bio");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('aria-describedby="bio-hint bio-error"');
		expect(html).toContain('<p id="bio-hint">Please enter no more than 200 characters.</p>');
		expect(html).toContain('<p id="bio-error" role="alert">The format is invalid</p>');
	});

	test("when only a hint exists and there is no error, aria-describedby points to the hint only", async () => {
		const field = new ProfileForm().bind().field("bio");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('aria-describedby="bio-hint"');
		expect(html).not.toContain("aria-invalid");
	});

	test("label and value are HTML-escaped", async () => {
		class XssForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>, "title"> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields() {
				return { title: { label: '<script>alert("x")</script>' } };
			}
		}
		const field = new XssForm().bind({ values: { title: '"quoted"' } }).field("title");
		const html = (await FormField({ field })).toString();

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain('value="&quot;quoted&quot;"');
	});

	test("textarea: label and textarea are rendered, with value as child text", async () => {
		const field = new AllWidgetsForm().bind({ values: { bio: "Nice to meet you" } }).field("bio");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('<label for="bio">Bio</label>');
		expect(html).toContain("<textarea");
		expect(html).toContain('rows="4"');
		expect(html).toContain(">Nice to meet you</textarea>");
		expect(html).not.toContain('value="Nice to meet you"');
	});

	test("select: renders the option list, and only the single-select selected option is true", async () => {
		const field = new AllWidgetsForm()
			.bind({ values: { favoriteColor: "blue" } })
			.field("favoriteColor");
		const html = (await FormField({ field })).toString();

		expect(html).toContain("<select");
		expect(html).not.toContain("multiple");
		expect(html).toContain('<option value="red">Red</option>');
		expect(html).toContain('<option value="blue" selected="">Blue</option>');
	});

	test("select multiple: multiple options become selected and the multiple attribute is added", async () => {
		const field = new AllWidgetsForm()
			.bind({ values: { colors: ["red", "blue"] } })
			.field("colors");
		const html = (await FormField({ field })).toString();

		expect(html).toContain("multiple");
		expect(html).toContain('<option value="red" selected="">Red</option>');
		expect(html).toContain('<option value="blue" selected="">Blue</option>');
	});

	test("checkbox: label follows the input, and checked is reflected", async () => {
		const field = new AllWidgetsForm().bind({ values: { agree: "on" } }).field("agree");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('type="checkbox"');
		expect(html).toContain("checked");
		expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<label"));
		expect(html).toContain('<label for="agree">I agree to the terms of service</label>');
	});

	test("checkbox: when there is no value (unchecked submission), checked is not added", async () => {
		const field = new AllWidgetsForm().bind().field("agree");
		const html = (await FormField({ field })).toString();

		expect(html).not.toContain("checked");
	});

	test("radio-group: wraps with fieldset+legend, only the selected value is checked; id combines with field.id to stay unique", async () => {
		const field = new AllWidgetsForm().bind({ values: { plan: "blue" } }).field("plan");
		const html = (await FormField({ field })).toString();

		expect(html).toContain("<fieldset");
		expect(html).toContain("<legend>Plan</legend>");
		expect(html).toContain('id="plan-red"');
		expect(html).toContain('id="plan-blue"');
		expect(html).toContain('<label for="plan-blue">Blue</label>');
		expect(html).toContain('type="radio"');

		const blueInputIndex = html.indexOf('id="plan-blue"');
		const blueInputEnd = html.indexOf("/>", blueInputIndex);
		expect(html.slice(blueInputIndex, blueInputEnd)).toContain("checked");

		const redInputIndex = html.indexOf('id="plan-red"');
		const redInputEnd = html.indexOf("/>", redInputIndex);
		expect(html.slice(redInputIndex, redInputEnd)).not.toContain("checked");
	});

	test("checkbox-group: multiple selected values become checked, and name is shared across all options", async () => {
		const field = new AllWidgetsForm()
			.bind({ values: { hobbies: ["red", "blue"] } })
			.field("hobbies");
		const html = (await FormField({ field })).toString();

		expect(html).toContain("<fieldset");
		expect(html).toContain('type="checkbox"');
		expect((html.match(/name="hobbies"/g) ?? []).length).toBe(2);
		expect(html).toContain('id="hobbies-red"');
		expect(html).toContain('id="hobbies-blue"');
	});

	test("radio-group/checkbox-group: aria-describedby and the error text attach to the fieldset side", async () => {
		const field = new AllWidgetsForm()
			.bind({ errors: [{ field: "plan", message: "Please select an option" }] })
			.field("plan");
		const html = (await FormField({ field })).toString();

		const fieldsetOpenEnd = html.indexOf(">");
		const fieldsetOpenTag = html.slice(0, fieldsetOpenEnd);

		expect(fieldsetOpenTag).toContain("aria-invalid");
		expect(fieldsetOpenTag).toContain("aria-describedby");
		expect(html).toContain('<p id="plan-error" role="alert">Please select an option</p>');
	});

	test("input: validation constraint attributes (minlength/maxlength/min/max/step/pattern/inputmode) are reflected", async () => {
		class ConstraintsForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>, "code"> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"code", FieldDef> {
				return {
					code: {
						label: "Code",
						minLength: 4,
						maxLength: 10,
						min: 0,
						max: 100,
						step: 1,
						pattern: "[A-Z0-9]+",
						inputmode: "numeric",
					},
				};
			}
		}
		const field = new ConstraintsForm().bind().field("code");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('minlength="4"');
		expect(html).toContain('maxlength="10"');
		expect(html).toContain('min="0"');
		expect(html).toContain('max="100"');
		expect(html).toContain('step="1"');
		expect(html).toContain('pattern="[A-Z0-9]+"');
		expect(html).toContain('inputmode="numeric"');
	});

	test("input type=file: accept/multiple are reflected", async () => {
		class FileForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>, "avatar"> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"avatar", FieldDef> {
				return { avatar: { label: "Avatar", type: "file", accept: "image/*", multiple: true } };
			}
		}
		const field = new FileForm().bind().field("avatar");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('type="file"');
		expect(html).toContain('accept="image/*"');
		expect(html).toContain("multiple");
	});

	test("widget: 'file': renders label + input[type=file], reflecting accept/multiple, with no value attribute", async () => {
		class DedicatedFileForm extends Form<
			StandardSchemaV1<unknown, Record<string, unknown>>,
			"avatar"
		> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"avatar", FieldDef> {
				return { avatar: { label: "Avatar", widget: "file", accept: "image/*", multiple: true } };
			}
		}
		const field = new DedicatedFileForm().bind().field("avatar");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('<label for="avatar">Avatar</label>');
		expect(html).toContain('type="file"');
		expect(html).toContain('name="avatar"');
		expect(html).toContain('accept="image/*"');
		expect(html).toContain("multiple");
		expect(html).not.toContain("value=");
	});

	test("widget: 'file': when there is an error, emits aria-invalid/aria-describedby/role=alert like other widgets", async () => {
		class DedicatedFileForm extends Form<
			StandardSchemaV1<unknown, Record<string, unknown>>,
			"avatar"
		> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"avatar", FieldDef> {
				return { avatar: { label: "Avatar", widget: "file" } };
			}
		}
		const field = new DedicatedFileForm()
			.bind({ errors: [{ field: "avatar", message: "Please select a file" }] })
			.field("avatar");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('aria-describedby="avatar-error"');
		expect(html).toContain('<p id="avatar-error" role="alert">Please select a file</p>');
	});

	test("textarea: minlength/maxlength/cols are reflected", async () => {
		class TextareaConstraintsForm extends Form<
			StandardSchemaV1<unknown, Record<string, unknown>>,
			"bio"
		> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"bio", FieldDef> {
				return {
					bio: { label: "Bio", widget: "textarea", minLength: 10, maxLength: 500, cols: 40 },
				};
			}
		}
		const field = new TextareaConstraintsForm().bind().field("bio");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('minlength="10"');
		expect(html).toContain('maxlength="500"');
		expect(html).toContain('cols="40"');
	});

	test("select: size is reflected", async () => {
		class SelectSizeForm extends Form<
			StandardSchemaV1<unknown, Record<string, unknown>>,
			"colors"
		> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"colors", FieldDef> {
				return { colors: { label: "Color", widget: "select", options: colorOptions, size: 2 } };
			}
		}
		const field = new SelectSizeForm().bind().field("colors");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('size="2"');
	});

	test("attrs: when conflicting with an explicit prop, attrs takes precedence (overridden by disabled=false)", async () => {
		class AttrsOverrideForm extends Form<
			StandardSchemaV1<unknown, Record<string, unknown>>,
			"nickname"
		> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"nickname", FieldDef> {
				return {
					nickname: {
						label: "Nickname",
						disabled: true,
						attrs: { disabled: false, "data-testid": "nickname-input" },
					},
				};
			}
		}
		const field = new AttrsOverrideForm().bind().field("nickname");
		const html = (await FormField({ field })).toString();

		expect(html).toContain('data-testid="nickname-input"');
		expect(html).not.toContain("disabled");
	});

	test("hidden: only input[type=hidden] is rendered, with no label/hint/error text/wrapper div", async () => {
		class HiddenForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>, "token"> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"token", FieldDef> {
				return { token: { label: "Token", widget: "hidden", hint: "Should not be visible" } };
			}
		}
		const field = new HiddenForm()
			.bind({
				errors: [{ field: "token", message: "Should not be visible" }],
				values: { token: "abc123" },
			})
			.field("token");
		const html = (await FormField({ field })).toString();

		expect(html).toBe('<input type="hidden" id="token" name="token" value="abc123"/>');
		expect(html).not.toContain("<label");
		expect(html).not.toContain("<div");
		expect(html).not.toContain('role="alert"');
	});
});

describe("default autocomplete derivation", () => {
	class AutocompleteForm extends Form<
		StandardSchemaV1<unknown, Record<string, unknown>>,
		"email" | "tel" | "url" | "plain" | "explicit"
	> {
		protected schema() {
			return defineStubSchema<Record<string, unknown>>();
		}
		protected fields(): Record<"email" | "tel" | "url" | "plain" | "explicit", FieldDef> {
			return {
				email: { label: "Email address", type: "email" },
				tel: { label: "Phone number", type: "tel" },
				url: { label: "Website URL", type: "url" },
				plain: { label: "Text", type: "text" },
				explicit: { label: "Nickname", type: "text", autocomplete: "nickname" },
			};
		}
	}

	test("email/tel/url derive autocomplete automatically from type", () => {
		const binding = new AutocompleteForm().bind();

		const email = binding.field("email");
		const tel = binding.field("tel");
		const url = binding.field("url");
		if (email.widget !== "input" || tel.widget !== "input" || url.widget !== "input") {
			throw new Error("unreachable");
		}

		expect(email.autocomplete).toBe("email");
		expect(tel.autocomplete).toBe("tel");
		expect(url.autocomplete).toBe("url");
	});

	test("types not in the derivation table (e.g. text) don't get autocomplete assigned", () => {
		const plain = new AutocompleteForm().bind().field("plain");
		if (plain.widget !== "input") throw new Error("unreachable");

		expect(plain.autocomplete).toBeUndefined();
	});

	test("an explicitly specified autocomplete always takes precedence over the default derivation", () => {
		const explicit = new AutocompleteForm().bind().field("explicit");
		if (explicit.widget !== "input") throw new Error("unreachable");

		expect(explicit.autocomplete).toBe("nickname");
	});
});

describe("CsrfField", () => {
	test("renders a hidden input whose name is CSRF_FORM_FIELD_NAME", async () => {
		const html = (await CsrfField({ token: "abc123" })).toString();

		expect(html).toBe(`<input type="hidden" name="${CSRF_FORM_FIELD_NAME}" value="abc123"/>`);
	});

	test("the token string is HTML-escaped", async () => {
		const html = (await CsrfField({ token: '"><script>alert(1)</script>' })).toString();

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("FormView", () => {
	test("automatically inserts CsrfField when csrfToken is a string", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: "abc123" })
		).toString();

		expect(html).toContain(`name="${CSRF_FORM_FIELD_NAME}"`);
		expect(html).toContain('value="abc123"');
	});

	test("does not insert CsrfField when csrfToken is null", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		expect(html).not.toContain(CSRF_FORM_FIELD_NAME);
	});

	test("when baseErrors exist, renders a role=alert block for the form-wide error", async () => {
		const binding = new ProfileForm().bind({
			errors: [{ field: "base", message: "This email address is already registered" }],
		});
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		expect(html).toContain('id="form-errors" role="alert"');
		expect(html).toContain("This email address is already registered");
	});

	test("fields are laid out in declaration order (nickname then bio)", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		expect(html.indexOf('name="nickname"')).toBeLessThan(html.indexOf('name="bio"'));
	});

	test("reflects action and method (defaulting to post), and renders children at the end", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({
				form: binding,
				action: "/profile",
				csrfToken: null,
				children: '<button type="submit">Save</button>',
			})
		).toString();

		expect(html).toContain('action="/profile"');
		expect(html).toContain('method="post"');
		expect(html.indexOf('name="bio"')).toBeLessThan(html.indexOf("Save"));
	});

	test("renders a form mixing every widget in declaration order (input→textarea→select→select multiple→checkbox→radio-group→checkbox-group)", async () => {
		const binding = new AllWidgetsForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		const positions = [
			html.indexOf('name="nickname"'),
			html.indexOf('name="bio"'),
			html.indexOf('name="favoriteColor"'),
			html.indexOf('name="colors"'),
			html.indexOf('name="agree"'),
			html.indexOf('name="plan"'),
			html.indexOf('name="hobbies"'),
		];

		for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
		for (let i = 1; i < positions.length; i++) expect(positions[i - 1]).toBeLessThan(positions[i]);
	});

	test("with noValidate defaulting to false, novalidate is not added", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		expect(html).not.toContain("novalidate");
	});

	test("noValidate: specifying true adds novalidate", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null, noValidate: true })
		).toString();

		expect(html).toContain("novalidate");
	});

	test("when baseErrors exist, formErrorId is wired into <form>'s aria-describedby", async () => {
		const binding = new ProfileForm().bind({
			errors: [{ field: "base", message: "Already registered" }],
		});
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		const formOpenEnd = html.indexOf(">");
		const formOpenTag = html.slice(0, formOpenEnd);
		expect(formOpenTag).toContain('aria-describedby="form-errors"');
	});

	test("when baseErrors is absent, <form> has no aria-describedby", async () => {
		const binding = new ProfileForm().bind();
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		const formOpenEnd = html.indexOf(">");
		const formOpenTag = html.slice(0, formOpenEnd);
		expect(formOpenTag).not.toContain("aria-describedby");
	});

	test("hiddenFields render right after CSRF and before visibleFields", async () => {
		class WithHiddenForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>> {
			protected schema() {
				return defineStubSchema<Record<string, unknown>>();
			}
			protected fields(): Record<"returnTo" | "nickname", FieldDef> {
				return {
					returnTo: { label: "Return to", widget: "hidden" },
					nickname: { label: "Nickname" },
				};
			}
		}
		const binding = new WithHiddenForm().bind({ values: { returnTo: "/mypage" } });
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: "abc123" })
		).toString();

		const csrfIndex = html.indexOf(`name="${CSRF_FORM_FIELD_NAME}"`);
		const returnToIndex = html.indexOf('name="returnTo"');
		const nicknameIndex = html.indexOf('name="nickname"');

		expect(csrfIndex).toBeLessThan(returnToIndex);
		expect(returnToIndex).toBeLessThan(nicknameIndex);
		expect(html).toContain('<input type="hidden" id="returnTo" name="returnTo" value="/mypage"/>');
	});

	test("when prefix is given, it is prepended to the field's name/id", async () => {
		const binding = new ProfileForm().bind({ prefix: "signup", values: {} });
		const html = (
			await FormView({ form: binding, action: "/profile", csrfToken: null })
		).toString();

		expect(html).toContain('name="signup-nickname"');
		expect(html).toContain('id="signup-nickname"');
	});
});
