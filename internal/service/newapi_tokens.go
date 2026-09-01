package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"

	"golang.org/x/crypto/bcrypt"
)

const (
	defaultNewAPITokenQueryTimeout    = 5 * time.Second
	newAPITokenRouteMaxCooldownSecond = 31_536_000
	newAPISchemaPresenceCacheTTL      = 5 * time.Minute
)

type NewAPITokenReaderConfig struct {
	DatabaseURL  string
	DatabaseType string
	QueryTimeout time.Duration
}

type NewAPIUser struct {
	ID            int64
	Username      string
	Email         string
	DisplayName   string
	IsAdmin       bool
	Provider      string
	SubjectPrefix string
}

type NewAPIUserBalance struct {
	ID           int64
	Username     string
	Email        string
	DisplayName  string
	Group        string
	Quota        float64
	UsedQuota    float64
	RequestCount int64
}

type NewAPITokenSelection struct {
	Key    string
	Group  string
	Name   string
	Groups []string
	Names  []string
}

type newAPITokenCandidate struct {
	ID               int64
	Key              string
	Name             string
	Group            string
	GroupRouteConfig string
}

type newAPITokenGroupRoute struct {
	Group           string `json:"group"`
	Priority        int    `json:"priority"`
	CooldownSeconds int    `json:"cooldown_seconds"`
	Enabled         *bool  `json:"enabled,omitempty"`
}

type NewAPITokenReader struct {
	db                  *sql.DB
	driver              string
	databaseKind        string
	configured          bool
	timeout             time.Duration
	schemaCacheMu       sync.RWMutex
	schemaPresenceCache map[string]newAPISchemaPresenceCacheEntry
}

