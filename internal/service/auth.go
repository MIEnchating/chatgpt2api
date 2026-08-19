package service

import (
	"crypto/hmac"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	AuthRoleAdmin = "admin"
	AuthRoleUser  = "user"

	AuthKindAPIKey  = "api_key"
	AuthKindSession = "session"

	AuthProviderLocal   = "local"
	AuthProviderLinuxDo = "linuxdo"
	AuthProviderNewAPI  = "newapi"

	DefaultManagedRoleID = "default-user"

	rbacRolesDocumentName = "rbac_roles.json"
	AuthSessionLifetime   = 30 * 24 * time.Hour
)

var ErrAuthUserCreationDisabled = authError("auth user creation is disabled")

type AuthPersistenceError struct {
	Err error
}

func (e AuthPersistenceError) Error() string {
	return "auth persistence failed"
}

func (e AuthPersistenceError) Unwrap() error {
	return e.Err
}

type Identity struct {
	ID             string
	Username       string
	Name           string
	Role           string
	RoleID         string
	RoleName       string
	Provider       string
	OwnerID        string
	CredentialID   string
	CredentialName string
	Kind           string
	MenuPaths      []string
	APIPermissions []string
}

func (i Identity) Map() map[string]any {
	return map[string]any{
		"id":              i.ID,
		"username":        i.Username,
		"name":            i.Name,
		"role":            i.Role,
		"role_id":         i.RoleID,
		"role_name":       i.RoleName,
		"provider":        i.Provider,
		"owner_id":        i.OwnerID,
		"credential_id":   i.CredentialID,
		"credential_name": i.CredentialName,
		"kind":            i.Kind,
		"menu_paths":      append([]string(nil), i.MenuPaths...),
		"api_permissions": append([]string(nil), i.APIPermissions...),
	}
}

type AuthOwner struct {
	ID           string
	Name         string
	Provider     string
	LinuxDoLevel string
}

type AuthKeyFilter struct {
	Role    string
	Kind    string
	OwnerID string
}

type ManagedRole struct {
	ID             string
	Name           string
	Description    string
	Builtin        bool
	MenuPaths      []string
	APIPermissions []string
	CreatedAt      string
	UpdatedAt      string
}

func (r ManagedRole) PermissionSet() PermissionSet {
	return PermissionSet{
		MenuPaths:      NormalizeMenuPermissions(r.MenuPaths),
		APIPermissions: NormalizeAPIPermissions(r.APIPermissions),
	}
}

type AuthService struct {
	mu              sync.Mutex
	storage         storage.Backend
	roleStore       storage.JSONDocumentBackend
	accounts        []PasswordAccount
	items           []map[string]any
	roles           []ManagedRole
	lastUsedFlushAt map[string]time.Time
	onUserCreated   func(string)
}

func NewAuthService(backend storage.Backend) (*AuthService, error) {
	if backend == nil {
		return nil, fmt.Errorf("auth storage backend is required")
	}
	s := &AuthService{storage: backend, roleStore: jsonDocumentStoreFromBackend(backend), lastUsedFlushAt: map[string]time.Time{}}
	var err error
	s.roles, err = s.loadRoles()
	if err != nil {
		return nil, fmt.Errorf("load auth roles: %w", err)
	}
	s.accounts, err = s.loadPasswordAccounts()
	if err != nil {
		return nil, fmt.Errorf("load password accounts: %w", err)
	}
	var sanitizeSessions bool
	s.items, sanitizeSessions, err = s.load()
	if err != nil {
		return nil, fmt.Errorf("load auth credentials: %w", err)
	}
	s.syncPasswordAccountsToItems()
	s.applyRolesToItems()
	if sanitizeSessions {
		if err := s.saveLocked(); err != nil {
			return nil, fmt.Errorf("sanitize stored auth sessions: %w", err)
		}
	}
	return s, nil
}

func (s *AuthService) SetUserCreatedHook(fn func(string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onUserCreated = fn
}

func (s *AuthService) notifyUserCreated(userID string) {
	userID = util.Clean(userID)
	if userID == "" {
		return
	}
	s.mu.Lock()
	fn := s.onUserCreated
	s.mu.Unlock()
	if fn != nil {
		fn(userID)
	}
}

func (s *AuthService) ListKeys(filter AuthKeyFilter) []map[string]any {
	filter = normalizeAuthKeyFilter(filter)
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, 0, len(s.items))
	for _, item := range s.items {
		if matchAuthKey(item, filter) {
			out = append(out, publicAuthItem(item))
		}
	}
	return out
}

