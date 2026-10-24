package ipnlocal

import (
	"net/netip"
	"strings"

	"tailscale.com/tailcfg"
)

// nativeExtraDNSRecord admits only literal address records from the original
// control netmap. An explicit type must match its address family; empty retains
// the upstream legacy inference. This never resolves a name or invents a route.
func nativeExtraDNSRecord(record tailcfg.DNSRecord) (string, netip.Addr, bool) {
	ip, err := netip.ParseAddr(record.Value)
	if err != nil {
		return "", netip.Addr{}, false
	}
	switch record.Type {
	case "":
	case "A":
		if !ip.Is4() {
			return "", netip.Addr{}, false
		}
	case "AAAA":
		if !ip.Is6() || ip.Is4In6() || ip.Zone() != "" {
			return "", netip.Addr{}, false
		}
	default:
		return "", netip.Addr{}, false
	}
	return strings.ToLower(strings.TrimSuffix(record.Name, ".")), ip, true
}
