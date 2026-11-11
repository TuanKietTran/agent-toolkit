//! Generic mutable traversal of the AST.
//!
//! A [`Visitor`] overrides only the node kinds it cares about; the default methods and the
//! `walk_*` free functions recurse in source order: a block's statements, an assignment's
//! value, a list's items and a map's entries (as assignments). String parts are NOT recursed
//! into: interpolations are leaves, handled by visitors overriding `visit_expr`.

use crate::ast::{Assign, Block, Expr, ExprKind, Stmt};

pub trait Visitor {
    fn visit_block(&mut self, b: &mut Block) {
        walk_block(self, b)
    }
    fn visit_assign(&mut self, a: &mut Assign) {
        walk_assign(self, a)
    }
    fn visit_expr(&mut self, e: &mut Expr) {
        walk_expr(self, e)
    }
}

pub fn walk_block<V: Visitor + ?Sized>(v: &mut V, b: &mut Block) {
    for stmt in &mut b.body {
        match stmt {
            Stmt::Block(inner) => v.visit_block(inner),
            Stmt::Assign(a) => v.visit_assign(a),
        }
    }
}

pub fn walk_assign<V: Visitor + ?Sized>(v: &mut V, a: &mut Assign) {
    v.visit_expr(&mut a.value);
}

pub fn walk_expr<V: Visitor + ?Sized>(v: &mut V, e: &mut Expr) {
    match &mut e.kind {
        ExprKind::List(items) => {
            for item in items {
                v.visit_expr(item);
            }
        }
        ExprKind::Map(assigns) => {
            for a in assigns {
                v.visit_assign(a);
            }
        }
        _ => {}
    }
}