func (s *AuthService) ListSingleAPIKeyForOwner(ownerID string) []map[string]any {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return []map[string]any{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	kept := false
	for _, item := range s.items {
		matchesOwnerAPIKey := util.Clean(item["role"]) == AuthRoleUser &&
			util.Clean(item["kind"]) == AuthKindAPIKey &&
			util.Clean(item["owner_id"]) == ownerID
		if !matchesOwnerAPIKey {
			continue
		}
		if kept {
			continue
		}
		kept = true
		out = append(out, publicAuthItem(item))
	}
	return out
}

func (s *AuthService) ListPersonalAPIKey(identity Identity) []map[string]any {
	role, owner, ok := personalAPIKeyScope(identity)
	if !ok {
		return []map[string]any{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	kept := false
	for _, item := range s.items {
		matchesPersonalAPIKey := util.Clean(item["role"]) == role &&
			util.Clean(item["kind"]) == AuthKindAPIKey &&
			util.Clean(item["owner_id"]) == owner.ID
		if !matchesPersonalAPIKey {
			continue
		}
		if kept {
			continue
		}
		kept = true
		out = append(out, publicAuthItem(item))
	}
	return out
}

func (s *AuthService) ListUsers() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listManagedAuthUsersLocked(s.items, s.roles, s.accounts)
}

func (s *AuthService) ListRoles() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return publicManagedRolesLocked(s.roles, s.items, s.accounts)
}

func (s *AuthService) RoleExists(id string) bool {
	id = util.Clean(id)
	if id == "" {
		id = DefaultManagedRoleID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := managedRoleByIDLocked(s.roles, id)
	return ok
}

func (s *AuthService) CreateRole(updates map[string]any) (map[string]any, error) {
	name := util.Clean(updates["name"])
	if name == "" {
		return nil, authError("role name is required")
	}
	permissions := DefaultPermissionSetForRole(AuthRoleUser)
	if value, ok := updates["menu_paths"]; ok {
		permissions.MenuPaths = NormalizeMenuPermissions(util.AsStringSlice(value))
	}
	if value, ok := updates["api_permissions"]; ok {
		permissions.APIPermissions = NormalizeAPIPermissions(util.AsStringSlice(value))
	}
	now := util.NowISO()
	role := ManagedRole{
		ID:             "role_" + util.NewHex(10),
		Name:           name,
		Description:    util.Clean(updates["description"]),
		MenuPaths:      permissions.MenuPaths,
		APIPermissions: permissions.APIPermissions,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if managedRoleNameExistsLocked(s.roles, "", name) {
		return nil, authError("role name already exists")
	}
	previousRoles := append([]ManagedRole(nil), s.roles...)
	previousItems := cloneAuthItems(s.items)
	s.roles = append(s.roles, role)
	sortManagedRoles(s.roles)
	if err := s.saveRolesLocked(); err != nil {
		s.restoreAuthRolesAfterSaveFailureLocked(previousRoles, previousItems, err)
		return nil, err
	}
	counts := managedRoleUserCountsLocked(s.items, s.accounts)
	return publicManagedRole(role, counts[role.ID]), nil
}

func (s *AuthService) UpdateRole(id string, updates map[string]any) (map[string]any, error) {
	id = util.Clean(id)
	if id == "" {
		return nil, authError("role id is required")
	}
	_, hasName := updates["name"]
	_, hasDescription := updates["description"]
	_, hasMenuPaths := updates["menu_paths"]
	_, hasAPIPermissions := updates["api_permissions"]
	if !hasName && !hasDescription && !hasMenuPaths && !hasAPIPermissions {
		return nil, authError("no updates provided")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for index, role := range s.roles {
		if role.ID != id {
			continue
		}
		previousRoles := append([]ManagedRole(nil), s.roles...)
		previousItems := cloneAuthItems(s.items)
		next := role
		if hasName {
			name := util.Clean(updates["name"])
			if name == "" {
				return nil, authError("role name is required")
			}
			if managedRoleNameExistsLocked(s.roles, role.ID, name) {
				return nil, authError("role name already exists")
			}
			next.Name = name
		}
		if hasDescription {
			next.Description = util.Clean(updates["description"])
		}
		if hasMenuPaths {
			next.MenuPaths = NormalizeMenuPermissions(util.AsStringSlice(updates["menu_paths"]))
		}
		if hasAPIPermissions {
			next.APIPermissions = NormalizeAPIPermissions(util.AsStringSlice(updates["api_permissions"]))
		}
		next.Builtin = role.Builtin
		next.UpdatedAt = util.NowISO()
		s.roles[index] = next
		sortManagedRoles(s.roles)
		for _, item := range s.items {
			if util.Clean(item["role"]) == AuthRoleUser && managedAuthRoleID(item) == next.ID {
				applyManagedRoleToAuthItem(item, next)
			}
		}
		if err := s.saveAuthAndRolesLocked(); err != nil {
			s.restoreAuthRolesAfterSaveFailureLocked(previousRoles, previousItems, err)
			return nil, err
		}
		counts := managedRoleUserCountsLocked(s.items, s.accounts)
		return publicManagedRole(next, counts[next.ID]), nil
	}
	return nil, authError("role not found")
}

func (s *AuthService) DeleteRole(id string) (bool, error) {
	id = util.Clean(id)
	if id == "" {
		return false, authError("role id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	role, ok := managedRoleByIDLocked(s.roles, id)
	if !ok {
		return false, nil
	}
	if role.Builtin {
		return false, authError("builtin role cannot be deleted")
	}
	counts := managedRoleUserCountsLocked(s.items, s.accounts)
	if counts[id] > 0 {
		return false, authError("role is assigned to users")
	}
	previousRoles := append([]ManagedRole(nil), s.roles...)
	previousItems := cloneAuthItems(s.items)
	next := s.roles[:0]
	for _, item := range s.roles {
		if item.ID != id {
			next = append(next, item)
		}
	}
	s.roles = next
	if err := s.saveRolesLocked(); err != nil {
		s.restoreAuthRolesAfterSaveFailureLocked(previousRoles, previousItems, err)
		return false, err
	}
	return true, nil
}

func (s *AuthService) PermissionCatalog() map[string]any {
	return map[string]any{
		"menus": AllMenuPermissions(),
		"apis":  AllAPIPermissions(),
	}
}

func (s *AuthService) CreateAPIKey(role, name string, owner AuthOwner) (map[string]any, string, error) {
	return s.createCredential(role, AuthKindAPIKey, name, owner, "")
}

func (s *AuthService) UpsertAPIKeyForOwner(name string, owner AuthOwner) (map[string]any, string, error) {
	owner = normalizeAuthOwner(owner)
	if owner.ID == "" {
		return nil, "", errAuthOwnerRequired()
	}
	name = util.Clean(name)
	if name == "" {
		name = "我的 API 令牌"
	}
	raw := "sk-" + util.RandomTokenURL(24)
	now := util.NowISO()

	s.mu.Lock()
	previousItems := cloneAuthItems(s.items)
	nextItems := make([]map[string]any, 0, len(s.items)+1)
	var updated map[string]any
	createdUserID := ""
	ownerExists := managedUserExistsLocked(s.items, s.accounts, owner.ID)
	for _, item := range s.items {
		matchesOwnerAPIKey := util.Clean(item["role"]) == AuthRoleUser &&
			util.Clean(item["kind"]) == AuthKindAPIKey &&
			util.Clean(item["owner_id"]) == owner.ID
		if !matchesOwnerAPIKey {
			nextItems = append(nextItems, item)
			continue
		}
		if updated != nil {
			continue
		}
		updated = util.CopyMap(item)
		updated["name"] = name
		updated["provider"] = owner.Provider
		updated["owner_name"] = owner.Name
		if account, ok := passwordAccountByIDLocked(s.accounts, owner.ID); ok {
			updated["username"] = account.Username
		}
		updated["key"] = raw
		updated["key_hash"] = util.SHA256Hex(raw)
		updated["enabled"] = true
		updated["last_used_at"] = nil
		updated["updated_at"] = now
		nextItems = append(nextItems, updated)
	}
	if updated == nil {
		updated = newAuthItem(AuthRoleUser, AuthKindAPIKey, name, owner, raw)
		if account, ok := passwordAccountByIDLocked(s.accounts, owner.ID); ok {
			updated["username"] = account.Username
		}
		if roleID, ok := managedAuthRoleIDLocked(s.items, s.accounts, owner.ID); ok {
			s.applyRoleToAuthItem(updated, roleID)
		} else {
			s.applyRoleToAuthItem(updated, "")
		}
		nextItems = append(nextItems, updated)
		if !ownerExists {
			createdUserID = managedAuthUserID(updated)
		}
	}
	s.items = nextItems
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
		s.mu.Unlock()
		return nil, "", err
	}
	item := publicAuthItem(updated)
	s.mu.Unlock()
	s.notifyUserCreated(createdUserID)
	return item, raw, nil
}

func (s *AuthService) UpsertPersonalAPIKey(identity Identity, name string) (map[string]any, string, error) {
	role, owner, ok := personalAPIKeyScope(identity)
	if !ok {
		return nil, "", errAuthOwnerRequired()
	}
	name = util.Clean(name)
	if name == "" {
		name = "我的 API 令牌"
	}
	raw := "sk-" + util.RandomTokenURL(24)
	now := util.NowISO()

	s.mu.Lock()
	defer s.mu.Unlock()
	previousItems := cloneAuthItems(s.items)
	nextItems := make([]map[string]any, 0, len(s.items)+1)
	var updated map[string]any
	for _, item := range s.items {
		matchesPersonalAPIKey := util.Clean(item["role"]) == role &&
			util.Clean(item["kind"]) == AuthKindAPIKey &&
			util.Clean(item["owner_id"]) == owner.ID
		if !matchesPersonalAPIKey {
			nextItems = append(nextItems, item)
			continue
		}
		if updated != nil {
			continue
		}
		updated = util.CopyMap(item)
		updated["name"] = name
		updated["provider"] = owner.Provider
		updated["owner_name"] = owner.Name
		updated["key"] = raw
		updated["key_hash"] = util.SHA256Hex(raw)
		updated["enabled"] = true
		updated["last_used_at"] = nil
		updated["updated_at"] = now
		s.applyIdentityRoleToAPIKey(updated, role, owner.ID)
		nextItems = append(nextItems, updated)
	}
	if updated == nil {
		updated = newAuthItem(role, AuthKindAPIKey, name, owner, raw)
		updated["username"] = identity.Username
		s.applyIdentityRoleToAPIKey(updated, role, owner.ID)
		nextItems = append(nextItems, updated)
	}
	s.items = nextItems
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
		return nil, "", err
	}
	return publicAuthItem(updated), raw, nil
}

func (s *AuthService) UpsertLinuxDoSession(owner AuthOwner) (map[string]any, string, error) {
	return s.upsertLinuxDoSession(owner, true)
}

func (s *AuthService) UpsertLinuxDoSessionIfAllowed(owner AuthOwner, allowCreate bool) (map[string]any, string, error) {
	return s.upsertLinuxDoSession(owner, allowCreate)
}

func (s *AuthService) UpsertNewAPISession(user NewAPIUser) (*Identity, string, error) {
	user.Username = util.Clean(user.Username)
	if user.ID <= 0 || user.Username == "" {
		return nil, "", errAuthOwnerRequired()
	}
	role := AuthRoleUser
	if user.IsAdmin {
		role = AuthRoleAdmin
	}
	name := util.Clean(user.DisplayName)
	if name == "" {
		name = user.Username
	}
	owner := AuthOwner{
		ID:       fmt.Sprintf("newapi:%d", user.ID),
		Name:     name,
		Provider: AuthProviderNewAPI,
	}
	raw := "sess-" + util.RandomTokenURL(32)
	now := util.NowISO()

	s.mu.Lock()
	previousItems := cloneAuthItems(s.items)
	sessionEnabled := true
	ownerSeen := false
	ownerHasEnabled := false
	for _, item := range s.items {
		if util.Clean(item["owner_id"]) != owner.ID {
			continue
		}
		ownerSeen = true
		if util.ToBool(util.ValueOr(item["enabled"], true)) {
			ownerHasEnabled = true
		}
	}
	if ownerSeen && !ownerHasEnabled {
		sessionEnabled = false
	}
	for index, item := range s.items {
		if util.Clean(item["kind"]) != AuthKindSession ||
			util.Clean(item["provider"]) != AuthProviderNewAPI ||
			util.Clean(item["owner_id"]) != owner.ID {
			continue
		}
		next := util.CopyMap(item)
		next["id"] = util.NewHex(12)
		next["name"] = name
		delete(next, "key")
		next["key_hash"] = util.SHA256Hex(raw)
		next["enabled"] = sessionEnabled
		next["owner_name"] = name
		next["username"] = user.Username
		next["email"] = user.Email
		next["last_used_at"] = nil
		next["updated_at"] = now
		next["expires_at"] = authSessionExpiry(now)
		next["role"] = role
		if role == AuthRoleAdmin {
			next["role_id"] = AuthRoleAdmin
			next["role_name"] = "管理员"
			applyPermissionSet(next, DefaultPermissionSetForRole(AuthRoleAdmin))
		} else {
			if roleID, ok := managedAuthRoleIDLocked(s.items, s.accounts, owner.ID); ok {
				s.applyRoleToAuthItem(next, roleID)
			} else {
				s.applyRoleToAuthItem(next, "")
			}
		}
		s.items[index] = next
		if err := s.saveLocked(); err != nil {
			s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
			s.mu.Unlock()
			return nil, "", err
		}
		identity := identityForAuthItem(next)
		s.mu.Unlock()
		return identity, raw, nil
	}

	item := newAuthItem(role, AuthKindSession, name, owner, raw)
	item["username"] = user.Username
	item["email"] = user.Email
	item["enabled"] = sessionEnabled
	item["updated_at"] = now
	if role == AuthRoleAdmin {
		item["role_id"] = AuthRoleAdmin
		item["role_name"] = "管理员"
		applyPermissionSet(item, DefaultPermissionSetForRole(AuthRoleAdmin))
	} else {
		if roleID, ok := managedAuthRoleIDLocked(s.items, s.accounts, owner.ID); ok {
			s.applyRoleToAuthItem(item, roleID)
		} else {
			s.applyRoleToAuthItem(item, "")
		}
	}
	s.items = append(s.items, item)
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
		s.mu.Unlock()
		return nil, "", err
	}
	identity := identityForAuthItem(item)
	createdUserID := ""
	if !ownerSeen {
		createdUserID = managedAuthUserID(item)
	}
	s.mu.Unlock()
	s.notifyUserCreated(createdUserID)
	return identity, raw, nil
}

func (s *AuthService) upsertLinuxDoSession(owner AuthOwner, allowCreate bool) (map[string]any, string, error) {
	owner.ID = util.Clean(owner.ID)
	owner.Name = util.Clean(owner.Name)
	owner.Provider = AuthProviderLinuxDo
	if owner.ID == "" {
		return nil, "", errAuthOwnerRequired()
	}
	name := owner.Name
	if name == "" {
		name = "Linuxdo 用户"
	}
	raw := "sess-" + util.RandomTokenURL(32)
	now := util.NowISO()

	s.mu.Lock()
	previousItems := cloneAuthItems(s.items)
	sessionEnabled := true
	ownerSeen := false
	ownerHasEnabled := false
	for _, item := range s.items {
		if util.Clean(item["role"]) != AuthRoleUser || util.Clean(item["owner_id"]) != owner.ID {
			continue
		}
		ownerSeen = true
		if util.ToBool(util.ValueOr(item["enabled"], true)) {
			ownerHasEnabled = true
		}
	}
	if ownerSeen && !ownerHasEnabled {
		sessionEnabled = false
	}
	for index, item := range s.items {
		if util.Clean(item["kind"]) != AuthKindSession ||
			util.Clean(item["provider"]) != AuthProviderLinuxDo ||
			util.Clean(item["owner_id"]) != owner.ID {
			continue
		}
		next := util.CopyMap(item)
		next["id"] = util.NewHex(12)
		next["name"] = name
		delete(next, "key")
		next["key_hash"] = util.SHA256Hex(raw)
		next["enabled"] = sessionEnabled
		next["owner_name"] = name
		next["linuxdo_level"] = owner.LinuxDoLevel
		next["last_used_at"] = nil
		next["updated_at"] = now
		next["expires_at"] = authSessionExpiry(now)
		s.items[index] = next
		if err := s.saveLocked(); err != nil {
			s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
			s.mu.Unlock()
			return nil, "", err
		}
		item := publicAuthItem(next)
		s.mu.Unlock()
		return item, raw, nil
	}
	if !ownerSeen && !allowCreate {
		s.mu.Unlock()
		return nil, "", ErrAuthUserCreationDisabled
	}

	item := newAuthItem(AuthRoleUser, AuthKindSession, name, owner, raw)
	if roleID, ok := managedAuthRoleIDLocked(s.items, s.accounts, owner.ID); ok {
		s.applyRoleToAuthItem(item, roleID)
	} else {
		s.applyRoleToAuthItem(item, "")
	}
	item["enabled"] = sessionEnabled
	s.items = append(s.items, item)
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
		s.mu.Unlock()
		return nil, "", err
	}
	public := publicAuthItem(item)
	createdUserID := ""
	if !ownerSeen {
		createdUserID = managedAuthUserID(item)
	}
	s.mu.Unlock()
	s.notifyUserCreated(createdUserID)
	return public, raw, nil
}

func (s *AuthService) RevealKey(id string, filter AuthKeyFilter) (string, bool) {
	id = util.Clean(id)
	if id == "" {
		return "", false
	}
	filter = normalizeAuthKeyFilter(filter)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.items {
		if item["id"] != id || !matchAuthKey(item, filter) {
			continue
		}
		raw := util.Clean(item["key"])
		if raw == "" {
			return "", false
		}
		return raw, true
	}
	return "", false
}

func (s *AuthService) UpdateKey(id string, updates map[string]any, filter AuthKeyFilter) (map[string]any, error) {
	id = util.Clean(id)
	if id == "" {
		return nil, nil
	}
	filter = normalizeAuthKeyFilter(filter)
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range s.items {
		if item["id"] != id || !matchAuthKey(item, filter) {
			continue
		}
		next := util.CopyMap(item)
		if value, ok := updates["name"]; ok && value != nil {
			name := util.Clean(value)
			if name == "" {
				name = defaultCredentialName(util.Clean(next["role"]), util.Clean(next["kind"]))
			}
			next["name"] = name
		}
		if value, ok := updates["enabled"]; ok && value != nil {
			next["enabled"] = util.ToBool(value)
		}
		previous := s.items[index]
		s.items[index] = next
		if err := s.saveLocked(); err != nil {
			s.items[index] = previous
			s.reloadAuthItemsAfterConflictLocked(err)
			return nil, err
		}
		return publicAuthItem(next), nil
	}
	return nil, nil
}

func (s *AuthService) UpdateUser(id string, updates map[string]any) (map[string]any, error) {
	id = util.Clean(id)
	if id == "" {
		return nil, nil
	}
	_, hasName := updates["name"]
	_, hasEnabled := updates["enabled"]
	_, hasRoleID := updates["role_id"]
	if !hasName && !hasEnabled && !hasRoleID {
		return nil, nil
	}
	name := util.Clean(updates["name"])
	enabled := util.ToBool(updates["enabled"])
	roleID := util.Clean(updates["role_id"])
	if hasRoleID && roleID == "" {
		roleID = DefaultManagedRoleID
	}
	now := util.NowISO()

	s.mu.Lock()
	defer s.mu.Unlock()
	var selectedRole ManagedRole
	if hasRoleID {
		role, ok := managedRoleByIDLocked(s.roles, roleID)
		if !ok {
			return nil, nil
		}
		selectedRole = role
	}
	accountDisplayName := ""
	if account, ok := passwordAccountByIDLocked(s.accounts, id); ok {
		accountDisplayName = account.DisplayName()
	}
	previousAccounts := append([]PasswordAccount(nil), s.accounts...)
	previousItems := cloneAuthItems(s.items)
	changed := false
	for index, account := range s.accounts {
		if account.ID != id || account.Role != AuthRoleUser {
			continue
		}
		next := account
		if hasName {
			next.Name = name
			if next.Name == "" {
				next.Name = account.Username
			}
		}
		if hasEnabled {
			next.Enabled = enabled
		}
		if hasRoleID {
			next.RoleID = selectedRole.ID
		}
		next.UpdatedAt = now
		s.accounts[index] = next
		changed = true
	}
	for index, item := range s.items {
		if managedAuthUserID(item) != id {
			continue
		}
		next := util.CopyMap(item)
		if hasName {
			itemName := name
			if itemName == "" {
				itemName = accountDisplayName
			}
			if itemName == "" {
				itemName = defaultCredentialName(util.Clean(next["role"]), util.Clean(next["kind"]))
			}
			if util.Clean(next["owner_id"]) != "" {
				next["owner_name"] = itemName
				if util.Clean(next["kind"]) == AuthKindSession {
					next["name"] = itemName
				}
			} else {
				next["name"] = itemName
			}
		}
		if hasEnabled {
			next["enabled"] = enabled
		}
		if hasRoleID {
			applyManagedRoleToAuthItem(next, selectedRole)
		}
		next["updated_at"] = now
		s.items[index] = next
		changed = true
	}
	if !changed {
		return nil, nil
	}
	var err error
	if account, ok := passwordAccountByIDLocked(s.accounts, id); ok && account.Role == AuthRoleUser {
		err = s.saveAuthAndPasswordAccountsLocked()
	} else {
		err = s.saveLocked()
	}
	if err != nil {
		s.restoreAuthAccountsAfterSaveFailureLocked(previousAccounts, previousItems, err)
		return nil, err
	}
	return managedAuthUserByIDLocked(s.items, s.roles, s.accounts, id), nil
}

func (s *AuthService) DeleteKey(id string, filter AuthKeyFilter) (bool, error) {
	id = util.Clean(id)
	if id == "" {
		return false, nil
	}
	filter = normalizeAuthKeyFilter(filter)
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := cloneAuthItems(s.items)
	next := s.items[:0]
	removed := false
	for _, item := range s.items {
		if item["id"] == id && matchAuthKey(item, filter) {
			removed = true
			continue
		}
		next = append(next, item)
	}
	if !removed {
		return false, nil
	}
	s.items = next
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previous, err)
		return false, err
	}
	return true, nil
}

