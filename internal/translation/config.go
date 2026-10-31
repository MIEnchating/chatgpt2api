// Package translation evaluates channel request rules without exposing host APIs.
package translation

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/parser"
)

const MaxSourceBytes = 128 << 10

// MaxValueBytes bounds any value serialized out of the rule VM. goja has no memory limit API, so the
// VM itself is only bounded by the call stack limit, the one second execution limit and MaxSourceBytes;
// this check stops an oversized result from being copied into Go memory and used.
const MaxValueBytes = 32 << 20

var methods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}

// Programs compiles models separately so only the selected rule needs inputs.
func Programs(source string) (map[string]*goja.Program, error) {
	result := map[string]*goja.Program{}
	if strings.TrimSpace(source) == "" {
		return result, nil
	}
	if len(source) > MaxSourceBytes {
		return nil, fmt.Errorf("转换配置不能超过 128 KiB")
	}
	code := "(" + source + "\n)"
	tree, err := parser.ParseFile(nil, "channel-rules", code, 0)
	if err != nil {
		return nil, fmt.Errorf("转换配置语法错误：%w", err)
	}
	if len(tree.Body) != 1 {
		return nil, fmt.Errorf("转换配置必须是对象")
	}
	statement, ok := tree.Body[0].(*ast.ExpressionStatement)
	if !ok {
		return nil, fmt.Errorf("转换配置必须是对象")
	}
	root, err := properties(statement.Expression)
	if err != nil {
		return nil, err
	}
	for name := range root {
		if name != "models" && name != "headers" && name != "poll" {
			return nil, fmt.Errorf("未知配置字段 %s", name)
		}
	}
	models, err := properties(root["models"])
	if err != nil {
		return nil, fmt.Errorf("models 必须是按模型名称索引的对象：%w", err)
	}
	fragment := func(expr ast.Expression, empty string) string {
		if expr == nil {
			return empty
		}
		return code[int(expr.Idx0())-1 : int(expr.Idx1())-1]
	}
	for name, expr := range models {
		fields, err := properties(expr)
		if err != nil || strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("模型 %q 必须配置对象", name)
		}
		if len(fields) == 0 {
			continue
		}
		requests := 0
		for key := range fields {
			switch key {
			case "result", "error", "poll":
				continue
			}
			found := false
			for _, method := range methods {
				if key == method {
					found = true
					requests++
				}
			}
			if !found {
				return nil, fmt.Errorf("模型 %s 的未知字段 %s", name, key)
			}
		}
		if requests != 1 {
			return nil, fmt.Errorf("模型 %s 必须配置一种请求方法", name)
		}
		for _, method := range methods {
			if fields[method] != nil {
				request, err := properties(fields[method])
				if err != nil {
					return nil, err
				}
				if request["url"] == nil {
					return nil, fmt.Errorf("模型 %s 的请求缺少 url", name)
				}
				if flag := request["crossOrigin"]; flag != nil {
					if _, ok := flag.(*ast.BooleanLiteral); !ok {
						return nil, fmt.Errorf("模型 %s 的 crossOrigin 必须是布尔字面量", name)
					}
				}
			}
		}
		for _, poll := range []ast.Expression{root["poll"], fields["poll"]} {
			if poll == nil {
				continue
			}
			if flag, ok := poll.(*ast.BooleanLiteral); ok && !flag.Value {
				continue
			}
			if _, err := properties(poll); err != nil {
				return nil, fmt.Errorf("poll 必须是对象或 false")
			}
		}
		program, err := goja.Compile("channel-rules", "({headers:"+fragment(root["headers"], "{}")+",poll:"+fragment(root["poll"], "false")+",rule:"+fragment(expr, "{}")+"})", true)
		if err != nil {
			return nil, err
		}
		result[name] = program
	}
	return result, nil
}

func Models(source string) ([]string, error) {
	programs, err := Programs(source)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(programs))
	for name := range programs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func properties(expr ast.Expression) (map[string]ast.Expression, error) {
	obj, ok := expr.(*ast.ObjectLiteral)
	if !ok {
		return nil, fmt.Errorf("配置必须使用对象字面量")
	}
	out := map[string]ast.Expression{}
	for _, entry := range obj.Value {
		field, ok := entry.(*ast.PropertyKeyed)
		if !ok || field.Computed || field.Kind != ast.PropertyKindValue {
			return nil, fmt.Errorf("配置键必须是静态名称")
		}
		var key string
		switch v := field.Key.(type) {
		case *ast.Identifier:
			key = v.Name.String()
		case *ast.StringLiteral:
			key = v.Value.String()
		default:
			return nil, fmt.Errorf("无效配置键")
		}
		if _, ok := out[key]; ok {
			return nil, fmt.Errorf("配置键 %s 重复", key)
		}
		out[key] = field.Value
	}
	return out, nil
}

func limited(vm *goja.Runtime, work func() error) (err error) {
	done := make(chan struct{})
	timer := time.AfterFunc(time.Second, func() { vm.Interrupt("转换表达式执行超时"); close(done) })
	defer func() {
		if !timer.Stop() {
			<-done
		}
		vm.ClearInterrupt()
	}()
	if exception := vm.Try(func() { err = work() }); exception != nil {
		return exception
	}
	return err
}

func plain(vm *goja.Runtime, value goja.Value, target any) error {
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return nil
	}
	stringify, ok := goja.AssertFunction(vm.Get("JSON").ToObject(vm).Get("stringify"))
	if !ok {
		return fmt.Errorf("配置不能替换 JSON.stringify")
	}
	encoded, err := stringify(goja.Undefined(), value)
	if err != nil {
		return err
	}
	if goja.IsUndefined(encoded) {
		return fmt.Errorf("配置值必须可序列化")
	}
	text := encoded.String()
	if len(text) > MaxValueBytes {
		return fmt.Errorf("转换结果超过 %d MiB", MaxValueBytes>>20)
	}
	return json.Unmarshal([]byte(text), target)
}
