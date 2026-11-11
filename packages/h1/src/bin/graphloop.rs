//! Deprecated `graphloop` shim bin (delete later): prints exactly one
//! deprecation line to stderr, then behaves byte-for-byte like the old
//! graphloop binary by running the yah CLI in-process.

fn main() {
    eprintln!(
        "graphloop is deprecated: use \"h1 <check|fmt|plan|up|down|graph|vault|runs|trace>\" instead"
    );
    std::process::exit(h1::yah::cli::main_from(std::env::args_os()));
}