func (s *AuthService) DeleteUser(id string) (bool, error) {
	id = util.Clean(id)
	if id == "" {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previousAccounts := append([]PasswordAccount(nil), s.accounts...)
	previousItems := cloneAuthItems(s.items)
	removed := false
	removedAccount := false
	nextAccounts := s.accounts[:0]
	for _, account := range s.accounts {
		if account.ID == id {
			removed = true
			removedAccount = true
			continue
		}
		nextAccounts = append(nextAccounts, account)
	}
	s.accounts = nextAccounts
	next := s.items[:0]
	for _, item := range s.items {
		if managedAuthUserID(item) == id {
			removed = true
			continue
		}
		next = append(next, item)
	}
	if !removed {
		return false, nil
	}
	s.items = next
	var err error
	if removedAccount {
		err = s.saveAuthAndPasswordAccountsLocked()
	} else {
		err = s.saveLocked()
	}
	if err != nil {
		s.restoreAuthAccountsAfterSaveFailureLocked(previousAccounts, previousItems, err)
		return false, err
	}
	return true, nil
}

func (s *AuthService) ResetUserAPIKey(id, name string) (map[string]any, map[string]any, string, bool, error) {
	id = util.Clean(id)
	if id == "" {
		return nil, nil, "", false, nil
	}
	name = util.Clean(name)
	raw := "sk-" + util.RandomTokenURL(24)
	now := util.NowISO()

	s.mu.Lock()
	defer s.mu.Unlock()
	previousItems := cloneAuthItems(s.items)
	owner, found := managedAuthOwnerLocked(s.items, s.accounts, id)
	if !found {
		return nil, nil, "", false, nil
	}
	currentUser := managedAuthUserByIDLocked(s.items, s.roles, s.accounts, id)
	enabled := currentUser != nil && util.ToBool(currentUser["enabled"])

	var updated map[string]any
	if owner.ID != "" {
		if name == "" {
			name = "我的 API 令牌"
		}
		nextItems := make([]map[string]any, 0, len(s.items)+1)
		for _, item := range s.items {
			matchesOwnerAPIKey := util.Clean(item["role"]) == AuthRoleUser &&
				util.Clean(item["kind"]) == AuthKindAPIKey &&
				util.Clean(item["owner_id"]) == owner.ID
			if !matchesOwnerAPIKey {
				nextItems = append(nextItems, item)
				continue
			}
			if updated != nil {
				continue
			}
			updated = util.CopyMap(item)
			updated["name"] = name
			updated["provider"] = owner.Provider
			updated["owner_name"] = owner.Name
			updated["linuxdo_level"] = owner.LinuxDoLevel
			if account, ok := passwordAccountByIDLocked(s.accounts, owner.ID); ok {
				updated["username"] = account.Username
			}
			updated["key"] = raw
			updated["key_hash"] = util.SHA256Hex(raw)
			updated["enabled"] = enabled
			updated["last_used_at"] = nil
			updated["updated_at"] = now
			nextItems = append(nextItems, updated)
		}
		if updated == nil {
			updated = newAuthItem(AuthRoleUser, AuthKindAPIKey, name, owner, raw)
			if account, ok := passwordAccountByIDLocked(s.accounts, owner.ID); ok {
				updated["username"] = account.Username
			}
			if roleID, ok := managedAuthRoleIDLocked(s.items, s.accounts, id); ok {
				s.applyRoleToAuthItem(updated, roleID)
			} else {
				s.applyRoleToAuthItem(updated, "")
			}
			updated["enabled"] = enabled
			nextItems = append(nextItems, updated)
		}
		s.items = nextItems
	} else {
		for index, item := range s.items {
			if managedAuthUserID(item) != id || util.Clean(item["kind"]) != AuthKindAPIKey {
				continue
			}
			if name == "" {
				name = util.Clean(item["name"])
			}
			if name == "" {
				name = defaultCredentialName(AuthRoleUser, AuthKindAPIKey)
			}
			updated = util.CopyMap(item)
			updated["name"] = name
			updated["key"] = raw
			updated["key_hash"] = util.SHA256Hex(raw)
			updated["enabled"] = enabled
			updated["last_used_at"] = nil
			updated["updated_at"] = now
			s.items[index] = updated
			break
		}
	}
	if updated == nil {
		return nil, nil, "", false, nil
	}
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
		return nil, nil, "", true, err
	}
	return managedAuthUserByIDLocked(s.items, s.roles, s.accounts, id), publicAuthItem(updated), raw, true, nil
}

