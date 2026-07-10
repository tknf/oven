/**
 * Verifies `Form` (the Standard Schema-based form validation layer)
 * (docs/testing.md L1). No external schema library is used; following the same
 * approach as `config.test.ts`, a minimal self-contained stub reproduces Standard Schema
 * according to the standardschema.dev specification.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vite-plus/test";
import type { FieldDef } from "../../src/form/form.js";
import {
	consumeFlashedFormState,
	errorsFor,
	FORM_BASE_ERROR_FIELD,
	Form,
	flashFormErrors,
	toFormErrors,
	toOldFormInput,
	trimFormInput,
} from "../../src/form/form.js";
import { Session } from "../../src/session/session.js";

/** Minimal Standard Schema implementation for tests. `validate` can be given either sync or async (same as `config.test.ts`). */
const defineStubSchema = <Output>(
	validate: (
		value: unknown,
	) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate,
	},
});

type SignupInput = { name: string; email: string };

/** Common field declarations for the test form (two fields: name/email). */
const signupFields = () => ({
	name: { label: "Full name" },
	email: { label: "Email address", type: "email" },
});

/** A form using a schema that always validates successfully (passes the trimmed value through as `value`). */
class PassthroughForm extends Form<StandardSchemaV1<unknown, SignupInput>, "name" | "email"> {
	protected schema() {
		return defineStubSchema<SignupInput>((value) => ({ value: value as SignupInput }));
	}
	protected fields() {
		return signupFields();
	}
}

/** A form that fails when name/email are empty (sync). */
class SignupForm extends Form<StandardSchemaV1<unknown, SignupInput>, "name" | "email"> {
	protected schema() {
		return defineStubSchema<SignupInput>((value) => {
			const record = value as Record<string, unknown>;
			const issues: StandardSchemaV1.Issue[] = [];
			if (typeof record.name !== "string" || record.name === "") {
				issues.push({ message: "Please enter your full name", path: ["name"] });
			}
			if (typeof record.email !== "string" || record.email === "") {
				issues.push({ message: "Please enter your email address", path: ["email"] });
			}
			if (issues.length > 0) return { issues };
			return { value: record as SignupInput };
		});
	}
	protected fields() {
		return signupFields();
	}
}

/** Async variant (returns the same validation logic wrapped in a Promise). */
class AsyncSignupForm extends Form<StandardSchemaV1<unknown, SignupInput>, "name" | "email"> {
	protected schema() {
		return defineStubSchema<SignupInput>(async (value) => {
			const record = value as Record<string, unknown>;
			if (typeof record.name !== "string" || record.name === "") {
				return { issues: [{ message: "Please enter your full name", path: ["name"] }] };
			}
			return { value: record as SignupInput };
		});
	}
	protected fields() {
		return signupFields();
	}
}

/** A form whose schema returns an issue without a path (a form-wide error). */
class BaseErrorForm extends Form<StandardSchemaV1<unknown, SignupInput>, "name" | "email"> {
	protected schema() {
		return defineStubSchema<SignupInput>(() => ({
			issues: [{ message: "This email address is already registered" }],
		}));
	}
	protected fields() {
		return signupFields();
	}
}

/** A form with a hint, a required field, and an array-valued field, for testing `bind()`. */
class ProfileForm extends Form<
	StandardSchemaV1<unknown, Record<string, unknown>>,
	"nickname" | "bio" | "tags"
> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>((value) => ({
			value: value as Record<string, unknown>,
		}));
	}
	protected fields(): Record<"nickname" | "bio" | "tags", FieldDef> {
		return {
			nickname: { label: "Nickname", required: true, autocomplete: "nickname" },
			bio: { label: "Bio", widget: "textarea", hint: "Please enter no more than 200 characters." },
			tags: {
				label: "Tags",
				widget: "select",
				multiple: true,
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
					{ value: "c", label: "C" },
				],
			},
		};
	}
}

