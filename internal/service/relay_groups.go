package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// CreationGroups reads configured groups, independently of existing user tokens.
func (r *NewAPITokenReader) CreationGroups(ctx context.Context) ([]string, error) {
	groups := []string{}
	if r == nil || !r.configured || r.db == nil {
		return groups, newAPITokenMessageError("请先配置并保存上游数据库连接", nil)
	}
	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	if r.IsSub2API() {
		rows, err := r.db.QueryContext(queryCtx, "SELECT name FROM groups WHERE status = 'active' AND deleted_at IS NULL ORDER BY name")
		if err != nil {
			return nil, newAPITokenMessageError("读取上游数据库分组失败", err)
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return nil, newAPITokenMessageError("读取上游数据库分组失败", err)
			}
			groups = append(groups, name)
		}
		if err := rows.Err(); err != nil {
			return nil, newAPITokenMessageError("读取上游数据库分组失败", err)
		}
	} else {
		var raw sql.NullString
		query := "SELECT " + r.quoteIdentifier("value") + " FROM options WHERE " + r.quoteIdentifier("key") + " = " + r.placeholder(1)
		err := r.db.QueryRowContext(queryCtx, query, "GroupRatio").Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return groups, nil
		}
		if err != nil {
			return nil, newAPITokenMessageError("读取上游数据库分组失败", err)
		}
		var ratios map[string]float64
		if err := json.Unmarshal([]byte(raw.String), &ratios); err != nil || ratios == nil {
			return nil, newAPITokenMessageError("上游数据库 GroupRatio 分组配置无效", err)
		}
		for name := range ratios {
			groups = append(groups, name)
		}
	}
	seen := make(map[string]bool)
	result := []string{}
	for _, name := range groups {
		if strings.TrimSpace(name) == "" || name == "<nil>" || (!r.IsSub2API() && name == "auto") || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, name)
	}
	sort.Strings(result)
	return result, nil
}