func (s *AuthService) RevealUserAPIKey(id string) (string, bool) {
	id = util.Clean(id)
	if id == "" {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.items {
		if managedAuthUserID(item) != id || util.Clean(item["kind"]) != AuthKindAPIKey {
			continue
		}
		raw := util.Clean(item["key"])
		if raw == "" {
			return "", false
		}
		return raw, true
	}
	return "", false
}

func (s *AuthService) Authenticate(raw string) *Identity {
	candidate := util.Clean(raw)
	if candidate == "" {
		return nil
	}
	hash := util.SHA256Hex(candidate)
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range s.items {
		if !util.ToBool(util.ValueOr(item["enabled"], true)) {
			continue
		}
		if util.Clean(item["kind"]) == AuthKindSession && authSessionExpired(item, time.Now().UTC()) {
			continue
		}
		stored := util.Clean(item["key_hash"])
		if stored == "" || !hmac.Equal([]byte(stored), []byte(hash)) {
			continue
		}
		next := util.CopyMap(item)
		s.applyRoleToAuthItem(next, managedAuthRoleID(next))
		now := time.Now().UTC()
		next["last_used_at"] = now.Format(time.RFC3339Nano)
		s.items[index] = next
		id := util.Clean(next["id"])
		if last, ok := s.lastUsedFlushAt[id]; !ok || now.Sub(last) >= time.Minute {
			if err := s.saveLocked(); err == nil {
				s.lastUsedFlushAt[id] = now
			} else {
				s.items[index] = item
				s.reloadAuthItemsAfterConflictLocked(err)
				if errors.Is(err, storage.ErrConcurrentRowUpdate) {
					for _, current := range s.items {
						if !util.ToBool(util.ValueOr(current["enabled"], true)) || authSessionExpiredIfNeeded(current, now) {
							continue
						}
						if hmac.Equal([]byte(util.Clean(current["key_hash"])), []byte(hash)) {
							return identityForAuthItem(current)
						}
					}
					return nil
				}
			}
		}
		return identityForAuthItem(next)
	}
	return nil
}

func authSessionExpiredIfNeeded(item map[string]any, now time.Time) bool {
	return util.Clean(item["kind"]) == AuthKindSession && authSessionExpired(item, now)
}

func (s *AuthService) RevokeSession(raw string) (bool, error) {
	removed, err := s.RevokeSessions(raw)
	return removed > 0, err
}

func (s *AuthService) RevokeSessions(rawTokens ...string) (int, error) {
	hashes := make([]string, 0, len(rawTokens))
	seen := make(map[string]struct{}, len(rawTokens))
	for _, raw := range rawTokens {
		candidate := util.Clean(raw)
		if candidate == "" {
			continue
		}
		hash := util.SHA256Hex(candidate)
		if _, exists := seen[hash]; exists {
			continue
		}
		seen[hash] = struct{}{}
		hashes = append(hashes, hash)
	}
	if len(hashes) == 0 {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := cloneAuthItems(s.items)
	next := make([]map[string]any, 0, len(s.items))
	removed := 0
	for _, item := range s.items {
		if util.Clean(item["kind"]) == AuthKindSession && authHashMatchesAny(util.Clean(item["key_hash"]), hashes) {
			removed++
			continue
		}
		next = append(next, item)
	}
	if removed == 0 {
		return 0, nil
	}
	s.items = next
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previous, err)
		return 0, err
	}
	return removed, nil
}

func authHashMatchesAny(stored string, candidates []string) bool {
	for _, candidate := range candidates {
		if hmac.Equal([]byte(stored), []byte(candidate)) {
			return true
		}
	}
	return false
}

func (s *AuthService) RevokeCredential(id string) error {
	id = util.Clean(id)
	if id == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := cloneAuthItems(s.items)
	next := make([]map[string]any, 0, len(s.items))
	for _, item := range s.items {
		if util.Clean(item["id"]) == id && util.Clean(item["kind"]) == AuthKindSession {
			continue
		}
		next = append(next, item)
	}
	if len(next) == len(s.items) {
		return nil
	}
	s.items = next
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previous, err)
		return err
	}
	return nil
}