describe("Form#validate", () => {
	test("returns ok and the validated value when validation succeeds", async () => {
		const result = await new PassthroughForm().validate({ name: "Taro", email: "t@example.com" });

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value).toEqual({ name: "Taro", email: "t@example.com" });
	});

	test("returns errors and trimmed values when validation fails", async () => {
		const result = await new SignupForm().validate({ name: "", email: "" });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual([
			{ field: "name", message: "Please enter your full name" },
			{ field: "email", message: "Please enter your email address" },
		]);
		expect(result.values).toEqual({ name: "", email: "" });
	});

	test("string values are trimmed before validation", async () => {
		const result = await new SignupForm().validate({
			name: "  Taro  ",
			email: " t@example.com ",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value).toEqual({ name: "Taro", email: "t@example.com" });
	});

	test("array values are trimmed element by element", () => {
		const trimmed = trimFormInput({ tags: [" a ", " b "] });

		expect(trimmed.tags).toEqual(["a", "b"]);
	});

	test("File values are excluded from trimming and pass through unchanged", () => {
		const file = new File(["data"], "cover.png", { type: "image/png" });

		const trimmed = trimFormInput({ cover: file });

		expect(trimmed.cover).toBe(file);
	});

	test("supports an async validate function", async () => {
		const result = await new AsyncSignupForm().validate({ name: "", email: "t@example.com" });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual([{ field: "name", message: "Please enter your full name" }]);
	});

	test("an issue without a path is routed to FORM_BASE_ERROR_FIELD", async () => {
		const result = await new BaseErrorForm().validate({ name: "Taro", email: "t@example.com" });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual([
			{ field: FORM_BASE_ERROR_FIELD, message: "This email address is already registered" },
		]);
	});
});

describe("toFormErrors", () => {
	test("adopts only the first path segment as field (discards deeper segments)", () => {
		const errors = toFormErrors([{ message: "Invalid", path: ["address", "city"] }]);

		expect(errors).toEqual([{ field: "address", message: "Invalid" }]);
	});

	test("uses the key when a path segment is a PathSegment object", () => {
		const errors = toFormErrors([{ message: "Invalid", path: [{ key: "email" }] }]);

		expect(errors).toEqual([{ field: "email", message: "Invalid" }]);
	});
});

describe("toOldFormInput", () => {
	test("keeps only strings/string arrays and excludes File values", () => {
		const file = new File(["data"], "cover.png", { type: "image/png" });

		const old = toOldFormInput({
			title: "Book title",
			tags: ["a", "b"],
			cover: file,
		});

		expect(old).toEqual({ title: "Book title", tags: ["a", "b"] });
	});
});

describe("flashFormErrors / consumeFlashedFormState", () => {
	test("errors/values pushed to flash can be retrieved on the next call (consume-once)", async () => {
		const result = await new SignupForm().validate({ name: "", email: "t@example.com" });
		if (result.ok) throw new Error("unreachable");

		const session = new Session("");
		flashFormErrors(session, result);

		const flashed = consumeFlashedFormState(session);
		expect(flashed).toEqual({
			errors: [{ field: "name", message: "Please enter your full name" }],
			values: { name: "", email: "t@example.com" },
		});

		expect(consumeFlashedFormState(session)).toBeNull();
	});

	test("returns null for a session with nothing flashed", () => {
		const session = new Session("");

		expect(consumeFlashedFormState(session)).toBeNull();
	});
});

describe("errorsFor", () => {
	test("collects only the messages for the given field, in declaration (input array) order", () => {
		const errors = [
			{ field: "name", message: "Full name error 1" },
			{ field: "email", message: "Email error" },
			{ field: "name", message: "Full name error 2" },
		];

		expect(errorsFor(errors, "name")).toEqual(["Full name error 1", "Full name error 2"]);
		expect(errorsFor(errors, "email")).toEqual(["Email error"]);
		expect(errorsFor(errors, "unknown")).toEqual([]);
	});
});

