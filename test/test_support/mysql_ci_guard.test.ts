/**
 * Guards against the MySQL adapter test suites (`test/model/mysql_model.test.ts`,
 * `test/kv/mysql_database_key_value_store.test.ts`, `test/session/
 * mysql_database_session_storage.test.ts`, ...) going silently green without ever
 * running against a real server.
 *
 * Every one of those files self-skips via `describe.skipIf(!OVEN_MYSQL_TEST_URL)`
 * when the variable is unset — the correct behavior for a local run without
 * Docker. But the same skip would just as quietly hide a CI misconfiguration
 * (e.g. the MySQL service container or the `OVEN_MYSQL_TEST_URL` step got
 * dropped from `.github/workflows/ci.yml`), since a skipped test still reports
 * as passing. GitHub Actions sets the `CI` environment variable to `"true"` for
 * every job, so this test fails loudly instead of skipping whenever `CI` is
 * truthy and `OVEN_MYSQL_TEST_URL` is not set.
 *
 * This test is intentionally not gated by `describe.skipIf`: it must always run
 * so it can catch the very condition the other files' skip gates would hide.
 */
import { expect, test } from "vite-plus/test";

test("OVEN_MYSQL_TEST_URL is set whenever CI is truthy, so MySQL adapter tests never silently skip in CI", () => {
	if (!process.env.CI) return;
	expect(process.env.OVEN_MYSQL_TEST_URL).toBeTruthy();
});
