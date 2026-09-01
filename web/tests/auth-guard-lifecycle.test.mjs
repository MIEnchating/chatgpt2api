import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/lib/use-auth-guard.ts", import.meta.url),
  "utf8",
);
const guardSource = source.slice(
  source.indexOf("export function useAuthGuard"),
  source.indexOf("export function useRedirectIfAuthenticated"),
);
const redirectSource = source.slice(source.indexOf("export function useRedirectIfAuthenticated"));

describe("auth guard lifecycle", () => {
  test("both public hooks share one verified-session lifecycle", () => {
    expect(source.match(/getVerifiedAuthSession\(\)/g)).toHaveLength(1);
    expect(source.match(/let active = true;/g)).toHaveLength(1);
    expect(source.match(/if \(!active\)/g)).toHaveLength(2);
    expect(source.match(/const \{ isCheckingAuth \} = useVerifiedSessionLifecycle\(/g)).toHaveLength(2);
  });

  test("retry and persistent error feedback remain centralized", () => {
    expect(source).toContain(`setIsCheckingAuth(true);\n    setRetryVersion((version) => version + 1);`);
    expect(source).toContain("toast.dismiss(AUTH_SESSION_ERROR_TOAST_ID)");
    expect(source).toContain("duration: Infinity");
    expect(source).toContain('label: "重试"');
  });

  test("the protected-route handler finishes checking before every redirect", () => {
    expect(guardSource).toContain(`setSession(null);\n      finishChecking();\n      navigate("/login", { replace: true });`);
    expect(guardSource.match(/finishChecking\(\);/g)).toHaveLength(4);
    expect(guardSource).toContain("() => getCachedAuthSession() === undefined");
    expect(guardSource).toContain("}, [allowedRolesKey, navigate, requiredPath]);");
  });

  test("the login redirect keeps checking active until navigation", () => {
    expect(redirectSource).toContain(`if (storedSession) {\n      navigate(getDefaultRouteForSession(storedSession), { replace: true });\n      return;\n    }\n\n    finishChecking();`);
    expect(redirectSource.match(/finishChecking\(\);/g)).toHaveLength(1);
    expect(redirectSource).toContain("() => getCachedAuthSession() !== null");
    expect(redirectSource).toContain("}, [navigate]);");
  });
});