describe("Form#bind", () => {
	test("without a state argument, returns BoundFields in declaration order with empty values and no errors", () => {
		const binding = new ProfileForm().bind();
		const fields = binding.fields();

		expect(fields.map((field) => field.name)).toEqual(["nickname", "bio", "tags"]);
		expect(fields[0]).toEqual({
			widget: "input",
			name: "nickname",
			id: "nickname",
			label: "Nickname",
			type: "text",
			value: "",
			error: undefined,
			errors: [],
			valid: true,
			hint: undefined,
			hintId: undefined,
			errorId: undefined,
			describedBy: undefined,
			required: true,
			placeholder: undefined,
			disabled: undefined,
			readonly: undefined,
			autofocus: undefined,
			attrs: undefined,
			autocomplete: "nickname",
			minLength: undefined,
			maxLength: undefined,
			min: undefined,
			max: undefined,
			step: undefined,
			pattern: undefined,
			inputmode: undefined,
			accept: undefined,
			multiple: undefined,
		});
	});

	test("resolves field metadata (widget-specific properties, hint, describedBy combination order)", () => {
		const binding = new ProfileForm().bind({
			errors: [{ field: "bio", message: "Bio format is invalid" }],
			values: { nickname: "taro", bio: "Nice to meet you" },
		});

		const bio = binding.field("bio");
		if (bio.widget !== "textarea") throw new Error("unreachable");
		expect(bio.value).toBe("Nice to meet you");
		expect(bio.hint).toBe("Please enter no more than 200 characters.");
		expect(bio.hintId).toBe("bio-hint");
		expect(bio.errorId).toBe("bio-error");
		expect(bio.describedBy).toBe("bio-hint bio-error");
		expect(bio.error).toBe("Bio format is invalid");
		expect(bio.errors).toEqual(["Bio format is invalid"]);

		const nickname = binding.field("nickname");
		expect(nickname.describedBy).toBeUndefined();
		expect(nickname.error).toBeUndefined();
	});

	test("when a field has multiple errors, errors contains all of them but error holds only the first", () => {
		const binding = new ProfileForm().bind({
			errors: [
				{ field: "nickname", message: "This field is required" },
				{ field: "nickname", message: "Please enter no more than 20 characters" },
			],
		});

		const nickname = binding.field("nickname");
		expect(nickname.error).toBe("This field is required");
		expect(nickname.errors).toEqual([
			"This field is required",
			"Please enter no more than 20 characters",
		]);
	});

	test("baseErrors returns only the messages addressed to FORM_BASE_ERROR_FIELD", () => {
		const binding = new ProfileForm().bind({
			errors: [
				{ field: FORM_BASE_ERROR_FIELD, message: "Global error 1" },
				{ field: "nickname", message: "Field error" },
				{ field: FORM_BASE_ERROR_FIELD, message: "Global error 2" },
			],
		});

		expect(binding.baseErrors()).toEqual(["Global error 1", "Global error 2"]);
	});

	test("value resolution: input (single value) goes into value", () => {
		const binding = new ProfileForm().bind({ values: { nickname: "taro" } });

		const nickname = binding.field("nickname");
		if (nickname.widget !== "input") throw new Error("unreachable");
		expect(nickname.value).toBe("taro");
	});

	test("value resolution: select multiple puts all selected values into values, and value is the first element", () => {
		const binding = new ProfileForm().bind({ values: { tags: ["a", "b", "c"] } });

		const tags = binding.field("tags");
		if (tags.widget !== "select") throw new Error("unreachable");
		expect(tags.value).toBe("a");
		expect(tags.values).toEqual(["a", "b", "c"]);
	});

	test("value resolution: an array mixed with File picks up only the string elements (from FormInput)", () => {
		const file = new File(["data"], "cover.png", { type: "image/png" });
		const binding = new ProfileForm().bind({ values: { tags: ["a", file, "b"] } });

		const tags = binding.field("tags");
		if (tags.widget !== "select") throw new Error("unreachable");
		expect(tags.value).toBe("a");
		expect(tags.values).toEqual(["a", "b"]);
	});

	test("value resolution: an unspecified field has value=''", () => {
		const binding = new ProfileForm().bind({ values: { nickname: "taro" } });

		const bio = binding.field("bio");
		if (bio.widget !== "textarea") throw new Error("unreachable");
		expect(bio.value).toBe("");
	});

	test("resolves both FormInput (values from a failed validation result) and OldFormInput (values from flash)", () => {
		const fromFormInput = new ProfileForm().bind({
			values: { nickname: "taro", tags: ["a", "b"] },
		});
		const fromOldFormInput = new ProfileForm().bind({
			values: { nickname: "taro", tags: ["a", "b"] } satisfies Record<string, string | string[]>,
		});

		const formInputTags = fromFormInput.field("tags");
		const oldFormInputTags = fromOldFormInput.field("tags");
		const formInputNickname = fromFormInput.field("nickname");
		const oldFormInputNickname = fromOldFormInput.field("nickname");
		if (formInputTags.widget !== "select" || oldFormInputTags.widget !== "select") {
			throw new Error("unreachable");
		}
		if (formInputNickname.widget !== "input" || oldFormInputNickname.widget !== "input") {
			throw new Error("unreachable");
		}

		expect(formInputNickname.value).toBe("taro");
		expect(oldFormInputNickname.value).toBe("taro");
		expect(formInputTags.values).toEqual(["a", "b"]);
		expect(oldFormInputTags.values).toEqual(["a", "b"]);
	});
});

