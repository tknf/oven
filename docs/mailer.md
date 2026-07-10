# Mailer

## What / Why

`Mailer` is the abstract base for mail send backends, following the same
composition-over-configuration policy as `Storage`: it knows nothing about
a backend's request/response shape, and domain code (templates, jobs)
receives a `Mailer` instance through the constructor rather than reaching
for a global. oven ships exactly one concrete implementation,
`ConsoleMailer` — a development fallback that logs instead of sending. Any
real send backend (Postmark, Resend, SES, your own SMTP relay, etc.) is
built by extending `FetchMailer`, an abstract base for `fetch`-based
backends that only requires implementing `buildRequest`.

Two supporting layers sit around `Mailer`: `MailTemplate<TProps>`, a JSX
template base that composes a subject/HTML/text body from typed `props` and
sends through an injected `Mailer`; and `DeliverMailJob`, a ready-made `Job`
(`@tknf/oven/jobs`) that puts a `Mailer#send` call on the job queue, so mail
delivery doesn't block the request that triggered it. `MailPreviewHandler`
rounds this out with a `RouteHandler` you mount in development to browse
composed `MailMessage`s in the browser without actually sending them.

## Minimal example

```ts
// src/lib/mailer.ts
import { ConsoleMailer } from "@tknf/oven/mailer";

export const mailer = new ConsoleMailer();
```

```ts
// src/mailers/welcome_mailer.ts
import { jsx } from "hono/jsx";
import { MailTemplate } from "@tknf/oven/mailer";
import { mailer } from "../lib/mailer.js";

type WelcomeProps = { name: string };

class WelcomeTemplate extends MailTemplate<WelcomeProps> {
  protected subject({ name }: WelcomeProps): string {
    return `Welcome, ${name}!`;
  }

  protected html({ name }: WelcomeProps) {
    return jsx("p", null, `Hi ${name}, thanks for signing up.`);
  }
}

export const welcomeMailer = new WelcomeTemplate(mailer, "no-reply@example.com");
```

```ts
// main.ts
app.post("/signup", async (c) => {
  // ...create the account...
  await welcomeMailer.send("new-user@example.com", { name: "Ada" });
  return c.redirect("/");
});
```

In development, `ConsoleMailer` prints the composed message
(from/to/subject/textBody/attachment summary) to the console instead of
sending it, so a verification link, for example, can be picked up from the
dev server logs.

## Common tasks

**Defining a `MailTemplate` subclass.** Implement `subject`/`html`
(required); `text` is optional and, when omitted, is mechanically derived
from the rendered `html` (block tags and `<br>` become newlines, then tags
are stripped) — write `text` explicitly whenever the HTML body has content
that wouldn't survive that derivation, such as a link URL that only appears
inside an `<a href>`:

```ts
class VerifyEmailTemplate extends MailTemplate<{ verifyUrl: string }> {
  protected subject(): string {
    return "Verify your email";
  }

  protected html({ verifyUrl }: { verifyUrl: string }) {
    return jsx("p", null, "Click ", jsx("a", { href: verifyUrl }, "here"), " to verify.");
  }

  protected text({ verifyUrl }: { verifyUrl: string }): string {
    return `Click here to verify: ${verifyUrl}`;
  }
}
```

**Sending through `ConsoleMailer` in development.** No configuration is
needed beyond constructing it — it's a drop-in `Mailer` for any code that
depends on the abstraction, so templates and jobs don't need to change when
you later swap in a real backend.

**Implementing a real send backend with `FetchMailer`.** Subclass it and
implement `buildRequest`, which converts a `MailMessage` into a `Request`
for your provider's API. `send` (inherited) validates the message with
`assertNoMailHeaderInjection` before calling `buildRequest`, injects a
timeout via the constructor's `timeoutMs`, and throws if the response isn't
`ok`:

```ts
import { FetchMailer } from "@tknf/oven/mailer";
import type { MailMessage } from "@tknf/oven/mailer";

export class PostmarkMailer extends FetchMailer {
  constructor(private readonly apiToken: string, fetchFn?: typeof fetch, timeoutMs?: number) {
    super(fetchFn, timeoutMs);
  }

  protected buildRequest(message: MailMessage): Request {
    return new Request("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": this.apiToken },
      body: JSON.stringify({
        From: message.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.textBody,
        HtmlBody: message.htmlBody,
      }),
    });
  }
}
```

