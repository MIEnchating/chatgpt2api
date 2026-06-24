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
	IsAdmin     bool
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
	Name   string
	Groups []string
	Names  []string
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
	return r.StatusForGroupAndName(ctx, identity, "", "")
}

func (r *NewAPITokenReader) ConfiguredTokenGroups(ctx context.Context) []string {
	if r == nil || !r.configured || r.db == nil {
		return nil
	}
	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	groups, err := r.lookupAvailableTokenGroups(queryCtx, 0)
	if err != nil {
		return nil
	}
	return groups
}

func (r *NewAPITokenReader) StatusForGroup(ctx context.Context, identity Identity, group string) map[string]any {
	return r.StatusForGroupAndName(ctx, identity, group, "")
}

func (r *NewAPITokenReader) StatusForGroupAndName(ctx context.Context, identity Identity, group, name string) map[string]any {
	configuredGroup := r.configuredGroup()
	selectedGroup := firstNonEmptyNewAPIString(strings.TrimSpace(group), configuredGroup)
	status := map[string]any{
		"has_key":          false,
		"key_preview":      "",
		"group":            selectedGroup,
		"token_name":       strings.TrimSpace(name),
		"configured_group": configuredGroup,
		"groups":           []string{},
		"token_names":      []string{},
		"source":           "newapi",
	}
	selection, err := r.TokenForIdentityGroupAndName(ctx, identity, selectedGroup, name)
	if err != nil {
		status["message"] = err.Error()
		if selection.Groups != nil {
			status["groups"] = selection.Groups
		}
		if selection.Names != nil {
			status["token_names"] = selection.Names
		}
		return status
	}
	status["has_key"] = true
	status["key_preview"] = previewNewAPIKey(selection.Key)
	status["group"] = selection.Group
	status["token_name"] = selection.Name
	status["groups"] = selection.Groups
	status["token_names"] = selection.Names
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
	selection, selectionErr := r.lookupTokenSelection(queryCtx, balance.ID, configuredGroup, "")
	if selection.Groups != nil {
		status["token_groups"] = selection.Groups
	}
	if selection.Names != nil {
		status["token_names"] = selection.Names
	}
	if selection.Group != "" {
		status["token_group"] = selection.Group
	}
	if selection.Name != "" {
		status["token_name"] = selection.Name
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
	selection, err := r.TokenForIdentityGroupAndName(ctx, identity, group, "")
	if err != nil {
		return "", err
	}
	return selection.Key, nil
}

func (r *NewAPITokenReader) KeyForIdentityGroupAndName(ctx context.Context, identity Identity, group, name string) (string, error) {
	selection, err := r.TokenForIdentityGroupAndName(ctx, identity, group, name)
	if err != nil {
		return "", err
	}
	return selection.Key, nil
}

func (r *NewAPITokenReader) TokenForIdentity(ctx context.Context, identity Identity) (NewAPITokenSelection, error) {
	return r.TokenForIdentityGroupAndName(ctx, identity, "", "")
}

func (r *NewAPITokenReader) TokenForIdentityGroup(ctx context.Context, identity Identity, groupOverride string) (NewAPITokenSelection, error) {
	return r.TokenForIdentityGroupAndName(ctx, identity, groupOverride, "")
}

func (r *NewAPITokenReader) TokenForIdentityGroupAndName(ctx context.Context, identity Identity, groupOverride, nameOverride string) (NewAPITokenSelection, error) {
	if r == nil || !r.configured || r.db == nil {
		return NewAPITokenSelection{}, newAPITokenMessageError("请先配置云棉数据库连接，并在云棉创建指定分组的令牌", nil)
	}
	group := firstNonEmptyNewAPIString(strings.TrimSpace(groupOverride), r.configuredGroup())
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
	return r.lookupTokenSelection(queryCtx, userID, group, nameOverride)
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
	adminExpr := r.newAPIAdminSelectExpression(queryCtx)
	query := "SELECT id, username, email, display_name, password, " + adminExpr + " FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND status = 1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	var user NewAPIUser
	var email, displayName, passwordHash sql.NullString
	var adminValue any
	err := r.db.QueryRowContext(queryCtx, query, login, login).Scan(&user.ID, &user.Username, &email, &displayName, &passwordHash, &adminValue)
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
	user.IsAdmin = isTruthyNewAPIAdminValue(adminValue)
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
	if group == "" {
		return 0, newAPITokenMessageError("请先在云棉创建当前登录用户，并创建可用令牌", nil)
	}
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

func (r *NewAPITokenReader) lookupTokenKey(ctx context.Context, userID int64, group, name string) (string, error) {
	keyColumn := r.quoteIdentifier("key")
	groupColumn := r.quoteIdentifier("group")
	nameColumn := r.quoteIdentifier("name")
	query := "SELECT " + keyColumn +
		" FROM tokens WHERE user_id = " + r.placeholder(1) +
		" AND " + groupColumn + " = " + r.placeholder(2) +
		" AND status = 1 AND deleted_at IS NULL" +
		" AND " + keyColumn + " <> ''" +
		" AND (expired_time = -1 OR expired_time > " + r.placeholder(3) + ")" +
		" AND (unlimited_quota = true OR remain_quota > 0)"
	args := []any{userID, group, time.Now().Unix()}
	if strings.TrimSpace(name) != "" {
		query += " AND " + nameColumn + " = " + r.placeholder(4)
		args = append(args, strings.TrimSpace(name))
	}
	query += " ORDER BY id ASC LIMIT 1"
	var key string
	err := r.db.QueryRowContext(ctx, query, args...).Scan(&key)
	if err == nil && strings.TrimSpace(key) != "" {
		return key, nil
	}
	if errors.Is(err, sql.ErrNoRows) || strings.TrimSpace(key) == "" {
		if strings.TrimSpace(name) != "" {
			return "", newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建“%s”分组下名为“%s”的令牌", group, name), nil)
		}
		return "", newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建“%s”分组的令牌", group), nil)
	}
	return "", newAPITokenMessageError("读取云棉 Key 失败，请检查云棉数据库连接", err)
}

func (r *NewAPITokenReader) lookupTokenSelection(ctx context.Context, userID int64, group, name string) (NewAPITokenSelection, error) {
	groups, err := r.lookupTokenGroups(ctx, userID)
	selection := NewAPITokenSelection{Group: strings.TrimSpace(group), Groups: groups}
	if err != nil {
		return selection, err
	}
	if len(groups) == 0 {
		if strings.TrimSpace(group) == "" {
			return selection, newAPITokenMessageError("请先在云棉为当前用户创建可用令牌", nil)
		}
		return selection, newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建“%s”分组的可用令牌", group), nil)
	}
	selectedGroup, ok := firstMatchingNewAPITokenGroup(groups, group)
	if !ok {
		if strings.TrimSpace(group) == "" {
			selectedGroup = groups[0]
			ok = true
		}
	}
	if !ok {
		return selection, newAPITokenMessageError(fmt.Sprintf("当前用户没有“%s”分组的可用令牌，可用分组：%s", group, strings.Join(groups, ", ")), nil)
	}
	selection.Group = selectedGroup
	names, err := r.lookupTokenNames(ctx, userID, selectedGroup)
	selection.Names = names
	if err != nil {
		return selection, err
	}
	selectedName := strings.TrimSpace(name)
	if len(names) > 0 {
		var ok bool
		selectedName, ok = firstMatchingNewAPITokenName(names, selectedName)
		if !ok {
			if strings.TrimSpace(name) == "" {
				selectedName = names[0]
			} else {
				return selection, newAPITokenMessageError(fmt.Sprintf("当前用户在“%s”分组下没有名为“%s”的可用令牌，可用令牌：%s", selectedGroup, name, strings.Join(names, ", ")), nil)
			}
		}
	}
	key, err := r.lookupTokenKey(ctx, userID, selectedGroup, selectedName)
	if err != nil {
		return selection, err
	}
	selection.Name = selectedName
	selection.Key = normalizeNewAPIKey(key)
	return selection, nil
}

func (r *NewAPITokenReader) lookupTokenNames(ctx context.Context, userID int64, group string) ([]string, error) {
	keyColumn := r.quoteIdentifier("key")
	groupColumn := r.quoteIdentifier("group")
	nameColumn := r.quoteIdentifier("name")
	query := "SELECT " + nameColumn +
		" FROM tokens WHERE user_id = " + r.placeholder(1) +
		" AND " + groupColumn + " = " + r.placeholder(2) +
		" AND status = 1 AND deleted_at IS NULL" +
		" AND " + keyColumn + " <> ''" +
		" AND " + nameColumn + " <> ''" +
		" AND (expired_time = -1 OR expired_time > " + r.placeholder(3) + ")" +
		" AND (unlimited_quota = true OR remain_quota > 0)" +
		" ORDER BY id ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, group, time.Now().Unix())
	if err != nil {
		return nil, newAPITokenMessageError("读取云棉令牌名称失败，请检查云棉数据库连接", err)
	}
	defer rows.Close()

	seen := map[string]struct{}{}
	names := make([]string, 0)
	for rows.Next() {
		var name sql.NullString
		if err := rows.Scan(&name); err != nil {
			return nil, newAPITokenMessageError("读取云棉令牌名称失败，请检查云棉数据库连接", err)
		}
		value := strings.TrimSpace(name.String)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		names = append(names, value)
	}
	if err := rows.Err(); err != nil {
		return nil, newAPITokenMessageError("读取云棉令牌名称失败，请检查云棉数据库连接", err)
	}
	return names, nil
}

func (r *NewAPITokenReader) lookupTokenGroups(ctx context.Context, userID int64) ([]string, error) {
	return r.lookupAvailableTokenGroups(ctx, userID)
}

func (r *NewAPITokenReader) lookupAvailableTokenGroups(ctx context.Context, userID int64) ([]string, error) {
	keyColumn := r.quoteIdentifier("key")
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT " + groupColumn +
		" FROM tokens WHERE status = 1 AND deleted_at IS NULL" +
		" AND " + keyColumn + " <> ''" +
		" AND " + groupColumn + " <> ''" +
		" AND (expired_time = -1 OR expired_time > " + r.placeholder(1) + ")" +
		" AND (unlimited_quota = true OR remain_quota > 0)"
	args := []any{time.Now().Unix()}
	if userID > 0 {
		query += " AND user_id = " + r.placeholder(2)
		args = append(args, userID)
	}
	query +=
		" ORDER BY id ASC"
	rows, err := r.db.QueryContext(ctx, query, args...)
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

func (r *NewAPITokenReader) newAPIAdminSelectExpression(ctx context.Context) string {
	for _, column := range []string{"role", "is_admin", "root"} {
		if r.hasTableColumn(ctx, "users", column) {
			quoted := r.quoteIdentifier(column)
			switch column {
			case "role":
				return "CASE WHEN " + quoted + " IN ('admin', 'root') THEN 1 ELSE 0 END"
			default:
				return "CASE WHEN " + quoted + " = 1 THEN 1 ELSE 0 END"
			}
		}
	}
	return "0"
}

func (r *NewAPITokenReader) hasTableColumn(ctx context.Context, table, column string) bool {
	table = strings.TrimSpace(table)
	column = strings.TrimSpace(column)
	if table == "" || column == "" || r == nil || r.db == nil {
		return false
	}
	switch r.driver {
	case "sqlite":
		rows, err := r.db.QueryContext(ctx, "PRAGMA table_info("+r.quoteIdentifier(table)+")")
		if err != nil {
			return false
		}
		defer rows.Close()
		for rows.Next() {
			var cid int
			var name, typ string
			var notNull int
			var defaultValue any
			var pk int
			if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
				return false
			}
			if strings.EqualFold(strings.TrimSpace(name), column) {
				return true
			}
		}
		return false
	default:
		query := "SELECT 1 FROM information_schema.columns WHERE table_name = " + r.placeholder(1) + " AND column_name = " + r.placeholder(2) + " LIMIT 1"
		var exists int
		return r.db.QueryRowContext(ctx, query, table, column).Scan(&exists) == nil
	}
}

func isTruthyNewAPIAdminValue(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case int64:
		return v != 0
	case int:
		return v != 0
	case []byte:
		return isTruthyNewAPIAdminValue(string(v))
	case string:
		text := strings.ToLower(strings.TrimSpace(v))
		return text == "1" || text == "true" || text == "admin" || text == "root"
	default:
		return util.ToBool(v)
	}
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

func firstMatchingNewAPITokenName(names []string, preferred string) (string, bool) {
	preferred = strings.TrimSpace(preferred)
	if preferred == "" {
		return "", false
	}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if strings.EqualFold(name, preferred) {
			return name, true
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
