/**
 * Abstract base class for authorization.
 *
 * Judgments (abilities) are "pure methods returning boolean" declared by
 * subclasses; the framework only supplies the enforcement convention
 * (`authorize`). We do not adopt the magic of registering ability names as
 * strings and looking them up at runtime; abilities are declared as
 * read-only arrow-function fields on the subclass and judged via explicit
 * method calls.
 *
 * The default status on denial is 404 (aligned with `error_handler.ts`'s
 * information-disclosure-prevention policy of "unifying 'not found' and 'no
 * permission' into the same 404"). Only when you want to make explicit that
 * the target exists but the operation is not permitted should a subclass
 * override `denyStatus` to 403.
 *
 * Usage:
 * ```ts
 * class BookPolicy extends Policy {
 * 	readonly canUpdate = (user: Account, book: Book): boolean => user.id === book.ownerId;
 * }
 *
 * const policy = new BookPolicy();
 * await policy.authorize(policy.canUpdate(user, book));
 * ```
 */
import { HTTPException } from "hono/http-exception";

export abstract class Policy {
	/**
	 * The HTTP status thrown on denial. Defaults to 404 (the
	 * information-disclosure-prevention unification policy). Override to 403 in
	 * a subclass only when you want to reveal the target's existence while
	 * making clear that permission is denied.
	 */
	protected get denyStatus(): 403 | 404 {
		return 404;
	}

	/**
	 * Enforces an ability's judgment result. Throws `HTTPException(denyStatus)`
	 * if `false`; resolves without doing anything if `true`. Since ability
	 * methods are themselves designed to return `boolean`, no other combinator
	 * helpers are provided.
	 *
	 * Usage: `await policy.authorize(policy.canUpdate(user, book));`
	 */
	readonly authorize = async (allowed: boolean | Promise<boolean>): Promise<void> => {
		if (!(await allowed)) {
			throw new HTTPException(this.denyStatus);
		}
	};
}