func authSessionExpired(item map[string]any, now time.Time) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, util.Clean(item["expires_at"]))
	return err != nil || !expiresAt.After(now)
}

func authSessionExpiry(now string) string {
	issuedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(now))
	if err != nil {
		issuedAt = time.Now().UTC()
	}
	return issuedAt.Add(AuthSessionLifetime).Format(time.RFC3339Nano)
}

func cloneAuthItems(items []map[string]any) []map[string]any {
	cloned := make([]map[string]any, len(items))
	for index, item := range items {
		cloned[index] = util.CopyMap(item)
	}
	return cloned
}

func (s *AuthService) restoreAuthItemsAfterSaveFailureLocked(previous []map[string]any, saveErr error) {
	s.items = previous
	s.reloadAuthItemsAfterConflictLocked(saveErr)
}

func (s *AuthService) restoreAuthAccountsAfterSaveFailureLocked(previousAccounts []PasswordAccount, previousItems []map[string]any, saveErr error) {
	s.accounts = previousAccounts
	s.items = previousItems
	if !errors.Is(saveErr, storage.ErrConcurrentRowUpdate) {
		return
	}
	accounts, accountsErr := s.loadPasswordAccounts()
	items, _, itemsErr := s.load()
	if accountsErr != nil || itemsErr != nil {
		return
	}
	s.accounts = accounts
	s.items = items
	s.syncPasswordAccountsToItems()
	s.applyRolesToItems()
}

func (s *AuthService) restoreAuthRolesAfterSaveFailureLocked(previousRoles []ManagedRole, previousItems []map[string]any, saveErr error) {
	s.roles = previousRoles
	s.items = previousItems
	if !errors.Is(saveErr, storage.ErrConcurrentRowUpdate) {
		return
	}
	roles, rolesErr := s.loadRoles()
	items, _, itemsErr := s.load()
	if rolesErr != nil || itemsErr != nil {
		return
	}
	s.roles = roles
	s.items = items
	s.syncPasswordAccountsToItems()
	s.applyRolesToItems()
}

func (s *AuthService) reloadAuthItemsAfterConflictLocked(saveErr error) {
	if !errors.Is(saveErr, storage.ErrConcurrentRowUpdate) {
		return
	}
	items, _, err := s.load()
	if err != nil {
		return
	}
	s.items = items
	s.syncPasswordAccountsToItems()
	s.applyRolesToItems()
}

func (s *AuthService) load() ([]map[string]any, bool, error) {
	items, err := s.storage.LoadAuthKeys()
	if err != nil {
		return nil, false, err
	}
	out := make([]map[string]any, 0, len(items))
	sanitizeSessions := false
	for _, item := range items {
		if normalizeAuthKind(util.Clean(item["kind"])) == AuthKindSession && util.Clean(item["key"]) != "" {
			sanitizeSessions = true
		}
		if normalized := normalizeAuthItem(item); normalized != nil {
			out = append(out, normalized)
		}
	}
	return out, sanitizeSessions, nil
}

func (s *AuthService) loadRoles() ([]ManagedRole, error) {
	var raw any
	if s.roleStore != nil {
		value, err := s.roleStore.LoadJSONDocument(rbacRolesDocumentName)
		if err != nil {
			return nil, err
		}
		raw = value
	}
	return normalizeManagedRoles(raw), nil
}

func (s *AuthService) loadPasswordAccounts() ([]PasswordAccount, error) {
	var raw any
	if s.roleStore != nil {
		value, err := s.roleStore.LoadJSONDocument(passwordAccountsDocumentName)
		if err != nil {
			return nil, err
		}
		raw = value
	}
	return normalizePasswordAccounts(raw), nil
}

func (s *AuthService) saveLocked() error {
	if err := s.storage.SaveAuthKeys(s.items); err != nil {
		return AuthPersistenceError{Err: err}
	}
	return nil
}

func (s *AuthService) savePasswordAccountsLocked() error {
	if s.roleStore == nil {
		return AuthPersistenceError{Err: fmt.Errorf("auth document storage is required")}
	}
	items := make([]map[string]any, 0, len(s.accounts))
	for _, account := range s.accounts {
		items = append(items, storedPasswordAccount(account))
	}
	if err := s.roleStore.SaveJSONDocument(passwordAccountsDocumentName, map[string]any{"items": items}); err != nil {
		return AuthPersistenceError{Err: err}
	}
	return nil
}

func (s *AuthService) saveAuthAndPasswordAccountsLocked() error {
	store, ok := s.storage.(storage.AuthStateBackend)
	if !ok {
		return AuthPersistenceError{Err: fmt.Errorf("atomic auth state storage is required")}
	}
	items := make([]map[string]any, 0, len(s.accounts))
	for _, account := range s.accounts {
		items = append(items, storedPasswordAccount(account))
	}
	if err := store.SaveAuthKeysAndJSONDocument(s.items, passwordAccountsDocumentName, map[string]any{"items": items}); err != nil {
		return AuthPersistenceError{Err: err}
	}
	return nil
}

func (s *AuthService) saveAuthAndRolesLocked() error {
	store, ok := s.storage.(storage.AuthStateBackend)
	if !ok {
		return AuthPersistenceError{Err: fmt.Errorf("atomic auth state storage is required")}
	}
	items := make([]map[string]any, 0, len(s.roles))
	for _, role := range s.roles {
		items = append(items, storedManagedRole(role))
	}
	if err := store.SaveAuthKeysAndJSONDocument(s.items, rbacRolesDocumentName, map[string]any{"items": items}); err != nil {
		return AuthPersistenceError{Err: err}
	}
	return nil
}

func (s *AuthService) saveRolesLocked() error {
	if s.roleStore == nil {
		return AuthPersistenceError{Err: fmt.Errorf("auth document storage is required")}
	}
	items := make([]map[string]any, 0, len(s.roles))
	for _, role := range s.roles {
		items = append(items, storedManagedRole(role))
	}
	if err := s.roleStore.SaveJSONDocument(rbacRolesDocumentName, map[string]any{"items": items}); err != nil {
		return AuthPersistenceError{Err: err}
	}
	return nil
}

func (s *AuthService) applyRolesToItems() {
	for _, item := range s.items {
		s.applyRoleToAuthItem(item, managedAuthRoleID(item))
	}
}

func (s *AuthService) syncPasswordAccountsToItems() {
	accountsByID := make(map[string]PasswordAccount, len(s.accounts))
	for _, account := range s.accounts {
		if account.ID != "" {
			accountsByID[account.ID] = account
		}
	}
	for _, item := range s.items {
		if util.Clean(item["provider"]) != AuthProviderLocal {
			continue
		}
		account, ok := accountsByID[util.Clean(item["owner_id"])]
		if !ok {
			continue
		}
		item["username"] = account.Username
		item["owner_name"] = account.DisplayName()
		item["enabled"] = account.Enabled
		if account.Role == AuthRoleUser {
			item["role"] = AuthRoleUser
			applyManagedRoleToAuthItem(item, roleForAccountLocked(s.roles, account))
			continue
		}
		item["role"] = AuthRoleAdmin
		item["role_id"] = AuthRoleAdmin
		item["role_name"] = "管理员"
		applyPermissionSet(item, DefaultPermissionSetForRole(AuthRoleAdmin))
	}
}

func (s *AuthService) applyRoleToAuthItem(item map[string]any, roleID string) {
	if util.Clean(item["role"]) != AuthRoleUser {
		return
	}
	role, ok := managedRoleByIDLocked(s.roles, roleID)
	if !ok {
		role, _ = managedRoleByIDLocked(s.roles, DefaultManagedRoleID)
	}
	applyManagedRoleToAuthItem(item, role)
}

func (s *AuthService) applyIdentityRoleToAPIKey(item map[string]any, role, ownerID string) {
	if role == AuthRoleAdmin {
		item["role"] = AuthRoleAdmin
		item["role_id"] = AuthRoleAdmin
		item["role_name"] = "管理员"
		applyPermissionSet(item, DefaultPermissionSetForRole(AuthRoleAdmin))
		return
	}
	if roleID, ok := managedAuthRoleIDLocked(s.items, s.accounts, ownerID); ok {
		s.applyRoleToAuthItem(item, roleID)
		return
	}
	s.applyRoleToAuthItem(item, "")
}

