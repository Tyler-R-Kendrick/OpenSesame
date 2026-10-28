// Copied only into the pinned upstream derphttp package by the review workflow.
package derphttp

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"testing"
	"time"

	"tailscale.com/net/bakedroots"
	"tailscale.com/tailcfg"
)

func TestCodeQLDERPActualTLSCaller(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "DERP review CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	makeServer := func(t *testing.T, dns string, expired bool) tls.Certificate {
		t.Helper()
		notAfter := now.Add(time.Hour)
		if expired {
			notAfter = now.Add(-time.Hour)
		}
		leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{dns}, NotBefore: now.Add(-2 * time.Hour), NotAfter: notAfter, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der, caDER}, PrivateKey: key}
	}
	for _, tc := range []struct {
		name, serverName, certName, leafName string
		baked, expired, success              bool
        untrusted, noConfig, insecureForTests bool
	}{
		{"empty CertName uses SNI and custom root", "front.example", "", "front.example", false, false, true, false, false, false},
		{"same CertName preserves custom root", "backend.example", "backend.example", "backend.example", false, false, true, false, false, false},
		{"different CertName preserves custom root", "front.example", "backend.example", "backend.example", false, false, true, false, false, false},
		{"different CertName rejects untrusted root", "front.example", "backend.example", "backend.example", false, false, false, true, false, false},
		{"different CertName rejects missing custom configuration", "front.example", "backend.example", "backend.example", false, false, false, false, true, false},
		{"test mode with distinct CertName still verifies", "front.example", "backend.example", "other.example", false, false, false, false, false, true},
		{"different CertName uses baked root", "front.example", "backend.example", "backend.example", true, false, true, false, false, false},
		{"different CertName rejects wrong hostname with custom root", "front.example", "backend.example", "other.example", false, false, false, false, false, false},
		{"different CertName rejects wrong hostname with baked root", "front.example", "backend.example", "other.example", true, false, false, false, false, false},
		{"different CertName rejects expired cert with custom root", "front.example", "backend.example", "backend.example", false, true, false, false, false, false},
		{"different CertName rejects expired cert with baked root", "front.example", "backend.example", "backend.example", true, true, false, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.baked {
				bakedroots.ResetForTest(t, caPEM)
			}
			cert := makeServer(t, tc.leafName, tc.expired)
			roots := x509.NewCertPool()
			if !tc.untrusted {
                roots.AddCert(ca)
            }
            var config *tls.Config
            if !tc.noConfig {
                config = &tls.Config{RootCAs: roots}
            }
			originalRoots := roots.Clone()
			dialer := &Client{TLSConfig: config}
			node := &tailcfg.DERPNode{HostName: tc.serverName, CertName: tc.certName, InsecureForTests: tc.insecureForTests}
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			deadline := time.Now().Add(5 * time.Second)
			if err := client.SetDeadline(deadline); err != nil {
				t.Fatal(err)
			}
			if err := server.SetDeadline(deadline); err != nil {
				t.Fatal(err)
			}
			seenSNI := make(chan string, 1)
			serverTLS := tls.Server(server, &tls.Config{Certificates: []tls.Certificate{cert}, GetConfigForClient: func(info *tls.ClientHelloInfo) (*tls.Config, error) { seenSNI <- info.ServerName; return nil, nil }})
			serverDone := make(chan error, 1)
			go func() { serverDone <- serverTLS.Handshake() }()
			clientTLS := dialer.tlsClient(client, node)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := clientTLS.HandshakeContext(ctx)
			if config != nil && (config.RootCAs != roots || !roots.Equal(originalRoots)) {
				t.Fatal("caller custom roots were mutated")
			}
			if (err == nil) != tc.success {
				t.Fatalf("handshake error %v; expected success %v", err, tc.success)
			}
			if got := <-seenSNI; got != tc.serverName {
				t.Fatalf("SNI %q, want %q", got, tc.serverName)
			}
			<-serverDone
		})
	}
}
