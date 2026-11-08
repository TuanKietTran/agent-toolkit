//! Graphloop: the Graphspec (`.yah`) vault and the launcher that turns a `team` block into
//! `h1 open` calls.
//!
//! Pipeline (docs/graphspec.md, "Parser requirements"):
//!
//! ```text
//! source --lexer--> tokens --parser--> ast::File
//!        --resolve--> ast::File (variables substituted, references checked)
//!        --schema---> spec::Spec (strict validation, defaults applied)
//!        --pick-----> pick::Resolved per harness (system-one decides `model = "system-one"`)
//!        --plan-----> plan::Plan (h1 open argv, edges)
//!        --cli------> `graphloop up` opens the labs, writes a manifest the console and lab-gui draw
//! ```
//!
//! Owners are named in each module's header; the types in `ast`, `spec`, `diag`, `pick` (the data
//! types) and `manifest` are the shared contract and change only by agreement with the commander.

pub mod ast;
pub mod cli;
pub mod diag;
pub mod envfile;
pub mod fmt;
pub mod lexer;
pub mod load;
pub mod manifest;
pub mod parser;
pub mod pick;
pub mod plan;
pub mod refs;
pub mod resolve;
pub mod schema;
pub mod scope;
pub mod spec;
pub mod vault;
pub mod visit;
