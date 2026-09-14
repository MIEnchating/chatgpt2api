package config

import (
	"net/url"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func TestStoreLoginImageNumbersSurviveJSONUpdateAndReload(t *testing.T) {
	t.Setenv("ROOT_DIR", t.TempDir())
	for _, envKey := range settingEnvKeys {
		unsetEnv(t, envKey)
	}
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	var update map[string]any
	if err := util.DecodeJSON(strings.NewReader(`{"login_page_image_zoom":2.25,"login_page_image_position_x":12.5,"login_page_image_position_y":87.5}`), &update); err != nil {
		t.Fatal(err)
	}
	result, err := store.Update(update)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	for _, got := range []map[string]any{result, store.Get(), reloaded.Get()} {
		for key, want := range map[string]float64{
			"login_page_image_zoom": 2.25, "login_page_image_position_x": 12.5, "login_page_image_position_y": 87.5,
		} {
			if got[key] != want {
				t.Errorf("%s = %v, want %v", key, got[key], want)
			}
		}
	}
}

func TestStructuredRelayDatabaseURLPreservesIPv6Host(t *testing.T) {
	for _, driver := range []string{"postgres", "mysql"} {
		for _, host := range []string{"2001:db8::1", "::1", "fe80::1%eth0"} {
			t.Run(driver+"/"+host, func(t *testing.T) {
				raw := buildRelayDatabaseConnectionURL(driver, host, "5433", "app", "reader", "password", "")
				parsed, err := url.Parse(raw)
				if err != nil {
					t.Fatal(err)
				}
				if parsed.Hostname() != host || parsed.Port() != "5433" {
					t.Fatalf("parsed connection address = %q, want host %q and port 5433", parsed.Host, host)
				}
			})
		}
	}
}
