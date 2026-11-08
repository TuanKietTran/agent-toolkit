//! The one symbol table for a `.yah` file. OWNER: w-ast (S3).
//!
//! [`Scope::build`] is the ONLY place the declared names are derived from the AST:
//! the declared variables, the vault labels with each vault's declared `secrets`
//! keys, and the harness labels. `resolve` and `schema` both borrow the same
//! `Scope` instead of re-deriving these lists in each pass.

use std::collections::HashMap;

use crate::ast::{ExprKind, Stmt};

/// Declared names in one file, in declaration order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    /// Labels of `variable` blocks.
    pub variables: Vec<String>,
    /// Labels of `vault` blocks.
    pub vaults: Vec<String>,
    /// Vault label -> declared `secrets` keys (empty: any KEY is allowed).
    pub vault_keys: HashMap<String, Vec<String>>,
    /// Labels of `harness` blocks.
    pub harnesses: Vec<String>,
}

impl Scope {
    pub fn build(file: &crate::ast::File) -> Scope {
        let mut scope = Scope::default();
        for stmt in &file.stmts {
            let Stmt::Block(block) = stmt else { continue };
            let Some(label) = &block.label else { continue };
            match block.kind.as_str() {
                "variable" => scope.variables.push(label.clone()),
                "vault" => {
                    scope.vaults.push(label.clone());
                    let keys = match block.assign("secrets").map(|a| &a.value.kind) {
                        Some(ExprKind::Map(entries)) => entries.iter().map(|e| e.key.clone()).collect(),
                        _ => Vec::new(),
                    };
                    scope.vault_keys.insert(label.clone(), keys);
                }
                "harness" => scope.harnesses.push(label.clone()),
                _ => {}
            }
        }
        scope
    }
}
