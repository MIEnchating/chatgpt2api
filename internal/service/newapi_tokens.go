package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"

	"golang.org/x/crypto/bcrypt"
)

const defaultNewAPITokenQueryTimeout = 5 * time.Second

type NewAPITokenReaderConfig struct {
	DatabaseURL  string
	TokenGroup   string
	QueryTimeout time.Duration
}

type NewAPIUser struct {
	ID          int64
	Username    string
	Email       string
	DisplayName string
}

type NewAPIUserBalance struct {
	ID           int64
	Username     string
	Email        string
	DisplayName  string
	Group        string
	Quota        int64
	UsedQuota    int64
	RequestCount int64
}

type NewAPITokenSelection struct {
	Key    string
	Group  string
	Groups []string
}

type NewAPITokenReader struct {
	db         *sql.DB
	driver     string
	mu         sync.RWMutex
	group      string
	configured bool
	timeout    time.Duration
}

type NewAPITokenError struct {
	Message string
	Cause   error
}

func (e NewAPITokenError) Error() string {
	return e.Message
}

func (e NewAPITokenError) Unwrap() error {
	return e.Cause
}

func NewNewAPITokenReader(cfg NewAPITokenReaderConfig) (*NewAPITokenReader, error) {
	group := strings.TrimSpace(cfg.TokenGroup)
	timeout := cfg.QueryTimeout
	if timeout <= 0 {
		timeout = defaultNewAPITokenQueryTimeout
	}
	reader := &NewAPITokenReader{group: group, timeout: timeout}
	databaseURL := strings.TrimSpace(cfg.DatabaseURL)
	if databaseURL == "" {
		return reader, nil
	}

	driver, dsn, err := storage.ParseDatabaseURL(databaseURL)
	if err != nil {
		return nil, err
	}
	if driver == "sqlite" {
		dsn = sqliteReadOnlyDSN(dsn)
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(time.Hour)
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	reader.db = db
	reader.driver = driver
	reader.configured = true
	return reader, nil
}

func (r *NewAPITokenReader) Close() error {
	if r == nil || r.db == nil {
		return nil
	}
	return r.db.Close()
}

func (r *NewAPITokenReader) SetConfiguredGroup(group string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.group = strings.TrimSpace(group)
	r.mu.Unlock()
}

func (r *NewAPITokenReader) Status(ctx context.Context, identity Identity) map[string]any {
	return r.StatusForGroup(ctx, identity, "")
}

func (r *NewAPITokenReader) StatusForGroup(ctx context.Context, identity Identity, group string) map[string]any {
	configuredGroup := r.configuredGroup()
	selectedGroup := firstNonEmptyNewAPIString(strings.TrimSpace(group), configuredGroup)
	status := map[string]any{
		"has_key":          false,
		"key_preview":      "",
		"group":            selectedGroup,
		"configured_group": configuredGroup,
		"groups":           []string{},
		"source":           "newapi",
	}
	selection, err := r.TokenForIdentityGroup(ctx, identity, selectedGroup)
	if err != nil {
		status["message"] = err.Error()
		if selection.Groups != nil {
			status["groups"] = selection.Groups
		}
		return status
	}
	status["has_key"] = true
	status["key_preview"] = previewNewAPIKey(selection.Key)
	status["group"] = selection.Group
	status["groups"] = selection.Groups
	return status
}

func (r *NewAPITokenReader) BalanceStatus(ctx context.Context, identity Identity) map[string]any {
	configuredGroup := r.configuredGroup()
	status := map[string]any{
		"has_balance":      false,
		"source":           "newapi",
		"token_group":      configuredGroup,
		"configured_group": configuredGroup,
		"token_groups":     []string{},
	}
	if r == nil || !r.configured || r.db == nil {
		status["message"] = "请先配置云棉数据库连接"
		return status
	}
	candidates := newAPIIdentityLookupValues(identity)
	if len(candidates) == 0 {
		status["message"] = "当前登录用户缺少云棉用户名，无法读取云棉余额"
		return status
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	balance, err := r.lookupUserBalance(queryCtx, candidates)
	if err != nil {
		status["message"] = err.Error()
		return status
	}
	selection, selectionErr := r.lookupTokenSelection(queryCtx, balance.ID, configuredGroup)
	if selection.Groups != nil {
		status["token_groups"] = selection.Groups
	}
	if selection.Group != "" {
		status["token_group"] = selection.Group
	}
	if selectionErr != nil {
		status["token_message"] = selectionErr.Error()
	}
	status["has_balance"] = true
	status["user_id"] = balance.ID
	status["username"] = balance.Username
	status["email"] = balance.Email
	status["display_name"] = balance.DisplayName
	status["user_group"] = balance.Group
	status["quota"] = balance.Quota
	status["used_quota"] = balance.UsedQuota
	status["request_count"] = balance.RequestCount
	return status
}

func (r *NewAPITokenReader) BalanceForIdentity(ctx context.Context, identity Identity) (NewAPIUserBalance, error) {
	if r == nil || !r.configured || r.db == nil {
		return NewAPIUserBalance{}, newAPITokenMessageError("请先配置云棉数据库连接", nil)
	}
	candidates := newAPIIdentityLookupValues(identity)
	if len(candidates) == 0 {
		return NewAPIUserBalance{}, newAPITokenMessageError("当前登录用户缺少云棉用户名，无法读取云棉余额", nil)
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	return r.lookupUserBalance(queryCtx, candidates)
}

func (r *NewAPITokenReader) KeyForIdentity(ctx context.Context, identity Identity) (string, error) {
	selection, err := r.TokenForIdentity(ctx, identity)
	if err != nil {
		return "", err
	}
	return selection.Key, nil
}

func (r *NewAPITokenReader) KeyForIdentityGroup(ctx context.Context, identity Identity, group string) (string, error) {
	selection, err := r.TokenForIdentityGroup(ctx, identity, group)
	if err != nil {
		return "", err
	}
	return selection.Key, nil
}

func (r *NewAPITokenReader) TokenForIdentity(ctx context.Context, identity Identity) (NewAPITokenSelection, error) {
	return r.TokenForIdentityGroup(ctx, identity, "")
}

func (r *NewAPITokenReader) TokenForIdentityGroup(ctx context.Context, identity Identity, groupOverride string) (NewAPITokenSelection, error) {
	if r == nil || !r.configured || r.db == nil {
		return NewAPITokenSelection{}, newAPITokenMessageError("请先配置云棉数据库连接，并在云棉创建指定分组的令牌", nil)
	}
	group := firstNonEmptyNewAPIString(strings.TrimSpace(groupOverride), r.configuredGroup())
	if group == "" {
		return NewAPITokenSelection{}, newAPITokenMessageError("请先配置云棉令牌分组", nil)
	}
	candidates := newAPIIdentityLookupValues(identity)
	if len(candidates) == 0 {
		return NewAPITokenSelection{}, newAPITokenMessageError("当前登录用户缺少云棉用户名，无法读取云棉 Key", nil)
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	userID, err := r.lookupUserID(queryCtx, candidates, group)
	if err != nil {
		return NewAPITokenSelection{}, err
	}
	return r.lookupTokenSelection(queryCtx, userID, group)
}

func (r *NewAPITokenReader) AuthenticatePassword(ctx context.Context, login, password string) (NewAPIUser, error) {
	if r == nil || !r.configured || r.db == nil {
		return NewAPIUser{}, newAPITokenMessageError("请先配置云棉数据库连接", nil)
	}
	login = strings.TrimSpace(login)
	if login == "" || password == "" {
		return NewAPIUser{}, newAPITokenMessageError("用户名或密码错误", nil)
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	query := "SELECT id, username, email, display_name, password FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND status = 1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	var user NewAPIUser
	var email, displayName, passwordHash sql.NullString
	err := r.db.QueryRowContext(queryCtx, query, login, login).Scan(&user.ID, &user.Username, &email, &displayName, &passwordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return NewAPIUser{}, newAPITokenMessageError("用户名或密码错误", nil)
	}
	if err != nil {
		return NewAPIUser{}, newAPITokenMessageError("读取云棉用户失败，请检查云棉数据库连接", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(strings.TrimSpace(passwordHash.String)), []byte(password)) != nil {
		return NewAPIUser{}, newAPITokenMessageError("用户名或密码错误", nil)
	}
	user.Username = strings.TrimSpace(user.Username)
	user.Email = strings.TrimSpace(email.String)
	user.DisplayName = strings.TrimSpace(displayName.String)
	if user.Username == "" {
		return NewAPIUser{}, newAPITokenMessageError("读取云棉用户失败，请检查云棉用户数据", nil)
	}
	return user, nil
}

func (r *NewAPITokenReader) lookupUserID(ctx context.Context, candidates []string, group string) (int64, error) {
	query := "SELECT id FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND status = 1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	for _, candidate := range candidates {
		var id int64
		err := r.db.QueryRowContext(ctx, query, candidate, candidate).Scan(&id)
		if err == nil {
			return id, nil
		}
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		return 0, newAPITokenMessageError("读取云棉 Key 失败，请检查云棉数据库连接", err)
	}
	group = firstNonEmptyNewAPIString(group, r.configuredGroup())
	return 0, newAPITokenMessageError(fmt.Sprintf("请先在云棉创建当前登录用户，并创建“%s”分组的令牌", group), nil)
}

func (r *NewAPITokenReader) lookupUserBalance(ctx context.Context, candidates []string) (NewAPIUserBalance, error) {
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT id, username, email, display_name, quota, used_quota, request_count, " + groupColumn + " FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND status = 1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	for _, candidate := range candidates {
		var balance NewAPIUserBalance
		var email, displayName, group sql.NullString
		var quota, usedQuota, requestCount sql.NullInt64
		err := r.db.QueryRowContext(ctx, query, candidate, candidate).Scan(&balance.ID, &balance.Username, &email, &displayName, &quota, &usedQuota, &requestCount, &group)
		if err == nil {
			balance.Username = strings.TrimSpace(balance.Username)
			balance.Email = strings.TrimSpace(email.String)
			balance.DisplayName = strings.TrimSpace(displayName.String)
			balance.Group = strings.TrimSpace(group.String)
			balance.Quota = quota.Int64
			balance.UsedQuota = usedQuota.Int64
			balance.RequestCount = requestCount.Int64
			if balance.Username == "" {
				return NewAPIUserBalance{}, newAPITokenMessageError("读取云棉余额失败，请检查云棉用户数据", nil)
			}
			return balance, nil
		}
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		return NewAPIUserBalance{}, newAPITokenMessageError("读取云棉余额失败，请检查云棉数据库连接", err)
	}
	return NewAPIUserBalance{}, newAPITokenMessageError("请先在云棉创建当前登录用户", nil)
}

func (r *NewAPITokenReader) lookupTokenKey(ctx context.Context, userID int64, group string) (string, error) {
	keyColumn := r.quoteIdentifier("key")
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT " + keyColumn +
		" FROM tokens WHERE user_id = " + r.placeholder(1) +
		" AND " + groupColumn + " = " + r.placeholder(2) +
		" AND status = 1 AND deleted_at IS NULL" +
		" AND " + keyColumn + " <> ''" +
		" AND (expired_time = -1 OR expired_time > " + r.placeholder(3) + ")" +
		" AND (unlimited_quota = true OR remain_quota > 0)" +
		" ORDER BY id ASC LIMIT 1"
	var key string
	err := r.db.QueryRowContext(ctx, query, userID, group, time.Now().Unix()).Scan(&key)
	if err == nil && strings.TrimSpace(key) != "" {
		return key, nil
	}
	if errors.Is(err, sql.ErrNoRows) || strings.TrimSpace(key) == "" {
		return "", newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建“%s”分组的令牌", group), nil)
	}
	return "", newAPITokenMessageError("读取云棉 Key 失败，请检查云棉数据库连接", err)
}

func (r *NewAPITokenReader) lookupTokenSelection(ctx context.Context, userID int64, group string) (NewAPITokenSelection, error) {
	groups, err := r.lookupTokenGroups(ctx, userID)
	selection := NewAPITokenSelection{Group: strings.TrimSpace(group), Groups: groups}
	if err != nil {
		return selection, err
	}
	if len(groups) == 0 {
		return selection, newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建“%s”分组的可用令牌", group), nil)
	}
	selectedGroup, ok := firstMatchingNewAPITokenGroup(groups, group)
	if !ok {
		return selection, newAPITokenMessageError(fmt.Sprintf("当前用户没有“%s”分组的可用令牌，可用分组：%s", group, strings.Join(groups, ", ")), nil)
	}
	key, err := r.lookupTokenKey(ctx, userID, selectedGroup)
	if err != nil {
		selection.Group = selectedGroup
		return selection, err
	}
	selection.Group = selectedGroup
	selection.Key = normalizeNewAPIKey(key)
	return selection, nil
}

func (r *NewAPITokenReader) lookupTokenGroups(ctx context.Context, userID int64) ([]string, error) {
	keyColumn := r.quoteIdentifier("key")
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT " + groupColumn +
		" FROM tokens WHERE user_id = " + r.placeholder(1) +
		" AND status = 1 AND deleted_at IS NULL" +
		" AND " + keyColumn + " <> ''" +
		" AND " + groupColumn + " <> ''" +
		" AND (expired_time = -1 OR expired_time > " + r.placeholder(2) + ")" +
		" AND (unlimited_quota = true OR remain_quota > 0)" +
		" ORDER BY id ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, time.Now().Unix())
	if err != nil {
		return nil, newAPITokenMessageError("读取云棉令牌分组失败，请检查云棉数据库连接", err)
	}
	defer rows.Close()

	seen := map[string]struct{}{}
	groups := make([]string, 0)
	for rows.Next() {
		var group sql.NullString
		if err := rows.Scan(&group); err != nil {
			return nil, newAPITokenMessageError("读取云棉令牌分组失败，请检查云棉数据库连接", err)
		}
		value := strings.TrimSpace(group.String)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		groups = append(groups, value)
	}
	if err := rows.Err(); err != nil {
		return nil, newAPITokenMessageError("读取云棉令牌分组失败，请检查云棉数据库连接", err)
	}
	return groups, nil
}

func firstNonEmptyNewAPIString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstMatchingNewAPITokenGroup(groups []string, preferred string) (string, bool) {
	preferred = strings.TrimSpace(preferred)
	if preferred == "" {
		return "", false
	}
	for _, group := range groups {
		group = strings.TrimSpace(group)
		if strings.EqualFold(group, preferred) {
			return group, true
		}
	}
	return "", false
}

func (r *NewAPITokenReader) configuredGroup() string {
	if r == nil {
		return ""
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return strings.TrimSpace(r.group)
}

func (r *NewAPITokenReader) placeholder(index int) string {
	if r != nil && r.driver == "postgres" {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}

func (r *NewAPITokenReader) quoteIdentifier(name string) string {
	if r != nil && r.driver == "postgres" {
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func newAPITokenMessageError(message string, cause error) error {
	return NewAPITokenError{Message: message, Cause: cause}
}

func newAPIIdentityLookupValues(identity Identity) []string {
	if username := util.Clean(identity.Username); username != "" {
		return []string{username}
	}
	return dedupeNewAPIValues([]string{
		util.Clean(identity.Name),
		util.Clean(identity.CredentialName),
		util.Clean(identity.OwnerID),
		util.Clean(identity.ID),
	})
}

func dedupeNewAPIValues(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func normalizeNewAPIKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" || strings.HasPrefix(key, "sk-") {
		return key
	}
	return "sk-" + key
}

func previewNewAPIKey(key string) string {
	key = normalizeNewAPIKey(key)
	if len(key) <= 12 {
		return key
	}
	return key[:7] + "..." + key[len(key)-4:]
}

func contextOrBackground(ctx context.Context) context.Context {
	if ctx != nil {
		return ctx
	}
	return context.Background()
}

func sqliteReadOnlyDSN(dsn string) string {
	dsn = strings.TrimSpace(dsn)
	if dsn == "" || strings.Contains(strings.ToLower(dsn), "mode=ro") {
		return dsn
	}
	if strings.HasPrefix(strings.ToLower(dsn), "file:") {
		if strings.Contains(dsn, "?") {
			return dsn + "&mode=ro"
		}
		return dsn + "?mode=ro"
	}
	if strings.Contains(dsn, "?") {
		pathPart, query, _ := strings.Cut(dsn, "?")
		return "file:" + filepath.ToSlash(pathPart) + "?" + query + "&mode=ro"
	}
	return "file:" + filepath.ToSlash(dsn) + "?mode=ro"
}
