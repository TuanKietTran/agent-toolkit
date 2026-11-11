//! `h1 relation add|list|remove|graph` and `h1 event subscribe` (wire contract: `wire.rs`).
//!
//! Relations live in the hosts' memory. This module only asks hosts over their sockets and merges
//! what they answer: nothing is stored here and nothing is written to disk.

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::wire::{Edge, EventKind, RelationKind, Request};

#[derive(Debug, Args)]
pub(crate) struct RelationArgs {
    #[command(subcommand)]
    pub action: RelationAction,
}

#[derive(Debug, Subcommand)]
pub(crate) enum RelationAction {
    /// Declare an edge: FROM KIND TO (kinds: parent, supervises, depends_on, pairs_with).
    Add(RelationEdgeArgs),
    /// Print the declared edges, of one session or of all.
    List(RelationListArgs),
    /// Remove an edge.
    Remove(RelationEdgeArgs),
    /// Print the relation graph of all sessions.
    Graph(RelationGraphArgs),
}

#[derive(Debug, Args)]
pub(crate) struct RelationEdgeArgs {
    #[arg(value_name = "FROM")]
    pub from: String,
    #[arg(value_name = "KIND", value_parser = parse_kind)]
    pub kind: RelationKind,
    #[arg(value_name = "TO")]
    pub to: String,
    /// With `parent`: ending the parent stops the child too.
    #[arg(long)]
    pub cascade: bool,
}

#[derive(Debug, Args)]
pub(crate) struct RelationListArgs {
    /// Only the edges this session knows (both directions).
    #[arg(long, short = 'n', value_name = "APP")]
    pub name: Option<String>,
    /// One JSON array instead of text lines.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub(crate) struct RelationGraphArgs {
    /// `{"nodes":[...],"edges":[...]}` instead of text.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub(crate) struct EventArgs {
    #[command(subcommand)]
    pub action: EventAction,
}

#[derive(Debug, Subcommand)]
pub(crate) enum EventAction {
    /// Stream the state changes of sessions as one JSON object per line.
    Subscribe(EventSubscribeArgs),
}

#[derive(Debug, Args)]
pub(crate) struct EventSubscribeArgs {
    /// Session to follow. Repeatable.
    #[arg(long, short = 'n', value_name = "APP")]
    pub names: Vec<String>,
    /// Follow every session that runs now.
    #[arg(long, conflicts_with = "names")]
    pub all: bool,
    /// Only these kinds, comma separated (started, asking, stalled, idle, exited, closed, relation_ended).
    #[arg(long, value_name = "K,K", value_delimiter = ',', value_parser = parse_event_kind)]
    pub kind: Vec<EventKind>,
    /// Do not replay the last event of each session first.
    #[arg(long)]
    pub no_replay: bool,
    /// Exit after printing this many events.
    #[arg(long, value_name = "N")]
    pub count: Option<usize>,
    /// Give up after this many milliseconds.
    #[arg(long = "timeout-ms", value_name = "MS")]
    pub timeout_ms: Option<u64>,
}

fn parse_kind(text: &str) -> std::result::Result<RelationKind, String> {
    RelationKind::parse(text).ok_or_else(|| {
        format!("unknown relation {text:?}; choose from parent, supervises, depends_on, pairs_with")
    })
}

fn parse_event_kind(text: &str) -> std::result::Result<EventKind, String> {
    serde_json::from_value(Value::String(text.to_owned())).map_err(|_| {
        format!("unknown event kind {text:?}; choose from started, asking, stalled, idle, exited, closed, relation_ended")
    })
}

pub(crate) fn run_relation(args: RelationArgs) -> Result<i32> {
    match args.action {
        RelationAction::Add(args) => {
            let edge = edge_of(&args)?;
            send_edge(&edge, true)?;
            println!("{}", serde_json::to_string(&edge)?);
        }
        RelationAction::Remove(args) => {
            let edge = edge_of(&args)?;
            send_edge(&edge, false)?;
            println!("{}", serde_json::to_string(&edge)?);
        }
        RelationAction::List(args) => {
            let edges = match &args.name {
                Some(name) => host_edges(&session::socket_for(name)?)?,
                None => all_edges().0,
            };
            if args.json {
                println!("{}", serde_json::to_string(&edges)?);
            } else {
                for edge in &edges {
                    println!("{}", edge_text(edge));
                }
            }
        }
        RelationAction::Graph(args) => {
            let (edges, apps) = all_edges();
            if args.json {
                let mut nodes: BTreeSet<String> = apps.into_iter().collect();
                for edge in &edges {
                    nodes.insert(edge.from.clone());
                    nodes.insert(edge.to.clone());
                }
                println!("{}", json!({ "nodes": nodes, "edges": edges }));
            } else {
                print!("{}", graph_text(&edges, &apps));
            }
        }
    }
    Ok(0)
}

