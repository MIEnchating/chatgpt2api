package service

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"

	"golang.org/x/crypto/bcrypt"
)

const (
	passwordAccountsDocumentName = "auth_users.json"
	passwordSessionName          = "登录会话"
	bootstrapAdminSaveAttempts   = 3
)

var ErrInvalidPasswordCredentials = authError("用户名或密码错误")

var accountUsernameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{2,31}$`)

type PasswordAccount struct {
	ID           string
	Username     string
	Name         string
	PasswordHash string
	Role         string
	RoleID       string
	Enabled      bool
	CreatedAt    string
	UpdatedAt    string
	LastLoginAt  string
}

func (a PasswordAccount) DisplayName() string {
	if name := util.Clean(a.Name); name != "" {
		return name
	}
	if username := util.Clean(a.Username); username != "" {
		return username
	}
	return "用户"
}

func (a PasswordAccount) ManagedRoleID() string {
	if a.Role != AuthRoleUser {
		return ""
	}
	if roleID := util.Clean(a.RoleID); roleID != "" {
		return roleID
	}
	return DefaultManagedRoleID
}

type BootstrapAdminResult struct {
	Created   bool
	Generated bool
	Username  string
	Password  string
}

func (s *AuthService) EnsureBootstrapAdmin(username, password string) (BootstrapAdminResult, error) {
	username, err := normalizeAccountUsername(username)
	if err != nil {
		return BootstrapAdminResult{}, err
	}
	password = strings.TrimSpace(password)
	generated := false
	if password == "" {
		password = util.RandomTokenURL(12)
		generated = true
	}
	if err := validateAccountPassword(password); err != nil {
		return BootstrapAdminResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := bootstrapAdminAccountLocked(s.accounts); ok {
		return BootstrapAdminResult{Username: existing.Username}, nil
	}
	if _, ok := passwordAccountByUsernameLocked(s.accounts, username); ok {
		return BootstrapAdminResult{}, fmt.Errorf("bootstrap admin username already exists")
	}
	hash, err := hashAccountPassword(password)
	if err != nil {
		return BootstrapAdminResult{}, err
	}
	now := util.NowISO()
	account := PasswordAccount{
		ID:           AuthRoleAdmin,
		Username:     username,
		Name:         "管理员",
		PasswordHash: hash,
		Role:         AuthRoleAdmin,
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	for attempt := 0; attempt < bootstrapAdminSaveAttempts; attempt++ {
		if existing, ok := bootstrapAdminAccountLocked(s.accounts); ok {
			return BootstrapAdminResult{Username: existing.Username}, nil
		}
		if _, ok := passwordAccountByUsernameLocked(s.accounts, username); ok {
			return BootstrapAdminResult{}, fmt.Errorf("bootstrap admin username already exists")
		}

		previousAccounts := append([]PasswordAccount(nil), s.accounts...)
		previousItems := cloneAuthItems(s.items)
		s.accounts = append(s.accounts, account)
		saveErr := s.savePasswordAccountsLocked()
		if saveErr == nil {
			return BootstrapAdminResult{Created: true, Generated: generated, Username: username, Password: password}, nil
		}
		s.accounts = previousAccounts
		s.items = previousItems
		if !errors.Is(saveErr, storage.ErrConcurrentRowUpdate) {
			return BootstrapAdminResult{}, saveErr
		}
		if reloadErr := s.reloadBootstrapAdminStateLocked(); reloadErr != nil {
			return BootstrapAdminResult{}, AuthPersistenceError{Err: fmt.Errorf("reload bootstrap admin after concurrent update: %w", reloadErr)}
		}
		if existing, ok := bootstrapAdminAccountLocked(s.accounts); ok {
			return BootstrapAdminResult{Username: existing.Username}, nil
		}
		if attempt+1 == bootstrapAdminSaveAttempts {
			return BootstrapAdminResult{}, saveErr
		}
	}
	return BootstrapAdminResult{}, fmt.Errorf("bootstrap admin save attempts exhausted")
}

func bootstrapAdminAccountLocked(accounts []PasswordAccount) (PasswordAccount, bool) {
	for _, account := range accounts {
		if account.Role == AuthRoleAdmin {
			return account, true
		}
	}
	return PasswordAccount{}, false
}

func (s *AuthService) reloadBootstrapAdminStateLocked() error {
	accounts, err := s.loadPasswordAccounts()
	if err != nil {
		return fmt.Errorf("load password accounts: %w", err)
	}
	items, _, err := s.load()
	if err != nil {
		return fmt.Errorf("load auth credentials: %w", err)
	}
	s.accounts = accounts
	s.applyLoadedAuthItemsLocked(items)
	return nil
}

func (s *AuthService) CreatePasswordUser(username, password, name, roleID string, enabled bool) (map[string]any, error) {
	username, err := normalizeAccountUsername(username)
	if err != nil {
		return nil, err
	}
	if err := validateAccountPassword(password); err != nil {
		return nil, err
	}
	name = normalizeAccountDisplayName(name, username)
	roleID = util.Clean(roleID)
	if roleID == "" {
		roleID = DefaultManagedRoleID
	}
	hash, err := hashAccountPassword(password)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	if _, ok := passwordAccountByUsernameLocked(s.accounts, username); ok {
		s.mu.Unlock()
		return nil, authError("username already exists")
	}
	role, ok := managedRoleByIDLocked(s.roles, roleID)
	if !ok {
		s.mu.Unlock()
		return nil, authError("role not found")
	}
	now := util.NowISO()
	account := PasswordAccount{
		ID:           "user_" + util.NewHex(12),
		Username:     username,
		Name:         name,
		PasswordHash: hash,
		Role:         AuthRoleUser,
		RoleID:       role.ID,
		Enabled:      enabled,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	previousAccounts := append([]PasswordAccount(nil), s.accounts...)
	previousItems := cloneAuthItems(s.items)
	s.accounts = append(s.accounts, account)
	if err := s.savePasswordAccountsLocked(); err != nil {
		s.restoreAuthAccountsAfterSaveFailureLocked(previousAccounts, previousItems, err)
		s.mu.Unlock()
		return nil, err
	}
	item := managedAuthUserByIDLocked(s.items, s.roles, s.accounts, account.ID)
	s.mu.Unlock()
	return item, nil
}

func (s *AuthService) LoginPassword(username, password string) (*Identity, string, error) {
	username, err := normalizeAccountUsername(username)
	if err != nil {
		return nil, "", ErrInvalidPasswordCredentials
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	index, account, ok := passwordAccountIndexByUsernameLocked(s.accounts, username)
	if !ok {
		return nil, "", ErrInvalidPasswordCredentials
	}
	if !account.Enabled {
		return nil, "", authError("用户已被禁用")
	}
	if !verifyAccountPassword(password, account.PasswordHash) {
		return nil, "", ErrInvalidPasswordCredentials
	}
	now := util.NowISO()
	previousAccounts := append([]PasswordAccount(nil), s.accounts...)
	previousItems := cloneAuthItems(s.items)
	account.LastLoginAt = now
	account.UpdatedAt = now
	s.accounts[index] = account
	item, raw := s.issuePasswordSessionLocked(account, now)
	if err := s.saveAuthAndPasswordAccountsLocked(); err != nil {
		s.restoreAuthAccountsAfterSaveFailureLocked(previousAccounts, previousItems, err)
		return nil, "", err
	}
	s.pruneLastUsedFlushAtLocked()
	return identityForAuthItem(item), raw, nil
}

func (s *AuthService) issuePasswordSessionLocked(account PasswordAccount, now string) (map[string]any, string) {
	raw := "sess-" + util.RandomTokenURL(32)
	owner := AuthOwner{
		ID:       account.ID,
		Name:     account.DisplayName(),
		Provider: AuthProviderLocal,
	}
	for index, item := range s.items {
		if util.Clean(item["kind"]) != AuthKindSession ||
			util.Clean(item["provider"]) != AuthProviderLocal ||
			util.Clean(item["owner_id"]) != account.ID {
			continue
		}
		next := util.CopyMap(item)
		next["id"] = util.NewHex(12)
		next["name"] = passwordSessionName
		next["owner_name"] = account.DisplayName()
		next["username"] = account.Username
		delete(next, "key")
		next["key_hash"] = util.SHA256Hex(raw)
		next["enabled"] = account.Enabled
		next["last_used_at"] = nil
		next["updated_at"] = now
		next["expires_at"] = authSessionExpiry(now)
		if account.Role == AuthRoleUser {
			applyManagedRoleToAuthItem(next, roleForAccountLocked(s.roles, account))
		} else {
			next["role"] = AuthRoleAdmin
			next["role_id"] = AuthRoleAdmin
			next["role_name"] = "管理员"
			applyPermissionSet(next, DefaultPermissionSetForRole(AuthRoleAdmin))
		}
		s.items[index] = next
		return next, raw
	}

	item := newAuthItem(account.Role, passwordSessionName, owner, raw)
	item["username"] = account.Username
	item["enabled"] = account.Enabled
	item["updated_at"] = now
	if account.Role == AuthRoleUser {
		applyManagedRoleToAuthItem(item, roleForAccountLocked(s.roles, account))
	} else {
		item["role_id"] = AuthRoleAdmin
		item["role_name"] = "管理员"
	}
	s.items = append(s.items, item)
	return item, raw
}

func roleForAccountLocked(roles []ManagedRole, account PasswordAccount) ManagedRole {
	role, ok := managedRoleByIDLocked(roles, account.ManagedRoleID())
	if ok {
		return role
	}
	role, _ = managedRoleByIDLocked(roles, DefaultManagedRoleID)
	return role
}

func normalizePasswordAccounts(raw any) []PasswordAccount {
	items := util.AsMapSlice(raw)
	if obj, ok := raw.(map[string]any); ok {
		items = util.AsMapSlice(obj["items"])
	}
	out := make([]PasswordAccount, 0, len(items))
	seenIDs := map[string]struct{}{}
	seenUsernames := map[string]struct{}{}
	for _, item := range items {
		account := normalizePasswordAccount(item)
		if account.ID == "" || account.Username == "" || account.PasswordHash == "" {
			continue
		}
		if _, ok := seenIDs[account.ID]; ok {
			continue
		}
		if _, ok := seenUsernames[account.Username]; ok {
			continue
		}
		seenIDs[account.ID] = struct{}{}
		seenUsernames[account.Username] = struct{}{}
		out = append(out, account)
	}
	return out
}

func normalizePasswordAccount(raw map[string]any) PasswordAccount {
	username, err := normalizeAccountUsername(util.Clean(raw["username"]))
	if err != nil {
		return PasswordAccount{}
	}
	role := normalizeAuthRole(util.Clean(raw["role"]))
	if role == "" {
		return PasswordAccount{}
	}
	id := util.Clean(raw["id"])
	if id == "" {
		return PasswordAccount{}
	}
	created := util.Clean(raw["created_at"])
	if created == "" {
		created = util.NowISO()
	}
	updated := util.Clean(raw["updated_at"])
	if updated == "" {
		updated = created
	}
	account := PasswordAccount{
		ID:           id,
		Username:     username,
		Name:         normalizeAccountDisplayName(util.Clean(raw["name"]), username),
		PasswordHash: util.Clean(raw["password_hash"]),
		Role:         role,
		RoleID:       util.Clean(raw["role_id"]),
		Enabled:      util.ToBool(util.ValueOr(raw["enabled"], true)),
		CreatedAt:    created,
		UpdatedAt:    updated,
		LastLoginAt:  util.Clean(raw["last_login_at"]),
	}
	if account.Role != AuthRoleUser {
		account.RoleID = ""
	} else if account.RoleID == "" {
		account.RoleID = DefaultManagedRoleID
	}
	return account
}

func storedPasswordAccount(account PasswordAccount) map[string]any {
	return map[string]any{
		"id":            account.ID,
		"username":      account.Username,
		"name":          account.Name,
		"password_hash": account.PasswordHash,
		"role":          account.Role,
		"role_id":       account.ManagedRoleID(),
		"enabled":       account.Enabled,
		"created_at":    account.CreatedAt,
		"updated_at":    account.UpdatedAt,
		"last_login_at": account.LastLoginAt,
	}
}

func passwordAccountByIDLocked(accounts []PasswordAccount, id string) (PasswordAccount, bool) {
	id = util.Clean(id)
	for _, account := range accounts {
		if account.ID == id {
			return account, true
		}
	}
	return PasswordAccount{}, false
}

func passwordAccountByUsernameLocked(accounts []PasswordAccount, username string) (PasswordAccount, bool) {
	_, account, ok := passwordAccountIndexByUsernameLocked(accounts, username)
	return account, ok
}

func passwordAccountIndexByUsernameLocked(accounts []PasswordAccount, username string) (int, PasswordAccount, bool) {
	username, err := normalizeAccountUsername(username)
	if err != nil {
		return -1, PasswordAccount{}, false
	}
	for index, account := range accounts {
		if account.Username == username {
			return index, account, true
		}
	}
	return -1, PasswordAccount{}, false
}

func normalizeAccountUsername(username string) (string, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if !accountUsernameRE.MatchString(username) {
		return "", errors.New("用户名需为 3-32 位小写字母、数字、点、下划线或短横线，并以字母或数字开头")
	}
	return username, nil
}

func normalizeAccountDisplayName(name, username string) string {
	name = util.Clean(name)
	if len([]rune(name)) > 64 {
		name = string([]rune(name)[:64])
	}
	if name != "" {
		return name
	}
	return username
}

func validateAccountPassword(password string) error {
	if len(password) < 8 {
		return errors.New("密码长度不能少于 8 位")
	}
	if len(password) > 128 {
		return errors.New("密码长度不能超过 128 位")
	}
	return nil
}

func hashAccountPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func verifyAccountPassword(password, hash string) bool {
	if password == "" || hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
