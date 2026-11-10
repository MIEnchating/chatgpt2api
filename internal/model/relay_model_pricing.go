package model

type RelayModelPriceRate struct {
	Label  string  `json:"label"`
	Amount float64 `json:"amount"`
	Unit   string  `json:"unit"`
}

type RelayModelPricing struct {
	Group      string                `json:"group,omitempty"`
	GroupRatio *float64              `json:"group_ratio,omitempty"`
	Reference  bool                  `json:"reference,omitempty"`
	Currency   string                `json:"currency"`
	Mode       string                `json:"mode"`
	Rates      []RelayModelPriceRate `json:"rates"`
}
