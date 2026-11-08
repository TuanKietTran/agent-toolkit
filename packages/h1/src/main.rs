use clap::Parser;

fn main() {
    let cli = h1::Cli::parse();
    let code = match h1::execute(cli) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("h1: {error:#}");
            1
        }
    };
    std::process::exit(code);
}