/** A form for verifying `initial` and `checkbox` checked precedence. */
class InitialForm extends Form<
	StandardSchemaV1<unknown, Record<string, unknown>>,
	"nickname" | "tags" | "agree"
> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>((value) => ({
			value: value as Record<string, unknown>,
		}));
	}
	protected fields(): Record<"nickname" | "tags" | "agree", FieldDef> {
		return {
			nickname: { label: "Nickname", initial: "Initial Taro" },
			tags: {
				label: "Tags",
				widget: "select",
				multiple: true,
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				initial: ["a"],
			},
			agree: { label: "I agree", widget: "checkbox", initial: true },
		};
	}
}

describe("initial (fallback to initial values for a new form)", () => {
	test("when values is absent (bind() called without arguments), initial goes into value", () => {
		const binding = new InitialForm().bind();

		const nickname = binding.field("nickname");
		if (nickname.widget !== "input") throw new Error("unreachable");
		expect(nickname.value).toBe("Initial Taro");
	});

	test("also falls back to initial when values exists but the field's key is missing", () => {
		const binding = new InitialForm().bind({ values: { nickname: "taro" } });

		const tags = binding.field("tags");
		if (tags.widget !== "select") throw new Error("unreachable");
		expect(tags.values).toEqual(["a"]);
	});

	test("if values has a key for the field, it always takes precedence over initial", () => {
		const binding = new InitialForm().bind({ values: { nickname: "taro" } });

		const nickname = binding.field("nickname");
		if (nickname.widget !== "input") throw new Error("unreachable");
		expect(nickname.value).toBe("taro");
	});

	test("checkbox: when values is absent, initial(true) goes into checked", () => {
		const binding = new InitialForm().bind();

		const agree = binding.field("agree");
		if (agree.widget !== "checkbox") throw new Error("unreachable");
		expect(agree.checked).toBe(true);
	});

	test("checkbox: when values exists but the key is missing (e.g. unchecked on an edit form), initial is ignored and checked=false", () => {
		const binding = new InitialForm().bind({ values: { nickname: "taro" } });

		const agree = binding.field("agree");
		if (agree.widget !== "checkbox") throw new Error("unreachable");
		expect(agree.checked).toBe(false);
	});

	test("checkbox: if values has the key, its presence means checked=true (takes precedence over initial)", () => {
		const binding = new InitialForm().bind({ values: { agree: "on" } });

		const agree = binding.field("agree");
		if (agree.widget !== "checkbox") throw new Error("unreachable");
		expect(agree.checked).toBe(true);
	});
});

/** A form for verifying that `disabled`/`readonly`/`autofocus`/`attrs` are applied. */
class AttrsForm extends Form<StandardSchemaV1<unknown, Record<string, unknown>>, "nickname"> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>((value) => ({
			value: value as Record<string, unknown>,
		}));
	}
	protected fields(): Record<"nickname", FieldDef> {
		return {
			nickname: {
				label: "Nickname",
				disabled: true,
				readonly: true,
				autofocus: true,
				attrs: { "data-testid": "nickname-input", disabled: false },
			},
		};
	}
}

describe("disabled/readonly/autofocus/attrs", () => {
	test("disabled/readonly/autofocus are reflected as-is on BoundField", () => {
		const nickname = new AttrsForm().bind().field("nickname");

		expect(nickname.disabled).toBe(true);
		expect(nickname.readonly).toBe(true);
		expect(nickname.autofocus).toBe(true);
	});

	test("attrs is passed through to BoundField (override precedence at render time is checked in form_field.test.ts)", () => {
		const nickname = new AttrsForm().bind().field("nickname");

		expect(nickname.attrs).toEqual({ "data-testid": "nickname-input", disabled: false });
	});
});

