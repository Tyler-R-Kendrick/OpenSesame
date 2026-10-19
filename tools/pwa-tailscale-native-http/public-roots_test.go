package nativehttp

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"io"
	"iter"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/x509roots/fallback/bundle"
)

var distrustDate = time.Date(2026, time.April, 15, 23, 59, 59, 0, time.UTC)

func rootSequence(roots ...bundle.Root) iter.Seq[bundle.Root] {
	return func(yield func(bundle.Root) bool) {
		for _, root := range roots {
			if !yield(root) {
				return
			}
		}
	}
}

func pinnedConstraint(t *testing.T) func([]*x509.Certificate) error {
	t.Helper()
	var constraint func([]*x509.Certificate) error
	count := 0
	for root := range bundle.Roots() {
		if root.Constraint == nil {
			continue
		}
		digest := sha256.Sum256(root.Certificate)
		if hex.EncodeToString(digest[:]) != "2530cc8e98321502bad96f9b1fba1b099e2d299e0f4548bb914f363bc0d4531f" {
			t.Fatal("Pinned NSS constrained root changed; review its source and contract.")
		}
		constraint = root.Constraint
		count++
	}
	if count != 1 {
		t.Fatal("Pinned NSS constraint count changed.")
	}
	return constraint
}

func TestPublicRootsExactlyPinnedAndIndependent(t *testing.T) {
	var subjects [][]byte
	for root := range bundle.Roots() {
		cert, err := x509.ParseCertificate(root.Certificate)
		if err != nil {
			t.Fatal("Pinned public bundle certificate did not parse.")
		}
		subjects = append(subjects, cert.RawSubject)
	}
	first, err := PublicRoots()
	if err != nil || len(subjects) != 120 || !reflect.DeepEqual(first.Subjects(), subjects) {
		t.Fatal("Public trust must contain exactly the pinned bundle, without system/operator union.")
	}
	second, err := PublicRoots()
	if err != nil || first == second {
		t.Fatal("Public pool construction reused mutable caller state.")
	}
	_, owned := certificate(t, "native.test", time.Now().Add(time.Hour), false)
	first.AddCert(owned)
	if !reflect.DeepEqual(second.Subjects(), subjects) {
		t.Fatal("Mutating one captured public pool changed another generation.")
	}
}

func TestPinnedNSSConstraintBoundary(t *testing.T) {
	constraint := pinnedConstraint(t)
	for _, issued := range []time.Time{distrustDate.Add(-time.Second), distrustDate} {
		if constraint([]*x509.Certificate{{NotBefore: issued}}) != nil {
			t.Fatal("Pinned NSS cutoff incorrectly rejected a permitted issuance date.")
		}
	}
	if constraint([]*x509.Certificate{{NotBefore: distrustDate.Add(time.Second)}}) == nil {
		t.Fatal("Pinned NSS distrust-after constraint was lost.")
	}
	if constraint([]*x509.Certificate{{NotBefore: distrustDate}, {NotBefore: distrustDate.Add(time.Second)}}) == nil {
		t.Fatal("Pinned NSS constraint did not inspect the complete supplied chain.")
	}
}

func TestPublicRootsRefuseActualOperatorTLS(t *testing.T) {
	var calls atomic.Int32
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.Write([]byte{0, 255})
	})
	public, err := PublicRoots()
	if err != nil {
		t.Fatal("Public pool construction failed.")
	}
	response, err := ownedTrustRequest(t, fixture, public)
	failed(t, response, err)
	if calls.Load() != 0 {
		t.Fatal("Public trust sent HTTP credentials/body through an untrusted operator root.")
	}
	response, err = ownedTrustRequest(t, fixture, fixture.roots)
	if err != nil || !bytes.Equal(response.Body, []byte{0, 255}) || calls.Load() != 1 {
		t.Fatal("The same actual TLS target did not work with its explicit operator pool.")
	}
}

func ownedTrustRequest(t *testing.T, fixture target, roots *x509.CertPool) (Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return Do(ctx, Request{Method: "GET", URL: fixture.url}, fixture.dial, roots, func() bool { return true })
}

func issuedCertificate(t *testing.T, issued time.Time) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	rootKey, leafKey := signer(t, false), signer(t, false)
	root := &x509.Certificate{
		SerialNumber: big.NewInt(11), Subject: pkix.Name{CommonName: "Owned constraint oracle root"},
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
		NotBefore: distrustDate.AddDate(-1, 0, 0), NotAfter: time.Now().Add(time.Hour),
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, root, root, rootKey.Public(), rootKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(12), DNSNames: []string{"native.test"},
		NotBefore: issued, NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, root, leafKey.Public(), rootKey)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}, parsed
}

func issuedTarget(t *testing.T, issued time.Time, calls *atomic.Int32) target {
	t.Helper()
	cert, root := issuedCertificate(t, issued)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.Write([]byte{0, 255})
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}
	server.StartTLS()
	t.Cleanup(func() { server.CloseClientConnections(); server.Close() })
	address := net.JoinHostPort("native.test", strconv.Itoa(server.Listener.Addr().(*net.TCPAddr).Port))
	dial := func(ctx context.Context, network, requested string) (net.Conn, error) {
		if network != "tcp" || requested != address {
			return nil, errors.New("Unapproved owned trust oracle target.")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}
	return target{server: server, url: "https://" + address, ca: root, dial: dial}
}

func TestConstrainedPoolActualTLSUsesPinnedNSSConstraint(t *testing.T) {
	constraint := pinnedConstraint(t)
	for _, test := range []struct {
		name                 string
		issued               time.Time
		constrained, allowed bool
	}{
		{"before-cutoff", distrustDate.Add(-time.Second), true, true},
		{"after-cutoff", distrustDate.Add(time.Second), true, false},
		{"same-after-cutoff-unconstrained-control", distrustDate.Add(time.Second), false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			fixture := issuedTarget(t, test.issued, &calls)
			root := bundle.Root{Certificate: fixture.ca.Raw}
			if test.constrained {
				root.Constraint = constraint
			}
			pool, err := constrainedRootPool(rootSequence(root))
			if err != nil {
				t.Fatal("Owned signable constraint oracle pool failed.")
			}
			response, err := ownedTrustRequest(t, fixture, pool)
			if test.allowed {
				if err != nil || !bytes.Equal(response.Body, []byte{0, 255}) || calls.Load() != 1 {
					t.Fatal("Allowed actual TLS failed through the original pool builder.")
				}
			} else {
				failed(t, response, err)
				if calls.Load() != 0 {
					t.Fatal("Constrained actual TLS reached HTTP despite pinned NSS rejection.")
				}
			}
		})
	}
}

func TestConstrainedPoolFailsClosedWithoutPartialTrust(t *testing.T) {
	var valid bundle.Root
	for root := range bundle.Roots() {
		valid = root
		break
	}
	for _, roots := range [][]bundle.Root{nil, {{Certificate: []byte("invalid")}}, {valid, {Certificate: []byte("invalid")}}} {
		pool, err := constrainedRootPool(rootSequence(roots...))
		if pool != nil || err != errTrust {
			t.Fatal("Invalid/empty root sequence exposed a partial trust pool or provider details.")
		}
	}
}
