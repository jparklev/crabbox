package cli

import (
	"testing"
	"time"
)

func TestShouldCleanupServerSkipsRunningAndProvisioningStates(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	for _, state := range []string{"running", "provisioning"} {
		server := Server{Labels: map[string]string{
			"keep":       "false",
			"state":      state,
			"expires_at": now.Add(-time.Hour).Format(time.RFC3339),
		}}
		if ok, reason := shouldCleanupServer(server, now); ok {
			t.Fatalf("shouldCleanupServer state=%s=%v, %s; want skip", state, ok, reason)
		}
	}
}

func TestShouldCleanupServerDeletesExpiredIdleStates(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	for _, state := range []string{"leased", "ready", "active"} {
		server := Server{Labels: map[string]string{
			"keep":       "false",
			"state":      state,
			"expires_at": now.Add(-time.Minute).Format(time.RFC3339),
		}}
		if ok, reason := shouldCleanupServer(server, now); !ok {
			t.Fatalf("shouldCleanupServer state=%s=%v, %s; want delete", state, ok, reason)
		}
	}
}

func TestShouldCleanupServerDeletesStaleRunningStates(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	server := Server{Labels: map[string]string{
		"keep":       "false",
		"state":      "running",
		"expires_at": now.Add(-13 * time.Hour).Format(time.RFC3339),
	}}
	if ok, reason := shouldCleanupServer(server, now); !ok {
		t.Fatalf("shouldCleanupServer=%v, %s; want delete", ok, reason)
	}
}

func TestShouldCleanupServerDeletesExpiredInactive(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	server := Server{Labels: map[string]string{
		"keep":       "false",
		"expires_at": now.Add(-time.Minute).Format(time.RFC3339),
	}}
	if ok, reason := shouldCleanupServer(server, now); !ok {
		t.Fatalf("shouldCleanupServer=%v, %s; want delete", ok, reason)
	}
}

func TestShouldCleanupServerKeepsUnexpiredAndKept(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	tests := []Server{
		{Labels: map[string]string{"keep": "true", "expires_at": now.Add(-time.Hour).Format(time.RFC3339)}},
		{Labels: map[string]string{"keep": "false", "expires_at": now.Add(time.Hour).Format(time.RFC3339)}},
		{Labels: map[string]string{"keep": "false"}},
	}
	for _, server := range tests {
		if ok, reason := shouldCleanupServer(server, now); ok {
			t.Fatalf("shouldCleanupServer=%v, %s; want skip", ok, reason)
		}
	}
}

func TestDirectLeaseExpiresAtUsesTTLAsCap(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	cfg := Config{TTL: 10 * time.Minute, IdleTimeout: 2 * time.Hour}
	if got := directLeaseExpiresAt(now, cfg); !got.Equal(now.Add(10 * time.Minute)) {
		t.Fatalf("expires_at=%s want TTL cap", got)
	}
	cfg = Config{TTL: 90 * time.Minute, IdleTimeout: 30 * time.Minute}
	if got := directLeaseExpiresAt(now, cfg); !got.Equal(now.Add(30 * time.Minute)) {
		t.Fatalf("expires_at=%s want idle timeout", got)
	}
}

func TestCoordinatorMachineOrphanField(t *testing.T) {
	active := activeCoordinatorLeaseIDs([]CoordinatorLease{{ID: "cbx_active"}})
	tests := map[string]struct {
		labels map[string]string
		want   string
	}{
		"active lease": {
			labels: map[string]string{"lease": "cbx_active"},
			want:   "",
		},
		"missing lease label": {
			labels: map[string]string{},
			want:   " orphan=missing-lease-label",
		},
		"missing active lease": {
			labels: map[string]string{"lease": "cbx_old"},
			want:   " orphan=no-active-lease",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			if got := coordinatorMachineOrphanField(tt.labels, active); got != tt.want {
				t.Fatalf("orphan field=%q want %q", got, tt.want)
			}
		})
	}
}

func TestHeartbeatInterval(t *testing.T) {
	tests := map[time.Duration]time.Duration{
		0:                15 * time.Second,
		9 * time.Second:  5 * time.Second,
		30 * time.Second: 15 * time.Second,
		90 * time.Minute: 15 * time.Second,
	}
	for ttl, want := range tests {
		if got := heartbeatInterval(ttl); got != want {
			t.Fatalf("heartbeatInterval(%s)=%s want %s", ttl, got, want)
		}
	}
}