/** A form for verifying that validation constraint attributes are applied. */
class ConstraintsForm extends Form<
	StandardSchemaV1<unknown, Record<string, unknown>>,
	"code" | "bio" | "colors" | "avatar"
> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>((value) => ({
			value: value as Record<string, unknown>,
		}));
	}
	protected fields(): Record<"code" | "bio" | "colors" | "avatar", FieldDef> {
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
			bio: { label: "Bio", widget: "textarea", minLength: 10, maxLength: 500, cols: 40 },
			colors: {
				label: "Color",
				widget: "select",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				size: 2,
			},
			avatar: { label: "Avatar", type: "file", accept: "image/*", multiple: true },
		};
	}
}

describe("validation constraint attributes per widget", () => {
	test("input: minLength/maxLength/min/max/step/pattern/inputmode are reflected on BoundField", () => {
		const code = new ConstraintsForm().bind().field("code");
		if (code.widget !== "input") throw new Error("unreachable");

		expect(code.minLength).toBe(4);
		expect(code.maxLength).toBe(10);
		expect(code.min).toBe(0);
		expect(code.max).toBe(100);
		expect(code.step).toBe(1);
		expect(code.pattern).toBe("[A-Z0-9]+");
		expect(code.inputmode).toBe("numeric");
	});

	test("input type=file: accept/multiple are reflected on BoundField", () => {
		const avatar = new ConstraintsForm().bind().field("avatar");
		if (avatar.widget !== "input") throw new Error("unreachable");

		expect(avatar.type).toBe("file");
		expect(avatar.accept).toBe("image/*");
		expect(avatar.multiple).toBe(true);
	});

	test("textarea: minLength/maxLength/cols are reflected on BoundField", () => {
		const bio = new ConstraintsForm().bind().field("bio");
		if (bio.widget !== "textarea") throw new Error("unreachable");

		expect(bio.minLength).toBe(10);
		expect(bio.maxLength).toBe(500);
		expect(bio.cols).toBe(40);
	});

	test("select: size is reflected on BoundField", () => {
		const colors = new ConstraintsForm().bind().field("colors");
		if (colors.widget !== "select") throw new Error("unreachable");

		expect(colors.size).toBe(2);
	});
});

/** A form for verifying the dedicated `widget: "file"` and the backward-compatible `widget: "input", type: "file"` spelling. */
class FileFieldsForm extends Form<
	StandardSchemaV1<unknown, Record<string, unknown>>,
	"avatar" | "legacyAvatar" | "plainFile"
> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>((value) => ({
			value: value as Record<string, unknown>,
		}));
	}
	protected fields(): Record<"avatar" | "legacyAvatar" | "plainFile", FieldDef> {
		return {
			avatar: { label: "Avatar", widget: "file", accept: "image/*", multiple: true },
			legacyAvatar: { label: "Avatar (legacy)", widget: "input", type: "file", accept: "image/*" },
			plainFile: { label: "Attachment", widget: "file" },
		};
	}
}

describe("file widget", () => {
	test("widget: 'file' reflects accept/multiple on BoundField", () => {
		const avatar = new FileFieldsForm().bind().field("avatar");
		if (avatar.widget !== "file") throw new Error("unreachable");

		expect(avatar.accept).toBe("image/*");
		expect(avatar.multiple).toBe(true);
	});

	test("widget: 'file' with no accept/multiple declared leaves both undefined", () => {
		const plainFile = new FileFieldsForm().bind().field("plainFile");
		if (plainFile.widget !== "file") throw new Error("unreachable");

		expect(plainFile.accept).toBeUndefined();
		expect(plainFile.multiple).toBeUndefined();
	});

	test("the legacy widget: 'input' + type: 'file' spelling still resolves to widget: 'input'", () => {
		const legacyAvatar = new FileFieldsForm().bind().field("legacyAvatar");
		if (legacyAvatar.widget !== "input") throw new Error("unreachable");

		expect(legacyAvatar.type).toBe("file");
		expect(legacyAvatar.accept).toBe("image/*");
	});

	test("Form#toInput never sets a key for widget: 'file' (a File value cannot be pre-populated)", () => {
		const input = new FileFieldsForm().toInput({
			avatar: "https://example.com/old-avatar.png",
			legacyAvatar: "https://example.com/old-legacy.png",
			plainFile: "https://example.com/old-file.pdf",
		});

		expect(Object.hasOwn(input, "avatar")).toBe(false);
		expect(Object.hasOwn(input, "plainFile")).toBe(false);
		// The legacy `widget: "input"` spelling is unaffected by the `file` skip and keeps its existing behavior.
		expect(input.legacyAvatar).toBe("https://example.com/old-legacy.png");
	});
});

