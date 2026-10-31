//! [`benilla_formats::web::encode_name`] is pure string math (no browser dependency), so it is
//! exercised here natively rather than only under a wasm target — it is the client half of the Data
//! URL scheme (Lane A ↔ Lane H), and a mismatch with the host's decode would silently 404 every
//! chain name with a space, backslash, or other reserved byte in it.

use benilla_formats::web::encode_name;

#[test]
fn matches_the_data_url_schemes_worked_example() {
    // The plan's own worked example: a backslash-separated chain name with a space in it.
    assert_eq!(
        encode_name(r"Interface\Glues\a b.blp"),
        "Interface%5CGlues%5Ca%20b.blp"
    );
}

#[test]
fn unreserved_characters_pass_through_unescaped() {
    let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    assert_eq!(encode_name(unreserved), unreserved);
}

#[test]
fn every_other_byte_is_percent_escaped_uppercase_hex() {
    // Backslash, forward slash, space, and a non-ASCII byte (encodeURIComponent works per UTF-8
    // byte, not per Unicode scalar) all leave the unreserved set.
    assert_eq!(encode_name("\\"), "%5C");
    assert_eq!(encode_name("/"), "%2F");
    assert_eq!(encode_name(" "), "%20");
    assert_eq!(encode_name("é"), "%C3%A9");
}

#[test]
fn empty_name_encodes_to_empty() {
    assert_eq!(encode_name(""), "");
}

#[test]
fn generated_catalogs_models_and_textures_are_not_rejected_by_the_mpq_index() {
    use benilla_formats::web::is_generated_asset;
    for name in [
        "__classic/spell-effects.json",
        "__classic/item-appearances.json",
        "__classic/166381.m2",
        r"__CLASSIC\166526.blp",
    ] {
        assert!(is_generated_asset(name), "{name}");
    }
    for name in [
        r"DBFilesClient\Spell.dbc",
        "Interface/Icons/Missing.blp",
        "not__classic/166381.m2",
    ] {
        assert!(!is_generated_asset(name), "{name}");
    }
}