func (s *AuthService) createCredential(role, kind, name string, owner AuthOwner, prefix string) (map[string]any, string, error) {
	role = normalizeAuthRole(role)
	if role == "" {
		role = AuthRoleUser
	}
	kind = normalizeAuthKind(kind)
	if kind == "" {
		kind = AuthKindAPIKey
	}
	owner = normalizeAuthOwner(owner)
	name = util.Clean(name)
	if name == "" {
		name = defaultCredentialName(role, kind)
	}
	if prefix == "" {
		prefix = "sk-"
	}
	raw := prefix + util.RandomTokenURL(24)
	item := newAuthItem(role, kind, name, owner, raw)
	s.mu.Lock()
	previousItems := cloneAuthItems(s.items)
	userID := managedAuthUserID(item)
	createdUserID := ""
	if userID != "" && !managedUserExistsLocked(s.items, s.accounts, userID) {
		createdUserID = userID
	}
	s.applyRoleToAuthItem(item, "")
	s.items = append(s.items, item)
	if err := s.saveLocked(); err != nil {
		s.restoreAuthItemsAfterSaveFailureLocked(previousItems, err)
		s.mu.Unlock()
		return nil, "", err
	}
	public := publicAuthItem(item)
	s.mu.Unlock()
	s.notifyUserCreated(createdUserID)
	return public, raw, nil
}

func newAuthItem(role, kind, name string, owner AuthOwner, raw string) map[string]any {
	role = normalizeAuthRole(role)
	kind = normalizeAuthKind(kind)
	owner = normalizeAuthOwner(owner)
	name = util.Clean(name)
	if name == "" {
		name = defaultCredentialName(role, kind)
	}
	provider := owner.Provider
	if provider == "" {
		provider = AuthProviderLocal
	}
	now := time.Now().UTC()
	item := map[string]any{
		"id":            util.NewHex(12),
		"name":          name,
		"role":          role,
		"kind":          kind,
		"provider":      provider,
		"owner_id":      owner.ID,
		"owner_name":    owner.Name,
		"linuxdo_level": owner.LinuxDoLevel,
		"key_hash":      util.SHA256Hex(raw),
		"enabled":       true,
		"created_at":    now.Format(time.RFC3339Nano),
		"last_used_at":  nil,
	}
	if kind == AuthKindSession {
		item["expires_at"] = now.Add(AuthSessionLifetime).Format(time.RFC3339Nano)
	} else {
		item["key"] = raw
	}
	applyPermissionSet(item, DefaultPermissionSetForRole(role))
	return item
}

func normalizeAuthItem(raw map[string]any) map[string]any {
	role := normalizeAuthRole(util.Clean(raw["role"]))
	if role == "" {
		return nil
	}
	key := util.Clean(raw["key"])
	hash := util.Clean(raw["key_hash"])
	if hash == "" {
		return nil
	}
	kind := normalizeAuthKind(util.Clean(raw["kind"]))
	if kind == "" {
		kind = AuthKindAPIKey
	}
	if kind == AuthKindAPIKey && key == "" {
		return nil
	}
	if key != "" && util.SHA256Hex(key) != hash {
		return nil
	}
	id := util.Clean(raw["id"])
	if id == "" {
		id = util.NewHex(12)
	}
	name := util.Clean(raw["name"])
	if name == "" {
		name = defaultCredentialName(role, kind)
	}
	owner := AuthOwner{
		ID:           util.Clean(raw["owner_id"]),
		Name:         util.Clean(raw["owner_name"]),
		Provider:     normalizeAuthProvider(util.Clean(raw["provider"])),
		LinuxDoLevel: util.Clean(raw["linuxdo_level"]),
	}
	if owner.Provider == "" {
		owner.Provider = AuthProviderLocal
	}
	created := util.Clean(raw["created_at"])
	if created == "" {
		created = util.NowISO()
	}
	lastUsed := raw["last_used_at"]
	if util.Clean(lastUsed) == "" {
		lastUsed = nil
	}
	out := map[string]any{
		"id":            id,
		"username":      util.Clean(raw["username"]),
		"name":          name,
		"role":          role,
		"kind":          kind,
		"provider":      owner.Provider,
		"owner_id":      owner.ID,
		"owner_name":    owner.Name,
		"linuxdo_level": owner.LinuxDoLevel,
		"key_hash":      hash,
		"enabled":       util.ToBool(util.ValueOr(raw["enabled"], true)),
		"created_at":    created,
		"last_used_at":  lastUsed,
	}
	if kind == AuthKindAPIKey {
		out["key"] = key
	}
	if kind == AuthKindSession {
		expiresAt := util.Clean(raw["expires_at"])
		if expiresAt == "" {
			createdAt, err := time.Parse(time.RFC3339Nano, created)
			if err != nil {
				return nil
			}
			expiresAt = createdAt.Add(AuthSessionLifetime).Format(time.RFC3339Nano)
		}
		if _, err := time.Parse(time.RFC3339Nano, expiresAt); err != nil {
			return nil
		}
		out["expires_at"] = expiresAt
	}
	if role == AuthRoleUser {
		roleID := util.Clean(raw["role_id"])
		if roleID == "" {
			roleID = DefaultManagedRoleID
		}
		out["role_id"] = roleID
		if roleName := util.Clean(raw["role_name"]); roleName != "" {
			out["role_name"] = roleName
		}
	} else if role == AuthRoleAdmin {
		out["role_id"] = AuthRoleAdmin
		out["role_name"] = "管理员"
	}
	permissions := DefaultPermissionSetForRole(role)
	if _, ok := raw["menu_paths"]; ok {
		permissions.MenuPaths = NormalizeMenuPermissions(util.AsStringSlice(raw["menu_paths"]))
	}
	if _, ok := raw["api_permissions"]; ok {
		permissions.APIPermissions = NormalizeAPIPermissions(util.AsStringSlice(raw["api_permissions"]))
	}
	applyPermissionSet(out, permissions)
	if updated := util.Clean(raw["updated_at"]); updated != "" {
		out["updated_at"] = updated
	}
	return out
}

func publicAuthItem(item map[string]any) map[string]any {
	return map[string]any{
		"id":              item["id"],
		"username":        item["username"],
		"name":            item["name"],
		"role":            item["role"],
		"role_id":         item["role_id"],
		"role_name":       item["role_name"],
		"kind":            item["kind"],
		"provider":        item["provider"],
		"owner_id":        item["owner_id"],
		"owner_name":      item["owner_name"],
		"linuxdo_level":   item["linuxdo_level"],
		"enabled":         util.ToBool(util.ValueOr(item["enabled"], true)),
		"created_at":      item["created_at"],
		"last_used_at":    item["last_used_at"],
		"expires_at":      item["expires_at"],
		"menu_paths":      append([]string(nil), authItemPermissions(item).MenuPaths...),
		"api_permissions": append([]string(nil), authItemPermissions(item).APIPermissions...),
	}
}

func identityForAuthItem(item map[string]any) *Identity {
	credentialID := util.Clean(item["id"])
	credentialName := util.Clean(item["name"])
	ownerID := util.Clean(item["owner_id"])
	ownerName := util.Clean(item["owner_name"])
	id := ownerID
	if id == "" {
		id = credentialID
	}
	name := ownerName
	if name == "" {
		name = credentialName
	}
	return &Identity{
		ID:             id,
		Username:       util.Clean(item["username"]),
		Name:           name,
		Role:           util.Clean(item["role"]),
		RoleID:         util.Clean(item["role_id"]),
		RoleName:       util.Clean(item["role_name"]),
		Provider:       util.Clean(item["provider"]),
		OwnerID:        ownerID,
		CredentialID:   credentialID,
		CredentialName: credentialName,
		Kind:           util.Clean(item["kind"]),
		MenuPaths:      authItemPermissions(item).MenuPaths,
		APIPermissions: authItemPermissions(item).APIPermissions,
	}
}

func authItemPermissions(item map[string]any) PermissionSet {
	return PermissionSet{
		MenuPaths:      NormalizeMenuPermissions(util.AsStringSlice(item["menu_paths"])),
		APIPermissions: NormalizeAPIPermissions(util.AsStringSlice(item["api_permissions"])),
	}
}

func applyPermissionSet(item map[string]any, permissions PermissionSet) {
	item["menu_paths"] = append([]string(nil), NormalizeMenuPermissions(permissions.MenuPaths)...)
	item["api_permissions"] = append([]string(nil), NormalizeAPIPermissions(permissions.APIPermissions)...)
}

func normalizeAuthKeyFilter(filter AuthKeyFilter) AuthKeyFilter {
	return AuthKeyFilter{
		Role:    normalizeAuthRole(util.Clean(filter.Role)),
		Kind:    normalizeAuthKind(util.Clean(filter.Kind)),
		OwnerID: util.Clean(filter.OwnerID),
	}
}

func matchAuthKey(item map[string]any, filter AuthKeyFilter) bool {
	if filter.Role != "" && util.Clean(item["role"]) != filter.Role {
		return false
	}
	if filter.Kind != "" && util.Clean(item["kind"]) != filter.Kind {
		return false
	}
	if filter.OwnerID != "" && util.Clean(item["owner_id"]) != filter.OwnerID {
		return false
	}
	return true
}