/** A form for verifying the hidden widget. */
class HiddenFieldsForm extends Form<
	StandardSchemaV1<unknown, Record<string, unknown>>,
	"csrfLike" | "nickname" | "returnTo"
> {
	protected schema() {
		return defineStubSchema<Record<string, unknown>>((value) => ({
			value: value as Record<string, unknown>,
		}));
	}
	protected fields(): Record<"csrfLike" | "nickname" | "returnTo", FieldDef> {
		return {
			csrfLike: { label: "Token", widget: "hidden" },
			nickname: { label: "Nickname" },
			returnTo: { label: "Return to", widget: "hidden" },
		};
	}
}

describe("hidden widget (visibleFields/hiddenFields)", () => {
	test("hiddenFields() returns only widget:hidden fields in declaration order", () => {
		const binding = new HiddenFieldsForm().bind({
			values: { csrfLike: "token123", returnTo: "/mypage" },
		});

		const hidden = binding.hiddenFields();
		expect(hidden.map((field) => field.name)).toEqual(["csrfLike", "returnTo"]);
		for (const field of hidden) expect(field.widget).toBe("hidden");
	});

	test("visibleFields() returns everything except widget:hidden, in declaration order", () => {
		const binding = new HiddenFieldsForm().bind();

		const visible = binding.visibleFields();
		expect(visible.map((field) => field.name)).toEqual(["nickname"]);
	});

	test("fields() returns all fields including hidden ones, in declaration order (as before)", () => {
		const binding = new HiddenFieldsForm().bind();

		expect(binding.fields().map((field) => field.name)).toEqual([
			"csrfLike",
			"nickname",
			"returnTo",
		]);
	});

	test("value resolution for the hidden widget follows the same rule as input", () => {
		const binding = new HiddenFieldsForm().bind({ values: { csrfLike: "token123" } });

		const csrfLike = binding.field("csrfLike");
		if (csrfLike.widget !== "hidden") throw new Error("unreachable");
		expect(csrfLike.value).toBe("token123");
	});
});

describe("prefix (equivalent to Form(prefix=...))", () => {
	test("bind({ prefix }) prepends prefix to name/id", () => {
		const binding = new ProfileForm().bind({ prefix: "signup", values: {} });

		const nickname = binding.field("nickname");
		expect(nickname.name).toBe("signup-nickname");
		expect(nickname.id).toBe("signup-nickname");
	});

	test("bind({ prefix }) also looks up values by the prefixed key", () => {
		const binding = new ProfileForm().bind({
			prefix: "signup",
			values: { "signup-nickname": "taro" },
		});

		const nickname = binding.field("nickname");
		if (nickname.widget !== "input") throw new Error("unreachable");
		expect(nickname.value).toBe("taro");
	});

	test("bind({ prefix }) matches errors by the plain name (prefixed names don't match)", () => {
		const binding = new ProfileForm().bind({
			prefix: "signup",
			errors: [{ field: "nickname", message: "This field is required" }],
		});

		const nickname = binding.field("nickname");
		expect(nickname.error).toBe("This field is required");
	});

	test("Form#validate({ prefix }) strips the prefixed keys before passing to the schema", async () => {
		const form = new PassthroughForm();
		const result = await form.validate(
			{ "signup-name": "Taro", "signup-email": "t@example.com" },
			{ prefix: "signup" },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value).toEqual({ name: "Taro", email: "t@example.com" });
	});

	test("Form#validate({ prefix }) discards keys that don't match the prefix", async () => {
		const form = new SignupForm();
		const result = await form.validate(
			{ "signup-name": "Taro", "signup-email": "t@example.com", "other-field": "extraneous" },
			{ prefix: "signup" },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value).toEqual({ name: "Taro", email: "t@example.com" });
	});
});

