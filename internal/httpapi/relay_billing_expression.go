package httpapi

import (
	"fmt"
	"math"
	"strings"

	"chatgpt2api/internal/model"

	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
)

// Only display a breakdown when the complete expression has a known meaning.
func parseRelayBillingExpression(expression string, rawSchema any) ([]model.RelayModelPriceRate, bool) {
	if len(expression) == 0 || len(expression) > 4096 {
		return nil, false
	}
	if strings.HasPrefix(expression, "v1:") {
		expression = strings.TrimPrefix(expression, "v1:")
	}
	tree, err := parser.Parse(expression)
	if err != nil {
		return nil, false
	}
	schema, _ := rawSchema.(map[string]any)
	var rates []model.RelayModelPriceRate
	var parseBranch func(ast.Node, []string, int) bool
	parseBranch = func(node ast.Node, previous []string, depth int) bool {
		if depth > 16 || len(rates) > 100 {
			return false
		}
		if conditional, ok := node.(*ast.ConditionalNode); ok {
			condition, ok := relayBillingCondition(conditional.Cond, schema)
			if !ok {
				return false
			}
			return parseBranch(conditional.Exp1, append(append([]string{}, previous...), condition), depth+1) &&
				parseBranch(conditional.Exp2, append(append([]string{}, previous...), "非("+condition+")"), depth+1)
		}
		args, ok := relayBillingCall(node, "tier", 2)
		if !ok {
			return false
		}
		name, ok := args[0].(*ast.StringNode)
		if !ok || len(name.Value) > 100 {
			return false
		}
		prefix := strings.Join(previous, " 且 ")
		if prefix == "" {
			prefix = name.Value
		}
		var parseTerms func(ast.Node) bool
		parseTerms = func(term ast.Node) bool {
			if binary, ok := term.(*ast.BinaryNode); ok && binary.Operator == "+" {
				if len(schema) == 0 && (relayBillingContainsFixed(binary.Left) || relayBillingContainsFixed(binary.Right)) {
					return false
				}
				return parseTerms(binary.Left) && parseTerms(binary.Right)
			}
			label, unit, amount, ok := relayBillingTerm(term, schema)
			if !ok || len(rates) >= 100 {
				return false
			}
			if prefix != "" && label != "" {
				label = prefix + " · " + label
			} else if prefix != "" {
				label = prefix
			}
			rates = append(rates, model.RelayModelPriceRate{Label: label, Unit: unit, Amount: amount})
			return true
		}
		return parseTerms(args[1])
	}
	if !parseBranch(tree.Node, nil, 0) || len(rates) == 0 {
		return nil, false
	}
	return rates, true
}

func relayBillingContainsFixed(node ast.Node) bool {
	if _, ok := relayBillingCall(node, "fixed", 1); ok {
		return true
	}
	if binary, ok := node.(*ast.BinaryNode); ok {
		return relayBillingContainsFixed(binary.Left) || relayBillingContainsFixed(binary.Right)
	}
	return false
}

func relayBillingCall(node ast.Node, name string, count int) ([]ast.Node, bool) {
	call, ok := node.(*ast.CallNode)
	if !ok || len(call.Arguments) != count {
		return nil, false
	}
	id, ok := call.Callee.(*ast.IdentifierNode)
	return call.Arguments, ok && id.Value == name
}

func relayBillingNumber(node ast.Node) (float64, bool) {
	var n float64
	switch value := node.(type) {
	case *ast.IntegerNode:
		n = float64(value.Value)
	case *ast.FloatNode:
		n = value.Value
	default:
		return 0, false
	}
	return n, n >= 0 && !math.IsNaN(n) && !math.IsInf(n, 0)
}

func relayBillingUsage(node ast.Node) (string, bool) {
	args, ok := relayBillingCall(node, "u", 1)
	if !ok {
		return "", false
	}
	key, ok := args[0].(*ast.StringNode)
	if !ok || key.Value == "" || len(key.Value) > 100 {
		return "", false
	}
	return key.Value, true
}

func relayBillingCondition(node ast.Node, schema map[string]any) (string, bool) {
	binary, ok := node.(*ast.BinaryNode)
	if !ok {
		return "", false
	}
	if binary.Operator == "&&" {
		left, leftOK := relayBillingCondition(binary.Left, schema)
		right, rightOK := relayBillingCondition(binary.Right, schema)
		return left + " 且 " + right, leftOK && rightOK
	}
	if binary.Operator != "==" {
		return "", false
	}
	key, ok := relayBillingUsage(binary.Left)
	value, valueOK := binary.Right.(*ast.StringNode)
	field, fieldOK := schema[key].(map[string]any)
	if !ok || !valueOK || !fieldOK || len(value.Value) > 100 {
		return "", false
	}
	values, ok := field["enum"].([]any)
	if !ok {
		return "", false
	}
	for _, item := range values {
		if item == value.Value {
			return fmt.Sprintf("%s = %s", key, value.Value), true
		}
	}
	return "", false
}

func relayBillingTerm(node ast.Node, schema map[string]any) (string, string, float64, bool) {
	if args, ok := relayBillingCall(node, "fixed", 1); ok {
		n, valid := relayBillingNumber(args[0])
		return "", "request", n, valid && len(schema) == 0
	}
	if n, ok := relayBillingNumber(node); ok {
		return "", "request", n, len(schema) > 0
	}
	binary, ok := node.(*ast.BinaryNode)
	if !ok {
		return "", "", 0, false
	}
	scaled := false
	if binary.Operator == "/" {
		divisor, valid := relayBillingNumber(binary.Right)
		if !valid || divisor != 1000000 {
			return "", "", 0, false
		}
		binary, ok = binary.Left.(*ast.BinaryNode)
		if !ok {
			return "", "", 0, false
		}
		scaled = true
	}
	if binary.Operator != "*" {
		return "", "", 0, false
	}
	amount, valid := relayBillingNumber(binary.Right)
	if !valid {
		return "", "", 0, false
	}
	if id, ok := binary.Left.(*ast.IdentifierNode); ok && len(schema) == 0 && !scaled {
		labels := map[string]string{"p": "输入", "c": "输出", "cr": "缓存读取", "cc": "缓存写入", "cc1h": "缓存写入（1小时）", "img": "图片输入", "ai": "音频输入", "ao": "音频输出"}
		label, ok := labels[id.Value]
		return label, "million_tokens", amount, ok
	}
	key, ok := relayBillingUsage(binary.Left)
	field, fieldOK := schema[key].(map[string]any)
	if !ok || !fieldOK || field["type"] != "number" {
		return "", "", 0, false
	}
	unit, _ := field["unit"].(string)
	switch unit {
	case "second":
		if scaled {
			return "", "", 0, false
		}
		return key, "second", amount, true
	case "count", "credit":
		if scaled {
			return "", "", 0, false
		}
		return key, unit, amount, true
	case "token":
		if !scaled {
			return "", "", 0, false
		}
		return key, "million_tokens", amount, true
	}
	return "", "", 0, false
}
