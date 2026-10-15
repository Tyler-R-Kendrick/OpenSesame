use super::trust_sas::sas_from_fingerprint;
use crate::fingerprint_of_spki;

#[test]
fn sas_is_first_sixteen_hex_digits_grouped() {
    let fp = fingerprint_of_spki(b"root");
    let sas = sas_from_fingerprint(&fp).expect("sas");
    assert_eq!(sas.len(), 19);
    assert_eq!(sas.chars().filter(|c| *c == '-').count(), 3);
}