func listManagedAuthUsersLocked(items []map[string]any, roles []ManagedRole, accounts []PasswordAccount) []map[string]any {
	byID := map[string]map[string]any{}
	for _, account := range accounts {
		if account.Role != AuthRoleUser || account.ID == "" {
			continue
		}
		byID[account.ID] = managedAuthUserForAccount(account, roles)
	}
	for _, item := range items {
		id := managedAuthUserID(item)
		if id == "" {
			continue
		}
		user := byID[id]
		if user == nil {
			user = managedAuthUserForItem(item, roles)
			byID[id] = user
		}
		mergeManagedAuthUser(user, item)
	}
	out := make([]map[string]any, 0, len(byID))
	for _, user := range byID {
		out = append(out, user)
	}
	sort.SliceStable(out, func(i, j int) bool {
		leftLast := util.Clean(out[i]["last_used_at"])
		rightLast := util.Clean(out[j]["last_used_at"])
		if leftLast != rightLast {
			return leftLast > rightLast
		}
		leftCreated := util.Clean(out[i]["created_at"])
		rightCreated := util.Clean(out[j]["created_at"])
		if leftCreated != rightCreated {
			return leftCreated > rightCreated
		}
		return util.Clean(out[i]["name"]) < util.Clean(out[j]["name"])
	})
	return out
}

func managedAuthUserForItem(item map[string]any, roles []ManagedRole) map[string]any {
	id := managedAuthUserID(item)
	return map[string]any{
		"id":               id,
		"name":             managedAuthUserName(item),
		"role":             AuthRoleUser,
		"role_id":          DefaultManagedRoleID,
		"role_name":        managedRoleName(roles, DefaultManagedRoleID),
		"provider":         util.Clean(item["provider"]),
		"owner_id":         util.Clean(item["owner_id"]),
		"owner_name":       util.Clean(item["owner_name"]),
		"linuxdo_level":    util.Clean(item["linuxdo_level"]),
		"enabled":          false,
		"has_api_key":      false,
		"has_session":      false,
		"api_key_id":       "",
		"api_key_name":     "",
		"session_id":       "",
		"session_name":     "",
		"credential_count": 0,
		"created_at":       nil,
		"last_used_at":     nil,
		"updated_at":       nil,
		"menu_paths":       []string{},
		"api_permissions":  []string{},
	}
}

func managedAuthUserForAccount(account PasswordAccount, roles []ManagedRole) map[string]any {
	roleID := account.ManagedRoleID()
	roleName := managedRoleName(roles, roleID)
	permissions := DefaultPermissionSetForRole(AuthRoleUser)
	if role, ok := managedRoleByIDLocked(roles, roleID); ok {
		permissions = role.PermissionSet()
	}
	return map[string]any{
		"id":               account.ID,
		"username":         account.Username,
		"name":             account.DisplayName(),
		"role":             AuthRoleUser,
		"role_id":          roleID,
		"role_name":        roleName,
		"provider":         AuthProviderLocal,
		"owner_id":         account.ID,
		"owner_name":       account.DisplayName(),
		"linuxdo_level":    "",
		"enabled":          account.Enabled,
		"has_api_key":      false,
		"has_session":      false,
		"api_key_id":       "",
		"api_key_name":     "",
		"session_id":       "",
		"session_name":     "",
		"credential_count": 0,
		"created_at":       account.CreatedAt,
		"last_used_at":     account.LastLoginAt,
		"updated_at":       account.UpdatedAt,
		"menu_paths":       append([]string(nil), permissions.MenuPaths...),
		"api_permissions":  append([]string(nil), permissions.APIPermissions...),
	}
}

func managedAuthUserByIDLocked(items []map[string]any, roles []ManagedRole, accounts []PasswordAccount, id string) map[string]any {
	id = util.Clean(id)
	if id == "" {
		return nil
	}
	var user map[string]any
	if account, ok := passwordAccountByIDLocked(accounts, id); ok && account.Role == AuthRoleUser && account.ID != "" {
		user = managedAuthUserForAccount(account, roles)
	}
	for _, item := range items {
		if managedAuthUserID(item) != id {
			continue
		}
		if user == nil {
			user = managedAuthUserForItem(item, roles)
		}
		mergeManagedAuthUser(user, item)
	}
	return user
}

func managedAuthOwnerLocked(items []map[string]any, accounts []PasswordAccount, id string) (AuthOwner, bool) {
	var owner AuthOwner
	found := false
	if account, ok := passwordAccountByIDLocked(accounts, id); ok && account.Role == AuthRoleUser {
		owner.ID = account.ID
		owner.Name = account.DisplayName()
		owner.Provider = AuthProviderLocal
		found = true
	}
	for _, item := range items {
		if managedAuthUserID(item) != id {
			continue
		}
		found = true
		if owner.ID == "" {
			owner.ID = util.Clean(item["owner_id"])
		}
		if owner.Name == "" {
			owner.Name = managedAuthUserName(item)
		}
		if owner.Provider == "" {
			owner.Provider = normalizeAuthProvider(util.Clean(item["provider"]))
		}
		if owner.LinuxDoLevel == "" {
			owner.LinuxDoLevel = util.Clean(item["linuxdo_level"])
		}
	}
	return normalizeAuthOwner(owner), found
}

func managedAuthUserID(item map[string]any) string {
	if util.Clean(item["role"]) != AuthRoleUser {
		return ""
	}
	if ownerID := util.Clean(item["owner_id"]); ownerID != "" {
		return ownerID
	}
	if util.Clean(item["kind"]) == AuthKindAPIKey {
		return util.Clean(item["id"])
	}
	return ""
}

func managedAuthUserName(item map[string]any) string {
	if name := util.Clean(item["owner_name"]); name != "" {
		return name
	}
	if name := util.Clean(item["name"]); name != "" {
		return name
	}
	return "普通用户"
}

func mergeManagedAuthUser(user, item map[string]any) {
	provider := normalizeAuthProvider(util.Clean(item["provider"]))
	if provider == AuthProviderLinuxDo || util.Clean(user["provider"]) == "" {
		user["provider"] = provider
	}
	if ownerID := util.Clean(item["owner_id"]); ownerID != "" {
		user["owner_id"] = ownerID
	}
	if username := util.Clean(item["username"]); username != "" {
		user["username"] = username
	}
	if ownerName := util.Clean(item["owner_name"]); ownerName != "" {
		user["owner_name"] = ownerName
		user["name"] = ownerName
	} else if util.Clean(user["name"]) == "" {
		user["name"] = managedAuthUserName(item)
	}
	if linuxDoLevel := util.Clean(item["linuxdo_level"]); linuxDoLevel != "" {
		user["linuxdo_level"] = linuxDoLevel
	}
	if roleID := managedAuthRoleID(item); roleID != "" {
		user["role_id"] = roleID
	}
	if roleName := util.Clean(item["role_name"]); roleName != "" {
		user["role_name"] = roleName
	}
	if util.ToBool(util.ValueOr(item["enabled"], true)) {
		user["enabled"] = true
	}
	permissions := authItemPermissions(item)
	if len(permissions.MenuPaths) > 0 || len(util.AsStringSlice(user["menu_paths"])) == 0 {
		user["menu_paths"] = append([]string(nil), permissions.MenuPaths...)
	}
	if len(permissions.APIPermissions) > 0 || len(util.AsStringSlice(user["api_permissions"])) == 0 {
		user["api_permissions"] = append([]string(nil), permissions.APIPermissions...)
	}
	user["credential_count"] = util.ToInt(user["credential_count"], 0) + 1
	if created := util.Clean(item["created_at"]); created != "" {
		current := util.Clean(user["created_at"])
		if current == "" || created < current {
			user["created_at"] = created
		}
	}
	if lastUsed := util.Clean(item["last_used_at"]); lastUsed != "" {
		current := util.Clean(user["last_used_at"])
		if current == "" || lastUsed > current {
			user["last_used_at"] = lastUsed
		}
	}
	if updated := util.Clean(item["updated_at"]); updated != "" {
		current := util.Clean(user["updated_at"])
		if current == "" || updated > current {
			user["updated_at"] = updated
		}
	}
	switch util.Clean(item["kind"]) {
	case AuthKindAPIKey:
		user["has_api_key"] = true
		if util.Clean(user["api_key_id"]) == "" {
			user["api_key_id"] = util.Clean(item["id"])
			user["api_key_name"] = util.Clean(item["name"])
		}
	case AuthKindSession:
		user["has_session"] = true
		if util.Clean(user["session_id"]) == "" {
			user["session_id"] = util.Clean(item["id"])
			user["session_name"] = util.Clean(item["name"])
		}
	}
}

func managedAuthRoleID(item map[string]any) string {
	if util.Clean(item["role"]) != AuthRoleUser {
		return ""
	}
	roleID := util.Clean(item["role_id"])
	if roleID == "" {
		return DefaultManagedRoleID
	}
	return roleID
}

func managedAuthRoleIDLocked(items []map[string]any, accounts []PasswordAccount, id string) (string, bool) {
	id = util.Clean(id)
	if id == "" {
		return "", false
	}
	if account, ok := passwordAccountByIDLocked(accounts, id); ok && account.Role == AuthRoleUser {
		return account.ManagedRoleID(), true
	}
	for _, item := range items {
		if managedAuthUserID(item) == id {
			return managedAuthRoleID(item), true
		}
	}
	return "", false
}

