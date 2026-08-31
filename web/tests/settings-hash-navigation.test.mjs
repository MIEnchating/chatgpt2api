import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsPage = await readFile(new URL("../src/app/settings/page.tsx", import.meta.url), "utf8");

test("settings hash listener stays stable and follows permission-dependent sections", () => {
  assert.match(settingsPage, /const settingsItems = useMemo\(\(\) => \[[\s\S]*?\], \[session\]\);/);
  assert.match(settingsPage, /const sectionFromHash = useCallback\(\(\) => \{[\s\S]*?settingsItems\.some[\s\S]*?\}, \[settingsItems\]\);/);
  assert.match(settingsPage, /const \[activeSection, setActiveSection\] = useState\(sectionFromHash\);/);
  assert.match(settingsPage, /useEffect\(\(\) => \{\s*const handleHashChange = \(\) => setActiveSection\(sectionFromHash\(\)\);\s*handleHashChange\(\);[\s\S]*?\}, \[sectionFromHash\]\);/);
  assert.match(settingsPage, /settingsItems\.some\(\(item\) => item\.id === hash\)/);
});
