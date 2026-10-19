package ipnlocal

import (
	"net/netip"
	"testing"

	"tailscale.com/tailcfg"
)

func TestNativeExtraDNSAddressRecords(t *testing.T) {
	for _, record := range []tailcfg.DNSRecord{
		{Name: "ContractApp-DSN.Algolia.NET.", Type: "A", Value: "100.64.0.1"},
		{Name: "api.contentful.com", Type: "AAAA", Value: "fd7a:115c:a1e0::1"},
		{Name: "api.cloudflare.com", Type: "A", Value: "192.0.2.1"},
		{Name: "legacy.example", Value: "100.64.0.1"},
		{Name: "legacy.example", Value: "fd7a:115c:a1e0::1"},
	} {
		t.Run(record.Type+"/"+record.Value, func(t *testing.T) {
			name, ip, ok := nativeExtraDNSRecord(record)
			if !ok || name == "" || ip != netip.MustParseAddr(record.Value) {
				t.Fatalf("Original operator literal address record refused: %q %v %v", name, ip, ok)
			}
			if record.Name == "ContractApp-DSN.Algolia.NET." && name != "contractapp-dsn.algolia.net" {
				t.Fatal("Original case/trailing-dot canonicalization changed")
			}
		})
	}
}

func TestNativeExtraDNSRejectsTypeAndAddressMismatch(t *testing.T) {
	for _, record := range []tailcfg.DNSRecord{
		{Type: "A", Value: "fd7a:115c:a1e0::1"},
		{Type: "AAAA", Value: "100.64.0.1"},
		{Type: "AAAA", Value: "::ffff:100.64.0.1"},
		{Type: "A", Value: "::ffff:100.64.0.1"},
		{Type: "AAAA", Value: "fd7a:115c:a1e0::1%zone"},
		{Type: "A", Value: "100.64.0.1/32"},
		{Type: "A", Value: "100.64.0.999"},
		{Type: "A", Value: "100.64.0.1:443"},
		{Type: "AAAA", Value: "[fd7a:115c:a1e0::1]"},
		{Type: "A", Value: "peer.tailnet.test"},
		{Type: "A", Value: " 100.64.0.1"},
		{Type: "AAAA", Value: ""},
		{Type: "CNAME", Value: "100.64.0.1"},
		{Type: "TXT", Value: "100.64.0.1"},
		{Type: "a", Value: "100.64.0.1"},
		{Type: "AAAA ", Value: "fd7a:115c:a1e0::1"},
	} {
		t.Run(record.Type+"/"+record.Value, func(t *testing.T) {
			record.Name = "contractapp-dsn.algolia.net"
			name, ip, ok := nativeExtraDNSRecord(record)
			if ok || name != "" || ip.IsValid() {
				t.Fatalf("Invalid record became an owned DNS answer: %q %v %v", name, ip, ok)
			}
		})
	}
}

func TestNativeExtraDNSLegacyInferencePreserved(t *testing.T) {
	for _, value := range []string{"::ffff:100.64.0.1", "fd7a:115c:a1e0::1%zone"} {
		_, ip, ok := nativeExtraDNSRecord(tailcfg.DNSRecord{Name: "legacy.example", Value: value})
		if !ok || ip != netip.MustParseAddr(value) {
			t.Fatal("Existing empty-type literal parsing changed; independent native route grants still apply")
		}
	}
}
