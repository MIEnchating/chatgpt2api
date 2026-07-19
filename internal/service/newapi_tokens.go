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
)

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
	_ = ctx
	if r == nil {
		return nil
	}
	group := r.configuredGroup()
	if group == "" {
		return nil
	}
	return []string{group}
}

func (r *NewAPITokenReader) StatusForGroup(ctx context.Context, identity Identity, group string) map[string]any {
	return r.StatusForGroupAndName(ctx, identity, group, "")
}

func (r *NewAPITokenReader) StatusForGroupAndName(ctx context.Context, identity Identity, group, name string) map[string]any {
	configuredGroup := r.configuredGroup()
	selectedGroup := firstNonEmptyNewAPIString(group, configuredGroup)
	selectedName := strings.TrimSpace(name)
	status := map[string]any{
		"has_key":          false,
		"key_preview":      "",
		"group":            selectedGroup,
		"token_name":       selectedName,
		"configured_group": configuredGroup,
		"groups":           []string{},
		"token_names":      []string{},
		"source":           "newapi",
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
	return r.lookupUserBalanceForIdentity(queryCtx, identity, candidates)
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

func (r *NewAPITokenReader) lookupUserIDForIdentity(ctx context.Context, identity Identity, candidates []string, group string) (int64, error) {
	if userID, ok := newAPIIdentityUserID(identity); ok {
		query := "SELECT id FROM users WHERE id = " + r.placeholder(1) + " AND status = 1 AND deleted_at IS NULL LIMIT 1"
		var id int64
		err := r.db.QueryRowContext(ctx, query, userID).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return 0, newAPITokenMessageError("读取云棉 Key 失败，请检查云棉数据库连接", err)
		}
		return 0, newAPITokenMessageError(fmt.Sprintf("云棉用户 ID %d 不存在或已停用，请重新登录", userID), nil)
	}
	return r.lookupUserID(ctx, candidates, group)
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

func (r *NewAPITokenReader) lookupUserBalanceForIdentity(ctx context.Context, identity Identity, candidates []string) (NewAPIUserBalance, error) {
	if userID, ok := newAPIIdentityUserID(identity); ok {
		groupColumn := r.quoteIdentifier("group")
		query := "SELECT id, username, email, display_name, quota, used_quota, request_count, " + groupColumn + " FROM users WHERE id = " + r.placeholder(1) + " AND status = 1 AND deleted_at IS NULL LIMIT 1"
		var balance NewAPIUserBalance
		var email, displayName, group sql.NullString
		var quota, usedQuota, requestCount sql.NullInt64
		err := r.db.QueryRowContext(ctx, query, userID).Scan(&balance.ID, &balance.Username, &email, &displayName, &quota, &usedQuota, &requestCount, &group)
		if errors.Is(err, sql.ErrNoRows) {
			return NewAPIUserBalance{}, newAPITokenMessageError(fmt.Sprintf("云棉用户 ID %d 不存在或已停用，请重新登录", userID), nil)
		}
		if err != nil {
			return NewAPIUserBalance{}, newAPITokenMessageError("读取云棉余额失败，请检查云棉数据库连接", err)
		}
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
	return r.lookupUserBalance(ctx, candidates)
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
		preferredGroup := firstNonEmptyNewAPIString(requestedGroup, r.configuredGroup())
		selection.Group = preferredGroup
		return selection, newAPITokenMessageError("请先在云棉为当前用户创建名称和 Key 均非空的可用令牌", nil)
	}

	if requestedName != "" {
		matched := candidatesByName[requestedName]
		switch len(matched) {
		case 0:
			return selection, newAPITokenMessageError(fmt.Sprintf("当前用户没有名为“%s”的可用令牌，可用令牌：%s", requestedName, strings.Join(names, ", ")), nil)
		case 1:
			selected := matched[0]
			selection.Key = normalizeNewAPIKey(selected.Key)
			selection.Name = selected.Name
			selection.Group = newAPITokenCandidateGroupMetadata(selected, userGroup)
			return selection, nil
		default:
			return selection, newAPITokenMessageError(fmt.Sprintf("当前用户存在 %d 个名为“%s”的可用令牌，无法唯一选择，请在云棉中重命名后重试", len(matched), requestedName), nil)
		}
	}

	if len(groups) == 0 {
		preferredGroup := firstNonEmptyNewAPIString(requestedGroup, r.configuredGroup())
		selection.Group = preferredGroup
		if preferredGroup != "" {
			return selection, newAPITokenMessageError(fmt.Sprintf("请先在云棉为当前用户创建仅使用“%s”分组的可用令牌", preferredGroup), nil)
		}
		return selection, newAPITokenMessageError("请先在云棉为当前用户创建仅使用单一分组的可用令牌", nil)
	}

	selectedGroup := requestedGroup
	if selectedGroup != "" {
		if _, ok := firstCandidateByGroup[selectedGroup]; !ok {
			return selection, newAPITokenMessageError(fmt.Sprintf("当前用户没有“%s”分组的安全可用令牌，可用分组：%s", selectedGroup, strings.Join(groups, ", ")), nil)
		}
	} else {
		configuredGroup := r.configuredGroup()
		if _, ok := firstCandidateByGroup[configuredGroup]; ok && configuredGroup != "" {
			selectedGroup = configuredGroup
		} else {
			selectedGroup = groups[0]
		}
	}

	selection.Group = selectedGroup
	selected := firstCandidateByGroup[selectedGroup]
	selection.Key = normalizeNewAPIKey(selected.Key)
	selection.Name = selected.Name
	return selection, nil
}

func (r *NewAPITokenReader) lookupTokenCandidates(ctx context.Context, userID int64) ([]newAPITokenCandidate, error) {
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
		return nil, newAPITokenMessageError("读取云棉令牌失败，请检查云棉数据库连接", err)
	}
	defer rows.Close()

	candidates := make([]newAPITokenCandidate, 0)
	for rows.Next() {
		var candidate newAPITokenCandidate
		var key, name, group, routeConfig sql.NullString
		if err := rows.Scan(&candidate.ID, &key, &name, &group, &routeConfig); err != nil {
			return nil, newAPITokenMessageError("读取云棉令牌失败，请检查云棉数据库连接", err)
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
		return nil, newAPITokenMessageError("读取云棉令牌失败，请检查云棉数据库连接", err)
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
	groupColumn := r.quoteIdentifier("group")
	query := "SELECT " + groupColumn + " FROM users WHERE id = " + r.placeholder(1) + " AND status = 1 AND deleted_at IS NULL LIMIT 1"
	var group sql.NullString
	err := r.db.QueryRowContext(ctx, query, userID).Scan(&group)
	if errors.Is(err, sql.ErrNoRows) {
		return "", newAPITokenMessageError("当前云棉用户不存在或已停用，请重新登录", nil)
	}
	if err != nil {
		return "", newAPITokenMessageError("读取云棉用户分组失败，请检查云棉数据库连接", err)
	}
	return strings.TrimSpace(group.String), nil
}

func (r *NewAPITokenReader) newAPIAdminSelectExpression(ctx context.Context) string {
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

func firstNonEmptyNewAPIString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
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

func newAPIIdentityUserID(identity Identity) (int64, bool) {
	for _, value := range []string{identity.OwnerID, identity.ID} {
		value = strings.TrimSpace(value)
		if !strings.HasPrefix(value, "newapi:") {
			continue
		}
		userID, err := strconv.ParseInt(strings.TrimPrefix(value, "newapi:"), 10, 64)
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