func managedUserExistsLocked(items []map[string]any, accounts []PasswordAccount, id string) bool {
	id = util.Clean(id)
	if id == "" {
		return false
	}
	if account, ok := passwordAccountByIDLocked(accounts, id); ok && account.Role == AuthRoleUser {
		return true
	}
	for _, item := range items {
		if managedAuthUserID(item) == id {
			return true
		}
	}
	return false
}

func normalizeManagedRoles(raw any) []ManagedRole {
	items := util.AsMapSlice(raw)
	if obj, ok := raw.(map[string]any); ok {
		items = util.AsMapSlice(obj["items"])
	}
	roles := make([]ManagedRole, 0, len(items)+1)
	for _, item := range items {
		role := normalizeManagedRole(item)
		if role.ID == "" {
			continue
		}
		roles = append(roles, role)
	}
	roles = mergeDefaultManagedRole(roles)
	sortManagedRoles(roles)
	return roles
}

func normalizeManagedRole(raw map[string]any) ManagedRole {
	id := util.Clean(raw["id"])
	name := util.Clean(raw["name"])
	if id == "" || name == "" {
		return ManagedRole{}
	}
	return ManagedRole{
		ID:             id,
		Name:           name,
		Description:    util.Clean(raw["description"]),
		Builtin:        util.ToBool(raw["builtin"]) && id == DefaultManagedRoleID,
		MenuPaths:      NormalizeMenuPermissions(util.AsStringSlice(raw["menu_paths"])),
		APIPermissions: NormalizeAPIPermissions(util.AsStringSlice(raw["api_permissions"])),
		CreatedAt:      util.Clean(raw["created_at"]),
		UpdatedAt:      util.Clean(raw["updated_at"]),
	}
}

func mergeDefaultManagedRole(roles []ManagedRole) []ManagedRole {
	defaultRole := defaultManagedRole()
	out := make([]ManagedRole, 0, len(roles)+1)
	seenDefault := false
	seen := map[string]struct{}{}
	for _, role := range roles {
		if _, ok := seen[role.ID]; ok {
			continue
		}
		seen[role.ID] = struct{}{}
		if role.ID == DefaultManagedRoleID {
			role.Builtin = true
			if role.Name == "" {
				role.Name = defaultRole.Name
			}
			if role.Description == "" {
				role.Description = defaultRole.Description
			}
			out = append(out, role)
			seenDefault = true
			continue
		}
		role.Builtin = false
		out = append(out, role)
	}
	if !seenDefault {
		out = append(out, defaultRole)
	}
	return out
}

func defaultManagedRole() ManagedRole {
	permissions := DefaultPermissionSetForRole(AuthRoleUser)
	return ManagedRole{
		ID:             DefaultManagedRoleID,
		Name:           "普通用户",
		Description:    "默认用户角色，适合基础创作和个人令牌管理。",
		Builtin:        true,
		MenuPaths:      permissions.MenuPaths,
		APIPermissions: permissions.APIPermissions,
	}
}

func sortManagedRoles(roles []ManagedRole) {
	sort.SliceStable(roles, func(i, j int) bool {
		if roles[i].Builtin != roles[j].Builtin {
			return roles[i].Builtin
		}
		if roles[i].Name != roles[j].Name {
			return roles[i].Name < roles[j].Name
		}
		return roles[i].ID < roles[j].ID
	})
}

func managedRoleByIDLocked(roles []ManagedRole, id string) (ManagedRole, bool) {
	id = util.Clean(id)
	if id == "" {
		id = DefaultManagedRoleID
	}
	for _, role := range roles {
		if role.ID == id {
			return role, true
		}
	}
	return ManagedRole{}, false
}

func managedRoleName(roles []ManagedRole, id string) string {
	if role, ok := managedRoleByIDLocked(roles, id); ok {
		return role.Name
	}
	return defaultManagedRole().Name
}

func managedRoleNameExistsLocked(roles []ManagedRole, exceptID, name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	for _, role := range roles {
		if role.ID != exceptID && strings.EqualFold(role.Name, name) {
			return true
		}
	}
	return false
}

func applyManagedRoleToAuthItem(item map[string]any, role ManagedRole) {
	if util.Clean(item["role"]) != AuthRoleUser || role.ID == "" {
		return
	}
	item["role_id"] = role.ID
	item["role_name"] = role.Name
	applyPermissionSet(item, role.PermissionSet())
}

func managedRoleUserCountsLocked(items []map[string]any, accounts []PasswordAccount) map[string]int {
	seenUsers := map[string]struct{}{}
	counts := map[string]int{}
	for _, account := range accounts {
		if account.Role != AuthRoleUser || account.ID == "" {
			continue
		}
		key := account.ID + "\x00" + account.ManagedRoleID()
		if _, ok := seenUsers[key]; ok {
			continue
		}
		seenUsers[key] = struct{}{}
		counts[account.ManagedRoleID()]++
	}
	for _, item := range items {
		userID := managedAuthUserID(item)
		if userID == "" {
			continue
		}
		key := userID + "\x00" + managedAuthRoleID(item)
		if _, ok := seenUsers[key]; ok {
			continue
		}
		seenUsers[key] = struct{}{}
		counts[managedAuthRoleID(item)]++
	}
	return counts
}

func publicManagedRolesLocked(roles []ManagedRole, items []map[string]any, accounts []PasswordAccount) []map[string]any {
	counts := managedRoleUserCountsLocked(items, accounts)
	out := make([]map[string]any, 0, len(roles))
	for _, role := range roles {
		out = append(out, publicManagedRole(role, counts[role.ID]))
	}
	return out
}

func publicManagedRole(role ManagedRole, userCount int) map[string]any {
	return map[string]any{
		"id":              role.ID,
		"name":            role.Name,
		"description":     role.Description,
		"builtin":         role.Builtin,
		"user_count":      userCount,
		"created_at":      role.CreatedAt,
		"updated_at":      role.UpdatedAt,
		"menu_paths":      append([]string(nil), role.PermissionSet().MenuPaths...),
		"api_permissions": append([]string(nil), role.PermissionSet().APIPermissions...),
	}
}

func storedManagedRole(role ManagedRole) map[string]any {
	return map[string]any{
		"id":              role.ID,
		"name":            role.Name,
		"description":     role.Description,
		"builtin":         role.Builtin,
		"created_at":      role.CreatedAt,
		"updated_at":      role.UpdatedAt,
		"menu_paths":      append([]string(nil), role.PermissionSet().MenuPaths...),
		"api_permissions": append([]string(nil), role.PermissionSet().APIPermissions...),
	}
}

func normalizeAuthRole(role string) string {
	switch role {
	case AuthRoleAdmin, AuthRoleUser:
		return role
	default:
		return ""
	}
}

func normalizeAuthKind(kind string) string {
	switch kind {
	case "", AuthKindAPIKey:
		return AuthKindAPIKey
	case AuthKindSession:
		return AuthKindSession
	default:
		return ""
	}
}

func normalizeAuthProvider(provider string) string {
	switch provider {
	case "", AuthProviderLocal:
		return AuthProviderLocal
	case AuthProviderLinuxDo:
		return AuthProviderLinuxDo
	default:
		return provider
	}
}

func normalizeAuthOwner(owner AuthOwner) AuthOwner {
	owner.ID = util.Clean(owner.ID)
	owner.Name = util.Clean(owner.Name)
	owner.Provider = normalizeAuthProvider(util.Clean(owner.Provider))
	owner.LinuxDoLevel = util.Clean(owner.LinuxDoLevel)
	if owner.ID == "" {
		owner.Provider = AuthProviderLocal
		owner.LinuxDoLevel = ""
	}
	if owner.Provider != AuthProviderLinuxDo {
		owner.LinuxDoLevel = ""
	}
	return owner
}

func defaultCredentialName(role, kind string) string {
	if kind == AuthKindSession {
		return "登录会话"
	}
	if role == AuthRoleAdmin {
		return "管理员密钥"
	}
	return "普通用户"
}

func errAuthOwnerRequired() error {
	return authError("owner_id is required")
}

func personalAPIKeyScope(identity Identity) (string, AuthOwner, bool) {
	role := normalizeAuthRole(identity.Role)
	if role == "" {
		return "", AuthOwner{}, false
	}
	ownerID := util.Clean(identity.OwnerID)
	if ownerID == "" {
		return "", AuthOwner{}, false
	}
	owner := normalizeAuthOwner(AuthOwner{
		ID:       ownerID,
		Name:     identity.Name,
		Provider: identity.Provider,
	})
	if owner.Name == "" {
		owner.Name = identity.CredentialName
	}
	if owner.Name == "" {
		owner.Name = owner.ID
	}
	return role, owner, true
}

type authError string

func (e authError) Error() string {
	return string(e)
}