type newAPISchemaPresenceCacheEntry struct {
	present   bool
	expiresAt time.Time
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
	timeout := cfg.QueryTimeout
	if timeout <= 0 {
		timeout = defaultNewAPITokenQueryTimeout
	}
	databaseKind := strings.ToLower(strings.TrimSpace(cfg.DatabaseType))
	if databaseKind == "" {
		databaseKind = "newapi"
	}
	if databaseKind != "newapi" && databaseKind != "sub2api" {
		return nil, fmt.Errorf("unsupported relay database type %q: must be newapi or sub2api", cfg.DatabaseType)
	}
	reader := &NewAPITokenReader{
		timeout: timeout, databaseKind: databaseKind,
		schemaPresenceCache: make(map[string]newAPISchemaPresenceCacheEntry),
	}
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

func (r *NewAPITokenReader) IsSub2API() bool {
	return r != nil && r.databaseKind == "sub2api"
}

func (r *NewAPITokenReader) Source() string {
	if r != nil && r.IsSub2API() {
		return "sub2api"
	}
	return "newapi"
}

func (r *NewAPITokenReader) Close() error {
	if r == nil || r.db == nil {
		return nil
	}
	return r.db.Close()
}

func (r *NewAPITokenReader) ValidateConnection(ctx context.Context) error {
	if r == nil || !r.configured || r.db == nil {
		return nil
	}
	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	return r.db.PingContext(queryCtx)
}

func (r *NewAPITokenReader) StatusForGroupAndName(ctx context.Context, identity Identity, group, name string) map[string]any {
	selectedGroup := strings.TrimSpace(group)
	selectedName := strings.TrimSpace(name)
	status := map[string]any{
		"has_key":             false,
		"key_preview":         "",
		"group":               selectedGroup,
		"token_name":          selectedName,
		"groups":              []string{},
		"token_names":         []string{},
		"source":              r.Source(),
		"database_configured": r != nil && r.configured && r.db != nil,
	}
	selection, err := r.TokenForIdentityGroupAndName(ctx, identity, group, name)
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
	status["key_preview"] = previewRelayKey(selection.Key)
	status["group"] = selection.Group
	status["token_name"] = selection.Name
	status["groups"] = selection.Groups
	status["token_names"] = selection.Names
	return status
}

func (r *NewAPITokenReader) BalanceStatus(ctx context.Context, identity Identity) map[string]any {
	status := map[string]any{
		"has_balance":         false,
		"source":              r.Source(),
		"token_groups":        []string{},
		"database_configured": r != nil && r.configured && r.db != nil,
	}
	if r == nil || !r.configured || r.db == nil {
		status["message"] = "请先配置数据库连接"
		return status
	}
	candidates := newAPIIdentityLookupValues(identity)
	if len(candidates) == 0 {
		status["message"] = "当前登录用户缺少云棉用户名，无法读取云棉余额"
		return status
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	balance, err := r.lookupUserBalanceForIdentity(queryCtx, identity, candidates)
	if err != nil {
		status["message"] = err.Error()
		return status
	}
	selection, selectionErr := r.lookupTokenSelection(queryCtx, balance.ID, "", "")
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

func (r *NewAPITokenReader) KeyForIdentity(ctx context.Context, identity Identity) (string, error) {
	selection, err := r.TokenForIdentity(ctx, identity)
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

func (r *NewAPITokenReader) TokenForIdentityGroupAndName(ctx context.Context, identity Identity, groupOverride, nameOverride string) (NewAPITokenSelection, error) {
	if r == nil || !r.configured || r.db == nil {
		return NewAPITokenSelection{}, newAPITokenMessageError("请先配置数据库连接，并创建指定分组的令牌", nil)
	}
	group := strings.TrimSpace(groupOverride)
	name := strings.TrimSpace(nameOverride)
	candidates := newAPIIdentityLookupValues(identity)
	if len(candidates) == 0 {
		return NewAPITokenSelection{}, newAPITokenMessageError("当前登录用户缺少云棉用户名，无法读取云棉 Key", nil)
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	userID, err := r.lookupUserIDForIdentity(queryCtx, identity, candidates, group)
	if err != nil {
		return NewAPITokenSelection{}, err
	}
	return r.lookupTokenSelection(queryCtx, userID, group, name)
}

func (r *NewAPITokenReader) AuthenticatePassword(ctx context.Context, login, password string) (NewAPIUser, error) {
	if r == nil || !r.configured || r.db == nil {
		return NewAPIUser{}, newAPITokenMessageError("请先配置数据库连接", nil)
	}
	login = strings.TrimSpace(login)
	if login == "" || password == "" {
		return NewAPIUser{}, newAPITokenMessageError("用户名或密码错误", nil)
	}

	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	adminExpr := r.newAPIAdminSelectExpression(queryCtx)
	query := "SELECT id, username, email, "
	if r.IsSub2API() {
		query += "username, password_hash, " + adminExpr
	} else {
		query += "display_name, password, " + adminExpr
	}
	query += " FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND " + r.activeUserPredicate() + " AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	var user NewAPIUser
	var email, displayName, passwordHash sql.NullString
	var adminValue any
	err := r.db.QueryRowContext(queryCtx, query, login, login).Scan(&user.ID, &user.Username, &email, &displayName, &passwordHash, &adminValue)
	if errors.Is(err, sql.ErrNoRows) {
		return NewAPIUser{}, newAPITokenMessageError("用户名或密码错误", nil)
	}
	if err != nil {
		return NewAPIUser{}, newAPITokenMessageError("读取用户失败，请检查数据库连接", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(strings.TrimSpace(passwordHash.String)), []byte(password)) != nil {
		return NewAPIUser{}, newAPITokenMessageError("用户名或密码错误", nil)
	}
	user.Username = strings.TrimSpace(user.Username)
	user.Email = strings.TrimSpace(email.String)
	user.DisplayName = strings.TrimSpace(displayName.String)
	if r.IsSub2API() && user.Username == "" {
		user.Username = user.Email
		user.DisplayName = user.Email
	}
	user.IsAdmin = isTruthyNewAPIAdminValue(adminValue)
	user.Provider = r.Source()
	user.SubjectPrefix = r.Source()
	if user.Username == "" {
		return NewAPIUser{}, newAPITokenMessageError("读取云棉用户失败，请检查云棉用户数据", nil)
	}
	return user, nil
}

func (r *NewAPITokenReader) lookupUserID(ctx context.Context, candidates []string, group string) (int64, error) {
	query := "SELECT id FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND " + r.activeUserPredicate() + " AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	for _, candidate := range candidates {
		var id int64
		err := r.db.QueryRowContext(ctx, query, candidate, candidate).Scan(&id)
		if err == nil {
			return id, nil
		}
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		return 0, newAPITokenMessageError("读取 Key 失败，请检查数据库连接", err)
	}
	group = strings.TrimSpace(group)
	if group == "" {
		return 0, newAPITokenMessageError("请先在云棉创建当前登录用户，并创建可用令牌", nil)
	}
	return 0, newAPITokenMessageError(fmt.Sprintf("请先在云棉创建当前登录用户，并创建“%s”分组的令牌", group), nil)
}

func (r *NewAPITokenReader) lookupUserIDForIdentity(ctx context.Context, identity Identity, candidates []string, group string) (int64, error) {
	if userID, ok := r.identityUserID(identity); ok {
		query := "SELECT id FROM users WHERE id = " + r.placeholder(1) + " AND " + r.activeUserPredicate() + " AND deleted_at IS NULL LIMIT 1"
		var id int64
		err := r.db.QueryRowContext(ctx, query, userID).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return 0, newAPITokenMessageError("读取 Key 失败，请检查数据库连接", err)
		}
		return 0, newAPITokenMessageError(fmt.Sprintf("云棉用户 ID %d 不存在或已停用，请重新登录", userID), nil)
	}
	return r.lookupUserID(ctx, candidates, group)
}

func (r *NewAPITokenReader) lookupUserBalance(ctx context.Context, candidates []string) (NewAPIUserBalance, error) {
	if r.IsSub2API() {
		return r.lookupSub2APIUserBalance(ctx, candidates)
	}
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT id, username, email, display_name, quota, used_quota, request_count, " + groupColumn + " FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND status = 1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	for _, candidate := range candidates {
		balance, err := scanNewAPIUserBalance(r.db.QueryRowContext(ctx, query, candidate, candidate))
		if err == nil {
			if balance.Username == "" {
				return NewAPIUserBalance{}, newAPITokenMessageError("读取云棉余额失败，请检查云棉用户数据", nil)
			}
			return balance, nil
		}
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		return NewAPIUserBalance{}, newAPITokenMessageError("读取余额失败，请检查数据库连接", err)
	}
	return NewAPIUserBalance{}, newAPITokenMessageError("请先在云棉创建当前登录用户", nil)
}

func (r *NewAPITokenReader) lookupUserBalanceForIdentity(ctx context.Context, identity Identity, candidates []string) (NewAPIUserBalance, error) {
	if userID, ok := r.identityUserID(identity); ok {
		groupColumn := r.quoteIdentifier("group")
		if r.IsSub2API() {
			return r.lookupSub2APIUserBalanceByID(ctx, userID)
		}
		query := "SELECT id, username, email, display_name, quota, used_quota, request_count, " + groupColumn + " FROM users WHERE id = " + r.placeholder(1) + " AND status = 1 AND deleted_at IS NULL LIMIT 1"
		balance, err := scanNewAPIUserBalance(r.db.QueryRowContext(ctx, query, userID))
		if errors.Is(err, sql.ErrNoRows) {
			return NewAPIUserBalance{}, newAPITokenMessageError(fmt.Sprintf("云棉用户 ID %d 不存在或已停用，请重新登录", userID), nil)
		}
		if err != nil {
			return NewAPIUserBalance{}, newAPITokenMessageError("读取余额失败，请检查数据库连接", err)
		}
		if balance.Username == "" {
			return NewAPIUserBalance{}, newAPITokenMessageError("读取云棉余额失败，请检查云棉用户数据", nil)
		}
		return balance, nil
	}
	return r.lookupUserBalance(ctx, candidates)
}

func scanNewAPIUserBalance(row *sql.Row) (NewAPIUserBalance, error) {
	var balance NewAPIUserBalance
	var email, displayName, group sql.NullString
	var quota, usedQuota, requestCount sql.NullInt64
	if err := row.Scan(&balance.ID, &balance.Username, &email, &displayName, &quota, &usedQuota, &requestCount, &group); err != nil {
		return NewAPIUserBalance{}, err
	}
	balance.Username = strings.TrimSpace(balance.Username)
	balance.Email = strings.TrimSpace(email.String)
	balance.DisplayName = strings.TrimSpace(displayName.String)
	balance.Group = strings.TrimSpace(group.String)
	balance.Quota = float64(quota.Int64)
	balance.UsedQuota = float64(usedQuota.Int64)
	balance.RequestCount = requestCount.Int64
	return balance, nil
}

func (r *NewAPITokenReader) lookupTokenSelection(ctx context.Context, userID int64, group, name string) (NewAPITokenSelection, error) {
	requestedGroup := strings.TrimSpace(group)
	requestedName := strings.TrimSpace(name)
	selection := NewAPITokenSelection{Group: requestedGroup, Name: requestedName, Groups: []string{}, Names: []string{}}
	userGroup, err := r.lookupUserGroup(ctx, userID)
	if err != nil {
		return selection, err
	}
	candidates, err := r.lookupTokenCandidates(ctx, userID)
	if err != nil {
		return selection, err
	}
	candidatesByName := make(map[string][]newAPITokenCandidate, len(candidates))
	names := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if _, exists := candidatesByName[candidate.Name]; !exists {
			names = append(names, candidate.Name)
		}
		candidatesByName[candidate.Name] = append(candidatesByName[candidate.Name], candidate)
	}
	selection.Names = names

	firstCandidateByGroup := make(map[string]newAPITokenCandidate, len(candidates))
	groups := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		candidateGroups, ok := newAPITokenCandidateGroups(candidate, userGroup)
		if !ok || len(candidateGroups) != 1 {
			continue
		}
		candidateGroup := candidateGroups[0]
		if _, exists := firstCandidateByGroup[candidateGroup]; exists {
			continue
		}
		firstCandidateByGroup[candidateGroup] = candidate
		groups = append(groups, candidateGroup)
	}
	selection.Groups = groups
	if len(candidates) == 0 {
		selection.Group = requestedGroup
		return selection, newAPITokenMessageError("请先在云棉为当前用户创建名称和 Key 均非空的可用令牌", nil)
	}

	if requestedName != "" {
		matched := candidatesByName[requestedName]
		switch len(matched) {
		case 0:
			return selection, newAPITokenMessageError(fmt.Sprintf("当前用户没有名为“%s”的可用令牌，可用令牌：%s", requestedName, strings.Join(names, ", ")), nil)
		case 1:
			selected := matched[0]
			selection.Key = r.normalizeRelayKey(selected.Key)
			selection.Name = selected.Name
			selection.Group = newAPITokenCandidateGroupMetadata(selected, userGroup)
			return selection, nil
		default:
			return selection, newAPITokenMessageError(fmt.Sprintf("当前用户存在 %d 个名为“%s”的可用令牌，无法唯一选择，请在云棉中重命名后重试", len(matched), requestedName), nil)
		}
	}

	if len(groups) == 0 {
		selection.Group = requestedGroup
		if requestedGroup != "" {
			return selection, newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建仅使用“%s”分组的可用令牌", requestedGroup), nil)
		}
		return selection, newAPITokenMessageError("请先在云棉为当前用户创建仅使用单一分组的可用令牌", nil)
	}

	selectedGroup := requestedGroup
	if selectedGroup != "" {
		if _, ok := firstCandidateByGroup[selectedGroup]; !ok {
			return selection, newAPITokenMessageError(fmt.Sprintf("当前用户没有“%s”分组的安全可用令牌，可用分组：%s", selectedGroup, strings.Join(groups, ", ")), nil)
		}
	} else {
		selectedGroup = groups[0]
	}

	selection.Group = selectedGroup
	selected := firstCandidateByGroup[selectedGroup]
	selection.Key = r.normalizeRelayKey(selected.Key)
	selection.Name = selected.Name
	return selection, nil
}

func (r *NewAPITokenReader) lookupTokenCandidates(ctx context.Context, userID int64) ([]newAPITokenCandidate, error) {
	if r.IsSub2API() {
		return r.lookupSub2APITokenCandidates(ctx, userID)
	}
	keyColumn := r.quoteIdentifier("key")
	nameColumn := r.quoteIdentifier("name")
	groupColumn := r.quoteIdentifier("group")
	routeConfigColumn := "''"
	if r.hasTableColumn(ctx, "tokens", "group_route_config") {
		routeConfigColumn = r.quoteIdentifier("group_route_config")
	}
	query := "SELECT id, " + keyColumn + ", " + nameColumn + ", " + groupColumn + ", " + routeConfigColumn +
		" FROM tokens WHERE user_id = " + r.placeholder(1) +
		" AND status = 1 AND deleted_at IS NULL" +
		" AND " + keyColumn + " <> ''" +
		" AND (expired_time = -1 OR expired_time >= " + r.placeholder(2) + ")" +
		" AND (unlimited_quota = true OR remain_quota > 0)" +
		" ORDER BY id ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, time.Now().Unix())
	if err != nil {
		return nil, newAPITokenMessageError("读取令牌失败，请检查数据库连接", err)
	}
	defer rows.Close()

	candidates := make([]newAPITokenCandidate, 0)
	for rows.Next() {
		var candidate newAPITokenCandidate
		var key, name, group, routeConfig sql.NullString
		if err := rows.Scan(&candidate.ID, &key, &name, &group, &routeConfig); err != nil {
			return nil, newAPITokenMessageError("读取令牌失败，请检查数据库连接", err)
		}
		candidate.Key = strings.TrimSpace(key.String)
		candidate.Name = strings.TrimSpace(name.String)
		candidate.Group = strings.TrimSpace(group.String)
		candidate.GroupRouteConfig = strings.TrimSpace(routeConfig.String)
		if candidate.Key != "" && candidate.Name != "" {
			candidates = append(candidates, candidate)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, newAPITokenMessageError("读取令牌失败，请检查数据库连接", err)
	}
	return candidates, nil
}

func newAPITokenCandidateGroupMetadata(candidate newAPITokenCandidate, userGroup string) string {
	if group := strings.TrimSpace(candidate.Group); group != "" {
		return group
	}
	if groups, ok := newAPITokenCandidateGroups(candidate, userGroup); ok && len(groups) == 1 {
		return groups[0]
	}
	return strings.TrimSpace(userGroup)
}

func (r *NewAPITokenReader) lookupUserGroup(ctx context.Context, userID int64) (string, error) {
	if r.IsSub2API() {
		return "", nil
	}
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT " + groupColumn + " FROM users WHERE id = " + r.placeholder(1) + " AND status = 1 AND deleted_at IS NULL LIMIT 1"
	var group sql.NullString
	err := r.db.QueryRowContext(ctx, query, userID).Scan(&group)
	if errors.Is(err, sql.ErrNoRows) {
		return "", newAPITokenMessageError("当前云棉用户不存在或已停用，请重新登录", nil)
	}
	if err != nil {
		return "", newAPITokenMessageError("读取用户分组失败，请检查数据库连接", err)
	}
	return strings.TrimSpace(group.String), nil
}

func (r *NewAPITokenReader) newAPIAdminSelectExpression(ctx context.Context) string {
	if r.IsSub2API() {
		return "CASE WHEN LOWER(" + r.quoteIdentifier("role") + ") IN ('admin', 'owner', 'super_admin') THEN 1 ELSE 0 END"
	}
	for _, column := range []string{"role", "is_admin", "root"} {
		if r.hasTableColumn(ctx, "users", column) {
			quoted := r.quoteIdentifier(column)
			switch column {
			case "role":
				return "CASE WHEN " + quoted + " IN (10, 100) THEN 1 ELSE 0 END"
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
	key := "column:" + strings.ToLower(table) + ":" + strings.ToLower(column)
	return r.cachedSchemaPresence(key, func() (bool, error) {
		if r.driver != "sqlite" {
			query := "SELECT 1 FROM information_schema.columns WHERE table_name = " + r.placeholder(1) + " AND column_name = " + r.placeholder(2) + " LIMIT 1"
			var exists int
			err := r.db.QueryRowContext(ctx, query, table, column).Scan(&exists)
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			return err == nil, err
		}
		rows, err := r.db.QueryContext(ctx, "PRAGMA table_info("+r.quoteIdentifier(table)+")")
		if err != nil {
			return false, err
		}
		defer rows.Close()
		for rows.Next() {
			var cid int
			var name, typ string
			var notNull int
			var defaultValue any
			var pk int
			if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
				return false, err
			}
			if strings.EqualFold(strings.TrimSpace(name), column) {
				return true, nil
			}
		}
		return false, rows.Err()
	})
}

func (r *NewAPITokenReader) hasTable(ctx context.Context, table string) bool {
	if r == nil || r.db == nil || strings.TrimSpace(table) == "" {
		return false
	}
	key := "table:" + strings.ToLower(strings.TrimSpace(table))
	return r.cachedSchemaPresence(key, func() (bool, error) {
		var exists int
		query := "SELECT 1 FROM information_schema.tables WHERE table_name = " + r.placeholder(1) + " LIMIT 1"
		arguments := []any{table}
		if r.driver == "sqlite" {
			query = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
		}
		err := r.db.QueryRowContext(ctx, query, arguments...).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return err == nil, err
	})
}

func (r *NewAPITokenReader) cachedSchemaPresence(key string, load func() (bool, error)) bool {
	if r == nil || load == nil {
		return false
	}
	now := time.Now()
	r.schemaCacheMu.RLock()
	entry, ok := r.schemaPresenceCache[key]
	r.schemaCacheMu.RUnlock()
	if ok && entry.expiresAt.After(now) {
		return entry.present
	}
	present, err := load()
	if err != nil {
		return false
	}
	r.schemaCacheMu.Lock()
	if r.schemaPresenceCache == nil {
		r.schemaPresenceCache = make(map[string]newAPISchemaPresenceCacheEntry)
	}
	r.schemaPresenceCache[key] = newAPISchemaPresenceCacheEntry{present: present, expiresAt: now.Add(newAPISchemaPresenceCacheTTL)}
	r.schemaCacheMu.Unlock()
	return present
}

func (r *NewAPITokenReader) activeUserPredicate() string {
	if r.IsSub2API() {
		return "status = 'active'"
	}
	return "status = 1"
}

func (r *NewAPITokenReader) lookupSub2APITokenCandidates(ctx context.Context, userID int64) ([]newAPITokenCandidate, error) {
	query := "SELECT ak.id, ak.key, ak.name, g.name, '' FROM api_keys ak JOIN groups g ON g.id = ak.group_id AND g.status = 'active' AND g.deleted_at IS NULL WHERE ak.user_id = " + r.placeholder(1) +
		" AND ak.status = 'active' AND ak.deleted_at IS NULL AND ak.key <> '' AND (ak.expires_at IS NULL OR ak.expires_at >= " + r.placeholder(2) + ") AND (ak.quota <= 0 OR ak.quota_used < ak.quota) ORDER BY ak.id ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, time.Now().UTC())
	if err != nil {
		return nil, newAPITokenMessageError("读取 Sub2API 令牌失败，请检查数据库连接", err)
	}
	defer rows.Close()
	var out []newAPITokenCandidate
	for rows.Next() {
		var candidate newAPITokenCandidate
		var key, name, group, route sql.NullString
		if err := rows.Scan(&candidate.ID, &key, &name, &group, &route); err != nil {
			return nil, newAPITokenMessageError("读取 Sub2API 令牌失败，请检查数据库连接", err)
		}
		candidate.Key, candidate.Name, candidate.Group = strings.TrimSpace(key.String), strings.TrimSpace(name.String), strings.TrimSpace(group.String)
		if candidate.Key != "" && candidate.Name != "" && candidate.Group != "" {
			out = append(out, candidate)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, newAPITokenMessageError("读取 Sub2API 令牌失败，请检查数据库连接", err)
	}
	return out, nil
}

func (r *NewAPITokenReader) lookupSub2APIUserBalance(ctx context.Context, candidates []string) (NewAPIUserBalance, error) {
	query := "SELECT id, username, email, balance FROM users WHERE (username = " + r.placeholder(1) + " OR email = " + r.placeholder(2) + ") AND status = 'active' AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
	for _, candidate := range candidates {
		balance, err := r.scanSub2APIUserBalance(ctx, r.db.QueryRowContext(ctx, query, candidate, candidate))
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return NewAPIUserBalance{}, newAPITokenMessageError("读取 Sub2API 余额失败，请检查数据库连接", err)
		}
		return balance, nil
	}
	return NewAPIUserBalance{}, newAPITokenMessageError("请先在 Sub2API 创建当前登录用户", nil)
}

func (r *NewAPITokenReader) lookupSub2APIUserBalanceByID(ctx context.Context, userID int64) (NewAPIUserBalance, error) {
	query := "SELECT id, username, email, balance FROM users WHERE id = " + r.placeholder(1) + " AND status = 'active' AND deleted_at IS NULL LIMIT 1"
	balance, err := r.scanSub2APIUserBalance(ctx, r.db.QueryRowContext(ctx, query, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return NewAPIUserBalance{}, newAPITokenMessageError(fmt.Sprintf("Sub2API 用户 ID %d 不存在或已停用，请重新登录", userID), nil)
	}
	if err != nil {
		return NewAPIUserBalance{}, newAPITokenMessageError("读取 Sub2API 余额失败，请检查数据库连接", err)
	}
	return balance, nil
}

func (r *NewAPITokenReader) scanSub2APIUserBalance(ctx context.Context, row *sql.Row) (NewAPIUserBalance, error) {
	var balance NewAPIUserBalance
	var email, username sql.NullString
	var amount sql.NullFloat64
	if err := row.Scan(&balance.ID, &username, &email, &amount); err != nil {
		return NewAPIUserBalance{}, err
	}
	balance.Username = strings.TrimSpace(username.String)
	balance.Email = strings.TrimSpace(email.String)
	balance.DisplayName = balance.Username
	if balance.Username == "" {
		balance.Username = balance.Email
		balance.DisplayName = balance.Email
	}
	balance.Quota = amount.Float64 * 500000
	balance.UsedQuota, balance.RequestCount = r.lookupSub2APIUsage(ctx, balance.ID)
	return balance, nil
}

func (r *NewAPITokenReader) lookupSub2APIUsage(ctx context.Context, userID int64) (float64, int64) {
	if !r.hasTable(ctx, "usage_logs") {
		return 0, 0
	}
	var used float64
	var count int64
	query := "SELECT COALESCE(SUM(actual_cost), 0), COUNT(*) FROM usage_logs WHERE user_id = " + r.placeholder(1)
	if err := r.db.QueryRowContext(ctx, query, userID).Scan(&used, &count); err != nil {
		return 0, 0
	}
	return used * 500000, count
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

func newAPITokenCandidateGroups(candidate newAPITokenCandidate, userGroup string) ([]string, bool) {
	routeConfig := strings.TrimSpace(candidate.GroupRouteConfig)
	if routeConfig != "" {
		var routes []newAPITokenGroupRoute
		if err := json.Unmarshal([]byte(routeConfig), &routes); err != nil || len(routes) == 0 {
			return nil, false
		}
		seen := map[string]struct{}{}
		groups := make([]string, 0, len(routes))
		for _, route := range routes {
			group := strings.TrimSpace(route.Group)
			if group == "" || route.Priority < 0 || route.CooldownSeconds <= 0 || route.CooldownSeconds > newAPITokenRouteMaxCooldownSecond {
				return nil, false
			}
			if _, exists := seen[group]; exists {
				return nil, false
			}
			seen[group] = struct{}{}
			if route.Enabled != nil && !*route.Enabled {
				continue
			}
			if group == "auto" {
				return nil, false
			}
			groups = append(groups, group)
		}
		return groups, len(groups) > 0
	}

	group := strings.TrimSpace(candidate.Group)
	if group == "auto" {
		return nil, false
	}
	if group == "" {
		group = strings.TrimSpace(userGroup)
	}
	if group == "" || group == "auto" {
		return nil, false
	}
	return []string{group}, true
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

func (r *NewAPITokenReader) identityUserID(identity Identity) (int64, bool) {
	prefix := r.Source() + ":"
	for _, value := range []string{identity.OwnerID, identity.ID} {
		value = strings.TrimSpace(value)
		if !strings.HasPrefix(value, prefix) {
			continue
		}
		userID, err := strconv.ParseInt(strings.TrimPrefix(value, prefix), 10, 64)
		if err == nil && userID > 0 {
			return userID, true
		}
	}
	return 0, false
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

func (r *NewAPITokenReader) normalizeRelayKey(key string) string {
	key = strings.TrimSpace(key)
	if r.IsSub2API() || key == "" || strings.HasPrefix(key, "sk-") {
		return key
	}
	return "sk-" + key
}

func previewRelayKey(key string) string {
	key = strings.TrimSpace(key)
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