describe("valid (per-field error presence check)", () => {
	test("a field with no errors has valid: true", () => {
		const binding = new ProfileForm().bind();

		expect(binding.field("nickname").valid).toBe(true);
	});

	test("a field with errors has valid: false", () => {
		const binding = new ProfileForm().bind({
			errors: [{ field: "nickname", message: "This field is required" }],
		});

		expect(binding.field("nickname").valid).toBe(false);
	});
});

describe("FormBinding#formErrorId", () => {
	test("returns undefined when there are no baseErrors", () => {
		const binding = new ProfileForm().bind();

		expect(binding.formErrorId()).toBeUndefined();
	});

	test("returns 'form-errors' when baseErrors exist and no prefix is given", () => {
		const binding = new ProfileForm().bind({
			errors: [{ field: FORM_BASE_ERROR_FIELD, message: "Already registered" }],
		});

		expect(binding.formErrorId()).toBe("form-errors");
	});

	test("returns '{prefix}-errors' when baseErrors exist and a prefix is given", () => {
		const binding = new ProfileForm().bind({
			prefix: "signup",
			errors: [{ field: FORM_BASE_ERROR_FIELD, message: "Already registered" }],
		});

		expect(binding.formErrorId()).toBe("signup-errors");
	});
});

describe("Form#toInput", () => {
	test("scalar values for input/textarea become strings, and null/undefined columns have no key", () => {
		const input = new ProfileForm().toInput({ nickname: "taro", bio: 123, tags: null });

		expect(input).toEqual({ nickname: "taro", bio: "123" });
		expect(Object.hasOwn(input, "tags")).toBe(false);

		const emptyInput = new ProfileForm().toInput({ nickname: undefined, bio: null });
		expect(Object.hasOwn(emptyInput, "nickname")).toBe(false);
		expect(Object.hasOwn(emptyInput, "bio")).toBe(false);
	});

	test("after passing through bind, scalar columns go into value, and missing columns fall back to initial/empty value", () => {
		const binding = new ProfileForm().bind({
			values: new ProfileForm().toInput({ nickname: "taro", bio: 123, tags: null }),
		});

		const nickname = binding.field("nickname");
		const bio = binding.field("bio");
		const tags = binding.field("tags");
		if (nickname.widget !== "input" || bio.widget !== "textarea" || tags.widget !== "select") {
			throw new Error("unreachable");
		}
		expect(nickname.value).toBe("taro");
		expect(bio.value).toBe("123");
		expect(tags.values).toEqual([]);
	});

	test("checkbox: a truthy column has its key present and checked=true; falsy/missing columns have no key and checked=false", () => {
		const checkedInput = new InitialForm().toInput({ agree: true });
		expect(checkedInput).toEqual({ agree: "on" });

		const uncheckedInput = new InitialForm().toInput({ agree: false });
		expect(Object.hasOwn(uncheckedInput, "agree")).toBe(false);

		const missingInput = new InitialForm().toInput({});
		expect(Object.hasOwn(missingInput, "agree")).toBe(false);

		const checkedBinding = new InitialForm().bind({ values: checkedInput });
		const uncheckedBinding = new InitialForm().bind({ values: uncheckedInput });
		const checkedAgree = checkedBinding.field("agree");
		const uncheckedAgree = uncheckedBinding.field("agree");
		if (checkedAgree.widget !== "checkbox" || uncheckedAgree.widget !== "checkbox") {
			throw new Error("unreachable");
		}
		expect(checkedAgree.checked).toBe(true);
		expect(uncheckedAgree.checked).toBe(false);
	});

	test("checkbox-group/select(multiple) becomes a string[] with only the string elements", () => {
		const input = new ProfileForm().toInput({ tags: ["a", "b", 3, null] });

		expect(input).toEqual({ tags: ["a", "b"] });

		const binding = new ProfileForm().bind({ values: input });
		const tags = binding.field("tags");
		if (tags.widget !== "select") throw new Error("unreachable");
		expect(tags.values).toEqual(["a", "b"]);
		expect(tags.value).toBe("a");
	});
});