pub(crate) fn run_event(args: EventArgs) -> Result<i32> {
    let EventAction::Subscribe(args) = args.action;
    let (sockets, strict) = if args.all {
        let sockets = session::entries()
            .into_iter()
            .map(|entry| PathBuf::from(entry.socket))
            .collect();
        (sockets, false)
    } else if args.names.is_empty() {
        let name = env::var("H1_NAME")
            .or_else(|_| env::var("H1_SELF"))
            .map_err(|_| anyhow!("event subscribe needs -n APP or --all"))?;
        (vec![session::socket_for(&name)?], true)
    } else {
        let sockets = args
            .names
            .iter()
            .map(|name| session::socket_for(name))
            .collect::<Result<Vec<_>>>()?;
        (sockets, true)
    };
    let request = Request::EventSubscribe {
        kinds: args.kind,
        replay: !args.no_replay,
    };
    crate::signals::stream_many(sockets, request, args.count, args.timeout_ms, strict)?;
    Ok(0)
}

fn edge_of(args: &RelationEdgeArgs) -> Result<Edge> {
    session::validate_name(&args.from)?;
    session::validate_name(&args.to)?;
    Ok(Edge {
        from: args.from.clone(),
        kind: args.kind,
        to: args.to.clone(),
        cascade: args.cascade && args.kind == RelationKind::Parent,
    })
}

/// Edges go to the `from` host, which mirrors them to the `to` host.
fn send_edge(edge: &Edge, add: bool) -> Result<()> {
    let socket = session::socket_for(&edge.from)?;
    let edge = edge.clone();
    let request_op = if add {
        Request::RelationAdd {
            edge,
            mirror: false,
        }
    } else {
        Request::RelationRemove {
            edge,
            mirror: false,
        }
    };
    request(&socket, serde_json::to_value(request_op)?)?;
    Ok(())
}

fn host_edges(socket: &Path) -> Result<Vec<Edge>> {
    let response = request(socket, serde_json::to_value(Request::RelationList)?)?;
    Ok(serde_json::from_value(
        response.get("edges").cloned().unwrap_or(Value::Null),
    )?)
}

/// Edges of every running session (deduplicated, sorted) and the session names.
fn all_edges() -> (Vec<Edge>, Vec<String>) {
    let mut edges = BTreeSet::new();
    let mut apps = Vec::new();
    for entry in session::entries() {
        if let Ok(found) = host_edges(Path::new(&entry.socket)) {
            for edge in found {
                edges.insert((edge.from, kind_name(edge.kind), edge.to, edge.cascade));
            }
            apps.push(entry.name);
        }
    }
    let edges = edges
        .into_iter()
        .filter_map(|(from, kind, to, cascade)| {
            Some(Edge {
                from,
                kind: RelationKind::parse(kind)?,
                to,
                cascade,
            })
        })
        .collect();
    (edges, apps)
}

fn kind_name(kind: RelationKind) -> &'static str {
    match kind {
        RelationKind::Parent => "parent",
        RelationKind::Supervises => "supervises",
        RelationKind::DependsOn => "depends_on",
        RelationKind::PairsWith => "pairs_with",
    }
}

pub(crate) fn edge_text(edge: &Edge) -> String {
    let cascade = if edge.cascade { " (cascade)" } else { "" };
    format!(
        "{} {} {}{cascade}",
        edge.from,
        kind_name(edge.kind),
        edge.to
    )
}

/// Text graph: every app that has an edge, with its outgoing edges as children.
pub(crate) fn graph_text(edges: &[Edge], apps: &[String]) -> String {
    let mut out: BTreeMap<&str, Vec<&Edge>> = BTreeMap::new();
    for app in apps {
        out.entry(app).or_default();
    }
    for edge in edges {
        out.entry(&edge.from).or_default().push(edge);
        out.entry(&edge.to).or_default();
    }
    let mut text = String::new();
    for (app, outgoing) in out {
        text.push_str(app);
        text.push('\n');
        for edge in outgoing {
            let cascade = if edge.cascade { " (cascade)" } else { "" };
            text.push_str(&format!(
                "  {} {}{cascade}\n",
                kind_name(edge.kind),
                edge.to
            ));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(from: &str, kind: RelationKind, to: &str, cascade: bool) -> Edge {
        Edge {
            from: from.into(),
            kind,
            to: to.into(),
            cascade,
        }
    }

    #[test]
    fn kinds_parse_and_unknown_kinds_list_the_choices() {
        assert_eq!(parse_kind("depends_on"), Ok(RelationKind::DependsOn));
        assert!(parse_kind("owns").unwrap_err().contains("pairs_with"));
        assert_eq!(
            parse_event_kind("relation_ended"),
            Ok(EventKind::RelationEnded)
        );
        assert!(parse_event_kind("nope").is_err());
    }

    #[test]
    fn cascade_only_applies_to_parent_edges() {
        let args = |kind| RelationEdgeArgs {
            from: "a".into(),
            kind,
            to: "b".into(),
            cascade: true,
        };
        assert!(edge_of(&args(RelationKind::Parent)).unwrap().cascade);
        assert!(!edge_of(&args(RelationKind::DependsOn)).unwrap().cascade);
        let bad = RelationEdgeArgs {
            from: "a b".into(),
            ..args(RelationKind::Parent)
        };
        assert!(edge_of(&bad).is_err());
    }

    #[test]
    fn text_forms() {
        let edges = vec![
            edge("a", RelationKind::Parent, "b", true),
            edge("a", RelationKind::DependsOn, "c", false),
        ];
        assert_eq!(edge_text(&edges[0]), "a parent b (cascade)");
        let graph = graph_text(&edges, &["z".to_owned()]);
        assert_eq!(graph, "a\n  parent b (cascade)\n  depends_on c\nb\nc\nz\n");
    }
}
