//! The reference language of `.yah`: ONE definition of which dotted paths are references, what they
//! mean, and when they are bound. `resolve` and `schema` both classify a path through
//! [`Reference::parse`]; nothing else in the crate matches reference words as strings.
//!
//! Evaluation is staged (docs/architecture.md): every reference belongs to exactly one [`Stage`].
//!
//! | form | stage | meaning |
//! | --- | --- | --- |
//! | `var.<name>` | compile | a `--var` or default value, folded into the AST by `resolve` |
//! | `harnesses.<label>.model`, `.model_id` | plan | the model `pick` chose for a harness |
//! | `env.<NAME>`, `vault.<name>.<KEY>` | apply | read when a lab is opened, never earlier |
//!
//! Extension point: a future function call or conditional would be a new expression node next to
//! this enum, resolved by the same pass; references stay the leaves.

use std::fmt;

/// A parsed reference. The words are spelled exactly as in the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reference {
    /// `var.<name>`
    Var(String),
    /// `env.<NAME>`
    Env(String),
    /// `vault.<name>.<KEY>`
    Vault { vault: String, key: String },
    /// `harnesses.<label>.model`: `provider/id`
    HarnessModel(String),
    /// `harnesses.<label>.model_id`: the bare model id
    HarnessModelId(String),
}

/// When a reference gets its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Compile,
    Plan,
    Apply,
}

/// A path that is not a reference. `root` is its first word, so a caller can build a hint that
/// matches what the author probably meant (a `var.` path gets variable names as candidates).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotAReference {
    pub root: Option<String>,
}

/// Every reference form, in the order messages list them.
pub const FORMS: &[&str] = &[
    "var.<name>",
    "env.<NAME>",
    "vault.<name>.<KEY>",
    "harnesses.<label>.model",
    "harnesses.<label>.model_id",
];

/// The sentence every "unknown reference" diagnostic ends with, built from [`FORMS`].
pub fn valid_forms() -> String {
    let (last, rest) = FORMS.split_last().expect("FORMS is not empty");
    format!("Valid references are {} and {}.", rest.join(", "), last)
}

impl Reference {
    /// Classify a dotted path. The shape decides: root word and number of words.
    pub fn parse(path: &[String]) -> Result<Reference, NotAReference> {
        let word = |i: usize| path[i].clone();
        match (path.first().map(String::as_str), path.len()) {
            (Some("var"), 2) => Ok(Reference::Var(word(1))),
            (Some("env"), 2) if !path[1].is_empty() => Ok(Reference::Env(word(1))),
            (Some("vault"), 3) => Ok(Reference::Vault {
                vault: word(1),
                key: word(2),
            }),
            (Some("harnesses"), 3) if path[2] == "model" => Ok(Reference::HarnessModel(word(1))),
            (Some("harnesses"), 3) if path[2] == "model_id" => {
                Ok(Reference::HarnessModelId(word(1)))
            }
            _ => Err(NotAReference {
                root: path.first().cloned(),
            }),
        }
    }

    pub fn stage(&self) -> Stage {
        match self {
            Reference::Var(_) => Stage::Compile,
            Reference::HarnessModel(_) | Reference::HarnessModelId(_) => Stage::Plan,
            Reference::Env(_) | Reference::Vault { .. } => Stage::Apply,
        }
    }

    /// The dotted words, as written.
    pub fn path(&self) -> Vec<String> {
        match self {
            Reference::Var(n) => vec!["var".into(), n.clone()],
            Reference::Env(n) => vec!["env".into(), n.clone()],
            Reference::Vault { vault, key } => vec!["vault".into(), vault.clone(), key.clone()],
            Reference::HarnessModel(h) => vec!["harnesses".into(), h.clone(), "model".into()],
            Reference::HarnessModelId(h) => vec!["harnesses".into(), h.clone(), "model_id".into()],
        }
    }
}

impl fmt::Display for Reference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.path().join("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Vec<String> {
        s.split('.').map(str::to_owned).collect()
    }

    #[test]
    fn every_form_parses_and_prints_back() {
        for (text, expected) in [
            ("var.work_dir", Reference::Var("work_dir".into())),
            ("env.API_KEY", Reference::Env("API_KEY".into())),
            (
                "vault.local.TOKEN",
                Reference::Vault {
                    vault: "local".into(),
                    key: "TOKEN".into(),
                },
            ),
            (
                "harnesses.builder.model",
                Reference::HarnessModel("builder".into()),
            ),
            (
                "harnesses.builder.model_id",
                Reference::HarnessModelId("builder".into()),
            ),
        ] {
            let r = Reference::parse(&p(text)).unwrap_or_else(|e| panic!("{text}: {e:?}"));
            assert_eq!(r, expected);
            assert_eq!(r.to_string(), text);
            assert_eq!(r.path(), p(text));
        }
    }

    #[test]
    fn stages_follow_the_binding_table() {
        assert_eq!(
            Reference::parse(&p("var.x")).unwrap().stage(),
            Stage::Compile
        );
        assert_eq!(
            Reference::parse(&p("harnesses.h.model")).unwrap().stage(),
            Stage::Plan
        );
        assert_eq!(
            Reference::parse(&p("harnesses.h.model_id"))
                .unwrap()
                .stage(),
            Stage::Plan
        );
        assert_eq!(Reference::parse(&p("env.X")).unwrap().stage(), Stage::Apply);
        assert_eq!(
            Reference::parse(&p("vault.v.K")).unwrap().stage(),
            Stage::Apply
        );
        assert!(Stage::Compile < Stage::Plan && Stage::Plan < Stage::Apply);
    }

    #[test]
    fn wrong_shapes_are_not_references_and_keep_their_root() {
        for (text, root) in [
            ("var", "var"),
            ("var.a.b", "var"),
            ("env", "env"),
            ("env.A.B", "env"),
            ("vault.v", "vault"),
            ("vault.v.k.x", "vault"),
            ("harnesses.h", "harnesses"),
            ("harnesses.h.tools", "harnesses"),
            ("harnesses.h.model.x", "harnesses"),
            ("nope.x", "nope"),
        ] {
            let e = Reference::parse(&p(text)).unwrap_err();
            assert_eq!(e.root.as_deref(), Some(root), "{text}");
        }
        assert_eq!(Reference::parse(&[]).unwrap_err().root, None);
    }

    #[test]
    fn valid_forms_text_is_exactly_what_diagnostics_have_always_said() {
        assert_eq!(
            valid_forms(),
            "Valid references are var.<name>, env.<NAME>, vault.<name>.<KEY>, harnesses.<label>.model and harnesses.<label>.model_id."
        );
    }

    #[test]
    fn every_listed_form_has_a_matching_example() {
        // FORMS and parse must not drift: each spelling with its placeholders filled in must parse.
        for form in FORMS {
            let filled: Vec<String> = form
                .split('.')
                .map(|w| {
                    if w.starts_with('<') {
                        "x".to_owned()
                    } else {
                        w.to_owned()
                    }
                })
                .collect();
            assert!(Reference::parse(&filled).is_ok(), "{form}");
        }
    }
}
