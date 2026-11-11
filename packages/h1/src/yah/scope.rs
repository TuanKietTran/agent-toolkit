//! The one symbol table for a `.yah` file.
//!
//! [`Scope::build`] is the ONLY place the declared names are derived from the AST:
//! the declared variables, the vault labels with each vault's declared `secrets`
//! keys, and the harness labels. `resolve` and `schema` both borrow the same
//! `Scope` instead of re-deriving these lists in each pass.

use std::collections::HashMap;

use crate::yah::ast::{ExprKind, Stmt};

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
    pub fn build(file: &crate::yah::ast::File) -> Scope {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yah::ast::{Assign, Block, Expr, File, Span};

    fn block(kind: &str, label: &str, body: Vec<Stmt>) -> Stmt {
        Stmt::Block(Block { kind: kind.to_string(), label: Some(label.to_string()), body, span: Span::default(), leading: Vec::new(), trailing: None })
    }

    fn file(stmts: Vec<Stmt>) -> File {
        File { name: "team.yah".to_string(), version: 1, stmts, tail_comments: Vec::new() }
    }

    fn assign(key: &str, value: Expr) -> Stmt {
        Stmt::Assign(Assign { key: key.to_string(), value, span: Span::default(), leading: Vec::new(), trailing: None })
    }

    fn secret_entry(key: &str) -> Assign {
        Assign { key: key.to_string(), value: Expr::str_lit("env:NAME", Span::default()), span: Span::default(), leading: Vec::new(), trailing: None }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn build_collects_names_per_kind_in_declaration_order() {
        let f = file(vec![
            block("variable", "beta", vec![]),
            block("vault", "vault_b", vec![]),
            block("harness", "zeta", vec![]),
            block("provider", "anthropic", vec![]),
            block("variable", "alpha", vec![]),
            block("harness", "alpha_h", vec![]),
            block("vault", "vault_a", vec![]),
            block("variable", "gamma", vec![]),
        ]);
        let scope = Scope::build(&f);
        assert_eq!(scope.variables, names(&["beta", "alpha", "gamma"]));
        assert_eq!(scope.vaults, names(&["vault_b", "vault_a"]));
        assert_eq!(scope.harnesses, names(&["zeta", "alpha_h"]));
    }

    #[test]
    fn vault_keys_from_secrets_map_and_vault_without_secrets_maps_to_empty_keys() {
        // Scope::build inserts an entry for EVERY vault label: a vault with a
        // `secrets` map maps to its declared key names, and a vault without one
        // maps to an empty key list (the entry is present, not absent).
        let secrets = Expr { kind: ExprKind::Map(vec![secret_entry("API_KEY"), secret_entry("DB_PASS")]), span: Span::default() };
        let f = file(vec![
            block("vault", "main", vec![assign("secrets", secrets)]),
            block("vault", "plain", vec![]),
        ]);
        let scope = Scope::build(&f);
        assert_eq!(scope.vaults, names(&["main", "plain"]));
        assert_eq!(scope.vault_keys.get("main"), Some(&names(&["API_KEY", "DB_PASS"])));
        assert_eq!(scope.vault_keys.get("plain"), Some(&Vec::new()));
    }

    #[test]
    fn build_of_file_with_no_blocks_is_empty() {
        let scope = Scope::build(&file(vec![]));
        assert!(scope.variables.is_empty());
        assert!(scope.vaults.is_empty());
        assert!(scope.vault_keys.is_empty());
        assert!(scope.harnesses.is_empty());
        assert_eq!(scope, Scope::default());
    }
}
