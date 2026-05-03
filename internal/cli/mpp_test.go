package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseMppxIncludeOutput(t *testing.T) {
	raw := strings.Join([]string{
		"HTTP/1.1 201 Created",
		"Content-Type: application/json",
		"Payment-Receipt: stub",
		"",
		`{"lease":{"id":"cbx_xx"}}`,
	}, "\r\n")
	status, body, err := parseMppxIncludeOutput([]byte(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if status != 201 {
		t.Fatalf("status = %d", status)
	}
	if !strings.Contains(string(body), "cbx_xx") {
		t.Fatalf("body = %q", body)
	}
}

func TestParseMppxIncludeOutputMissingBlankLine(t *testing.T) {
	if _, _, err := parseMppxIncludeOutput([]byte("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nbody-no-blank")); err == nil {
		t.Fatalf("expected error for missing header/body separator")
	}
}

func TestMppxOptIn(t *testing.T) {
	t.Setenv("CRABBOX_MPP_PAY", "")
	if mppxOptIn() {
		t.Fatalf("expected off when env unset")
	}
	t.Setenv("CRABBOX_MPP_PAY", "auto")
	if !mppxOptIn() {
		t.Fatalf("expected on for auto")
	}
}

// TestRetryWithMPPX_StubBinary writes a fake `mppx` binary to a temp dir,
// puts it on PATH, then verifies that retryWithMPPX shells out, parses the
// stub's HTTP-style stdout, and decodes the lease+bearer payload.
func TestRetryWithMPPX_StubBinary(t *testing.T) {
	dir := t.TempDir()
	stubPath := filepath.Join(dir, "mppx")
	leaseJSON := `{"lease":{"id":"cbx_stub00000001","provider":"hetzner","host":"192.0.2.10","sshUser":"crabbox","sshPort":"2222"},"bearer":"cbxu_stub-bearer-token"}`
	stub := fmt.Sprintf(`#!/usr/bin/env bash
echo $@ > "%s/mppx-args"
printf 'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n'
printf '%%s' '%s'
`, dir, leaseJSON)
	if err := os.WriteFile(stubPath, []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CRABBOX_MPP_PAY", "auto")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("WWW-Authenticate", `Payment id="x", realm="test", method="tempo", intent="charge"`)
		http.Error(w, "payment required", http.StatusPaymentRequired)
	}))
	defer server.Close()
	client := &CoordinatorClient{BaseURL: server.URL, Client: server.Client()}
	originalErr := &coordinatorHTTPError{Method: http.MethodPost, Path: "/v1/leases", Status: 402, Body: "payment required"}

	var res CoordinatorLeaseResponse
	body := []byte(`{"leaseID":"cbx_stub00000001"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := retryWithMPPX(ctx, client, "/v1/leases", body, originalErr, &res); err != nil {
		t.Fatalf("retryWithMPPX: %v", err)
	}
	if res.Lease.ID != "cbx_stub00000001" {
		t.Fatalf("lease.ID = %q", res.Lease.ID)
	}
	if res.Bearer != "cbxu_stub-bearer-token" {
		t.Fatalf("bearer = %q", res.Bearer)
	}
	args, err := os.ReadFile(filepath.Join(dir, "mppx-args"))
	if err != nil {
		t.Fatalf("stub args file missing: %v", err)
	}
	if !strings.Contains(string(args), server.URL+"/v1/leases") {
		t.Fatalf("mppx args missing url: %q", args)
	}
	if !strings.Contains(string(args), "-X POST") {
		t.Fatalf("mppx args missing method: %q", args)
	}
	if !strings.Contains(string(args), "-J ") {
		t.Fatalf("mppx args missing json body flag: %q", args)
	}
}

// TestRetryWithMPPX_NotApplicable confirms we don't retry when the original
// error is not a 402 or when the user hasn't opted in.
func TestRetryWithMPPX_NotApplicable(t *testing.T) {
	t.Setenv("CRABBOX_MPP_PAY", "")
	original := &coordinatorHTTPError{Status: 402}
	err := retryWithMPPX(context.Background(), nil, "/v1/leases", nil, original, nil)
	if !errors.Is(err, errMppxNotApplicable) {
		t.Fatalf("err = %v, want errMppxNotApplicable", err)
	}

	t.Setenv("CRABBOX_MPP_PAY", "auto")
	original500 := &coordinatorHTTPError{Status: 500}
	err = retryWithMPPX(context.Background(), nil, "/v1/leases", nil, original500, nil)
	if !errors.Is(err, errMppxNotApplicable) {
		t.Fatalf("err = %v, want errMppxNotApplicable", err)
	}
}
