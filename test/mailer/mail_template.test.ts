/**
 * Verifies `MailTemplate` (the JSX mail template layer) (docs/testing.md L1).
 * Since JSX literals cannot be used in `.test.ts`, the tree is built with
 * `hono/jsx`'s `jsx()` and converted to a `JSX.Element` (`HtmlEscapedString`)
 * via `hono/html`'s `raw()`.
 */
import { raw } from "hono/html";
import { jsx } from "hono/jsx";
import { describe, expect, test } from "vite-plus/test";
import { MailTemplate } from "../../src/mailer/mail_template.js";
import { Mailer, type MailMessage } from "../../src/mailer/mailer.js";

/** A test-only `Mailer` stub that just records what it sends. */
class RecordingMailer extends Mailer {
	readonly sent: MailMessage[] = [];

	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

type GreetingProps = { name: string; verifyUrl: string };

/** A template that does not implement textBody explicitly (relies on the default html-derived text). */
class GreetingTemplate extends MailTemplate<GreetingProps> {
	protected subject({ name }: GreetingProps): string {
		return `Guide for ${name}`;
	}

	protected html({ name, verifyUrl }: GreetingProps) {
		const tree = jsx(
			"div",
			null,
			jsx("p", null, `Hello, ${name}.`),
			jsx("p", null, jsx("a", { href: verifyUrl }, verifyUrl)),
		);
		return raw(tree.toString());
	}
}

/** A template that explicitly implements textBody (used to confirm the explicit method takes priority over html-derived text). */
class GreetingTemplateWithExplicitText extends GreetingTemplate {
	protected text({ name }: GreetingProps): string {
		return `${name}, this is the explicit text version.`;
	}
}

describe("MailTemplate", () => {
	test("builds subject/htmlBody from JSX and passes them to the injected Mailer", async () => {
		const mailer = new RecordingMailer();
		const template = new GreetingTemplate(mailer, "no-reply@example.com");

		await template.send("listener@example.com", {
			name: "Taro",
			verifyUrl: "https://example.com/verify?token=abc",
		});

		expect(mailer.sent).toHaveLength(1);
		const message = mailer.sent[0];
		expect(message?.from).toBe("no-reply@example.com");
		expect(message?.to).toBe("listener@example.com");
		expect(message?.subject).toBe("Guide for Taro");
		expect(message?.htmlBody).toContain("<p>Hello, Taro.</p>");
		expect(message?.htmlBody).toContain(
			'<a href="https://example.com/verify?token=abc">https://example.com/verify?token=abc</a>',
		);
	});

	test("when text() is omitted, derives text from htmlBody by stripping tags and converting line breaks", async () => {
		const mailer = new RecordingMailer();
		const template = new GreetingTemplate(mailer, "no-reply@example.com");

		await template.send("listener@example.com", {
			name: "Taro",
			verifyUrl: "https://example.com/verify?token=abc",
		});

		const textBody = mailer.sent[0]?.textBody ?? "";
		expect(textBody).not.toContain("<");
		expect(textBody).toContain("Hello, Taro.");
		expect(textBody).toContain("https://example.com/verify?token=abc");
	});

	test("when text() is implemented, the explicit text takes priority over html-derived text", async () => {
		const mailer = new RecordingMailer();
		const template = new GreetingTemplateWithExplicitText(mailer, "no-reply@example.com");

		await template.send("listener@example.com", {
			name: "Hanako",
			verifyUrl: "https://example.com/verify?token=xyz",
		});

		expect(mailer.sent[0]?.textBody).toBe("Hanako, this is the explicit text version.");
	});

	test("special characters in props are HTML-escaped", async () => {
		const mailer = new RecordingMailer();
		const template = new GreetingTemplate(mailer, "no-reply@example.com");

		await template.send("listener@example.com", {
			name: '<script>alert("x")</script>',
			verifyUrl: "https://example.com/verify",
		});

		expect(mailer.sent[0]?.htmlBody).not.toContain("<script>");
		expect(mailer.sent[0]?.htmlBody).toContain("&lt;script&gt;");
	});
});