**Sending through a Cloudflare Email Sending binding with
`CloudflareEmailMailer`.** `@tknf/oven/cloudflare` ships a ready-made
`Mailer` that wraps a `SendEmail` binding (configured as `send_email` in
`wrangler.jsonc`; see [Deployment § Email Sending](./deployment.md#email-sending)
for the binding config). Unlike `FetchMailer` subclasses, it needs no
`buildRequest` override — construct it directly with the binding:

```ts
import { CloudflareEmailMailer } from "@tknf/oven/cloudflare";

export const mailer = new CloudflareEmailMailer(env.SEND_EMAIL);
```

It validates the message with `assertNoMailHeaderInjection` itself (like
`FetchMailer`, just implemented directly since it doesn't extend
`FetchMailer`), then hands the message to the binding's
`EmailMessageBuilder` overload — the binding composes the outgoing MIME
message, so this adapter never constructs raw MIME. `MailAttachment.content`
is base64-encoded automatically unless it's already `encoding: "base64"`,
since the binding requires attachment content to be base64 when it's a
`string`.

**Mounting `MailPreviewHandler` for development.** It takes a table of
preview name → factory returning a `MailMessage`, and exposes a listing
page plus one detail page per preview (`?part=text` shows the plain-text
version). Guard the mount behind an environment check yourself — the
handler has no built-in environment detection:

```ts
if (import.meta.env.DEV) {
  app.route(
    "/dev/mails",
    new MailPreviewHandler({
      previews: {
        welcome: () => ({
          from: "no-reply@example.com",
          to: "test@example.com",
          subject: "Welcome",
          textBody: "Hi there!",
        }),
      },
    }),
  );
}
```

**Sending through the job queue with `DeliverMailJob`.** Register one
instance per `Mailer` with your `JobRegistry`, then `enqueue` a
`MailMessage` wherever a request would otherwise block on `Mailer#send`:

```ts
import { JobRegistry } from "@tknf/oven/jobs";
import { DeliverMailJob } from "@tknf/oven/mailer";
import { mailer } from "./lib/mailer.js";

export const registry = new JobRegistry();
export const deliverMailJob = new DeliverMailJob(mailer);
registry.register(deliverMailJob);
```

```ts
app.post("/signup", async (c) => {
  await queue.enqueue(deliverMailJob, {
    from: "no-reply@example.com",
    to: "new-user@example.com",
    subject: "Welcome!",
    textBody: "Thanks for signing up.",
  });
  return c.redirect("/");
});
```

`MailMessage` is JSON-serializable by design (attachment `content` is
always a `string`, base64-encoded for binary data), so it can be carried
as-is on any `JobQueue` backend, including ones that persist the payload.

## Gotchas / Security notes

- **`ConsoleMailer` never sends real mail** — it only logs. Don't leave it
  wired up in production; swap in a `FetchMailer` subclass (or your own
  `Mailer` implementation) before deploying.
- **Header injection is validated, but only up to a point.** `FetchMailer#send`
  and `assertNoMailHeaderInjection` reject CR/LF in `from`/`subject`, every
  address in `to`/`cc`/`bcc`, and attachment `filename`/`contentType` — but
  `textBody`/`htmlBody` are body content and are intentionally excluded from
  this check. If you extend `Mailer` directly instead of `FetchMailer`,
  you're responsible for running the same validation yourself before
  sending — `CloudflareEmailMailer` is the one adapter oven ships that does
  this (it calls `assertNoMailHeaderInjection` itself, since it extends
  `Mailer` directly rather than `FetchMailer`).
- **`MailTemplate`'s HTML is auto-escaped through Hono's JSX, but only
  values passed as JSX children/attributes** — anything you construct as a
  raw string outside of JSX (e.g. string-concatenating into `html()`
  yourself) bypasses that escaping.
- **`MailPreviewHandler` has no production guard built in.** It only builds
  and returns a `MailMessage` (it never calls `deliver`/`Mailer#send`), but
  mounting it anywhere reachable in production still exposes internal email
  copy and recipient addresses used in your preview factories. Gate the
  `app.route(...)` call behind an environment check or an auth guard.
- **`DeliverMailJob` failures propagate like any other job failure**: a
  throw from `Mailer#send` propagates immediately from `InlineJobQueue`,
  while a `CloudflareJobQueue` + `QueueConsumer` deployment relies on the
  consumer's own retry behavior. If you register more than one `Mailer`,
  give each `DeliverMailJob` a distinct `options.name` — `JobRegistry`
  throws on a duplicate name, so registering a second job under the default
  `"oven:deliver_mail"` name fails at startup.

## See also

- [Concepts](./concepts.md) — the composition-over-configuration pattern
  (`Mailer` injected via constructor) shared with `Storage` and other
  backend-agnostic abstractions.
- [Jobs](./jobs.md) — `Job`, `JobRegistry`, and `JobQueue`, which
  `DeliverMailJob` builds on.
- [Deployment § Email Sending](./deployment.md#email-sending) — wiring the
  `SendEmail` binding that `CloudflareEmailMailer` wraps.
