import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const sources = Object.fromEntries(["users", "rbac"].map(name => [name, ts.createSourceFile(`${name}.tsx`, readFileSync(new URL(`../src/app/${name}/page.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));

function compile(expression, context) {
  const code = ts.transpile(`const callback = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${code}\nreturn callback;`)(...Object.values(context));
}

// Execute production callbacks with deferred API responses and shared refs.
function callback(domain, name, context) {
  const source = sources[domain];
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      const value = node.initializer;
      expression = ts.isCallExpression(value) && value.expression.getText(source) === "useCallback"
        ? value.arguments[0].getText(source) : value.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing ${domain}.${name}`);
  return compile(expression, context);
}

function dialogChange(domain, openExpression, context) {
  const source = sources[domain];
  let expression;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "Dialog") {
      const attributes = node.attributes.properties;
      const open = attributes.find(item => item.name?.getText(source) === "open");
      if (open?.initializer?.expression?.getText(source) === openExpression) {
        expression = attributes.find(item => item.name?.getText(source) === "onOpenChange").initializer.expression.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing ${domain} dialog ${openExpression}`);
  return compile(expression, context);
}

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}

function usersFixture(response) {
  const requests = [];
  const commits = [];
  const user = { id: "user-a", enabled: true };
  const context = {
    pageActiveRef: { current: true }, creatingUserRef: { current: false }, pendingUserIdsRef: { current: new Set() },
    loadUsersRequestRef: { current: 0 }, loadUsersAbortRef: { current: null }, rolesLoadedRef: { current: true },
    usersQueryRef: { current: { page: 1, pageSize: "20", searchText: "old", providerFilter: "all", statusFilter: "all", sortBy: "id", sortOrder: "desc" } },
    createForm: { role_id: "role-a" }, roleUser: user, selectedRoleId: "role-a", deletingUser: user,
    validateCreateUserForm: () => ({}), createUserPayload: value => value, createEmptyUserForm: () => ({}),
    createManagedUser: () => response.promise, updateManagedUser: () => response.promise, deleteManagedUser: () => response.promise,
    fetchManagedUsers: async query => { requests.push(query); return { items: [], total: 0, total_pages: 1, page: 1, usage_stats_available: true }; },
    fetchManagedRoles: () => assert.fail("Mutation refresh should not reload roles"),
    normalizeManagedUsers: values => values, normalizeManagedRoles: values => values,
    setIsLoading: () => {}, setItems: () => {}, setTotal: () => {}, setTotalPages: () => {}, setUsageStatsAvailable: () => {}, setPage: () => {},
    setRoles: () => {}, setCreateForm: () => commits.push("form"), setCreateErrors: () => {},
    setIsCreateDialogOpen: () => commits.push("create-dialog"), setIsCreating: () => {}, setIsSavingRole: () => {},
    setRoleUser: () => commits.push("role-dialog"), setDeletingUser: () => commits.push("delete-dialog"), setPendingIds: () => {},
    toast: { success: () => commits.push("toast"), error: error => assert.fail(String(error)) },
  };
  context.loadUsers = callback("users", "loadUsers", context);
  context.setItemPending = callback("users", "setItemPending", context);
  return { user, context, requests, commits };
}

for (const name of ["handleCreate", "handleToggle", "handleSaveRole", "handleDelete"]) {
  test(`users ${name} refreshes using the filters selected while its request was pending`, async () => {
    const response = deferred();
    const fixture = usersFixture(response);
    const action = callback("users", name, fixture.context);
    const pending = action(fixture.user);
    fixture.context.usersQueryRef.current = { page: 3, pageSize: "50", searchText: "new search", providerFilter: "local", statusFilter: "disabled", sortBy: "name", sortOrder: "asc" };
    response.resolve({});
    await pending;
    assert.equal(fixture.requests.length, 1);
    const { signal, ...request } = fixture.requests[0];
    assert.equal(signal.aborted, false);
    assert.deepEqual(request, { page: 3, page_size: "50", search: "new search", provider: "local", status: "disabled", sort_by: "name", sort_order: "asc" });
  });

  test(`users ${name} does not refresh or clear forms after unmount`, async () => {
    const response = deferred();
    const fixture = usersFixture(response);
    const pending = callback("users", name, fixture.context)(fixture.user);
    fixture.context.pageActiveRef.current = false;
    response.resolve({});
    await pending;
    assert.deepEqual(fixture.requests, []);
    assert.deepEqual(fixture.commits, []);
  });
}

test("users synchronously reject duplicate mutations before a render", async () => {
  for (const name of ["handleCreate", "handleToggle", "handleSaveRole", "handleDelete"]) {
    const response = deferred();
    const fixture = usersFixture(response);
    let calls = 0;
    const context = { ...fixture.context };
    for (const api of ["createManagedUser", "updateManagedUser", "deleteManagedUser"]) {
      context[api] = () => { calls++; return response.promise; };
    }
    const action = callback("users", name, context);
    const first = action(fixture.user);
    await action(fixture.user);
    assert.equal(calls, 1, name);
    response.resolve({});
    await first;
  }
});

function rolesFixture(response) {
  const role = { id: "role-a", name: "Role A" };
  const calls = [];
  const commits = [];
  const context = {
    pageActiveRef: { current: true }, mutationPendingRef: { current: false },
    loadRBACRequestRef: { current: 0 }, loadRBACAbortRef: { current: null },
    selectedRoleIdRef: { current: role.id }, draftVersionRef: { current: 0 },
    selectedRole: role, roleName: role.name, roleDescription: "", selectedMenuPaths: [], selectedApiPermissions: [],
    createName: "New role", createDescription: "", deletingRole: role,
    updateManagedRole: () => { calls.push("save"); return response.promise; },
    createManagedRole: () => { calls.push("create"); return response.promise; },
    deleteManagedRole: () => { calls.push("delete"); return response.promise; },
    fetchManagedRoles: () => { calls.push("load"); return response.promise; }, fetchPermissionCatalog: async () => ({ menus: [], apis: [] }),
    normalizeManagedRoles: values => values, applySelectedRole: value => commits.push(["selection", value]),
    setRoles: value => commits.push(["roles", value]), setCatalog: value => commits.push(["catalog", value]),
    setIsLoading: () => {}, setIsSaving: () => {}, setIsCreating: () => {}, setIsDeleting: () => {},
    setCreateName: () => commits.push(["name"]), setCreateDescription: () => commits.push(["description"]),
    setIsCreateDialogOpen: () => commits.push(["create-dialog"]), setDeletingRole: () => commits.push(["delete-dialog"]),
    toast: { success: () => commits.push(["toast"]), error: error => assert.fail(String(error)) },
  };
  return { context, role, calls, commits };
}

for (const name of ["handleSave", "handleCreate", "handleDelete"]) {
  test(`rbac ${name} excludes other mutations and full-table refreshes until it settles`, async () => {
    const response = deferred();
    const fixture = rolesFixture(response);
    const pending = callback("rbac", name, fixture.context)();
    for (const other of ["handleSave", "handleCreate", "handleDelete", "loadRBAC"]) {
      await callback("rbac", other, fixture.context)();
    }
    assert.equal(fixture.calls.length, 1);
    response.resolve({ item: fixture.role, items: [fixture.role] });
    await pending;
    assert.equal(fixture.context.mutationPendingRef.current, false);
  });

  test(`rbac ${name} cannot apply a response after its page unmounts`, async () => {
    const response = deferred();
    const fixture = rolesFixture(response);
    const pending = callback("rbac", name, fixture.context)();
    fixture.context.pageActiveRef.current = false;
    response.resolve({ item: fixture.role, items: [fixture.role] });
    await pending;
    assert.deepEqual(fixture.commits, []);
    assert.equal(fixture.context.mutationPendingRef.current, false);
  });
}

test("a role mutation invalidates an older full-table load", async () => {
  const loadResponse = deferred();
  const mutationResponse = deferred();
  const fixture = rolesFixture(mutationResponse);
  fixture.context.fetchManagedRoles = () => loadResponse.promise;
  const loading = callback("rbac", "loadRBAC", fixture.context)();
  const controller = fixture.context.loadRBACAbortRef.current;
  const saving = callback("rbac", "handleSave", fixture.context)();
  assert.equal(controller.signal.aborted, true);
  loadResponse.resolve({ items: [{ id: "stale" }] });
  await loading;
  assert.deepEqual(fixture.commits, []);
  mutationResponse.resolve({ item: fixture.role, items: [fixture.role] });
  await saving;
  assert.deepEqual(fixture.commits.find(([type]) => type === "roles"), ["roles", [fixture.role]]);
});

test("role deletion preserves another selected role and its unsaved draft", async () => {
  const response = deferred();
  const fixture = rolesFixture(response);
  const deleting = callback("rbac", "handleDelete", fixture.context)();
  fixture.context.selectedRoleIdRef.current = "role-b";
  response.resolve({ items: [{ id: "role-b", name: "Saved name" }] });
  await deleting;
  assert.equal(fixture.commits.some(([type]) => type === "selection"), false);
});

test("pending user and role dialogs reject outside-close events", () => {
  const pending = { current: true };
  const users = { current: new Set(["user-a"]) };
  let closed = 0;
  const context = {
    mutationPendingRef: pending, pendingUserIdsRef: users, roleUser: { id: "user-a" }, deletingUser: { id: "user-a" },
    setRoleUser: () => closed++, setDeletingUser: () => closed++, setIsCreateDialogOpen: () => closed++, setDeletingRole: () => closed++,
  };
  const handlers = [
    dialogChange("users", "Boolean(roleUser)", context), dialogChange("users", "Boolean(deletingUser)", context),
    dialogChange("rbac", "isCreateDialogOpen", context), dialogChange("rbac", "Boolean(deletingRole)", context),
  ];
  handlers.forEach(handler => handler(false));
  assert.equal(closed, 0);
  pending.current = false;
  users.current.clear();
  handlers.forEach(handler => handler(false));
  assert.equal(closed, 4);
});

test("user creation keeps its form open and unchanged while submitting", () => {
  const fixture = usersFixture(deferred());
  fixture.context.creatingUserRef.current = true;
  const close = callback("users", "closeCreateDialog", fixture.context);
  close(false);
  assert.deepEqual(fixture.commits, []);
});
